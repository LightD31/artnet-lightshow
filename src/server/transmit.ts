import { sendArtDmx, sendArtSync } from './artnet.ts';
import { sendSacn, sendSacnDiscovery, MIN_UNIVERSE, MAX_UNIVERSE, DISCOVERY_INTERVAL_MS } from './sacn.ts';
import { sendDdp } from './ddp.ts';
import type { DdpRun } from './ddp.ts';
import { isInternalUniverse } from '../shared/placement.ts';
import { spreadPixels } from './ddp-routes.ts';
import type { DdpRoute } from './ddp-routes.ts';
import type { OpenRgbTarget } from './openrgb.ts';
import { openrgbKey, openrgbHostKey, openrgbPixels } from './openrgb-routes.ts';
import type { OpenRgbRoute } from './openrgb-routes.ts';
import type { ArtDmxTarget } from './artnet.ts';
import type { ArtRoutes } from './artnet-nodes.ts';
import type { SacnTarget } from './sacn.ts';
import type { Settings } from './settings.ts';

/** Where Art-Net goes, and which nodes claimed which universes. */
export interface ArtnetOutput {
  enabled: boolean;
  host: string;
  port: number;
  sync: boolean;
  routes?: ArtRoutes | null;
}

export type SacnOutput = Settings['sacn'];

/** Every wire a frame goes out on, and how long the fast ones wait for Hue. */
export interface TransmitConfig {
  artnet: ArtnetOutput;
  sacn: SacnOutput;
  delayMs: number;
  /** The WLEDs, and the universes that are theirs (ddp-routes.ts). */
  ddp?: DdpRoute[];
  /** The OpenRGB devices, and the universes that are theirs (openrgb-routes.ts). */
  openrgb?: OpenRgbRoute[];
  /**
   * Whether anything may leave the machine (armed.ts). Left out means it
   * may; false drops every frame, after the streams have been ended.
   */
  armed?: boolean;
}

/**
 * One frame of a WLED's pixels, as the wire takes it: from its first LED, or
 * each of `runs` (in bytes) where it goes when the WLED is patched segment by
 * segment.
 */
export interface DdpTarget {
  host: string;
  port: number;
  sequence: number;
  rgbw: boolean;
  runs?: DdpRun[];
}

/** The packets themselves; swapped for fakes in tests. */
export interface Wires {
  artnet(target: ArtDmxTarget, frame: Buffer): boolean;
  artnetSync(target: { host: string; port: number }): unknown;
  sacn(target: SacnTarget, frame: Buffer): boolean;
  sacnDiscovery(packet: { cid: string; sourceName: string; universes: number[]; iface: string }): unknown;
  ddp(target: DdpTarget, data: Uint8Array): boolean;
  /** One frame of an OpenRGB device's LEDs, three bytes each. */
  openrgb(target: OpenRgbTarget, rgb: Uint8Array): boolean;
  /** Hang up on an OpenRGB server, once what was written has gone. */
  openrgbClose(target: { host: string; port: number }): unknown;
}

export interface SendOptions {
  immediate?: boolean;
  terminate?: boolean;
}

export type Wire = 'artnet' | 'sacn' | 'ddp' | 'openrgb';

export interface Transmitter {
  send(universe: number, frame: Buffer, config: TransmitConfig, options?: SendOptions): Wire[];
  endFrame(config: TransmitConfig | null | undefined): void;
}

// A universe counts as one this source is sending for this long after its
// last packet: long enough to span a Hue delay, short enough that one the rig
// has moved off drops out of the next discovery list.
const SACN_ACTIVE_MS = 3000;

const ZERO_FRAME = Buffer.alloc(512);

/**
 * Putting a rendered universe on the wire: Art-Net, sACN, and the delay line
 * that holds both back for the Hue lamps.
 *
 * It lives wherever frames are rendered — the engine's worker thread, or the
 * main thread when the engine runs there — and is told the output settings
 * with every frame rather than reading them from the live state, which only
 * the main thread has. output.js on the main thread builds that config
 * (`transmitConfig`) and keeps everything to do with Hue itself.
 */

