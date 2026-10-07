import { makeGrid, beatPositionAt } from './shared/beat-clock.ts';
import type { BeatGrid } from './shared/beat-clock.ts';
import type { BeatPacket, PositionPacket } from './prolink-packets.ts';

/**
 * One player on the PRO DJ LINK network, and where it is in its track.
 *
 * A deck is heard three ways, each better than the last:
 *
 *   status    about five times a second from every player: the track, play
 *             state, pitch, tempo, on-air and master flags, and the number of
 *             the beat the deck is in — but not where in it;
 *   beat      on every beat while it plays: the moment a beat starts, which
 *             pins the phase that status packets only bracket;
 *   position  every 30 ms from a CDJ-3000: the playhead itself, to the
 *             millisecond, through loops, scratches and needle jumps.
 *
 * Between packets the position runs on the monotonic clock at the deck's own
 * speed (its pitch, or standing still while paused), and each packet only
 * corrects it — see _reanchor for the status case. While position packets are
 * arriving they decide, and beat numbers and beat packets are only kept for
 * the tempo they carry.
 */

/** One CDJ status packet, as alphatheta-connect reports it. */
export interface CdjStatus {
  deviceId: number;
  trackId: number;
  trackDeviceId: number;
  trackSlot: number;
  trackType: number;
  isMaster: boolean;
  isOnAir?: boolean;
  trackBPM: number | null;
  effectivePitch: number;
  beatInMeasure: number;
  playState: number;
  beat: number | null;
}

/** One beat of rekordbox's grid. */
export interface BeatGridEntry {
  offset: number;
  count?: number;
  bpm: number;
}

/** Where a deck's position runs from. */
interface Anchor {
  posMs: number;
  at: number;
  rate: number;
}

// alphatheta-connect's CDJStatus.PlayState. A deck in any of these is not
// moving through its track: nothing loaded, loading, paused or cued, the
// platter held, spun down, or run off the end.
export const PlayState = {
  Empty: 0, Loading: 2, Playing: 3, Looping: 4, Paused: 5, Cued: 6, Cuing: 7,
  PlatterHeld: 8, Searching: 9, SpunDown: 14, Ended: 17,
} as const;
const STILL = new Set<number>([PlayState.Empty, PlayState.Loading, PlayState.Paused, PlayState.Cued,
  PlayState.PlatterHeld, PlayState.SpunDown, PlayState.Ended]);

/** A deck that has not reported for this long has gone away. */
export const STALE_PACKET_MS = 5000;
// Position packets come every 30 ms; after this without one, the deck has
// stopped sending them (ejected, or not a CDJ-3000 after all).
const ABSOLUTE_FRESH_MS = 250;
// A position packet this far from where the deck was expected to be is a
// jump — a loop, a cue, a scratch — and is taken as it is. Nearer, it is
// arrival jitter and only half of it is taken.
const ABSOLUTE_SNAP_MS = 60;
// Status packets come about five times a second. A beat that changed across a
// longer gap than this is placed at its start, not halfway into the gap.
const STATUS_CADENCE_MS = 1000;

export function isStill(playState: number): boolean {
  return STILL.has(playState);
}

class Deck {
  declare readonly deviceId: number;
  declare identity: string | null;
  declare trackId: number;
  declare trackDeviceId: number;
  declare trackSlot: number;
  declare trackType: number;
  declare playState: number;
  declare trackBpm: number;
  declare pitch: number;
  declare beatInMeasure: number;
  declare master: boolean;
  declare onAir: boolean;
  declare lastBeat: number | null;
  declare grid: BeatGridEntry[] | null;
  declare lastStatusAt: number;
  declare lastStatusPacketAt: number;
  declare lastPositionAt: number;
  declare lastBeatPacketAt: number;
  declare trackLengthMs: number;
  declare audibleSince: number | null;
  declare lastAudibleAt: number | null;
  declare _anchor: Anchor | null;
  declare _lastPlayhead: number | null;
  declare _clockGridFor: BeatGridEntry[] | null;
  declare _clockGridCache: BeatGrid | null;

