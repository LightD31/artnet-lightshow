import net from 'node:net';
import { HttpError, codeOf, messageOf } from '../errors.ts';
import { OPENRGB_PORT } from './openrgb-routes.ts';

/**
 * OpenRGB's SDK server, which drives the RGB inside a PC — the RAM, the
 * board, the GPU, the keyboard, the mouse, the monitors' light bars — over
 * one TCP connection, a packet a device a frame.
 *
 * A packet is a sixteen-byte header, little-endian, and its data:
 *
 *   0–3    "ORGB"
 *   4–7    the device the packet is about, by index in the server's list
 *   8–11   what the packet is (PACKET)
 *   12–15  how many bytes of data follow
 *
 * The server answers a request with the same device and packet id. The
 * client asks the server's protocol version (40), names itself (50), counts
 * the devices (0) and reads each one (1: its name, type, modes, zones and
 * LEDs); it paints a device with UPDATELEDS (1050: a count and that many
 * colours as four bytes R, G, B, 0), after putting it in its per-LED
 * "Direct" mode with UPDATEMODE (1101) when it is in a hardware effect.
 *
 * Reference: openrgb-python, which LedFx drives OpenRGB through. The engine's
 * worker loads this module the first time a frame goes to a device, so it
 * stays what the wire needs; a device's profile and identify are
 * openrgb-devices.ts.
 */

const MAGIC = Buffer.from('ORGB', 'ascii');
const HEADER = 16;
// The protocol this client speaks (a server that speaks less is spoken to
// at its own). Three is what LedFx speaks, and what every 0.9+ server takes.
const PROTOCOL_VERSION = 3;
const CLIENT_NAME = 'ArtNet Lightshow';

export const PACKET = {
  REQUEST_CONTROLLER_COUNT: 0,
  REQUEST_CONTROLLER_DATA: 1,
  REQUEST_PROTOCOL_VERSION: 40,
  SET_CLIENT_NAME: 50,
  DEVICE_LIST_UPDATED: 100,
  RGBCONTROLLER_UPDATELEDS: 1050,
  RGBCONTROLLER_UPDATEMODE: 1101,
} as const;

/** What the server says a device is, by its type number. */
const DEVICE_TYPES = [
  'Motherboard', 'DRAM', 'GPU', 'Cooler', 'LED strip', 'Keyboard', 'Mouse', 'Mousemat', 'Headset', 'Headset stand',
  'Gamepad', 'Light', 'Speaker', 'Virtual', 'Storage', 'Case', 'Microphone', 'Accessory', 'Keypad', 'Unknown',
];

// Mode flags and colour modes, as OpenRGB numbers them.
const MODE_FLAG_PER_LED_COLOR = 1 << 5;
const MODE_COLORS_PER_LED = 1;

// Nothing the server sends is bigger than a keyboard's controller data, a
// few tens of KB; a header claiming more is not an OpenRGB server.
const MAX_PACKET_BYTES = 16 * 1024 * 1024;
// An old server never answers the version question: a second, and it is 0.
const VERSION_TIMEOUT_MS = 1000;
const REQUEST_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 3000;
// A socket this far behind is a device that cannot keep up: frames are
// dropped rather than queued behind it, so what reaches it is current.
const HIGH_WATER_BYTES = 64 * 1024;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const MAX_DEVICES = 64;

// ── Packets ─────────────────────────────────────────────────────────────────

/** A packet: the header for `device` and `id`, and `data` after it. */
function buildPacket(device: number, id: number, data: Uint8Array = new Uint8Array(0)): Buffer {
  const packet = Buffer.alloc(HEADER + data.length);
  MAGIC.copy(packet, 0);
  packet.writeUInt32LE(device >>> 0, 4);
  packet.writeUInt32LE(id >>> 0, 8);
  packet.writeUInt32LE(data.length, 12);
  packet.set(data, HEADER);
  return packet;
}

/** A packet's header, or null when the bytes are not one. */
function parseHeader(buf: Buffer): { device: number; id: number; length: number } | null {
  if (buf.length < HEADER || !buf.subarray(0, 4).equals(MAGIC)) return null;
  return { device: buf.readUInt32LE(4), id: buf.readUInt32LE(8), length: buf.readUInt32LE(12) };
}

/**
 * UPDATELEDS for `device`: `leds` colours, from `rgb` three bytes a LED (a
 * LED past the end of `rgb` is dark). The data is its own length, the count,
 * then each colour as R, G, B and a zero byte — 0x00BBGGRR, little-endian.
 */
