import { beatPositionAt, localBpm } from '../shared/beat-clock.ts';
import { TEMPO_MODES } from './presets.ts';
import type { BeatGrid } from '../shared/beat-clock.ts';

// The one clock patterns keep time by. Sources, best first: auto show grid, CDJ master deck, a
// track's cached grid, live input, else the free clock (tap). In 'auto' a tap or typed BPM holds
// cdj, track or live off until that music moves on or follow(); 'manual' follows only the auto show.

// Moves beyond these are a discontinuity (a new epoch), not jitter.
const BACKWARD_JUMP_BEATS = 0.25;
const FORWARD_JUMP_BEATS = 2;

// Longer than any gap between frames, shorter than a beat at any tempo: a track this still is paused.
const STALL_MS = 200;

const clampBpm = (bpm: number): number => Math.max(20, Math.min(300, bpm));

export type ClockSource = 'auto' | 'cdj' | 'track' | 'live' | 'tap';

export type TempoMode = typeof TEMPO_MODES[number];

export interface ClockReading {
  beatPos: number;
  bpm: number;
  source: ClockSource;
  /** The beat the running scene was scheduled on, when the source knows it. */
  anchorBeat?: number;
}

export interface MusicalTime extends ClockReading {
  epoch: number;
}

export interface AutoClock {
  grid: BeatGrid | null;
  positionMs: number;
  /** When the scene now playing was scheduled, in track time. */
  anchorMs?: number | null;
}

export interface DeckClock {
  beatPos: number;
  bpm?: number | null;
  /** The deck and its track, or the live input's lock: a hand holds until it changes. */
  key?: string | number | null;
}

// Followed of their own accord, best first; a hand holds off its source and every one after it.
const FOLLOWED = ['cdj', 'track', 'live'] as const;
type Followed = typeof FOLLOWED[number];

const isFollowed = (source: ClockSource): source is Followed => (FOLLOWED as readonly string[]).includes(source);

interface Hand {
  source: Followed;
  key: string | number | null | undefined;
  /** What the sources below followed then, so a quiet source's hand ends when one moves on. */
  below: { track: string | null; live: string | number | null };
}

interface TrackLock {
  key: string | null | undefined;
  grid: BeatGrid;
  positionMs: () => number;
}

interface FreeClock {
  at: number;
  beatPos: number;
  bpm: number;
  running: boolean;
}

class Conductor {
  declare _now: () => number;
  declare _free: FreeClock;
  declare _autoSource: () => AutoClock | null;
  declare _prolinkSource: () => DeckClock | null;
  declare _liveSource: () => DeckClock | null;
  declare _track: TrackLock | null;
  declare _override: boolean;
  declare _last: (ClockReading & { t: number }) | null;
  declare _epoch: number;
  declare _onTempo: (bpm: number) => void;
  declare _reportedBpm: number | null;
  declare _still: Record<string, { positionMs: number; since: number }>;
  declare _tookOver: boolean;
  declare _tempoMode: TempoMode;
  declare _hand: Hand | null;

  constructor({ now = () => performance.now(), bpm = 120 }: { now?: () => number; bpm?: number } = {}) {
    this._now = now;
    this._free = { at: now(), beatPos: 0, bpm, running: true };
    this._autoSource = () => null;
    this._prolinkSource = () => null;
    this._liveSource = () => null;
    this._track = null;                 // { key, grid, positionMs }
    this._override = false;             // a tap or typed BPM beats the track source
    this._last = null;                  // the previous reading, for continuity
    this._epoch = 0;
    this._onTempo = () => {};
    this._reportedBpm = null;
    this._still = {};                   // per grid source: { positionMs, since }
    this._tookOver = false;             // the operator just took the tempo from a track
    this._tempoMode = 'auto';
    this._hand = null;                  // the tempo taken by hand from a followed source
  }

  setAutoSource(fn: (() => AutoClock | null) | null | undefined): void { this._autoSource = typeof fn === 'function' ? fn : () => null; }