  constructor(deviceId: number) {
    this.deviceId = deviceId;
    this.identity = null;
    this.trackId = 0;
    this.trackDeviceId = 0;
    this.trackSlot = 0;
    this.trackType = 0;
    this.playState = PlayState.Empty;
    this.trackBpm = 0;
    this.pitch = 0;
    this.beatInMeasure = 0;
    this.master = false;
    this.onAir = false;
    this.lastBeat = null;
    this.grid = null;
    this.lastStatusAt = 0;
    this.lastStatusPacketAt = 0;
    this.lastPositionAt = 0;
    this.lastBeatPacketAt = 0;
    this.trackLengthMs = 0;
    this.audibleSince = null;
    this.lastAudibleAt = null;
    this._anchor = null;
    this._lastPlayhead = null;
    this._clockGridFor = null;
    this._clockGridCache = null;
  }

  get hasTrack(): boolean { return this.identity !== null; }
  get playing(): boolean { return this.hasTrack && !isStill(this.playState); }
  /** The tempo the room hears: the track's, pitched. */
  get bpm(): number { return this.trackBpm > 0 ? this.trackBpm * (1 + this.pitch / 100) : 0; }

  isStale(now: number): boolean {
    return this.lastStatusAt > 0 && now - this.lastStatusAt > STALE_PACKET_MS;
  }

  /** Whether CDJ-3000 position packets are what the position follows. */
  isAbsolute(now: number): boolean {
    return this.lastPositionAt > 0 && now - this.lastPositionAt <= ABSOLUTE_FRESH_MS;
  }

  /** Whether beat packets are arriving, which makes them the phase to trust. */
  hasBeatPackets(now: number): boolean {
    const beatMs = this.trackBpm > 0 ? 60000 / this.trackBpm : 500;
    return this.lastBeatPacketAt > 0 && now - this.lastBeatPacketAt <= 2 * beatMs + 100;
  }

  /** The deck's speed through its track right now: its pitch, or still. */
  _rate(): number {
    return this.playing ? 1 + this.pitch / 100 : 0;
  }

  /** Position in ms within the loaded track. */
  positionMs(now: number): number {
    const a = this._anchor;
    if (!a) return 0;
    return a.posMs + (now - a.at) * a.rate;
  }

  /** Run on from here at `rate`, from the position reached by `now`. */
  _rebase(now: number, rate: number): void {
    if (this._anchor) this._anchor = { posMs: this.positionMs(now), at: now, rate };
  }

  /**
   * Fold in a status packet. Returns whether the deck now has a different
   * track (or none).
   */
  status(s: CdjStatus, now: number): { trackChanged: boolean } {
    const identity = s.trackId ? `${s.trackDeviceId}:${s.trackSlot}:${s.trackId}` : null;
    const trackChanged = identity !== this.identity;
    if (trackChanged) this._loadTrack(identity, s);
    const previousStatusAt = this.lastStatusPacketAt;
    this.lastStatusAt = now;
    this.lastStatusPacketAt = now;

    this.master = !!s.isMaster;
    this.onAir = !!s.isOnAir;
    const trackBpm = typeof s.trackBPM === 'number' && Number.isFinite(s.trackBPM) ? s.trackBPM : 0;
    const pitch = typeof s.effectivePitch === 'number' && Number.isFinite(s.effectivePitch) ? s.effectivePitch : 0;
    this.beatInMeasure = s.beatInMeasure || 0;

    // Stopping or starting: the position reached so far is where it runs on
    // from, at the new speed.
    const wasStill = isStill(this.playState);
    this.playState = s.playState;
    this.trackBpm = trackBpm;
    this.pitch = pitch;
    if (wasStill !== isStill(s.playState) || (!this.isAbsolute(now) && this._anchor?.rate !== this._rate())) {
      this._rebase(now, this._rate());
    }

    const beat = s.beat;
    if (typeof beat !== 'number' || beat <= 0) return { trackChanged };
    const beatChanged = beat !== this.lastBeat;
    this.lastBeat = beat;
    if (this.isAbsolute(now)) return { trackChanged };
    if (isStill(s.playState)) {
      // A cue jump while paused moves the deck without playing it.
      if (beatChanged || !this._anchor) this._anchor = { posMs: this.beatMs(beat), at: now, rate: 0 };
    } else {
      this._anchor = this._reanchor({ beat, beatChanged, now, previousPacketAt: previousStatusAt, rate: this._rate() });
    }
    return { trackChanged };
  }

