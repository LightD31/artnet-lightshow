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

/**
 * One of a WLED's segments: its LEDs from `at`, `count` of them, and — on a
 * panel — the rectangle they make, whose rows lie `rowStride` LEDs apart.
 */
export interface WledSegment {
  id: number;
  name: string;
  at: number;
  count: number;
  grid: { columns: number; rows: number } | null;
  rowStride: number | null;
}

export interface WledClient {
  discover(timeoutMs?: number): Promise<FoundWled[]>;
  info(host: string): Promise<WledInfo>;
  /** Its segments, as its /json/state lists them. */
  segments?(host: string, info: WledInfo): Promise<WledSegment[]>;
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
  return readInfo(await getJson(host, '/json/info', { fetchImpl, port }), host);
}

/** GET http://<host>/json/state, bounded the same way: the segments it lists. */
async function segments(host: string, wled: WledInfo,
  { fetchImpl = fetch, port }: { fetchImpl?: typeof fetch; port?: number } = {}): Promise<WledSegment[]> {
  return readSegments(await getJson(host, '/json/state', { fetchImpl, port }), wled, host);
}

/** One of a WLED's JSON documents, bounded in time and size. */
async function getJson(host: string, path: string, { fetchImpl = fetch, port }: { fetchImpl?: typeof fetch; port?: number }): Promise<unknown> {
  let raw: unknown;
  try {
    const res = await fetchImpl(`http://${host}${port ? `:${port}` : ''}${path}`, {
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS), redirect: 'error', headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new HttpError(502, `${host} answered ${res.status}: is it a WLED?`);
    raw = JSON.parse(await readCapped(res, host));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new HttpError(504, `${host} did not answer within ${INFO_TIMEOUT_MS / 1000} s`);
    }
    if (err instanceof SyntaxError) throw new HttpError(502, `${host} is not a WLED: its ${path} is not JSON`);
    const cause = err instanceof Error && err.cause ? `: ${messageOf(err.cause)}` : '';
    throw new HttpError(502, `Cannot reach ${host} (${messageOf(err)}${cause})`);
  }
  return raw;
}

