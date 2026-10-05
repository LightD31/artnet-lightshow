import { beatPositionAt, localBpm } from '../shared/beat-clock.ts';
import { TEMPO_MODES } from './presets.ts';
import type { BeatGrid } from '../shared/beat-clock.ts';

/**
 * The Conductor: the one clock every pattern keeps time by.
 *
 * It answers a single question each frame — where are we in the music, in
 * beats? — from the best source available, in this order:
 *
 *   auto   the auto show is running: its track's analysed beat grid, read at
 *          the show's position (sync offset and all). The pattern steps land
 *          on the same beats the analyser found, so a drummer who pushes the
 *          chorus or a DJ who pitches the track is followed exactly.
 *   cdj    PRO DJ LINK is on and the master deck is playing: the deck's own
 *          beat position, through rekordbox's grid.
 *   track  the auto show is off, but the track playing has a cached analysis:
 *          manual patterns lock to its grid too.
 *   live   the live input hears the music and has found its beat: the grid
 *          it keeps (see live-input.ts), for a track nothing else knows.
 *   tap    none of those: a free-running clock at the operator's BPM, set by
 *          tap tempo, BPM entry or MIDI.
 *
 * A tap, a typed BPM or a nudge while a deck, a track or the live input leads
 * takes the tempo by hand: the clock reads `tap` at that tempo, so the BPM
 * read-out is the tempo the rig runs at. The hand holds off that source and
 * those below it until the music it was taken from moves on — the next
 * track; the master deck loading a new track, or another deck becoming the
 * master; the live input losing its beat and finding a new one — and then
 * the clock follows again. The auto show's grid is never taken by hand.
 *
 * That is the `auto` tempo mode, automatic tempo match. In `manual` the
 * operator keeps the tempo: the deck, the track and the live input are not
 * listened to, and the free clock runs at the tapped or typed BPM. The auto
 * show's grid still leads while the show runs, because its scenes are
 * scheduled on that grid; held off it, they would land between the beats.
 *
 * A source that stops answering hands over to the free clock at the beat
 * position and tempo it had reached, so stopping the auto show mid-song does
 * not make the rig lurch — the chase carries on in time until someone changes
 * it. A paused track counts as stopped: its position stands still, and a rig
 * frozen on one step for the length of a pause looks broken, where carrying on
 * at the song's tempo looks like the show waiting for the music. Any real
 * discontinuity (a seek, a new track, a different source taking over) bumps
 * `epoch`, which tells the engine to re-anchor its patterns rather than wait
 * for a beat position that has just jumped away from them.
 */

// A reading that moves back by more than this, or forward by this much more
// than the elapsed time explains, is a discontinuity rather than jitter.
const BACKWARD_JUMP_BEATS = 0.25;
const FORWARD_JUMP_BEATS = 2;

// A track whose position has not moved for this long is paused, not playing.
// Longer than any gap between two frames, shorter than a beat at any tempo.
const STALL_MS = 200;

const clampBpm = (bpm: number): number => Math.max(20, Math.min(300, bpm));

/** What the clock is locked to. */
export type ClockSource = 'auto' | 'cdj' | 'track' | 'live' | 'tap';

/** Whether the clock follows the music (`auto`) or the operator's tempo (`manual`). */
export type TempoMode = typeof TEMPO_MODES[number];

/** Where the music is, in beats, and at what tempo. */
export interface ClockReading {
  beatPos: number;
  bpm: number;
  source: ClockSource;
  /** The beat the running scene was scheduled on, when the source knows it. */
  anchorBeat?: number;
}

/** A reading, with the epoch that changes at every discontinuity. */
export interface MusicalTime extends ClockReading {
  epoch: number;
}

/** The auto show's clock while it runs. */
export interface AutoClock {
  grid: BeatGrid | null;
  positionMs: number;
  /** When the scene now playing was scheduled, in track time. */
  anchorMs?: number | null;
}

/** A deck's clock while it plays, or the live input's while it hears a beat. */
export interface DeckClock {
  beatPos: number;
  bpm?: number | null;
  /**
   * What is followed: the deck and its track, or the live input's lock. A
   * tempo taken by hand from the source holds until this changes.
   */
  key?: string | number | null;
}

// The sources the clock follows of its own accord, best first. A tempo taken
// by hand from one holds off it and every one after it.
const FOLLOWED = ['cdj', 'track', 'live'] as const;
type Followed = typeof FOLLOWED[number];

const isFollowed = (source: ClockSource): source is Followed => (FOLLOWED as readonly string[]).includes(source);

/** A tempo the operator took by hand: from which source, and what it was following then. */
interface Hand {
  source: Followed;
  key: string | number | null | undefined;
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

  /**
   * `fn()` → `{ grid, positionMs, anchorMs? }` while the auto show is running,
   * else null. `anchorMs` is when the scene now playing was scheduled.
   */
  setAutoSource(fn: (() => AutoClock | null) | null | undefined): void { this._autoSource = typeof fn === 'function' ? fn : () => null; }

