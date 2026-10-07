
import type { Server } from 'socket.io';

export const PROTOCOL = 2;

/** Rooms a socket is in: which protocol it speaks, and what it subscribed to. */
export const ROOM = { v1: 'protocol:1', v2: 'protocol:2', dmx: 'feed:dmx', audio: 'feed:audio' } as const;

/** What a page may subscribe to. */
export const TOPICS = { dmx: ROOM.dmx, audio: ROOM.audio } as const;

export type Domain = 'look' | 'rig' | 'show' | 'sources' | 'audio' | 'sequence' | 'catalogs' | 'library' | 'voices' | 'pads' | 'system';
export const DOMAINS: readonly Domain[] = ['look', 'rig', 'show', 'sources', 'audio', 'sequence', 'catalogs', 'library', 'voices', 'pads', 'system'];

const DOMAIN_OF: Readonly<Record<string, Domain>> = {
  bpm: 'look', clock: 'look', tempoMode: 'look', beatDivision: 'look', running: 'look', pattern: 'look',
  colorA: 'look', colorB: 'look', colorC: 'look', colorD: 'look', palette: 'look',
  masterDimmer: 'look', masterBlackout: 'look', flashLimit: 'look',
  strobeSpeed: 'look', strobeFunction: 'look', pixelMap: 'look', pixelPattern: 'look', panelPattern: 'look',
  energyOverride: 'look', paletteOverride: 'look', paletteOverrideId: 'look', safety: 'look',
  // The manual strobe, on or off and its settings: it plays over the look, and the look's views show it.
  strobe: 'look',
  // The matrix board, its mode and held colours: like the strobe, played over the look.
  matrix: 'look',

  artnet: 'rig', universes: 'rig', fixtures: 'rig', profiles: 'rig', identify: 'rig', hueBridges: 'rig', hueStrobe: 'rig', armed: 'rig',

  autoIntensity: 'show', autoSyncOffsetMs: 'show', autoSource: 'show', autoPrefetchDepth: 'show',
  autoShow: 'show', activeSource: 'show', showOn: 'show', cues: 'show', warm: 'show',

  spotify: 'sources', spotifyNext: 'sources', spotifyPrefetch: 'sources', nowPlaying: 'sources',
  hybrid: 'sources', deezer: 'sources', deezerPrefetch: 'sources', prolink: 'sources', live: 'sources',
  midi: 'sources',

  // The audio summary: its levels move every sweep, and only the meters watch them.
  audio: 'audio',

  // The sequencer: the sequence loaded, and (from the transport) where it plays.
  sequence: 'sequence',

  colorPresets: 'catalogs', patterns: 'catalogs', energyEffects: 'catalogs', strobeFunctions: 'catalogs',
  palettes: 'catalogs', builtinProfileIds: 'catalogs', hueProfileIds: 'catalogs', syncOffsetLimitMs: 'catalogs',
  families: 'catalogs', builtinPalettes: 'catalogs',

  // The presets and palettes saved on this server: one saved mid-show reaches
  // every open page, and only the pickers watch them.
  effects: 'library', userPalettes: 'library',

  // The effects launched over the look: a pad pressed moves only this, and only the pads watch it.
  voices: 'voices',

  // The pads' layout and which of them are lit: the deck and the pad grid watch it, nothing else.
  pads: 'pads',
};

/** Is the key named in the table (rather than falling to `system`)? */
export function hasDomain(key: string): boolean {
  return Object.hasOwn(DOMAIN_OF, key);
}

export function domainOf(key: string): Domain {
  return Object.hasOwn(DOMAIN_OF, key) ? DOMAIN_OF[key] : 'system';
}

// How far a screen carrying the clock on may drift before the clock is news:
// a frame of a 60 Hz display, which no closer correction could show.
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

  /** `live`, with a clock that is no news (clockMoved) swapped for the one last sent. */
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

  /** The version each domain is at, for a snapshot. */
  versions(): Record<Domain, number> {
    return { ...this._versions };
  }
}

/** The part of socket.io's server this needs; a test may pass less. */
type Io = Pick<Server, 'emit'> & Partial<Pick<Server, 'to' | 'sockets'>>;

export function createPublisher(io: Io) {
  const differ = new StateDiffer();
  let lastLiveJson = '';
  let lastFrame: Uint8Array | null = null;
  // Undefined until something is sent; null once the audio has gone.
  let lastAudio: unknown;
  let lastAudioJson: string | undefined;

  const room = (name: string) => (typeof io.to === 'function' ? io.to(name) : io);
  const size = (name: string): number => io.sockets?.adapter?.rooms?.get(name)?.size ?? 0;

  return {
    publishState(live: Record<string, unknown>): void {
      // Settled first: a clock that only moved on as expected is no change.
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

    /** The audio last sent, for a page that has just subscribed; undefined before any. */
    lastAudio(): unknown {
      return lastAudio;
    },

    /** Forget the last audio sent: nobody is subscribed. */
    resetAudio(): void {
      lastAudio = undefined;
      lastAudioJson = undefined;
    },
  };
}

export type Publisher = ReturnType<typeof createPublisher>;
