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

export interface ArtnetOutput {
  enabled: boolean;
  host: string;
  port: number;
  sync: boolean;
  routes?: ArtRoutes | null;
}

export type SacnOutput = Settings['sacn'];

export interface TransmitConfig {
  artnet: ArtnetOutput;
  sacn: SacnOutput;
  delayMs: number;
  ddp?: DdpRoute[];
  openrgb?: OpenRgbRoute[];
  armed?: boolean;
}

export interface DdpTarget {
  host: string;
  port: number;
  sequence: number;
  rgbw: boolean;
  runs?: DdpRun[];
}

export interface Wires {
  artnet(target: ArtDmxTarget, frame: Buffer): boolean;
  artnetSync(target: { host: string; port: number }): unknown;
  sacn(target: SacnTarget, frame: Buffer): boolean;
  sacnDiscovery(packet: { cid: string; sourceName: string; universes: number[]; iface: string }): unknown;
  ddp(target: DdpTarget, data: Uint8Array): boolean;
  openrgb(target: OpenRgbTarget, rgb: Uint8Array): boolean;
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

const SACN_ACTIVE_MS = 3000;

const ZERO_FRAME = Buffer.alloc(512);

// Offset Art-Net’s zero-based universes to sACN’s one-based range before sending.
function sacnUniverseFor(universe: number, offset: number): number | null {
  const mapped = universe + offset;
  if (!Number.isInteger(mapped) || mapped < MIN_UNIVERSE || mapped > MAX_UNIVERSE) return null;
  return mapped;
}

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

const ddpKey = (route: Pick<DdpRoute, 'host' | 'port'>) => `${route.host}:${route.port}`;
const routeKey = (route: DdpRoute) => `${ddpKey(route)}@${route.runs[0]?.at ?? 0}`;

function sacnStreamKey(sacn: SacnOutput | null | undefined): string | null {
  if (!sacn || !sacn.enabled) return null;
  return [sacn.host, sacn.universeOffset, sacn.cid, sacn.sourceName, sacn.priority, sacn.interface].join('|');
}

function createTransmitter({ wires = DEFAULT_WIRES, now = () => performance.now() }: {
  wires?: Wires;
  now?: () => number;
} = {}): Transmitter {
  const syncTargets = new Set<string>();
  const sacnSent = new Map<number, number>();
  let sacnStream: { key: string; config: SacnOutput } | null = null;
  let lastDiscovery = -Infinity;
  const ddpFrames = new Map<number, Buffer>();
  let ddpSent = new Map<string, { route: DdpRoute; bytes: number }>();
  const ddpSequence = new Map<string, number>();
  const openrgbFrames = new Map<number, Buffer>();
  let openrgbSent = new Map<string, OpenRgbRoute>();
  let live = true;
  const artnetSent = new Map<number, { hosts: string[]; port: number }>();

  const delayLine = new Map<number, { at: number; frame: Buffer }[]>();

  function delayedFrame(universe: number, frame: Buffer, delayMs: number): Buffer | null {
    const t = now();
    const queue = delayLine.get(universe) || [];
    queue.push({ at: t, frame: Buffer.from(frame) });
    let ready: Buffer | null = null;
    while (queue.length && queue[0].at <= t - delayMs) ready = (queue.shift() as { frame: Buffer }).frame;
    delayLine.set(universe, queue);
    return ready;
  }

  // Bypass and discard delayed frames for blackout or retirement so stale light cannot follow shutdown.
  function send(universe: number, frame: Buffer, config: TransmitConfig,
    { immediate = false, terminate = false }: SendOptions = {}): Wire[] {
    const sent: Wire[] = [];
    if (!syncArmed(config)) return sent;
    if (isInternalUniverse(universe)) return sent;
    if (!immediate && config.delayMs > 0) {
      const ready = delayedFrame(universe, frame, config.delayMs);
      if (!ready) return sent;
      frame = ready;
    } else {
      delayLine.delete(universe);
    }

    const toWled = ddpUniverses(config.ddp);
    if (toWled && toWled.has(universe)) {
      ddpFrames.set(universe, frame);
      sent.push('ddp');
      return sent;
    }
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

  // Terminate streams with their old settings before sending under changed destinations or universes.
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

  function syncArmed(config: TransmitConfig): boolean {
    const armed = config.armed !== false;
    if (armed === live) return armed;
    live = armed;
    if (!armed) goDark(config);
    return armed;
  }

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
      lastDiscovery = -Infinity;
    }
    for (const gone of ddpSent.values()) sendToWled(gone.route, new Uint8Array(gone.bytes), byteRuns(gone.route, 0));
    ddpSent = new Map();
    for (const gone of openrgbSent.values()) wires.openrgb(openrgbTarget(gone), new Uint8Array(gone.leds * 3));
    hangUpOpenRgb(openrgbSent, new Map());
    openrgbSent = new Map();
  }

  function endFrame(config: TransmitConfig | null | undefined): void {
    if (config && !syncArmed(config)) {
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

  function endDdpFrame(routes: DdpRoute[] | null | undefined): void {
    const now = new Map<string, { route: DdpRoute; bytes: number }>();
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
    return { host: route.host, port: route.port, device: route.device, ...(route.name ? { name: route.name } : {}), leds: route.leds };
  }

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

  function ledBytes(route: DdpRoute): number {
    if (route.spread) return route.spread.leds * (route.rgbw ? 4 : 3);
    return route.parts.reduce((sum, part) => sum + part.bytes, 0);
  }

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
    const whole = runs.length === 1 && runs[0].at === 0 && runs[0].from === 0 && runs[0].bytes === data.length;
    wires.ddp({ host: route.host, port: route.port, sequence, rgbw: route.rgbw, ...(whole ? {} : { runs }) }, data);
  }

  return { send, endFrame };
}

export {
  createTransmitter,
  sacnUniverseFor,
};