  /** `fn()` → `{ beatPos, bpm }` while a master deck is playing, else null. */
  setProlinkSource(fn: (() => DeckClock | null) | null | undefined): void { this._prolinkSource = typeof fn === 'function' ? fn : () => null; }

  /** `fn()` → `{ beatPos, bpm }` while the live input hears a beat, else null. */
  setLiveSource(fn: (() => DeckClock | null) | null | undefined): void { this._liveSource = typeof fn === 'function' ? fn : () => null; }

  /**
   * Lock manual patterns to a playing track. A different track clears any
   * override the operator set on the last one; the same track keeps it.
   */
  setTrack({ key, grid, positionMs }: {
    key?: string | null;
    grid?: BeatGrid | null;
    positionMs?: () => number;
  } = {}): void {
    if (!grid || typeof positionMs !== 'function') return this.clearTrack({ key });
    if (!this._track || this._track.key !== key) this._nextTrack();
    this._track = { key, grid, positionMs };
  }

  /** No lockable track is playing. `key` names the track that is, if any. */
  clearTrack({ key = null }: { key?: string | null } = {}): void {
    if (!this._track || this._track.key !== key) this._nextTrack();
    this._track = null;
  }

  /** The next track: the operator's override on the last one, and a tempo taken by hand from it, end. */
  _nextTrack(): void {
    this._override = false;
    if (this._hand?.source === 'track') this._hand = null;
  }

  get trackKey(): string | null | undefined { return this._track ? this._track.key : null; }

  get tempoMode(): TempoMode { return this._tempoMode; }

  /**
   * Follow the music, or keep the operator's tempo. Only this switch decides;
   * a tap or a typed BPM never flips it.
   *
   * To `manual`, the source being followed stops answering, and the free
   * clock takes over the way it does when any source stops: at the beat and
   * tempo the clock had reached. Back to `auto`, the best source answering
   * takes over, with a new epoch only if its count is not the free clock's.
   * Either way the reading is taken at once, so the hand-over is done before
   * a BPM sent straight after the switch, and `status()` tells the truth.
   */
  setTempoMode(mode: unknown): void {
    if (!TEMPO_MODES.includes(mode as TempoMode) || mode === this._tempoMode) return;
    this._tempoMode = mode as TempoMode;
    // Following again means following: a tap that took the tempo from this
    // track or any other source, in either mode, no longer holds it off.
    if (mode === 'auto') {
      this._override = false;
      this._hand = null;
    }
    // Said again even if unchanged: a BPM typed while the music led moved the
    // read-out but not the clock, and the nudges start from the read-out.
    this._reportedBpm = null;
    this.now();
  }

  /**
   * Called with the clock's tempo, to a hundredth, whenever it moves by a
   * twentieth of a BPM or more: the song's while one is followed, the one the
   * free clock carried on at when it stopped, the operator's otherwise. The
   * server keeps its BPM read-out on it, so a ±1 nudge moves from the tempo
   * the rig is actually running at.
   */
  onTempo(fn: ((bpm: number) => void) | null | undefined): void { this._onTempo = typeof fn === 'function' ? fn : () => {}; }

  _freeBeatAt(t: number): number {
    const f = this._free;
    return f.running ? f.beatPos + ((t - f.at) / 60000) * f.bpm : f.beatPos;
  }

  /**
   * The operator's tempo. Keeps the phase: the free clock is re-anchored at
   * where it is now, so a nudge speeds the pattern up from this beat rather
   * than jumping it. `manual` (the default) means a person set it, which takes
   * the tempo by hand from a deck, a track or the live input; the auto show's
   * own tempo marks do not.
   */
  setBpm(bpm: unknown, { manual = true } = {}): void {
    const value = Number(bpm);
    if (!Number.isFinite(value)) return;
    const t = this._now();
    const current = this._current(t);
    const takesOver = manual && isFollowed(current.source);
    // Taking over starts from the beat the music is on, not from wherever the
    // idle free clock had wandered to.
    const beatPos = takesOver ? current.beatPos : this._freeBeatAt(t);
    this._free = { ...this._free, at: t, beatPos, bpm: clampBpm(value) };
    if (manual && this._track) this._override = true;
    if (takesOver) this._takeHand(current.source as Followed);
    // Under the auto show's grid a typed tempo moves nothing, but the server
    // has already shown it: say the grid's tempo again, so the read-out does
    // not keep a tempo the rig is not running at.
    else if (manual && current.source === 'auto') this._reportedBpm = null;
  }

  /** Take the tempo by hand from `source`, remembering what it was following. */
  _takeHand(source: Followed): void {
    const reading = source === 'cdj' ? this._prolinkSource() : source === 'live' ? this._liveSource() : null;
    this._hand = { source, key: source === 'track' ? this._track?.key : reading?.key };
    this._tookOver = true;
  }