  setProlinkSource(fn: (() => DeckClock | null) | null | undefined): void { this._prolinkSource = typeof fn === 'function' ? fn : () => null; }

  setLiveSource(fn: (() => DeckClock | null) | null | undefined): void { this._liveSource = typeof fn === 'function' ? fn : () => null; }

  /** A different track ends the operator's override on the last one; the same track keeps it. */
  setTrack({ key, grid, positionMs }: {
    key?: string | null;
    grid?: BeatGrid | null;
    positionMs?: () => number;
  } = {}): void {
    if (!grid || typeof positionMs !== 'function') return this.clearTrack({ key });
    if (!this._track || this._track.key !== key) this._nextTrack();
    this._track = { key, grid, positionMs };
  }

  /** No lockable track is playing; `key` names the one that is, if any. */
  clearTrack({ key = null }: { key?: string | null } = {}): void {
    if (!this._track || this._track.key !== key) this._nextTrack();
    this._track = null;
  }

  _nextTrack(): void {
    this._override = false;
    if (this._hand?.source === 'track') this._hand = null;
  }

  get trackKey(): string | null | undefined { return this._track ? this._track.key : null; }

  get tempoMode(): TempoMode { return this._tempoMode; }

  /** Reads at once, so a BPM sent straight after the switch starts from the hand-over. */
  setTempoMode(mode: unknown): void {
    if (!TEMPO_MODES.includes(mode as TempoMode)) return;
    if (mode === this._tempoMode) {
      if (mode === 'auto') this.follow();
      return;
    }
    this._tempoMode = mode as TempoMode;
    // Following again: a hand taken in either mode no longer holds the music off.
    if (mode === 'auto') {
      this._override = false;
      this._hand = null;
    }
    // Said again even if unchanged: a BPM typed while the music led moved only the read-out.
    this._reportedBpm = null;
    this.now();
  }

  /** Ends a hand now rather than at its source's next discontinuity. */
  follow(): void {
    if (this._tempoMode !== 'auto' || (!this._hand && !this._override)) return;
    this._override = false;
    this._hand = null;
    this._reportedBpm = null;
    this.now();
  }

  /** Whether a hand keeps cdj, track or live from leading now, so screens offer follow(). */
  byHand(): boolean {
    if (this._tempoMode !== 'auto' || this._next(this._now()).reading.source !== 'tap') return false;
    return this._handFrom() < FOLLOWED.length || (this._override && !!this._track);
  }

  /** The read-out follows the rig's tempo, so a ±1 nudge starts from what is running. */
  onTempo(fn: ((bpm: number) => void) | null | undefined): void { this._onTempo = typeof fn === 'function' ? fn : () => {}; }

  _freeBeatAt(t: number): number {
    const f = this._free;
    return f.running ? f.beatPos + ((t - f.at) / 60000) * f.bpm : f.beatPos;
  }

  // Re-anchors so a nudge keeps the phase; a source's report (manual: false) never beats a hand.
  setBpm(bpm: unknown, { manual = true } = {}): boolean {
    const value = Number(bpm);
    if (!Number.isFinite(value)) return false;
    const t = this._now();
    const current = this._settle(t);
    if (!manual && (this._holdsTempo() || current.source === 'track' || current.source === 'live')) return false;
    const takesOver = manual && isFollowed(current.source);
    // Taking over starts on the music's beat, not the idle free clock's.
    const beatPos = takesOver ? current.beatPos : this._freeBeatAt(t);
    this._free = { ...this._free, at: t, beatPos, bpm: clampBpm(value) };
    if (manual && this._track) this._override = true;
    if (takesOver) this._takeHand(current.source as Followed);
    // Under the auto show a typed tempo moves nothing: say the grid's tempo to the read-out again.
    else if (manual && current.source === 'auto') this._reportedBpm = null;
    return true;
  }

  /** Whether the operator holds the tempo: in 'manual', or by hand in 'auto'. */
  _holdsTempo(): boolean {
    return this._tempoMode === 'manual' || this._handFrom() < FOLLOWED.length;
  }

