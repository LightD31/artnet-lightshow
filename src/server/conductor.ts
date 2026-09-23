import { beatPositionAt, localBpm } from '../shared/beat-clock.ts';
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
 *          manual patterns lock to its grid too. A tap or a typed BPM takes
 *          the tempo back by hand until the next track.
 *   live   the live input hears the music and has found its beat: the grid
 *          it keeps (see live-input.ts), for a track nothing else knows.
 *   tap    none of those: a free-running clock at the operator's BPM, set by
 *          tap tempo, BPM entry or MIDI.
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
    if (!this._track || this._track.key !== key) this._override = false;
    this._track = { key, grid, positionMs };
  }

  /** No lockable track is playing. `key` names the track that is, if any. */
  clearTrack({ key = null }: { key?: string | null } = {}): void {
    if (!this._track || this._track.key !== key) this._override = false;
    this._track = null;
  }

  get trackKey(): string | null | undefined { return this._track ? this._track.key : null; }

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
   * the tempo back from a locked track; a tempo reported by a CDJ does not.
   */
  setBpm(bpm: unknown, { manual = true } = {}): void {
    const value = Number(bpm);
    if (!Number.isFinite(value)) return;
    const t = this._now();
    const current = this._current(t);
    const takesOver = manual && current.source === 'track';
    // Taking over from a locked track starts from the beat the music is on,
    // not from wherever the idle free clock had wandered to.
    const beatPos = takesOver ? current.beatPos : this._freeBeatAt(t);
    this._free = { ...this._free, at: t, beatPos, bpm: clampBpm(value) };
    if (manual && this._track) this._override = true;
    if (takesOver) this._tookOver = true;
  }

  /**
   * A tap is a beat. The free clock jumps to the next whole beat, so the step
   * lands on the tap as it always has, and a locked track hands the tempo over
   * — at the song's tempo, until a second tap says otherwise.
   */
  tap(): void {
    const t = this._now();
    const current = this._current(t);
    const takesOver = current.source === 'track';
    this._free = {
      ...this._free,
      at: t,
      beatPos: Math.floor(current.beatPos + 1e-9) + 1,
      bpm: takesOver ? clampBpm(current.bpm) : this._free.bpm,
    };
    if (this._track) this._override = true;
    if (takesOver) this._tookOver = true;
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
    const cdj = this._prolinkSource();
    if (cdj && Number.isFinite(cdj.beatPos)) {
      const bpm = typeof cdj.bpm === 'number' && Number.isFinite(cdj.bpm) && cdj.bpm > 0 ? cdj.bpm : this._free.bpm;
      return { beatPos: cdj.beatPos, bpm, source: 'cdj' };
    }
    const track = this._track && !this._override ? this._track : null;
    const fromTrack = this._gridReading('track', track && track.grid, track ? track.positionMs() : NaN, t);
    if (fromTrack) return fromTrack;
    const live = this._liveSource();
    if (live && Number.isFinite(live.beatPos) && typeof live.bpm === 'number' && live.bpm > 0) {
      return { beatPos: live.beatPos, bpm: live.bpm, source: 'live' };
    }
    return { beatPos: this._freeBeatAt(t), bpm: this._free.bpm, source: 'tap' };
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
    let reading = this._current(t);
    const last = this._last;

    if (last && reading.source === 'tap' && last.source !== 'tap' && !this._tookOver) {
      // A locked source stopped answering: carry on from where it was.
      const beatPos = last.beatPos + ((t - last.t) / 60000) * last.bpm;
      this._free = { ...this._free, at: t, beatPos, bpm: clampBpm(last.bpm) };
      reading = this._current(t);
    } else if (last) {
      const expected = ((t - last.t) / 60000) * Math.max(last.bpm, reading.bpm);
      const moved = reading.beatPos - last.beatPos;
      if (moved < -BACKWARD_JUMP_BEATS || moved > expected + FORWARD_JUMP_BEATS) this._epoch++;
    }
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

  /** What the rig is locked to, for the UI: `{ source, bpm }`. */
  status(): { source: ClockSource; bpm: number } {
    const reading = this._last || this._current(this._now());
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