  /**
   * A tap is a beat. The free clock jumps to the next whole beat, so the step
   * lands on the tap as it always has, and a deck, a track or the live input
   * hands the tempo over by hand — at the music's tempo, until a second tap
   * says otherwise.
   */
  tap(): void {
    const t = this._now();
    const current = this._current(t);
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

  /** Stopping the patterns freezes the free clock where it is. */
  setRunning(running: unknown): void {
    const t = this._now();
    this._free = { ...this._free, at: t, beatPos: this._freeBeatAt(t), running: !!running };
  }

  /** Whether a grid source's position is still moving, i.e. not paused. */
  _moving(source: string, positionMs: number, t: number): boolean {
    const still = this._still[source];
    if (!still || Math.abs(positionMs - still.positionMs) > 0.5) {
      this._still[source] = { positionMs, since: t };
      return true;
    }
    return t - still.since < STALL_MS;
  }

  /**
   * A reading off a beat grid, or null when the position is unusable or
   * paused. `anchorMs`, when the source knows it, is when the running scene
   * was scheduled: carried as `anchorBeat` for re-anchoring after a jump.
   */
  _gridReading(source: 'auto' | 'track', grid: BeatGrid | null | undefined, positionMs: number | undefined,
    t: number, anchorMs: number | null | undefined = null): ClockReading | null {
    if (!grid || typeof positionMs !== 'number' || !Number.isFinite(positionMs)) {
      // Forget where it stood, so a show started later is not judged paused
      // for landing on the same position the last one stopped at.
      delete this._still[source];
      return null;
    }
    const beatPos = beatPositionAt(grid, positionMs);
    if (!Number.isFinite(beatPos) || !this._moving(source, positionMs, t)) return null;
    const reading: ClockReading = { beatPos, bpm: localBpm(grid, positionMs), source };
    if (typeof anchorMs === 'number' && Number.isFinite(anchorMs)) reading.anchorBeat = beatPositionAt(grid, anchorMs);
    return reading;
  }

  /** The reading from the best source that answers. */
  _current(t: number): ClockReading {
    const auto: Partial<AutoClock> = this._autoSource() || {};
    const fromAuto = this._gridReading('auto', auto.grid, auto.positionMs, t, auto.anchorMs);
    if (fromAuto) return fromAuto;
    // Held by hand: only the auto show's grid, above, leads the operator's tempo.
    if (this._tempoMode === 'manual') return { beatPos: this._freeBeatAt(t), bpm: this._free.bpm, source: 'tap' };
    // The followed sources from this one on are held off by a tempo taken by hand.
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

  /**
   * Where in FOLLOWED a tempo taken by hand starts holding sources off, or
   * past its end when none is. A deck or the live input that answers for
   * something else now — a new track or deck, a new lock — has moved on, and
   * the hand gives way to it; a track's hand ends with the next track
   * (_nextTrack).
   */
  _handFrom(): number {
    const hand = this._hand;
    if (!hand) return FOLLOWED.length;
    if (hand.source !== 'track') {
      const reading = hand.source === 'cdj' ? this._prolinkSource() : this._liveSource();
      if (reading && Number.isFinite(reading.beatPos) && reading.key !== hand.key) {
        this._hand = null;
        return FOLLOWED.length;
      }
    }
    return FOLLOWED.indexOf(hand.source);
  }

  /**
   * What now() reads at `t`, without doing it: the reading, its epoch, and the
   * free clock a source that has stopped answering hands over to.
   */
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

  /**
   * Where the music is now: `{ beatPos, bpm, source, epoch, anchorBeat? }`,
   * `anchorBeat` being the beat the running scene was scheduled on when the
   * source knows it.
   *
   * A locked source that stops answering hands over to the free clock, which
   * carries its beat position and tempo on. Any jump the elapsed time cannot
   * explain starts a new epoch — a seek, a new track, or a source whose count
   * has nothing to do with the last one's. A change of source that carries on
   * counting (the auto show stopping on a track the clock then follows on its
   * own) does not, so the chase does not restart for it.
   */
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

  /**
   * The beat position at a track time in the grid now driving, for anchoring
   * a pattern to the moment its scene was scheduled rather than the moment it
   * happened to fire. Null when no grid is driving.
   */
  beatAtTrackMs(ms: unknown): number | null {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
    const { source } = this._current(this._now());
    if (source === 'auto') return beatPositionAt(this._autoSource()?.grid, ms);
    if (source === 'track') return beatPositionAt(this._track?.grid, ms);
    return null;
  }

  /**
   * Where the music is now, without moving anything: no epoch, no hand-over
   * to the free clock, no tempo report. For readers other than the engine —
   * the MIDI clock — which must not change what the engine will read next.
   */
  peek(): ClockReading {
    return this._current(this._now());
  }

  /**
   * Where the beat is now and the epoch it belongs to, exactly as the engine's
   * next reading will find them, for screens that keep their own beat in
   * phase with the rig's. Moves nothing, like peek(); unlike it, a source that
   * has just stopped answering is carried on from, as now() is about to.
   */
  phase(): { beatPos: number; epoch: number } {
    const { reading, epoch } = this._next(this._now());
    return { beatPos: reading.beatPos, epoch };
  }

  /**
   * What the rig is locked to, for the UI: `{ source, bpm }`, as the engine's
   * next reading will find it — so a tap, a typed tempo or a switch shows at
   * once, not a frame later.
   */
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
