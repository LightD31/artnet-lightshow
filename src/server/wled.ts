import dgram from 'node:dgram';
import { MAX_CELLS_PER_FIXTURE } from '../shared/rig.ts';
import { HttpError, messageOf } from '../errors.ts';
import { profileSchema, validate } from './validation.ts';
import type { ProfileInput } from './validation.ts';
import type { ChannelMap, ProfileCell } from '../types/rig.ts';

/**
 * Finding a WLED and making it a fixture.
 *
 * A WLED announces itself over mDNS as `_wled._tcp`, and says what it is at
 * http://<it>/json/info: its name, how many LEDs, whether they have a white
 * channel, and — set up as a panel — its width and height. That is everything
 * a profile needs, so adding one is: ask it, build the profile, patch it on
 * universes of its own and send it DDP (ddp-routes.ts).
 */

/** A WLED that answered. */
export interface FoundWled {
  host: string;
  name: string;
}

/** What a WLED says it is. */
export interface WledInfo {
  name: string;
  version: string;
  leds: number;
  rgbw: boolean;
  matrix: { w: number; h: number } | null;
  mac: string | null;
}

export interface WledClient {
  discover(timeoutMs?: number): Promise<FoundWled[]>;
  info(host: string): Promise<WledInfo>;
}

// ── mDNS ────────────────────────────────────────────────────────────────────
// A PTR question for _wled._tcp.local, and what comes back: the service's
// instances (PTR), where each runs (SRV) and that host's address (A).

const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE = '_wled._tcp.local';
const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_SRV = 33;

