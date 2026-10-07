// Version each domain independently so clients can detect missed patches and request a snapshot.

import type { Server } from 'socket.io';

export const PROTOCOL = 2;

export const ROOM = { v1: 'protocol:1', v2: 'protocol:2', dmx: 'feed:dmx', audio: 'feed:audio' } as const;

export const TOPICS = { dmx: ROOM.dmx, audio: ROOM.audio } as const;

export type Domain = 'look' | 'rig' | 'show' | 'sources' | 'audio' | 'sequence' | 'catalogs' | 'library' | 'voices' | 'pads' | 'system';
export const DOMAINS: readonly Domain[] = ['look', 'rig', 'show', 'sources', 'audio', 'sequence', 'catalogs', 'library', 'voices', 'pads', 'system'];

const DOMAIN_OF: Readonly<Record<string, Domain>> = {
  bpm: 'look', clock: 'look', tempoMode: 'look', beatDivision: 'look', running: 'look', pattern: 'look',
  colorA: 'look', colorB: 'look', colorC: 'look', colorD: 'look', palette: 'look',
  masterDimmer: 'look', masterBlackout: 'look', flashLimit: 'look',
  strobeSpeed: 'look', strobeFunction: 'look', pixelMap: 'look', pixelPattern: 'look', panelPattern: 'look',
  energyOverride: 'look', paletteOverride: 'look', paletteOverrideId: 'look', safety: 'look',
  strobe: 'look',
  matrix: 'look',

  artnet: 'rig', universes: 'rig', fixtures: 'rig', profiles: 'rig', identify: 'rig', hueBridges: 'rig', hueStrobe: 'rig', armed: 'rig',

  autoIntensity: 'show', autoSyncOffsetMs: 'show', autoSource: 'show', autoPrefetchDepth: 'show',
  autoShow: 'show', activeSource: 'show', showOn: 'show', cues: 'show', warm: 'show',

  spotify: 'sources', spotifyNext: 'sources', spotifyPrefetch: 'sources', nowPlaying: 'sources',
  hybrid: 'sources', deezer: 'sources', deezerPrefetch: 'sources', prolink: 'sources', live: 'sources',
  midi: 'sources',

  audio: 'audio',

  sequence: 'sequence', sequences: 'sequence', sequencePatterns: 'sequence',

  colorPresets: 'catalogs', patterns: 'catalogs', energyEffects: 'catalogs', strobeFunctions: 'catalogs',
  palettes: 'catalogs', builtinProfileIds: 'catalogs', hueProfileIds: 'catalogs', syncOffsetLimitMs: 'catalogs',
  families: 'catalogs', builtinPalettes: 'catalogs',

  effects: 'library', userPalettes: 'library',

  voices: 'voices',

  pads: 'pads',
};

export function hasDomain(key: string): boolean {
  return Object.hasOwn(DOMAIN_OF, key);
}

export function domainOf(key: string): Domain {
  return Object.hasOwn(DOMAIN_OF, key) ? DOMAIN_OF[key] : 'system';
}

const CLOCK_TOLERANCE_MS = 1000 / 60;

interface ClockPhase { bpm: number; beatPos: number; at: number }

function isClockPhase(value: unknown): value is ClockPhase {
  const v = value as Partial<ClockPhase> | null;
  return !!v && typeof v === 'object' && [v.bpm, v.beatPos, v.at].every(Number.isFinite) && (v.bpm as number) > 0;
}

export function clockMoved(sent: unknown, fresh: unknown): boolean {
  if (!isClockPhase(sent) || !isClockPhase(fresh)) return JSON.stringify(sent) !== JSON.stringify(fresh);
  const { beatPos: was, at: wasAt, ...before } = sent;
  const { beatPos: is, at: isAt, ...after } = fresh;
  if (JSON.stringify(before) !== JSON.stringify(after)) return true;
  if (is === was) return false;
  const carried = was + ((isAt - wasAt) / 60000) * sent.bpm;
  return (Math.abs(is - carried) * 60000) / sent.bpm > CLOCK_TOLERANCE_MS;
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

export class StateDiffer {
  declare _sent: Map<string, string>;
  declare _sentClock: unknown;
  declare _versions: Record<Domain, number>;

  constructor() {
    this._sent = new Map();
    this._sentClock = undefined;
    this._versions = Object.fromEntries(DOMAINS.map((d) => [d, 0])) as Record<Domain, number>;
  }

  settle(live: Record<string, unknown>): Record<string, unknown> {
    if (live.clock === undefined || clockMoved(this._sentClock, live.clock)) return live;
    return { ...live, clock: this._sentClock };
  }

  diff(fresh: Record<string, unknown>): Patch[] {
    const live = this.settle(fresh);
    this._sentClock = live.clock;
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

  versions(): Record<Domain, number> {
    return { ...this._versions };
  }
}

type Io = Pick<Server, 'emit'> & Partial<Pick<Server, 'to' | 'sockets'>>;

export function createPublisher(io: Io) {
  const differ = new StateDiffer();
  let lastLiveJson = '';
  let lastFrame: Uint8Array | null = null;
  let lastAudio: unknown;
  let lastAudioJson: string | undefined;

  const room = (name: string) => (typeof io.to === 'function' ? io.to(name) : io);
  const size = (name: string): number => io.sockets?.adapter?.rooms?.get(name)?.size ?? 0;

  return {
    publishState(live: Record<string, unknown>): void {
      const json = JSON.stringify(differ.settle(live));
      if (json === lastLiveJson) return;
      lastLiveJson = json;
      room(ROOM.v1).emit('state', live);
      for (const patch of differ.diff(live)) room(ROOM.v2).emit('patch', patch);
    },

    snapshot(full: Record<string, unknown>): Snapshot {
      const { dmxSnapshot: _dmx, ...state } = full;
      return { protocol: PROTOCOL, versions: differ.versions(), state };
    },

    wants(name: string): boolean {
      return size(name) > 0;
    },

    sendDmxFrame(frame: Uint8Array): boolean {
      if (typeof io.to !== 'function') return false;
      if (lastFrame && lastFrame.length === frame.length && lastFrame.every((b, i) => b === frame[i])) return false;
      lastFrame = frame;
      io.to(ROOM.dmx).volatile.emit('dmx-frame', frame);
      return true;
    },

    lastDmxFrame(): Uint8Array | null {
      return lastFrame;
    },

    resetDmx(): void {
      lastFrame = null;
    },

    // Deliver audio disappearance reliably so meters cannot remain stuck on their last level.
    sendAudio(feed: unknown): boolean {
      if (typeof io.to !== 'function') return false;
      const json = JSON.stringify(feed ?? null);
      if (json === lastAudioJson) return false;
      lastAudioJson = json;
      lastAudio = feed ?? null;
      if (feed) io.to(ROOM.audio).volatile.emit('audio', feed);
      else io.to(ROOM.audio).emit('audio', null);
      return true;
    },

    lastAudio(): unknown {
      return lastAudio;
    },

    resetAudio(): void {
      lastAudio = undefined;
      lastAudioJson = undefined;
    },
  };
}

export type Publisher = ReturnType<typeof createPublisher>;