  _loadTrack(identity: string | null, s: CdjStatus): void {
    this.identity = identity;
    this.trackId = s.trackId || 0;
    this.trackDeviceId = s.trackDeviceId;
    this.trackSlot = s.trackSlot;
    this.trackType = s.trackType;
    this.lastBeat = null;
    this.grid = null;
    this.trackLengthMs = 0;
    this._anchor = null;
    this._lastPlayhead = null;
    this.audibleSince = null;
    this.lastAudibleAt = null;
  }

  /**
   * A beat starts now. The status packets said which beat the deck is in; this
   * says when it began, which they cannot. The deck is placed on whichever
   * beat of the grid it was nearest to, unless it was more than half a beat
   * from any — then the status packets have not caught up with a jump yet,
   * and the beat is left to them.
   */
  beatPacket(p: BeatPacket, now: number): void {
    this.lastBeatPacketAt = now;
    this.lastStatusAt = Math.max(this.lastStatusAt, now);
    if (p.trackBpm) this.trackBpm = p.trackBpm;
    if (Number.isFinite(p.pitch)) this.pitch = p.pitch;
    if (p.beatInBar >= 1 && p.beatInBar <= 4) this.beatInMeasure = p.beatInBar;
    if (!this._anchor || !this.playing || this.isAbsolute(now)) return;
    const predicted = this.positionMs(now);
    const edge = this._nearestBeatMs(predicted);
    if (edge === null) return;
    if (Math.abs(predicted - edge.ms) <= edge.span / 2) {
      this._anchor = { posMs: edge.ms, at: now, rate: this._rate() };
    }
  }

  /**
   * The playhead, from a CDJ-3000. Arrival jitter of a few milliseconds is
   * halved rather than followed; anything bigger is the DJ moving the track,
   * and is taken as it comes.
   */
  positionPacket(p: PositionPacket, now: number): void {
    this.lastPositionAt = now;
    this.lastStatusAt = Math.max(this.lastStatusAt, now);
    if (p.trackLengthSec > 0) this.trackLengthMs = p.trackLengthSec * 1000;
    if (Number.isFinite(p.pitch)) this.pitch = p.pitch;
    const previous = this._lastPlayhead;
    this._lastPlayhead = p.playheadMs;
    // Which way the playhead is going, from the last packet 30 ms ago: a
    // deck playing in reverse runs its position backwards.
    const step = previous === null ? 0 : p.playheadMs - previous;
    const direction = step < 0 && step > -250 ? -1 : 1;
    const rate = this._rate() * direction;
    const predicted = this._anchor ? this.positionMs(now) : null;
    const posMs = predicted === null || Math.abs(p.playheadMs - predicted) > ABSOLUTE_SNAP_MS
      ? p.playheadMs
      : predicted + (p.playheadMs - predicted) / 2;
    this._anchor = { posMs, at: now, rate };
  }

  /**
   * Fold one status packet's beat number into the running position.
   *
   * A status packet arrives about five times a second and names the beat the
   * deck is in, not where in it. Taking the packet's arrival as the start of
   * the beat snaps the position back to the top of the beat on every packet:
   * a sawtooth the size of a packet interval, five times a second, each step
   * far enough backwards to make the show re-seek.
   *
   * Instead the position keeps running at the deck's own speed and a packet
   * only corrects it:
   *
   *   - still inside the reported beat: left alone — the normal case;
   *   - within a beat of it: pulled back to its nearer edge, which removes
   *     drift without restarting anything — unless beat packets are arriving,
   *     which know the phase better than a status packet that may be a
   *     little late, and it is left to them;
   *   - further off (a seek, a loop, a new track, the first packet): placed at
   *     the reported beat, plus half the time since the previous packet when
   *     the beat has only just changed — the boundary fell somewhere in that
   *     gap, and its middle is the unbiased guess.
   */
  _reanchor({ beat, beatChanged, now, previousPacketAt, rate }: {
    beat: number;
    beatChanged: boolean;
    now: number;
    previousPacketAt: number;
    rate: number;
  }): Anchor {
    const lo = this.beatMs(beat);
    const hi = this.beatMs(beat + 1);
    const span = Math.max(1, hi - lo);
    const predicted = this._anchor ? this.positionMs(now) : null;

    let posMs: number;
    if (predicted != null && predicted >= lo - span && predicted <= hi + span) {
      posMs = this.hasBeatPackets(now) ? predicted : Math.min(Math.max(predicted, lo), hi);
    } else {
      const gap = now - previousPacketAt;
      const sinceBoundary = beatChanged && previousPacketAt && gap < STATUS_CADENCE_MS
        ? Math.min(span, (gap / 2) * rate)
        : 0;
      posMs = lo + sinceBoundary;
    }
    return { posMs, at: now, rate };
  }