/** A one-question DNS query for the WLED service's instances. */
function buildQuery(): Buffer {
  const labels = SERVICE.split('.');
  const name = Buffer.concat([...labels.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // one question
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(TYPE_PTR, 0);
  tail.writeUInt16BE(1, 2); // IN
  return Buffer.concat([header, name, tail]);
}

/** A name at `offset`, following compression pointers; and where the name ends. */
function readName(buf: Buffer, offset: number): { name: string; end: number } {
  const labels: string[] = [];
  let at = offset;
  let end = -1;
  for (let jumps = 0; jumps < 32; jumps++) {
    if (at >= buf.length) throw new Error('name runs off the packet');
    const len = buf[at];
    if (len === 0) {
      if (end < 0) end = at + 1;
      return { name: labels.join('.'), end };
    }
    if ((len & 0xc0) === 0xc0) {
      if (at + 1 >= buf.length) throw new Error('pointer runs off the packet');
      if (end < 0) end = at + 2;
      at = ((len & 0x3f) << 8) | buf[at + 1];
      continue;
    }
    if (at + 1 + len > buf.length) throw new Error('label runs off the packet');
    labels.push(buf.toString('utf8', at + 1, at + 1 + len));
    at += 1 + len;
  }
  throw new Error('too many name pointers');
}

/**
 * The WLEDs a response names: each instance of the service, at the address of
 * the host its SRV names, or failing that the address the response came from.
 */
function parseResponse(buf: Buffer, from: string): FoundWled[] {
  if (buf.length < 12) return [];
  const questions = buf.readUInt16BE(4);
  const records = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let at = 12;
  try {
    for (let q = 0; q < questions; q++) at = readName(buf, at).end + 4;
    const instances: string[] = [];
    const targets = new Map<string, string>();
    const addresses = new Map<string, string>();
    for (let r = 0; r < records && at < buf.length; r++) {
      const { name, end } = readName(buf, at);
      if (end + 10 > buf.length) break;
      const type = buf.readUInt16BE(end);
      const length = buf.readUInt16BE(end + 8);
      const data = end + 10;
      if (data + length > buf.length) break;
      const owner = name.toLowerCase();
      if (type === TYPE_PTR && owner === SERVICE) instances.push(readName(buf, data).name);
      else if (type === TYPE_SRV && length >= 7) targets.set(owner, readName(buf, data + 6).name.toLowerCase());
      else if (type === TYPE_A && length === 4) addresses.set(owner, [...buf.subarray(data, data + 4)].join('.'));
      at = data + length;
    }
    return instances.map((instance) => {
      const target = targets.get(instance.toLowerCase());
      return { name: instance.split('.')[0], host: (target && addresses.get(target)) || from };
    });
  } catch (_) {
    return [];
  }
}

/**
 * Ask the network for WLEDs and wait `timeoutMs` for answers. The question
 * goes out from a port of its own, which RFC 6762 answers directly; a socket
 * on 5353 also hears answers sent to the group, when this machine lets it
 * share that port.
 */
async function discover(timeoutMs = 2000): Promise<FoundWled[]> {
  const found = new Map<string, FoundWled>();
  const take = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    for (const wled of parseResponse(msg, rinfo.address)) if (!found.has(wled.host)) found.set(wled.host, wled);
  };
  const sockets: dgram.Socket[] = [];
  const open = (port: number, group: boolean) => new Promise<void>((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', () => resolve());
    socket.on('message', take);
    socket.bind(port, () => {
      if (group) {
        try { socket.addMembership(MDNS_GROUP); } catch (_) { /* no multicast here */ }
      }
      sockets.push(socket);
      resolve();
    });
  });
  await open(0, false);
  await open(MDNS_PORT, true);
  const asker = sockets[0];
  if (!asker) throw new HttpError(500, 'Cannot open a socket to look for WLEDs');
  asker.send(buildQuery(), MDNS_PORT, MDNS_GROUP);
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  for (const socket of sockets) {
    try { socket.close(); } catch (_) { /* already closed */ }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ── What a WLED is ──────────────────────────────────────────────────────────

const INFO_TIMEOUT_MS = 3000;
const INFO_MAX_BYTES = 256 * 1024;

/** GET http://<host>/json/info, bounded in time and size, and the fields a profile needs. */
async function info(host: string, { fetchImpl = fetch, port }: { fetchImpl?: typeof fetch; port?: number } = {}): Promise<WledInfo> {
  let raw: unknown;
  try {
    const res = await fetchImpl(`http://${host}${port ? `:${port}` : ''}/json/info`, {
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS), redirect: 'error', headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new HttpError(502, `${host} answered ${res.status}: is it a WLED?`);
    const declared = Number(res.headers.get('content-length'));
    if (declared > INFO_MAX_BYTES) throw new HttpError(502, `${host} sent too much to be a WLED's info`);
    const text = await res.text();
    if (text.length > INFO_MAX_BYTES) throw new HttpError(502, `${host} sent too much to be a WLED's info`);
    raw = JSON.parse(text);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new HttpError(504, `${host} did not answer within ${INFO_TIMEOUT_MS / 1000} s`);
    }
    if (err instanceof SyntaxError) throw new HttpError(502, `${host} is not a WLED: its /json/info is not JSON`);
    const cause = err instanceof Error && err.cause ? `: ${messageOf(err.cause)}` : '';
    throw new HttpError(502, `Cannot reach ${host} (${messageOf(err)}${cause})`);
  }
  return readInfo(raw, host);
}

/** The fields a profile needs, from a WLED's /json/info, checked. */
function readInfo(raw: unknown, host: string): WledInfo {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const leds = (body.leds && typeof body.leds === 'object' ? body.leds : null) as Record<string, unknown> | null;
  const count = leds && Number.isInteger(leds.count) ? leds.count as number : null;
  if (!leds || count === null) throw new HttpError(502, `${host} is not a WLED: its info says nothing about LEDs`);
  // `lc` is what the LEDs can do, bit 2 a white channel; older builds said `rgbw`.
  const rgbw = leds.rgbw === true || (Number.isInteger(leds.lc) && ((leds.lc as number) & 0x02) !== 0);
  const m = leds.matrix && typeof leds.matrix === 'object' ? leds.matrix as Record<string, unknown> : null;
  const matrix = m && Number.isInteger(m.w) && Number.isInteger(m.h) && (m.w as number) > 0 && (m.h as number) > 0
    ? { w: m.w as number, h: m.h as number } : null;
  return {
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 64) : host,
    version: typeof body.ver === 'string' ? body.ver.slice(0, 32) : '',
    leds: count,
    rgbw,
    matrix,
    mac: typeof body.mac === 'string' && /^[0-9a-f]{12}$/i.test(body.mac) ? body.mac.toLowerCase() : null,
  };
}

/**
 * The profile for a WLED: its LEDs as cells of red, green and blue (and white),
 * in a grid when it is set up as a panel. Throws a 400 for one the engine
 * cannot take.
 */
function wledProfile(wled: WledInfo, host: string): ProfileInput {
  if (wled.leds < 1) throw new HttpError(400, `${wled.name} reports no LEDs`);
  if (wled.leds > MAX_CELLS_PER_FIXTURE) {
    throw new HttpError(400, `${wled.name} has ${wled.leds} LEDs; a fixture takes up to ${MAX_CELLS_PER_FIXTURE}. Split it into segments of its own in WLED`);
  }
  const names = wled.rgbw ? ['red', 'green', 'blue', 'white'] : ['red', 'green', 'blue'];
  const width = names.length;
  const mapOf = (c: number): ChannelMap => Object.fromEntries(names.map((n, k) => [n, c * width + k]));
  const grid = wled.matrix && wled.matrix.w * wled.matrix.h === wled.leds ? { columns: wled.matrix.w, rows: wled.matrix.h } : null;
  const id = `wled-${wled.mac || host.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 128);
  const kind = wled.rgbw ? 'RGBW' : 'RGB';
  const profile = {
    id,
    name: `WLED ${wled.name}`.slice(0, 128),
    manufacturer: 'WLED',
    modeName: `${wled.leds} ${wled.leds === 1 ? 'pixel' : 'pixels'}, ${kind}${grid ? `, ${grid.columns} × ${grid.rows}` : ''}`,
    channelCount: wled.leds * width,
    // One LED is one light; more are its cells, one after another.
    channelMap: wled.leds === 1 ? mapOf(0) : {},
    channelList: Array.from({ length: wled.leds * width }, (_, o) => ({
      offset: o,
      name: `${wled.leds === 1 ? '' : `Pixel ${Math.floor(o / width) + 1} `}${names[o % width][0].toUpperCase()}${names[o % width].slice(1)}`,
      attribute: names[o % width],
      ...(wled.leds > 1 ? { cell: Math.floor(o / width) } : {}),
    })),
    ...(wled.leds > 1 ? { cells: Array.from({ length: wled.leds }, (_, c): ProfileCell => ({ name: `Pixel ${c + 1}`, channelMap: mapOf(c) })) } : {}),
    ...(grid ? { grid } : {}),
  };
  return validate(profileSchema, profile, 'WLED profile');
}

const wledClient: WledClient = { discover, info: (host) => info(host) };

export {
  buildQuery,
  parseResponse,
  discover,
  info as wledInfo,
  readInfo,
  wledProfile,
  wledClient,
  MDNS_PORT,
};
