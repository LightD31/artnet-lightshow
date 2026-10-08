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
 *   audio      what the party effects hear (audio-features.ts), the same way:
 *              up to thirty times a second, to `subscribe: ['audio']`
 *
 * Version 1 is kept, unchanged, for whatever connects without asking — the
 * Bitfocus Companion module, a page from before protocol 2 — and its JSON DMX
 * stream is only built while one is connected.
 */

import type { Server } from 'socket.io';

export const PROTOCOL = 2;

/** Rooms a socket is in: which protocol it speaks, and what it subscribed to. */
export const ROOM = { v1: 'protocol:1', v2: 'protocol:2', dmx: 'feed:dmx', audio: 'feed:audio' } as const;

/** What a page may subscribe to. */
export const TOPICS = { dmx: ROOM.dmx, audio: ROOM.audio } as const;

export type Domain = 'look' | 'rig' | 'show' | 'sources' | 'audio' | 'sequence' | 'catalogs' | 'library' | 'voices' | 'pads' | 'system';
export const DOMAINS: readonly Domain[] = ['look', 'rig', 'show', 'sources', 'audio', 'sequence', 'catalogs', 'library', 'voices', 'pads', 'system'];

/**
 * Which domain each key of the live state belongs to. Grouped by what changes
 * together and what a view watches: the look on stage moves with every fader,
 * the rig when the patch is edited, the show with the track, the sources on
 * their own clocks. A key not named here is `system`.
 */
const DOMAIN_OF: Readonly<Record<string, Domain>> = {
  bpm: 'look', clock: 'look', tempoMode: 'look', beatDivision: 'look', running: 'look', pattern: 'look',
  colorA: 'look', colorB: 'look', colorC: 'look', colorD: 'look', palette: 'look',
  masterDimmer: 'look', masterBlackout: 'look', flashLimit: 'look',
  strobeSpeed: 'look', strobeFunction: 'look', pixelMap: 'look', pixelPattern: 'look', panelPattern: 'look',
  energyOverride: 'look', paletteOverride: 'look', paletteOverrideId: 'look', safety: 'look',
  basePalette: 'look', overridePalette: 'look',
  strobe: 'look',
  // The matrix board, its mode and held colours: like the strobe, played over the look.
  matrix: 'look',

  artnet: 'rig', universes: 'rig', fixtures: 'rig', profiles: 'rig', identify: 'rig', hueBridges: 'rig', hueStrobe: 'rig', hardware: 'rig', armed: 'rig',

  autoIntensity: 'show', autoSyncOffsetMs: 'show', autoSource: 'show', autoPrefetchDepth: 'show',
  autoShow: 'show', activeSource: 'show', showOn: 'show', cues: 'show', warm: 'show',

  spotify: 'sources', spotifyNext: 'sources', spotifyPrefetch: 'sources', nowPlaying: 'sources',
  hybrid: 'sources', deezer: 'sources', deezerPrefetch: 'sources', prolink: 'sources', live: 'sources',
  midi: 'sources',

  // The audio summary: its levels move every sweep, and only the meters watch them.
  audio: 'audio',

  // The sequencer: the sequence loaded, and (from the transport) where it plays;
  // the shelf of saved ones and of patterns, by id and name.
  sequence: 'sequence', sequences: 'sequence', sequencePatterns: 'sequence',

  colorPresets: 'catalogs', patterns: 'catalogs', energyEffects: 'catalogs', strobeFunctions: 'catalogs',
  palettes: 'catalogs', builtinProfileIds: 'catalogs', syncOffsetLimitMs: 'catalogs',
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

/**
 * Whether the live state's `clock` says anything a screen holding `sent`
 * does not know. Its beat is read afresh every time, so equal JSON would make
 * every broadcast and every sweep a change. A screen carries the beat on as
 * beatPos + (now − at) / 60000 × bpm: a beat that lands within a frame of
 * that, or one standing where it was sent (the patterns stopped), is no news;
 * a tap, a seek, a stop or a drifting tempo is, as are a new source, tempo or
 * epoch. Anything without a beat compares as it is.
 */
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

/**
 * The live state, diffed against what was last published: the keys that
 * changed, grouped by domain, each domain's version moved on by one.
 */
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

/**
 * Sends each protocol its own form of the same changes.
 *
 *   publishState(live)  on every broadcast: v1 pages get the whole live state
 *                       when anything in it changed, v2 pages the patches
 *   snapshot(full)      for a v2 page connecting or asking to resync
 *   wants(room)         whether anyone is listening there, so a feed nobody
 *                       reads is not built
 *   sendDmxFrame(bytes) to the pages subscribed to DMX
 *   sendAudio(feed)     to the pages subscribed to the audio
 */
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

    /**
     * What the party effects hear, to its subscribers, unless they have it
     * already. Volatile like the DMX; the one message that the audio has gone
     * (null) is not, so no meter is left standing on the last level.
     */
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
