import { sendArtDmx, sendArtSync } from './artnet.ts';
import { sendSacn, sendSacnDiscovery, MIN_UNIVERSE, MAX_UNIVERSE, DISCOVERY_INTERVAL_MS } from './sacn.ts';
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
}

/** The packets themselves; swapped for fakes in tests. */
export interface Wires {
  artnet(target: ArtDmxTarget, frame: Buffer): boolean;
  artnetSync(target: { host: string; port: number }): unknown;
  sacn(target: SacnTarget, frame: Buffer): boolean;
  sacnDiscovery(packet: { cid: string; sourceName: string; universes: number[]; iface: string }): unknown;
}

export interface SendOptions {
  immediate?: boolean;
  terminate?: boolean;
}

export interface Transmitter {
  send(universe: number, frame: Buffer, config: TransmitConfig, options?: SendOptions): ('artnet' | 'sacn')[];
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

const DEFAULT_WIRES: Wires = {
  artnet: sendArtDmx, artnetSync: sendArtSync, sacn: sendSacn, sacnDiscovery: sendSacnDiscovery,
};

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
    { immediate = false, terminate = false }: SendOptions = {}): ('artnet' | 'sacn')[] {
    const sent: ('artnet' | 'sacn')[] = [];
    if (!immediate && config.delayMs > 0) {
      const ready = delayedFrame(universe, frame, config.delayMs);
      if (!ready) return sent;
      frame = ready;
    } else {
      delayLine.delete(universe);
    }

    const { artnet, sacn } = config;
    syncSacnStream(sacn);
    if (artnet && artnet.enabled !== false) {
      const claimed = artnet.routes && artnet.routes[universe];
      const hosts = claimed && claimed.length ? claimed : [artnet.host];
      if (wires.artnet({ hosts, port: artnet.port, universe }, frame)) {
        sent.push('artnet');
        if (artnet.sync) for (const host of hosts) syncTargets.add(host);
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
   * Close the frame: with ArtSync on, tell every node this frame's Art-Net
   * went to that it can output it now.
   */
  function endFrame(config: TransmitConfig | null | undefined): void {
    const artnet = config && config.artnet;
    if (artnet && artnet.sync && artnet.enabled !== false) {
      for (const host of syncTargets) wires.artnetSync({ host, port: artnet.port });
    }
    syncTargets.clear();
    endSacnFrame(config && config.sacn);
  }

  return { send, endFrame };
}

export {
  createTransmitter,
  sacnUniverseFor,
};