function buildUpdateLeds(device: number, rgb: Uint8Array, leds: number): Buffer {
  const n = Math.max(0, Math.min(0xffff, Math.floor(leds)));
  const data = Buffer.alloc(4 + 2 + 4 * n);
  data.writeUInt32LE(data.length, 0);
  data.writeUInt16LE(n, 4);
  for (let i = 0; i < n && i * 3 + 2 < rgb.length; i++) {
    const at = 6 + i * 4;
    data[at] = rgb[i * 3];
    data[at + 1] = rgb[i * 3 + 1];
    data[at + 2] = rgb[i * 3 + 2];
  }
  return buildPacket(device, PACKET.RGBCONTROLLER_UPDATELEDS, data);
}

/** UPDATEMODE for `device`: the mode's index and its description as the server sent it. */
function buildUpdateMode(device: number, mode: OpenRgbMode): Buffer {
  const data = Buffer.alloc(4 + 4 + mode.raw.length);
  data.writeUInt32LE(data.length, 0);
  data.writeInt32LE(mode.index, 4);
  mode.raw.copy(data, 8);
  return buildPacket(device, PACKET.RGBCONTROLLER_UPDATEMODE, data);
}

/** What a UPDATELEDS packet's data says, for tests and a fake server. */
function parseUpdateLeds(data: Buffer): { count: number; rgb: Uint8Array } {
  const count = data.length >= 6 ? data.readUInt16LE(4) : 0;
  const rgb = new Uint8Array(count * 3);
  for (let i = 0; i < count && 6 + i * 4 + 2 < data.length; i++) {
    rgb[i * 3] = data[6 + i * 4];
    rgb[i * 3 + 1] = data[6 + i * 4 + 1];
    rgb[i * 3 + 2] = data[6 + i * 4 + 2];
  }
  return { count, rgb };
}

/** Reads a controller's description field by field; throws past its end. */
class Reader {
  buf: Buffer;
  at: number;

  constructor(buf: Buffer) {
    this.buf = buf;
    this.at = 0;
  }

  need(n: number): number {
    if (this.at + n > this.buf.length) throw new Error('controller data ends early');
    const was = this.at;
    this.at += n;
    return was;
  }

  u16(): number { return this.buf.readUInt16LE(this.need(2)); }
  u32(): number { return this.buf.readUInt32LE(this.need(4)); }
  i32(): number { return this.buf.readInt32LE(this.need(4)); }
  skip(n: number): void { this.need(n); }

  /** A string: its length (the NUL included), then the characters. */
  string(): string {
    const length = this.u16();
    const start = this.need(length);
    return this.buf.toString('utf8', start, start + length).replace(/\0+$/, '');
  }
}

/** One of a device's modes: its index, its name, whether it takes a colour a LED, and its bytes to send back. */
export interface OpenRgbMode {
  index: number;
  name: string;
  perLed: boolean;
  raw: Buffer;
}

/** What a device is, as REQUEST_CONTROLLER_DATA answers. */
export interface ControllerData {
  name: string;
  type: string;
  leds: number;
  modes: OpenRgbMode[];
  activeMode: number;
  /** The colour each LED shows now, three bytes a LED. */
  colors: Uint8Array;
}

/**
 * A device's description, read to the fields this needs: its name and type,
 * its modes (each kept as sent, to switch back to), how many LEDs it has and
 * what they show. Protocol 3 added brightness to a mode, 4 segments to a
 * zone; a mode's name and type and the LED list are the same in every one.
 */
