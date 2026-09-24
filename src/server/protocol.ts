/**
 * What the live page is sent, and how: protocol v2.
 *
 * Version 1 pushed the whole live state — about 7 KB — on every change: every
 * step of a slider drag, two expression updates a second, a 1 Hz status sweep.
 * Nearly every component on the page re-rendered each time, and the DMX
 * monitor re-diffed its 512 cells. DMX itself went out as JSON arrays ten
 * times a second, to every open page whether it showed DMX or not.
 *
 * Version 2, which a page asks for when it connects (`auth.protocol: 2`):
 *
 *   snapshot   on connect, and whenever the page asks (`sync`): the whole
 *              state and the version each domain is at
 *   patch      after that, only the keys that changed, grouped by domain —
 *              { d: domain, v: version, set: { key: value }, del?: [key] }.
 *              Each domain counts its own versions, so a page that misses one
 *              knows to ask for a snapshot rather than drifting
 *   dmx-frame  the DMX, as bytes (shared/dmx-frame.ts), thirty times a second
 *              while it changes, and only to pages that have subscribed to it
 *              (`subscribe: ['dmx']`). Volatile: a frame a slow page cannot
 *              take is dropped rather than queued behind the next
 *
 * Version 1 is kept, unchanged, for whatever connects without asking — the
 * Bitfocus Companion module, a page from before protocol 2 — and its JSON DMX
 * stream is only built while one is connected.
 */

import type { Server } from 'socket.io';

export const PROTOCOL = 2;

/** Rooms a socket is in: which protocol it speaks, and what it subscribed to. */
export const ROOM = { v1: 'protocol:1', v2: 'protocol:2', dmx: 'feed:dmx' } as const;

/** What a page may subscribe to. */
export const TOPICS = { dmx: ROOM.dmx } as const;

export type Domain = 'look' | 'rig' | 'show' | 'sources' | 'catalogs' | 'system';
export const DOMAINS: readonly Domain[] = ['look', 'rig', 'show', 'sources', 'catalogs', 'system'];

/**
 * Which domain each key of the live state belongs to. Grouped by what changes
 * together and what a view watches: the look on stage moves with every fader,
 * the rig when the patch is edited, the show with the track, the sources on
 * their own clocks. A key not named here is `system`.
 */
const DOMAIN_OF: Readonly<Record<string, Domain>> = {
  bpm: 'look', clock: 'look', beatDivision: 'look', running: 'look', pattern: 'look',
  colorA: 'look', colorB: 'look', colorC: 'look', colorD: 'look', palette: 'look',
  masterDimmer: 'look', masterBlackout: 'look', flashLimit: 'look',
  strobeSpeed: 'look', strobeFunction: 'look', pixelMap: 'look', pixelPattern: 'look', energyOverride: 'look',

  artnet: 'rig', universes: 'rig', fixtures: 'rig', profiles: 'rig', identify: 'rig',

  autoIntensity: 'show', autoSyncOffsetMs: 'show', autoSource: 'show', autoPrefetchDepth: 'show',
  autoShow: 'show', activeSource: 'show', showOn: 'show', cues: 'show', warm: 'show',

  spotify: 'sources', spotifyNext: 'sources', spotifyPrefetch: 'sources', nowPlaying: 'sources',
  hybrid: 'sources', deezer: 'sources', deezerPrefetch: 'sources', prolink: 'sources', live: 'sources',
  midi: 'sources',

  colorPresets: 'catalogs', patterns: 'catalogs', energyEffects: 'catalogs', strobeFunctions: 'catalogs',
  palettes: 'catalogs', builtinProfileIds: 'catalogs', syncOffsetLimitMs: 'catalogs',
};

export function domainOf(key: string): Domain {
  return Object.hasOwn(DOMAIN_OF, key) ? DOMAIN_OF[key] : 'system';
}

export interface Patch {
  d: Domain;
  v: number;
  set: Record<string, unknown>;
  del?: string[];
}