  _takeHand(source: Followed): void {
    const reading = source === 'cdj' ? this._prolinkSource() : source === 'live' ? this._liveSource() : null;
    this._hand = {
      source,
      key: source === 'track' ? this._track?.key : reading?.key,
      below: { track: this._track?.key ?? null, live: this._liveSource()?.key ?? null },
    };
    this._tookOver = true;
  }

  // A tap is a beat: the step lands on it, and a followed source's tempo is taken by hand.
  tap(): void {
    const t = this._now();
    const current = this._settle(t);
    const takesOver = isFollowed(current.source);
    this._free = {
      ...this._free,
      at: t,
      beatPos: Math.floor(current.beatPos + 1e-9) + 1,
      bpm: takesOver ? clampBpm(current.bpm) : this._free.bpm,
    };
    if (this._track) this._override = true;
    if (takesOver) this._takeHand(current.source as Followed);
  }

  setRunning(running: unknown): void {
    const t = this._now();
    this._settle(t);
    this._free = { ...this._free, at: t, beatPos: this._freeBeatAt(t), running: !!running };
  }

  /** False once a grid source's position has stood still for STALL_MS. */
  _moving(source: string, positionMs: number, t: number): boolean {
    const still = this._still[source];
    if (!still || Math.abs(positionMs - still.positionMs) > 0.5) {
      this._still[source] = { positionMs, since: t };
      return true;
    }
    return t - still.since < STALL_MS;
  }

  /** Null when unusable or paused; anchorMs becomes anchorBeat for re-anchoring after a jump. */
  _gridReading(source: 'auto' | 'track', grid: BeatGrid | null | undefined, positionMs: number | undefined,
    t: number, anchorMs: number | null | undefined = null): ClockReading | null {
    if (!grid || typeof positionMs !== 'number' || !Number.isFinite(positionMs)) {
      // So a later show starting where the last one stopped is not judged paused.
      delete this._still[source];
      return null;
    }
    const beatPos = beatPositionAt(grid, positionMs);
    if (!Number.isFinite(beatPos) || !this._moving(source, positionMs, t)) return null;
    const reading: ClockReading = { beatPos, bpm: localBpm(grid, positionMs), source };
    if (typeof anchorMs === 'number' && Number.isFinite(anchorMs)) reading.anchorBeat = beatPositionAt(grid, anchorMs);
    return reading;
  }

  _current(t: number): ClockReading {
    const auto: Partial<AutoClock> = this._autoSource() || {};
    const fromAuto = this._gridReading('auto', auto.grid, auto.positionMs, t, auto.anchorMs);
    if (fromAuto) return fromAuto;
    // In 'manual' only the auto show's grid, above, leads the operator's tempo.
    if (this._tempoMode === 'manual') return { beatPos: this._freeBeatAt(t), bpm: this._free.bpm, source: 'tap' };
    // From FOLLOWED[held] on, sources are held off by a hand.
    const held = this._handFrom();
    const cdj = this._prolinkSource();
    if (held > 0 && cdj && Number.isFinite(cdj.beatPos)) {
      const bpm = typeof cdj.bpm === 'number' && Number.isFinite(cdj.bpm) && cdj.bpm > 0 ? cdj.bpm : this._free.bpm;
      return { beatPos: cdj.beatPos, bpm, source: 'cdj' };
    }
    const track = held > 1 && this._track && !this._override ? this._track : null;
    const fromTrack = this._gridReading('track', track && track.grid, track ? track.positionMs() : NaN, t);
    if (fromTrack) return fromTrack;
    const live = held > 2 ? this._liveSource() : null;
    if (live && Number.isFinite(live.beatPos) && typeof live.bpm === 'number' && live.bpm > 0) {
      return { beatPos: live.beatPos, bpm: live.bpm, source: 'live' };
    }
    return { beatPos: this._freeBeatAt(t), bpm: this._free.bpm, source: 'tap' };
  }