function parseControllerData(buf: Buffer, version: number): ControllerData {
  const r = new Reader(buf);
  r.u32();                                   // the data's own length
  const type = r.i32();
  const name = r.string();
  if (version >= 1) r.string();              // vendor
  for (let k = 0; k < 4; k++) r.string();    // description, firmware, serial, location
  const modeCount = r.u16();
  const activeMode = r.i32();
  const modes: OpenRgbMode[] = [];
  for (let m = 0; m < modeCount; m++) {
    const start = r.at;
    const modeName = r.string();
    r.i32();                                 // value
    const flags = r.u32();
    r.skip(8);                               // speed min, max
    if (version >= 3) r.skip(8);             // brightness min, max
    r.skip(8);                               // colours min, max
    r.u32();                                 // speed
    if (version >= 3) r.u32();               // brightness
    r.u32();                                 // direction
    const colorMode = r.u32();
    r.skip(r.u16() * 4);                     // the mode's own colours
    modes.push({
      index: m, name: modeName, perLed: colorMode === MODE_COLORS_PER_LED || (flags & MODE_FLAG_PER_LED_COLOR) !== 0,
      raw: Buffer.from(buf.subarray(start, r.at)),
    });
  }
  const zoneCount = r.u16();
  for (let z = 0; z < zoneCount; z++) {
    r.string();
    r.i32();                                 // type
    r.skip(12);                              // LEDs min, max, count
    r.skip(r.u16());                         // the matrix map, by its byte length
    if (version >= 4) {
      const segments = r.u16();
      for (let s = 0; s < segments; s++) { r.string(); r.skip(12); }
    }
  }
  const ledCount = r.u16();
  for (let l = 0; l < ledCount; l++) { r.string(); r.u32(); }
  const colorCount = r.u16();
  const colors = new Uint8Array(ledCount * 3);
  for (let c = 0; c < colorCount; c++) {
    const at = r.need(4);
    if (c < ledCount) {
      colors[c * 3] = buf[at];
      colors[c * 3 + 1] = buf[at + 1];
      colors[c * 3 + 2] = buf[at + 2];
    }
  }
  return { name: name.trim() || `Device ${type}`, type: DEVICE_TYPES[type] ?? 'Unknown', leds: ledCount, modes, activeMode, colors };
}

/** The mode a device is painted LED by LED in: one called Direct, else any that takes a colour a LED. */
function directMode(data: ControllerData): OpenRgbMode | null {
  return data.modes.find((m) => m.name.toLowerCase() === 'direct') ?? data.modes.find((m) => m.perLed) ?? null;
}

// ── The connection ──────────────────────────────────────────────────────────

/** A device as the patch refers to it: the server's number for it when it was added, and its name then, when kept. */
export interface OpenRgbDeviceRef {
  device: number;
  name?: string;
}

interface Pending {
  device: number;
  id: number;
  resolve: (data: Buffer) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const timedOut = (what: string, ms: number) => Object.assign(new Error(`${what} did not answer within ${ms / 1000} s`), { code: 'ETIMEDOUT' });

const LOG_INTERVAL_MS = 5000;
let lastLoggedAt = 0;
let suppressed = 0;

/** A failure, no more than once in a while: a PC that is off is not worth a log a frame. */
function logFailure(message: string): void {
  const now = Date.now();
  if (now - lastLoggedAt < LOG_INTERVAL_MS) {
    suppressed++;
    return;
  }
  const extra = suppressed ? ` (${suppressed} more since last message)` : '';
  suppressed = 0;
  lastLoggedAt = now;
  console.warn(`[openrgb] ${message}${extra}`);
}

/**
 * One TCP connection to an SDK server, kept open as long as frames go to it.
 *
 * Frames never wait on it: `send` writes when the connection is up and the
 * device known, and otherwise says no and sees to it in the background —
 * dialling (again, after a back-off that doubles to thirty seconds), the
 * handshake, the device's description and its Direct mode. A socket that
 * falls behind drops frames rather than queueing them.
 */
export class OpenRgbConnection {
  host: string;
  port: number;
  reconnect: boolean;
  socket: net.Socket | null = null;
  ready = false;
  ended = false;
  dropped = 0;
  version = PROTOCOL_VERSION;
  buffer: Buffer = Buffer.alloc(0);
  pending: Pending[] = [];
  opening: Promise<void> | null = null;
  settleOpen: { resolve: () => void; reject: (err: Error) => void } | null = null;
  count: number | null = null;
  /** Every device read so far, by the server's number. */
  described = new Map<number, ControllerData>();
  /** The devices in their Direct mode, ready for frames, by the server's number. */
  devices = new Map<number, ControllerData>();
  /** The server's number today for each device the patch refers to, by the patch's number. */
  live = new Map<number, number>();
  preparing = new Map<number, Promise<ControllerData>>();
  /** The mode a device was in before it was put in Direct, to go back to. */
  wasIn = new Map<number, OpenRgbMode>();
  wanted = new Map<number, OpenRgbDeviceRef>();
  backoff = 0;
  retry: ReturnType<typeof setTimeout> | null = null;

  constructor({ host, port = OPENRGB_PORT, reconnect = true }: { host: string; port?: number; reconnect?: boolean }) {
    this.host = host;
    this.port = port;
    this.reconnect = reconnect;
  }

  where(): string { return `OpenRGB at ${this.host}:${this.port}`; }