/**
 * The sACN universe a rig universe maps to.
 *
 * Art-Net counts universes from 0 and sACN from 1, so the default offset of 1
 * lines them up the way every other tool does. Returns null when the result
 * falls outside what E1.31 allows, which the caller reports rather than
 * silently sending nowhere.
 */
function sacnUniverseFor(universe: number, offset: number): number | null {
  const mapped = universe + offset;
  if (!Number.isInteger(mapped) || mapped < MIN_UNIVERSE || mapped > MAX_UNIVERSE) return null;
  return mapped;
}

// The OpenRGB wire is loaded by the first frame that goes to a device, so a
// rig with no PC in it never loads it: the engine's worker starts with the
// same modules it always had. Frames are dropped until it is in, as they are
// while the connection opens.
let openrgbWire: Pick<Wires, 'openrgb' | 'openrgbClose'> | null = null;
let openrgbLoading: Promise<void> | null = null;
function loadOpenRgbWire(): void {
  if (openrgbLoading) return;
  openrgbLoading = import('./openrgb.ts').then((m) => { openrgbWire = { openrgb: m.sendOpenRgb, openrgbClose: m.closeOpenRgb }; }, (err) => {
    console.warn(`[openrgb] cannot load the wire: ${err instanceof Error ? err.message : String(err)}`);
    openrgbLoading = null;
  });
}

const DEFAULT_WIRES: Wires = {
  artnet: sendArtDmx, artnetSync: sendArtSync, sacn: sendSacn, sacnDiscovery: sendSacnDiscovery, ddp: sendDdp,
  openrgb: (target, rgb) => {
    if (openrgbWire) return openrgbWire.openrgb(target, rgb);
    loadOpenRgbWire();
    return false;
  },
  openrgbClose: (target) => openrgbWire?.openrgbClose(target),
};

/** The universes a config sends to WLEDs, worked out once per config. */
const ddpUniversesOf = new WeakMap<DdpRoute[], Set<number>>();
function ddpUniverses(routes: DdpRoute[] | undefined): Set<number> | null {
  if (!routes || !routes.length) return null;
  let set = ddpUniversesOf.get(routes);
  if (!set) {
    set = new Set(routes.flatMap((route) => route.parts.map((part) => part.universe)));
    ddpUniversesOf.set(routes, set);
  }
  return set;
}

/** The universes a config sends to OpenRGB devices, worked out once per config. */
const openrgbUniversesOf = new WeakMap<OpenRgbRoute[], Set<number>>();
function openrgbUniverses(routes: OpenRgbRoute[] | undefined): Set<number> | null {
  if (!routes || !routes.length) return null;
  let set = openrgbUniversesOf.get(routes);
  if (!set) {
    set = new Set(routes.flatMap((route) => route.parts.map((part) => part.universe)));
    openrgbUniversesOf.set(routes, set);
  }
  return set;
}

/** What makes one WLED another: where its frames go. */
const ddpKey = (route: Pick<DdpRoute, 'host' | 'port'>) => `${route.host}:${route.port}`;
/** And one fixture on it another: where its pixels start. */
const routeKey = (route: DdpRoute) => `${ddpKey(route)}@${route.runs[0]?.at ?? 0}`;

/** What makes one sACN stream another: a change here ends the old one. */
function sacnStreamKey(sacn: SacnOutput | null | undefined): string | null {
  if (!sacn || !sacn.enabled) return null;
  return [sacn.host, sacn.universeOffset, sacn.cid, sacn.sourceName, sacn.priority, sacn.interface].join('|');
}

/**
 * `wires` stands in for the sockets in tests: `{ artnet(target, frame),
 * artnetSync(target), sacn(target, frame), sacnDiscovery(source) }`, each
 * returning whether anything left.
 */