  // A source answering for something new ends its hand; a quiet one's ends when one below moves on.
  _handFrom(): number {
    const hand = this._hand;
    if (!hand) return FOLLOWED.length;
    const from = FOLLOWED.indexOf(hand.source);
    const own = hand.source === 'cdj' ? this._prolinkSource() : hand.source === 'live' ? this._liveSource() : null;
    const answers = hand.source === 'track' ? !!this._track : !!own && Number.isFinite(own.beatPos);
    let movedOn = !!own && answers && own.key !== hand.key;
    if (!answers) {
      const live = from < 2 ? this._liveSource() : null;
      movedOn = (from < 1 && !!this._track && (this._track.key ?? null) !== hand.below.track)
        || (!!live && Number.isFinite(live.beatPos) && (live.key ?? null) !== hand.below.live);
    }
    if (!movedOn) return from;
    this._hand = null;
    return FOLLOWED.length;
  }

  /** Makes a due hand-over now, so a tempo, tap or stop in that frame starts where the clock carries on. */
  _settle(t: number): ClockReading {
    const { reading, handOver } = this._next(t);
    if (handOver) {
      this._free = handOver;
      this._last = { ...reading, t };
    }
    return reading;
  }

  /** What now() would read, moving nothing; handOver is the free clock a stopped source leaves. */
  _next(t: number): { reading: ClockReading; epoch: number; handOver: FreeClock | null } {
    const reading = this._current(t);
    const last = this._last;
    if (last && reading.source === 'tap' && last.source !== 'tap' && !this._tookOver) {
      // A locked source stopped answering: carry on from where it was.
      const beatPos = last.beatPos + ((t - last.t) / 60000) * last.bpm;
      const handOver = { ...this._free, at: t, beatPos, bpm: clampBpm(last.bpm) };
      return { reading: { beatPos, bpm: handOver.bpm, source: 'tap' }, epoch: this._epoch, handOver };
    }
    let epoch = this._epoch;
    if (last) {
      const expected = ((t - last.t) / 60000) * Math.max(last.bpm, reading.bpm);
      const moved = reading.beatPos - last.beatPos;
      if (moved < -BACKWARD_JUMP_BEATS || moved > expected + FORWARD_JUMP_BEATS) epoch++;
    }
    return { reading, epoch, handOver: null };
  }

  // A stopped source hands its beat on to the free clock; only an unexplained jump starts an epoch.
  now(): MusicalTime {
    const t = this._now();
    const { reading, epoch, handOver } = this._next(t);
    if (handOver) this._free = handOver;
    this._epoch = epoch;
    this._tookOver = false;

    const tempo = Math.round(reading.bpm * 100) / 100;
    if (this._reportedBpm === null || Math.abs(tempo - this._reportedBpm) >= 0.05) {
      this._reportedBpm = tempo;
      this._onTempo(tempo);
    }

    this._last = { ...reading, t };
    return { ...reading, epoch: this._epoch };
  }

  /** Anchors a pattern to when its scene was scheduled, not when it fired. */
  beatAtTrackMs(ms: unknown): number | null {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
    const { source } = this._current(this._now());
    if (source === 'auto') return beatPositionAt(this._autoSource()?.grid, ms);
    if (source === 'track') return beatPositionAt(this._track?.grid, ms);
    return null;
  }

  /** For the MIDI clock: moves nothing, so the engine's next reading is unchanged. */
  peek(): ClockReading {
    return this._next(this._now()).reading;
  }

  /** For screens that keep their own beat in phase with the rig; moves nothing, like peek(). */
  phase(): { beatPos: number; epoch: number } {
    const { reading, epoch } = this._next(this._now());
    return { beatPos: reading.beatPos, epoch };
  }

  /** As the engine reads next, so a tap, typed tempo or switch shows at once. */
  status(): { source: ClockSource; bpm: number } {
    const { reading } = this._next(this._now());
    return { source: reading.source, bpm: Math.round(reading.bpm * 10) / 10 };
  }
}

// The server has one clock. Tests make their own.
const conductor = new Conductor();

export {
  Conductor,
  conductor,
  BACKWARD_JUMP_BEATS,
  FORWARD_JUMP_BEATS,
  STALL_MS,
};