  /** Connect and shake hands; resolves once requests and frames may go. */
  open(): Promise<void> {
    if (this.ready && this.socket) return Promise.resolve();
    if (this.ended) return Promise.reject(new Error(`${this.where()}: connection ended`));
    if (!this.opening) {
      this.opening = new Promise<void>((resolve, reject) => {
        this.settleOpen = { resolve, reject };
        this.dial();
      });
    }
    return this.opening;
  }

  dial(): void {
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.unref();
    socket.setNoDelay(true);
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => { if (!this.ready) socket.destroy(timedOut(this.where(), CONNECT_TIMEOUT_MS)); });
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err) => this.lost(err));
    socket.on('close', () => this.lost(new Error(`${this.where()} closed the connection`)));
    socket.once('connect', () => {
      socket.setTimeout(0);
      this.handshake().then(() => this.became(), (err) => socket.destroy(err instanceof Error ? err : new Error(messageOf(err))));
    });
  }

  /** Ask the server's protocol version (an old one never answers: 0), and give it our name. */
  async handshake(): Promise<void> {
    const mine = Buffer.alloc(4);
    mine.writeUInt32LE(PROTOCOL_VERSION, 0);
    try {
      const reply = await this.request(0, PACKET.REQUEST_PROTOCOL_VERSION, mine, VERSION_TIMEOUT_MS);
      this.version = Math.min(PROTOCOL_VERSION, reply.length >= 4 ? reply.readUInt32LE(0) : 0);
    } catch (err) {
      if (codeOf(err) !== 'ETIMEDOUT') throw err;
      this.version = 0;
    }
    this.write(buildPacket(0, PACKET.SET_CLIENT_NAME, Buffer.from(`${CLIENT_NAME}\0`, 'utf8')));
  }

  became(): void {
    this.ready = true;
    this.backoff = 0;
    const settle = this.settleOpen;
    this.settleOpen = null;
    this.opening = null;
    settle?.resolve();
    for (const ref of this.wanted.values()) this.prepare(ref).catch(() => { /* logged by prepare */ });
  }

  /** The connection is gone: fail what waited on it and, unless ended, allow a retry after the back-off. */
  lost(err: unknown): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    this.ready = false;
    this.count = null;
    this.described.clear();
    this.devices.clear();
    this.live.clear();
    this.preparing.clear();
    this.wasIn.clear();
    this.buffer = Buffer.alloc(0);
    socket.destroy();
    const error = err instanceof Error ? err : new Error(messageOf(err));
    for (const p of this.pending.splice(0)) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    const settle = this.settleOpen;
    this.settleOpen = null;
    this.opening = null;
    settle?.reject(error);
    // A one-shot connection (discover, identify) reports to whoever asked.
    if (this.ended || !this.reconnect) return;
    logFailure(`${this.where()}: ${error.message}`);
    this.backoff = this.backoff ? Math.min(this.backoff * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS;
    const timer = setTimeout(() => { this.retry = null; }, this.backoff);
    timer.unref();
    this.retry = timer;
  }

  /** Close for good: what is written goes out first, and nothing dials again. */
  end(): void {
    this.ended = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const socket = this.socket;
    if (!socket) return;
    socket.end();
    const timer = setTimeout(() => socket.destroy(), 2000);
    timer.unref();
  }

  write(packet: Buffer): boolean {
    if (!this.socket) return false;
    this.socket.write(packet);
    return true;
  }

  /** Send a request and wait for its answer: the next packet with the same device and id. */
  request(device: number, id: number, data: Uint8Array = new Uint8Array(0), timeoutMs = REQUEST_TIMEOUT_MS): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      if (!this.socket) return reject(new Error(`${this.where()}: not connected`));
      const entry: Pending = {
        device, id, resolve, reject,
        timer: setTimeout(() => {
          const at = this.pending.indexOf(entry);
          if (at >= 0) this.pending.splice(at, 1);
          reject(timedOut(this.where(), timeoutMs));
        }, timeoutMs),
      };
      entry.timer.unref();
      this.pending.push(entry);
      this.write(buildPacket(device, id, data));
    });
  }

  onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.buffer.length < HEADER) return;
      const header = parseHeader(this.buffer);
      if (!header || header.length > MAX_PACKET_BYTES) {
        this.lost(new Error(`${this.where()} is not an OpenRGB SDK server`));
        return;
      }
      if (this.buffer.length < HEADER + header.length) return;
      const data = Buffer.from(this.buffer.subarray(HEADER, HEADER + header.length));
      this.buffer = this.buffer.subarray(HEADER + header.length);
      this.onPacket(header, data);
    }
  }

  onPacket(header: { device: number; id: number }, data: Buffer): void {
    if (header.id === PACKET.DEVICE_LIST_UPDATED) {
      // The PC's devices came or went: read them again, and find each of
      // ours again, before the next frame.
      this.count = null;
      this.described.clear();
      this.devices.clear();
      this.live.clear();
      this.wasIn.clear();
      for (const ref of this.wanted.values()) this.prepare(ref).catch(() => {});
      return;
    }
    const head = this.pending[0];
    if (!head || head.id !== header.id || head.device !== header.device) return;
    this.pending.shift();
    clearTimeout(head.timer);
    head.resolve(data);
  }

  /** How many devices the server has. */
  async controllerCount(): Promise<number> {
    if (this.count !== null) return this.count;
    const reply = await this.request(0, PACKET.REQUEST_CONTROLLER_COUNT);
    this.count = reply.length >= 4 ? reply.readUInt32LE(0) : 0;
    return this.count;
  }

  /** What device `index` is. */
  async controllerData(index: number): Promise<ControllerData> {
    const count = await this.controllerCount();
    if (index >= count) throw new HttpError(404, `${this.where()} has no device #${index}: it lists ${count}`);
    const version = Buffer.alloc(4);
    version.writeUInt32LE(this.version, 0);
    return parseControllerData(await this.request(index, PACKET.REQUEST_CONTROLLER_DATA, version), this.version);
  }

  /** What device `index` is, read once per connection and device list. */
  async describe(index: number): Promise<ControllerData> {
    const known = this.described.get(index);
    if (known) return known;
    const data = await this.controllerData(index);
    this.described.set(index, data);
    return data;
  }

  /**
   * Which of the server's devices `ref` is today. OpenRGB numbers its devices
   * in the order it finds them, so a stick pulled, a monitor off or a
   * wireless mouse asleep at boot shifts the others: a device patched under
   * its name is looked for by name, whatever its number today — the k-th of
   * that name on the server for the k-th of that name in the patch, so four
   * identical RAM sticks keep their order. One patched by number alone is
   * that number.
   */
  async resolve(ref: OpenRgbDeviceRef): Promise<number> {
    const known = this.live.get(ref.device);
    if (known !== undefined) return known;
    const count = Math.min(MAX_DEVICES, await this.controllerCount());
    let index = ref.device;
    if (ref.name) {
      const named: number[] = [];
      for (let i = 0; i < count; i++) if ((await this.describe(i)).name === ref.name) named.push(i);
      const siblings = [...this.wanted.values()].filter((w) => w.name === ref.name).map((w) => w.device).sort((a, b) => a - b);
      const found = named[Math.max(0, siblings.indexOf(ref.device))];
      if (found === undefined) throw new HttpError(404, `${this.where()} has no device named "${ref.name}" (it was #${ref.device})`);
      index = found;
    } else if (index >= count) {
      throw new HttpError(404, `${this.where()} has no device #${index}: it lists ${count}`);
    }
    this.live.set(ref.device, index);
    return index;
  }

  /**
   * Find device `ref` (resolve), read it, and put it in its Direct mode when
   * it is in another, as openrgb-python's set_mode does; kept until the
   * connection drops.
   */
  prepare(ref: OpenRgbDeviceRef): Promise<ControllerData> {
    const live = this.live.get(ref.device);
    const known = live === undefined ? undefined : this.devices.get(live);
    if (known) return Promise.resolve(known);
    const inflight = this.preparing.get(ref.device);
    if (inflight) return inflight;
    const run = (async () => {
      await this.open();
      const index = await this.resolve(ref);
      const ready = this.devices.get(index);
      if (ready) return ready;
      const data = await this.describe(index);
      const direct = directMode(data);
      if (direct && data.activeMode !== direct.index) {
        const before = data.modes[data.activeMode];
        if (before) this.wasIn.set(index, before);
        this.write(buildUpdateMode(index, direct));
        data.activeMode = direct.index;
      }
      this.devices.set(index, data);
      return data;
    })();
    this.preparing.set(ref.device, run);
    run.catch((err) => { if (this.reconnect) logFailure(`${this.where()}: ${messageOf(err)}`); })
      .finally(() => { if (this.preparing.get(ref.device) === run) this.preparing.delete(ref.device); });
    return run;
  }

  /**
   * One frame of device `ref`'s LEDs. False when nothing went: still
   * connecting (started here, when not already under way or waiting out a
   * back-off), the device not found or read yet, or the socket too far behind.
   */
  send(ref: OpenRgbDeviceRef, rgb: Uint8Array, leds: number): boolean {
    this.wanted.set(ref.device, ref);
    if (this.ended) return false;
    const socket = this.socket;
    if (!socket || !this.ready) {
      if (!socket && !this.retry) this.open().catch(() => {});
      return false;
    }
    const index = this.live.get(ref.device);
    const device = index === undefined ? undefined : this.devices.get(index);
    if (index === undefined || !device) {
      this.prepare(ref).catch(() => {});
      return false;
    }
    if (socket.writableLength > HIGH_WATER_BYTES) {
      this.dropped++;
      return false;
    }
    socket.write(buildUpdateLeds(index, rgb, Math.min(leds, device.leds)));
    return true;
  }

  /** Put device `ref` back as it was found: its colours, and the mode it was in. */
  restore(ref: OpenRgbDeviceRef): void {
    const index = this.live.get(ref.device);
    const device = index === undefined ? undefined : this.devices.get(index);
    if (index === undefined || !device || !this.socket || !this.ready) return;
    this.socket.write(buildUpdateLeds(index, device.colors, device.leds));
    const before = this.wasIn.get(index);
    if (before) this.socket.write(buildUpdateMode(index, before));
  }
}