  /**
   * Beat `n` (counted from 1, as the deck counts) in ms within the track:
   * rekordbox's grid when there is one, else the track's own tempo — not the
   * pitched one, since pitch changes how fast the deck moves through the
   * track, not where its beats are.
   */
  beatMs(n: number): number {
    const grid = this.grid;
    if (!grid || !grid.length) {
      const bpm = this.trackBpm > 0 ? this.trackBpm : 120;
      return Math.max(0, (n - 1) * (60000 / bpm));
    }
    if (n <= 1) return grid[0].offset || 0;
    if (n > grid.length) {
      const last = grid[grid.length - 1];
      const bpm = last.bpm > 0 ? last.bpm : (this.trackBpm || 120);
      return last.offset + (n - grid.length) * (60000 / bpm);
    }
    return grid[n - 1].offset;
  }

  /** The beat edge nearest `ms`, and the length of the beat around it. */
  _nearestBeatMs(ms: number): { ms: number; span: number } | null {
    const grid = this.grid;
    if (!grid || grid.length < 2) {
      if (!(this.trackBpm > 0)) return null;
      const span = 60000 / this.trackBpm;
      return { ms: Math.max(0, Math.round(ms / span)) * span, span };
    }
    let lo = 0;
    let hi = grid.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (grid[mid].offset < ms) lo = mid + 1; else hi = mid;
    }
    const after = lo;
    const before = Math.max(0, after - 1);
    const pick = Math.abs(grid[before].offset - ms) <= Math.abs(grid[after].offset - ms) ? before : after;
    const span = pick + 1 < grid.length
      ? grid[pick + 1].offset - grid[pick].offset
      : grid[pick].offset - grid[pick - 1].offset;
    return { ms: grid[pick].offset, span: Math.max(1, span) };
  }

  /** rekordbox's grid in the shape beat-clock reads, built once per track. */
  clockGrid(): BeatGrid | null {
    const source = this.grid;
    if (!Array.isArray(source) || source.length < 2) return null;
    if (this._clockGridFor !== source) {
      this._clockGridFor = source;
      this._clockGridCache = makeGrid(source.map((b) => Number(b && b.offset) / 1000));
    }
    return this._clockGridCache;
  }

  /**
   * Where the deck is in beats, for the pattern clock: `{ beatPos, bpm }`, or
   * null unless it is playing and still reporting. Read through rekordbox's
   * grid, so the steps land on the beats the DJ sees; without one yet it is
   * counted at the track's tempo.
   */
  beatReading(now: number): { beatPos: number; bpm: number | null } | null {
    if (!this.hasTrack || !this._anchor || !this.playing || this.isStale(now)) return null;
    const posMs = this.positionMs(now);
    if (!Number.isFinite(posMs)) return null;
    const grid = this.clockGrid();
    let beatPos: number;
    if (grid) beatPos = beatPositionAt(grid, posMs);
    else if (this.trackBpm > 0) beatPos = (posMs / 60000) * this.trackBpm;
    else return null;
    if (!Number.isFinite(beatPos)) return null;
    return { beatPos, bpm: this.bpm > 0 ? this.bpm : null };
  }
}

export default Deck;