function createTransmitter({ wires = DEFAULT_WIRES, now = () => performance.now() }: {
  wires?: Wires;
  now?: () => number;
} = {}): Transmitter {
  // Where this frame's Art-Net went, for the ArtSync that closes it.
  const syncTargets = new Set<string>();
  // The sACN universes this source is sending (mapped universe → last sent),
  // the settings they were sent with, and when discovery last went out.
  const sacnSent = new Map<number, number>();
  let sacnStream: { key: string; config: SacnOutput } | null = null;
  let lastDiscovery = -Infinity;
  // This frame's universes for the WLEDs, gathered until the frame ends and
  // each WLED can be sent its pixels as one run; the WLEDs sent to last
  // frame, so one that leaves the patch is sent a dark frame to end on; and
  // each WLED's sequence number.
  const ddpFrames = new Map<number, Buffer>();
  let ddpSent = new Map<string, { route: DdpRoute; bytes: number }>();
  const ddpSequence = new Map<string, number>();
  // The same for the OpenRGB devices: this frame's universes, and the
  // devices sent to last frame, so one that leaves the patch is sent a dark
  // frame and a server with no device left on it is hung up on.
  const openrgbFrames = new Map<number, Buffer>();
  let openrgbSent = new Map<string, OpenRgbRoute>();
  // Whether frames are leaving the machine (armed.ts, through the config),
  // and where each universe's Art-Net last went, for the black frame that
  // ends it when they stop.
  let live = true;
  const artnetSent = new Map<number, { hosts: string[]; port: number }>();

  // ── Hue latency compensation ──────────────────────────────────────────────
  // Art-Net reaches a node in about a millisecond; a Hue lamp hears about a
  // frame through the bridge and a Zigbee hop, tens of milliseconds later. So
  // on a mixed rig every accent landed on the pars first and the lamps after
  // it, which on a snare hit is plainly two events. The fast wire is the one
  // that can wait: each universe's frames queue here and go out `delayMs`
  // after they were rendered, while Hue is sent the current frame.
  const delayLine = new Map<number, { at: number; frame: Buffer }[]>();

  /** The newest frame for this universe old enough to send, or null. */
  function delayedFrame(universe: number, frame: Buffer, delayMs: number): Buffer | null {
    const t = now();
    const queue = delayLine.get(universe) || [];
    queue.push({ at: t, frame: Buffer.from(frame) });
    let ready: Buffer | null = null;
    while (queue.length && queue[0].at <= t - delayMs) ready = (queue.shift() as { frame: Buffer }).frame;
    delayLine.set(universe, queue);
    return ready;
  }

  /**
   * Put one universe on every enabled wire.
   *
   * `config` is `{ artnet: { enabled, host, port, sync, routes }, sacn: {
   * enabled, host, priority, sourceName, universeOffset, cid }, delayMs }`.
   * `routes` (from artnet-nodes.js) names the nodes that output a universe;
   * a universe with none goes to `host`.
   *
   * Returns the protocols the frame was handed to. Art-Net counts only once
   * its host has resolved: until then the frame is dropped, and reporting it
   * as sent would say the rig is being driven when nothing has left the
   * machine.
   *
   * With a delay, the frame is queued and an older one goes out in its place.
   * `immediate` skips the queue — for the blackout sent at shutdown and when a
   * universe leaves the patch, which must not wait behind the look they are
   * replacing — and discards what was waiting. `terminate` says the universe
   * is not coming back: sACN follows the frame with its stream-terminated
   * packets.
   */
  function send(universe: number, frame: Buffer, config: TransmitConfig,
    { immediate = false, terminate = false }: SendOptions = {}): Wire[] {
    const sent: Wire[] = [];
    // Disarmed, nothing leaves — not even a blackout: there is nothing on the
    // wire to black out, the streams having been ended on the way here.
    if (!syncArmed(config)) return sent;
    // The server's own universes (fixtures with no DMX address, read back by
    // the Hue lamps) are rendered and never sent.
    if (isInternalUniverse(universe)) return sent;
    if (!immediate && config.delayMs > 0) {
      const ready = delayedFrame(universe, frame, config.delayMs);
      if (!ready) return sent;
      frame = ready;
    } else {
      delayLine.delete(universe);
    }

    // A WLED's universe is its alone: it waits for the frame's end, when the
    // WLED is sent every universe of its pixels as one run.
    const toWled = ddpUniverses(config.ddp);
    if (toWled && toWled.has(universe)) {
      ddpFrames.set(universe, frame);
      sent.push('ddp');
      return sent;
    }
    // And an OpenRGB device's: one UPDATELEDS packet a device at the frame's end.
    const toOpenRgb = openrgbUniverses(config.openrgb);
    if (toOpenRgb && toOpenRgb.has(universe)) {
      openrgbFrames.set(universe, frame);
      sent.push('openrgb');
      return sent;
    }

    const { artnet, sacn } = config;
    syncSacnStream(sacn);
    if (artnet && artnet.enabled !== false) {
      const claimed = artnet.routes && artnet.routes[universe];
      const hosts = claimed && claimed.length ? claimed : [artnet.host];
      if (wires.artnet({ hosts, port: artnet.port, universe }, frame)) {
        sent.push('artnet');
        if (artnet.sync) for (const host of hosts) syncTargets.add(host);
        if (terminate) artnetSent.delete(universe);
        else artnetSent.set(universe, { hosts, port: artnet.port });
      }
    }

    if (sacn && sacn.enabled) {
      const mapped = sacnUniverseFor(universe, sacn.universeOffset);
      if (mapped !== null && sendSacnUniverse(sacn, mapped, frame, terminate)) sent.push('sacn');
    }
    return sent;
  }

  function sendSacnUniverse(sacn: SacnOutput, mapped: number, frame: Buffer, terminate: boolean): boolean {
    const ok = wires.sacn({
      universe: mapped,
      cid: sacn.cid,
      sourceName: sacn.sourceName,
      priority: sacn.priority,
      host: sacn.host,
      iface: sacn.interface || '',
      terminate,
    }, frame);
    if (terminate) sacnSent.delete(mapped);
    else if (ok) sacnSent.set(mapped, now());
    return ok;
  }

  /**
   * When the settings the stream is sent with change — sACN turned off, a new
   * offset, another target — the universes it was sending are ended properly,
   * with the old settings, rather than left for each receiver to time out.
   * Checked before anything goes out under the new settings.
   */
  function syncSacnStream(sacn: SacnOutput | null | undefined): void {
    const key = sacnStreamKey(sacn);
    if (sacnStream && sacnStream.key !== key) {
      const old = sacnStream.config;
      sacnStream = null;
      for (const mapped of [...sacnSent.keys()]) sendSacnUniverse(old, mapped, ZERO_FRAME, true);
      sacnSent.clear();
      lastDiscovery = -Infinity;
    }
    sacnStream = key && sacn ? { key, config: { ...sacn } } : null;
  }

  /** The sACN side of closing a frame: every ten seconds, the discovery list. */
  function endSacnFrame(sacn: SacnOutput | null | undefined): void {
    const t = now();
    syncSacnStream(sacn);
    if (!sacnStream || !sacn) return;

    for (const [mapped, at] of sacnSent) if (t - at > SACN_ACTIVE_MS) sacnSent.delete(mapped);
    if (sacnSent.size && t - lastDiscovery >= DISCOVERY_INTERVAL_MS) {
      lastDiscovery = t;
      wires.sacnDiscovery({
        cid: sacn.cid, sourceName: sacn.sourceName, universes: [...sacnSent.keys()], iface: sacn.interface || '',
      });
    }
  }

  /**
   * Whether the config says frames may leave; on the change to "no", every
   * stream this transmitter had going is ended first (goDark). Checked with
   * every frame, since a change arrives the way everything else does: in the
   * config the next frame carries.
   */
  function syncArmed(config: TransmitConfig): boolean {
    const armed = config.armed !== false;
    if (armed === live) return armed;
    live = armed;
    if (!armed) goDark(config);
    return armed;
  }

  /**
   * End every stream, the way "Ending a stream" in the README has it: each
   * universe's Art-Net gets a black frame where it was last sent (and the
   * ArtSync that shows it, when nodes wait for one); each sACN universe a
   * black frame and its stream-terminated packets, under the settings it was
   * sent with; each WLED one dark frame, so its realtime timeout hands the
   * strip back to its own effects; each OpenRGB device one dark frame, and
   * the connection to its server closed. Frames held for the Hue delay are
   * dropped: they are the look being ended.
   */
  function goDark(config: TransmitConfig): void {
    delayLine.clear();
    ddpFrames.clear();
    openrgbFrames.clear();
    const { artnet } = config;
    for (const [universe, { hosts, port }] of artnetSent) {
      if (wires.artnet({ hosts, port, universe }, ZERO_FRAME) && artnet && artnet.sync) {
        for (const host of hosts) syncTargets.add(host);
      }
    }
    artnetSent.clear();
    if (artnet && artnet.sync) for (const host of syncTargets) wires.artnetSync({ host, port: artnet.port });
    syncTargets.clear();
    if (sacnStream) {
      const old = sacnStream.config;
      for (const mapped of [...sacnSent.keys()]) sendSacnUniverse(old, mapped, ZERO_FRAME, true);
      sacnSent.clear();
      // Announced again the moment the universes are back.
      lastDiscovery = -Infinity;
    }
    for (const gone of ddpSent.values()) sendToWled(gone.route, new Uint8Array(gone.bytes), byteRuns(gone.route, 0));
    ddpSent = new Map();
    for (const gone of openrgbSent.values()) wires.openrgb(openrgbTarget(gone), new Uint8Array(gone.leds * 3));
    hangUpOpenRgb(openrgbSent, new Map());
    openrgbSent = new Map();
  }

  /**
   * Close the frame: with ArtSync on, tell every node this frame's Art-Net
   * went to that it can output it now.
   */
  function endFrame(config: TransmitConfig | null | undefined): void {
    if (config && !syncArmed(config)) {
      // Nothing went out this frame, and nothing is owed: a WLED that left
      // the patch while disarmed was already sent its dark frame on the way
      // here, or was never sent at all.
      ddpFrames.clear();
      openrgbFrames.clear();
      syncTargets.clear();
      return;
    }
    endDdpFrame(config && config.ddp);
    endOpenRgbFrame(config && config.openrgb);
    const artnet = config && config.artnet;
    if (artnet && artnet.sync && artnet.enabled !== false) {
      for (const host of syncTargets) wires.artnetSync({ host, port: artnet.port });
    }
    syncTargets.clear();
    endSacnFrame(config && config.sacn);
  }

  /**
   * Send every WLED its pixels: its universes' bytes, in order, as one run.
   * A WLED whose universes did not all arrive this frame (held in the Hue
   * delay line) waits for the next. One that has left the patch is sent a
   * dark frame, so it does not hold its last look until WLED's own timeout
   * hands it back to its effects.
   */
  function endDdpFrame(routes: DdpRoute[] | null | undefined): void {
    const now = new Map<string, { route: DdpRoute; bytes: number }>();
    // A WLED patched segment by segment is several fixtures: its frame is all
    // of them, sent together and shown once.
    const byWled = new Map<string, DdpRoute[]>();
    for (const route of routes || []) {
      now.set(routeKey(route), { route, bytes: ledBytes(route) });
      const list = byWled.get(ddpKey(route)) || [];
      list.push(route);
      byWled.set(ddpKey(route), list);
    }
    for (const group of byWled.values()) {
      if (!group.every((route) => route.parts.every((part) => ddpFrames.has(part.universe)))) continue;
      const data = new Uint8Array(group.reduce((sum, route) => sum + ledBytes(route), 0));
      const runs: DdpRun[] = [];
      let at = 0;
      for (const route of group) {
        const own = new Uint8Array(route.parts.reduce((n, part) => n + part.bytes, 0));
        let cursor = 0;
        for (const part of route.parts) {
          const frame = ddpFrames.get(part.universe) as Buffer;
          own.set(frame.subarray(part.from, part.from + part.bytes), cursor);
          cursor += part.bytes;
        }
        // A wash or zones: its few cells, each lighting its share of the LEDs.
        const leds = route.spread ? spreadPixels(own, route.rgbw ? 4 : 3, route.spread) : own;
        data.set(leds, at);
        runs.push(...byteRuns(route, at));
        at += leds.length;
      }
      sendToWled(group[0], data, runs);
    }
    for (const [key, gone] of ddpSent) {
      if (!now.has(key)) sendToWled(gone.route, new Uint8Array(gone.bytes), byteRuns(gone.route, 0));
    }
    ddpSent = now;
    ddpFrames.clear();
  }

  /**
   * Send every OpenRGB device its LEDs: its universes' bytes, in order, as
   * one packet. A device whose universes did not all arrive this frame
   * (held in the Hue delay line) waits for the next. One that has left the
   * patch is sent a dark frame, and a server with no device left on it is
   * hung up on: OpenRGB keeps the last colours it was sent.
   */
  function endOpenRgbFrame(routes: OpenRgbRoute[] | null | undefined): void {
    const current = new Map<string, OpenRgbRoute>();
    for (const route of routes || []) {
      current.set(openrgbKey(route), route);
      if (!route.parts.every((part) => openrgbFrames.has(part.universe))) continue;
      wires.openrgb(openrgbTarget(route), openrgbPixels(route, (universe) => openrgbFrames.get(universe) as Buffer));
    }
    for (const [key, gone] of openrgbSent) {
      if (!current.has(key)) wires.openrgb(openrgbTarget(gone), new Uint8Array(gone.leds * 3));
    }
    hangUpOpenRgb(openrgbSent, current);
    openrgbSent = current;
    openrgbFrames.clear();
  }

  function openrgbTarget(route: OpenRgbRoute): OpenRgbTarget {
    return { host: route.host, port: route.port, device: route.device, leds: route.leds };
  }

  /** Close the connection to every server that had devices in `before` and has none in `after`. */
  function hangUpOpenRgb(before: Map<string, OpenRgbRoute>, after: Map<string, OpenRgbRoute>): void {
    const kept = new Set([...after.values()].map(openrgbHostKey));
    const closed = new Set<string>();
    for (const route of before.values()) {
      const host = openrgbHostKey(route);
      if (kept.has(host) || closed.has(host)) continue;
      closed.add(host);
      wires.openrgbClose({ host: route.host, port: route.port });
    }
  }

  /** How many bytes a fixture's LEDs are on the wire: its channels', unless spread. */
  function ledBytes(route: DdpRoute): number {
    if (route.spread) return route.spread.leds * (route.rgbw ? 4 : 3);
    return route.parts.reduce((sum, part) => sum + part.bytes, 0);
  }

  /** A fixture's pixel runs as bytes, its data starting at `from` in the frame. */
  function byteRuns(route: DdpRoute, from: number): DdpRun[] {
    const width = route.rgbw ? 4 : 3;
    const out: DdpRun[] = [];
    let cursor = from;
    for (const run of route.runs) {
      out.push({ at: run.at * width, from: cursor, bytes: run.count * width });
      cursor += run.count * width;
    }
    return out;
  }

  function sendToWled(route: DdpRoute, data: Uint8Array, runs: DdpRun[]): void {
    const key = ddpKey(route);
    const sequence = (ddpSequence.get(key) || 0) % 15 + 1;
    ddpSequence.set(key, sequence);
    // One run from the WLED's first LED is the whole WLED, as it always was.
    const whole = runs.length === 1 && runs[0].at === 0 && runs[0].from === 0 && runs[0].bytes === data.length;
    wires.ddp({ host: route.host, port: route.port, sequence, rgbw: route.rgbw, ...(whole ? {} : { runs }) }, data);
  }

  return { send, endFrame };
}

export {
  createTransmitter,
  sacnUniverseFor,
};