// ── Sending frames ──────────────────────────────────────────────────────────
// One connection per server, opened by the first frame that goes to it: the
// engine renders in a worker, and the main thread has nothing to send.

/** Where one frame of a device's LEDs goes. */
export interface OpenRgbTarget extends OpenRgbDeviceRef {
  host: string;
  port: number;
  leds: number;
}

const connections = new Map<string, OpenRgbConnection>();
const keyOf = (host: string, port: number) => `${host.toLowerCase()}:${port}`;

/** Send one frame of a device's LEDs, three bytes each. False when nothing left (see OpenRgbConnection.send). */
function sendOpenRgb(target: OpenRgbTarget, rgb: Uint8Array): boolean {
  const key = keyOf(target.host, target.port);
  let connection = connections.get(key);
  if (!connection) {
    connection = new OpenRgbConnection({ host: target.host, port: target.port });
    connections.set(key, connection);
  }
  return connection.send(target, rgb, target.leds);
}

/** Close the connection to a server, once what was written has gone. */
function closeOpenRgb({ host, port }: { host: string; port: number }): void {
  const key = keyOf(host, port);
  const connection = connections.get(key);
  if (!connection) return;
  connections.delete(key);
  connection.end();
}

// ── Finding devices, and making one show itself ────────────────────────────