/** A response body as text, refused past INFO_MAX_BYTES however it is sent. */
async function readCapped(res: Response, host: string): Promise<string> {
  const tooMuch = () => new HttpError(502, `${host} sent too much to be a WLED's info`);
  if (Number(res.headers.get('content-length')) > INFO_MAX_BYTES) throw tooMuch();
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > INFO_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw tooMuch();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
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
 * A WLED's segments, from its /json/state: each one's first LED and length, or
 * on a panel the rectangle it covers. Segments that cover nothing, or reach
 * past the WLED's LEDs, are left out.
 *
 * Over DDP a WLED is sent its LEDs in their logical order (a panel's row by
 * row, its own wiring worked out by WLED), not through its segments — so a
 * segment is simply the stretch of that order it covers, or on a panel one
 * stretch for each of its rows.
 */
function readSegments(raw: unknown, wled: WledInfo, host: string): WledSegment[] {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (!Array.isArray(body.seg)) throw new HttpError(502, `${host} is not a WLED: its state lists no segments`);
  const width = wled.matrix ? wled.matrix.w : 0;
  const out: WledSegment[] = [];
  body.seg.forEach((entry: unknown, index: number) => {
    const seg = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const int = (v: unknown) => (Number.isInteger(v) ? v as number : null);
    const start = int(seg.start);
    const stop = int(seg.stop);
    if (start === null || stop === null || stop <= start) return;
    const id = int(seg.id) ?? index;
    const named = typeof seg.n === 'string' && seg.n.trim() ? seg.n.trim().slice(0, 48) : `Segment ${id + 1}`;
    const startY = int(seg.startY);
    const stopY = int(seg.stopY);
    if (width && startY !== null && stopY !== null && stopY > startY) {
      const columns = stop - start;
      const rows = stopY - startY;
      const at = startY * width + start;
      if (stop > width || at + (rows - 1) * width + columns > wled.leds) return;
      out.push({ id, name: named, at, count: columns * rows, grid: { columns, rows }, rowStride: columns < width ? width : null });
    } else {
      if (stop > wled.leds) return;
      out.push({ id, name: named, at: start, count: stop - start, grid: null, rowStride: null });
    }
  });
  return out;
}

/**
 * What a WLED is patched as, as a DMX bar has a 3-channel mode and a pixel one:
 *
 *   wash    one light, every LED the same colour — a par, to the show: it
 *           takes the rig's wash, its chases step by it, and it strobes and
 *           blinds with the pars
 *   zones   a few cells along it, each an equal share of its LEDs (on a panel,
 *           a band of its columns) — an LED bar, to the show
 *   pixels  every LED a cell of its own, and a panel a picture
 *   strobe  a panel as a strobe panel is built (an ADJ Jolt Panel): a line
 *           of white segments across its middle, which light only for white
 *           — a strobe, a blinder, the strobe core's strike — and rows of
 *           square colour zones above and below it; `zones` is how many
 *           across. A fixture laid out in rows, to the show, that plays the
 *           bars' programs rather than a panel's pictures
 */
export type WledMode = 'wash' | 'zones' | 'pixels' | 'strobe';

export const WLED_MODES: readonly WledMode[] = ['wash', 'zones', 'pixels', 'strobe'];
export const DEFAULT_WLED_MODE: WledMode = 'zones';
export const DEFAULT_WLED_ZONES = 8;

/** How a WLED is patched: its mode, and in zones how many. */
export interface WledLook {
  mode?: WledMode;
  zones?: number;
}

/** The LEDs a whole WLED, or one segment of it, lights; and a panel's grid. */
function areaOf(wled: WledInfo, segment: WledSegment | null): { leds: number; grid: { columns: number; rows: number } | null } {
  if (segment) return { leds: segment.count, grid: segment.grid };
  const grid = wled.matrix && wled.matrix.w * wled.matrix.h === wled.leds ? { columns: wled.matrix.w, rows: wled.matrix.h } : null;
  return { leds: wled.leds, grid };
}

/** One zone of a strobe panel: where it sits in the fixture's grid, the LEDs it covers, and whether it is white. */
export interface StrobeZone {
  at: { x: number; y: number };
  /** Its rectangle of LEDs: column, row, width, height. */
  area: [number, number, number, number];
  white: boolean;
}

/**
 * The zones of a strobe panel `columns` × `rows` LEDs, `across` of them
 * across: a line of white segments through the middle, an eighth of the
 * panel high, and above and below it rows of colour zones as near square as
 * the panel allows. Top to bottom, left to right; the grid is `across` wide
 * and a row for the white line between the colour rows. Null when the panel
 * is too small to hold them.
 */
function strobePanel(columns: number, rows: number, across: number): { grid: { columns: number; rows: number }; zones: StrobeZone[] } | null {
  let band = Math.max(1, Math.round(rows / 8));
  if ((rows - band) % 2) band += 1;
  const half = (rows - band) / 2;
  const count = Math.min(across, columns);
  if (half < 1 || count < 2) return null;
  const edge = (k: number, of: number, span: number) => Math.round((k * span) / of);
  const tall = Math.max(1, Math.min(half, Math.round(half / (columns / count))));
  const zones: StrobeZone[] = [];
  const row = (y: number, top: number, height: number, white: boolean) => {
    for (let k = 0; k < count; k++) {
      const x = edge(k, count, columns);
      zones.push({ at: { x: k, y }, area: [x, top, edge(k + 1, count, columns) - x, height], white });
    }
  };
  for (let j = 0; j < tall; j++) row(j, edge(j, tall, half), edge(j + 1, tall, half) - edge(j, tall, half), false);
  row(tall, half, band, true);
  for (let j = 0; j < tall; j++) row(tall + 1 + j, half + band + edge(j, tall, half), edge(j + 1, tall, half) - edge(j, tall, half), false);
  return { grid: { columns: count, rows: 2 * tall + 1 }, zones };
}

/**
 * How many cells a WLED patched this way is: its LEDs, a panel's columns in
 * zones or its LEDs if fewer, or one. Fewer than two zones is a wash.
 */
function cellCount(leds: number, grid: { columns: number; rows: number } | null, { mode = 'pixels', zones = DEFAULT_WLED_ZONES }: WledLook): number {
  if (mode === 'pixels') return leds;
  if (mode === 'strobe') return grid ? strobePanel(grid.columns, grid.rows, zones)?.zones.length ?? 0 : 0;
  if (mode === 'wash') return 1;
  const n = Math.min(zones, grid ? grid.columns : leds);
  return n >= 2 ? n : 1;
}

/**
 * The profile for a WLED: its LEDs as cells of red, green and blue (and white),
 * in a grid when it is set up as a panel — or, with `segment`, the profile for
 * that one segment of it — or, as a wash or in zones, one light or a few
 * spread over them (wledSpan says over how many). Throws a 400 for one the
 * engine cannot take.
 */
function wledProfile(wled: WledInfo, host: string, segment: WledSegment | null = null, look: WledLook = {}): ProfileInput {
  const { leds, grid: area } = areaOf(wled, segment);
  const mode = look.mode || 'pixels';
  if (leds < 1) throw new HttpError(400, `${wled.name} reports no LEDs`);
  if (mode === 'pixels' && leds > MAX_CELLS_PER_FIXTURE) {
    throw new HttpError(400, `${wled.name}${segment ? ` · ${segment.name}` : ''} has ${leds} LEDs; a fixture takes up to `
      + `${MAX_CELLS_PER_FIXTURE}. Split it into segments of its own in WLED, or add it as a wash or in zones`);
  }
  if (mode === 'strobe') return strobeProfile(wled, host, segment, area, look.zones ?? DEFAULT_WLED_ZONES);
  const cells = cellCount(leds, area, look);
  const names = wled.rgbw ? ['red', 'green', 'blue', 'white'] : ['red', 'green', 'blue'];
  const width = names.length;
  const mapOf = (c: number): ChannelMap => Object.fromEntries(names.map((n, k) => [n, c * width + k]));
  const grid = mode === 'pixels' ? area : null;
  // The pixels keep the id they always had, so a show saved before modes
  // still finds its WLED's profile.
  const suffix = mode === 'pixels' ? '' : cells === 1 ? '-wash' : `-zones${cells}`;
  const id = `wled-${wled.mac || host.toLowerCase().replace(/[^a-z0-9]+/g, '-')}${segment ? `-seg${segment.id}` : ''}${suffix}`.slice(0, 128);
  const kind = wled.rgbw ? 'RGBW' : 'RGB';
  const shape = mode === 'pixels'
    ? `${leds} ${leds === 1 ? 'pixel' : 'pixels'}, ${kind}${grid ? `, ${grid.columns} × ${grid.rows}` : ''}`
    : `${cells === 1 ? 'Wash' : `${cells} zones`}, ${kind}, ${leds} ${leds === 1 ? 'LED' : 'LEDs'}${area ? `, ${area.columns} × ${area.rows}` : ''}`;
  const profile = {
    id,
    name: (segment ? `${wled.name} · ${segment.name}` : wled.name).slice(0, 128),
    manufacturer: 'WLED',
    modeName: `${shape}${segment ? `, from LED ${segment.at + 1}` : ''}`,
    channelCount: cells * width,
    // One cell is one light; more are its cells, one after another. No channel
    // list and no cell names: a 64 × 32 panel's were half a megabyte of
    // "Pixel 1234 Green" in the show file and in every copy of the rig sent
    // to a page, and the cells already say which channel is which colour.
    channelMap: cells === 1 ? mapOf(0) : {},
    ...(cells > 1 ? { cells: Array.from({ length: cells }, (_, c): ProfileCell => ({ channelMap: mapOf(c) })) } : {}),
    ...(grid ? { grid } : {}),
  };
  return validate(profileSchema, profile, 'WLED profile');
}

/**
 * A WLED panel as a strobe panel (see WledMode): its zones in a grid, each
 * colour zone red, green and blue and each white one only white — on an RGB
 * WLED a byte the DDP sends to all three of its LEDs' dies (ddp-routes.ts).
 * `zoned`: a fixture in rows, not a screen, so the show gives it the bars'
 * programs (shared/rig.ts).
 */
function strobeProfile(wled: WledInfo, host: string, segment: WledSegment | null, area: { columns: number; rows: number } | null,
  across: number): ProfileInput {
  const label = `${wled.name}${segment ? ` · ${segment.name}` : ''}`;
  if (!area) throw new HttpError(400, `${label} is not set up as a matrix in WLED: a strobe panel needs its rows and columns`);
  const panel = strobePanel(area.columns, area.rows, across);
  if (!panel) throw new HttpError(400, `${label} is ${area.columns} × ${area.rows}: too small for a strobe panel`);
  const width = wled.rgbw ? 4 : 3;
  const cells = panel.zones.map((zone, c): ProfileCell => ({
    // A white zone is one byte of its cell — the white die's on an RGBW WLED.
    channelMap: zone.white ? { white: c * width + (wled.rgbw ? 3 : 0) } : { red: c * width, green: c * width + 1, blue: c * width + 2 },
    at: zone.at,
  }));
  const whites = panel.zones.filter((z) => z.white).length;
  const profile = {
    id: `wled-${wled.mac || host.toLowerCase().replace(/[^a-z0-9]+/g, '-')}${segment ? `-seg${segment.id}` : ''}-strobe${panel.grid.columns}`.slice(0, 128),
    name: label.slice(0, 128),
    manufacturer: 'WLED',
    modeName: `Strobe panel: ${whites} white and ${panel.zones.length - whites} colour zones, ${wled.rgbw ? 'RGBW' : 'RGB'}, `
      + `${area.columns} × ${area.rows}${segment ? `, from LED ${segment.at + 1}` : ''}`,
    channelCount: cells.length * width,
    channelMap: {},
    cells,
    grid: panel.grid,
    zoned: true,
  };
  return validate(profileSchema, profile, 'WLED profile');
}

/**
 * What a fixture's DDP output adds to say its cells are spread over the LEDs
 * (types/rig.ts DdpOutput): nothing in pixels, where each cell is one; for a
 * strobe panel, the rectangle each zone covers.
 */
function wledSpan(wled: WledInfo, segment: WledSegment | null = null, look: WledLook = {}):
  { leds?: number; columns?: number; areas?: [number, number, number, number][] } {
  const { leds, grid } = areaOf(wled, segment);
  if (look.mode === 'strobe' && grid) {
    const panel = strobePanel(grid.columns, grid.rows, look.zones ?? DEFAULT_WLED_ZONES);
    if (panel) return { leds, columns: grid.columns, areas: panel.zones.map((z) => z.area) };
  }
  if (cellCount(leds, grid, look) === leds) return {};
  return { leds, ...(grid ? { columns: grid.columns } : {}) };
}

/**
 * The profile id a WLED's is, whatever mode it is patched in: two fixtures
 * with the same one light the same LEDs.
 */
function wledSeat(profileId: string): string {
  return profileId.replace(/-(?:wash|zones\d+|strobe\d+)$/, '');
}

const wledClient: WledClient = { discover, info: (host) => info(host), segments: (host, wled) => segments(host, wled) };

export {
  buildQuery,
  parseResponse,
  discover,
  info as wledInfo,
  segments as wledSegments,
  readInfo,
  readSegments,
  wledProfile,
  wledSpan,
  wledSeat,
  strobePanel,
  wledClient,
  MDNS_PORT,
};