export interface Snapshot {
  protocol: typeof PROTOCOL;
  versions: Record<Domain, number>;
  state: Record<string, unknown>;
}

/**
 * The live state, diffed against what was last published: the keys that
 * changed, grouped by domain, each domain's version moved on by one.
 */
export class StateDiffer {
  declare _sent: Map<string, string>;
  declare _versions: Record<Domain, number>;

  constructor() {
    this._sent = new Map();
    this._versions = Object.fromEntries(DOMAINS.map((d) => [d, 0])) as Record<Domain, number>;
  }

  diff(live: Record<string, unknown>): Patch[] {
    const groups = new Map<Domain, { set: Record<string, unknown>; del: string[] }>();
    const group = (d: Domain) => {
      let g = groups.get(d);
      if (!g) groups.set(d, g = { set: {}, del: [] });
      return g;
    };
    for (const [key, value] of Object.entries(live)) {
      if (value === undefined) continue;
      const json = JSON.stringify(value);
      if (this._sent.get(key) === json) continue;
      this._sent.set(key, json);
      group(domainOf(key)).set[key] = value;
    }
    for (const key of [...this._sent.keys()]) {
      if (live[key] !== undefined) continue;
      this._sent.delete(key);
      group(domainOf(key)).del.push(key);
    }
    return [...groups].map(([d, g]) => ({
      d, v: ++this._versions[d], set: g.set, ...(g.del.length ? { del: g.del } : {}),
    }));
  }

  /** The version each domain is at, for a snapshot. */
  versions(): Record<Domain, number> {
    return { ...this._versions };
  }
}

/** The part of socket.io's server this needs; a test may pass less. */
type Io = Pick<Server, 'emit'> & Partial<Pick<Server, 'to' | 'sockets'>>;

/**
 * Sends each protocol its own form of the same changes.
 *
 *   publishState(live)  on every broadcast: v1 pages get the whole live state
 *                       when anything in it changed, v2 pages the patches
 *   snapshot(full)      for a v2 page connecting or asking to resync
 *   wants(room)         whether anyone is listening there, so a feed nobody
 *                       reads is not built
 *   sendDmxFrame(bytes) to the pages subscribed to DMX
 */
export function createPublisher(io: Io) {
  const differ = new StateDiffer();
  let lastLiveJson = '';
  let lastFrame: Uint8Array | null = null;

  const room = (name: string) => (typeof io.to === 'function' ? io.to(name) : io);
  const size = (name: string): number => io.sockets?.adapter?.rooms?.get(name)?.size ?? 0;

  return {
    publishState(live: Record<string, unknown>): void {
      const json = JSON.stringify(live);
      if (json === lastLiveJson) return;
      lastLiveJson = json;
      room(ROOM.v1).emit('state', live);
      for (const patch of differ.diff(live)) room(ROOM.v2).emit('patch', patch);
    },

    snapshot(full: Record<string, unknown>): Snapshot {
      // Built from the state as it is now, which may be ahead of the last
      // publish: the patches that follow set those keys again, which is
      // harmless, and nothing is missed.
      const { dmxSnapshot: _dmx, ...state } = full;
      return { protocol: PROTOCOL, versions: differ.versions(), state };
    },

    wants(name: string): boolean {
      return size(name) > 0;
    },

    /** A frame for the DMX subscribers, unless it is the one they already have. */
    sendDmxFrame(frame: Uint8Array): boolean {
      if (typeof io.to !== 'function') return false;
      if (lastFrame && lastFrame.length === frame.length && lastFrame.every((b, i) => b === frame[i])) return false;
      lastFrame = frame;
      io.to(ROOM.dmx).volatile.emit('dmx-frame', frame);
      return true;
    },

    /** The last frame sent, for a page that has just subscribed. */
    lastDmxFrame(): Uint8Array | null {
      return lastFrame;
    },

    /** Forget the last frame, so the next is sent even if it is the same. */
    resetDmx(): void {
      lastFrame = null;
    },
  };
}

export type Publisher = ReturnType<typeof createPublisher>;