/** A device the server lists. */
export interface OpenRgbDevice {
  index: number;
  name: string;
  type: string;
  leds: number;
  /** Does it have a mode that takes a colour a LED, which the show needs. */
  direct: boolean;
}

export interface OpenRgbClient {
  /** The devices of the server at `host`. */
  discover(host: string, port?: number): Promise<OpenRgbDevice[]>;
}

/** An error from a connection, as a route answers it. */
function asHttpError(err: unknown, where: string): HttpError {
  if (err instanceof HttpError) return err;
  if (codeOf(err) === 'ETIMEDOUT') return new HttpError(504, messageOf(err));
  return new HttpError(502, `Cannot reach ${where} (${messageOf(err)}); is OpenRGB running with its SDK server on?`);
}

/** Connect to the server at `host`, list its devices, and hang up. */
async function discover(host: string, port = OPENRGB_PORT): Promise<OpenRgbDevice[]> {
  const connection = new OpenRgbConnection({ host, port, reconnect: false });
  try {
    await connection.open();
    const count = Math.min(MAX_DEVICES, await connection.controllerCount());
    const devices: OpenRgbDevice[] = [];
    for (let index = 0; index < count; index++) {
      const data = await connection.controllerData(index);
      devices.push({ index, name: data.name, type: data.type, leds: data.leds, direct: directMode(data) !== null });
    }
    return devices;
  } catch (err) {
    throw asHttpError(err, connection.where());
  } finally {
    connection.end();
  }
}

const openrgbClient: OpenRgbClient = { discover };

export {
  OPENRGB_PORT,
  buildPacket,
  parseHeader,
  buildUpdateLeds,
  buildUpdateMode,
  parseUpdateLeds,
  parseControllerData,
  directMode,
  sendOpenRgb,
  closeOpenRgb,
  discover as discoverOpenRgb,
  openrgbClient,
  asHttpError as openrgbHttpError,
  keyOf as openrgbConnectionKey,
};
