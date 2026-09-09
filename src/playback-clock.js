'use strict';

/**
 * A monotonic playback clock that converges on observations instead of
 * snapping to them.
 *
 * Every position source the show can follow reports in coarse, jittery
 * samples: Spotify's Web API answers roughly once a second with a value that
 * was already a network round trip old, and the OS media session quantises to
 * its own poll interval. The obvious way to use them —
 *
 *     position = lastReported + (now - whenReported)
 *
 * — re-anchors on every sample, so each one drags the show forward or backward
 * by however much that sample happened to be off. At 1 Hz that is a visible
 * stutter, and it can run *backwards*, which means the timeline cursor
 * re-crosses events it has already fired.
 *
 * This class keeps its own clock and treats each observation as a correction
 * rather than as the truth:
 *
 *   small error   run the clock a few percent fast or slow until the error is
 *                 absorbed. The position never jumps and never reverses.
 *   large error   a seek, a track change, or a resume from pause — there is no
 *                 correcting that gradually, so snap and start again.
 *
 * The result is a clock that is linear between observations and continuous
 * across them, which is what a beat-synchronised show needs: cues land where
 * the music is, not where the last poll said it was.
 */

const DEFAULTS = {
  /**
   * Error beyond which the clock snaps instead of slewing, in milliseconds.
   * Below this is jitter to be smoothed; above it is a real discontinuity, and
   * slewing towards it would leave the show wrong for the whole absorption.
   */
  snapThresholdMs: 1200,
  /**
   * How long the clock aims to take to absorb an error, in milliseconds.
   * Shorter converges faster and runs further from real speed while it does.
   */
  absorbMs: 2000,
  /**
   * Hard cap on how far from real time the clock will run, as a ratio.
   * 0.05 is five percent — about 23 ms per beat at 128 BPM, and only while a
   * correction is in flight. Past roughly a tenth the correction itself starts
   * to read as the show rushing.
   */
  maxSlew: 0.05,
  /**
   * After this long with no observation the clock stops correcting and runs at
   * real time. A source that has gone quiet should not leave the clock
   * permanently running fast on the strength of its last correction.
   */
  staleMs: 5000,
};


class PlaybackClock {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.reset();
  }

  /** Forget everything. The next observation is taken as ground truth. */
  reset() {
    this._basePositionMs = 0;
    this._baseAt = 0;
    this._rate = 1;
    this._playing = false;
    this._haveFix = false;
    this._lastObservedAt = 0;
    this._lastErrorMs = 0;
    this._snaps = 0;
  }

  /** Has the clock been given anything to work from? */
  get hasFix() { return this._haveFix; }

  get isPlaying() { return this._playing; }

  /** Signed error of the most recent observation, in milliseconds. */
  get driftMs() { return this._lastErrorMs; }

  /** Current speed as a ratio of real time. 1 is exact. */
  get rate() { return this._rate; }

  /** How many times the clock has had to snap. A rising count means the
   *  source is reporting discontinuities, not jitter. */
  get snaps() { return this._snaps; }

  /**
   * Where the show is now, in milliseconds.
   *
   * Paused holds still. Running advances at `rate`, which is within a few
   * percent of real time and only ever positive — so this is monotonic between
   * snaps, and the timeline cursor can never re-cross an event it has fired.
   */
  positionMs(now = Date.now()) {
    if (!this._haveFix) return 0;
    if (!this._playing) return this._basePositionMs;
    const elapsed = Math.max(0, now - this._baseAt);
    if (this._rate === 1) return this._basePositionMs + elapsed;

    // A correction expires after `staleMs` without a new observation, and the
    // expiry has to be piecewise rather than a change of multiplier: switching
    // the rate under a fixed anchor would move the reported position at that
    // instant, which is the one thing this class promises never to do. So the
    // corrected stretch is closed off at the expiry and real time continues
    // from there.
    const correctedFor = Math.max(0, Math.min(
      elapsed, this._lastObservedAt + this.options.staleMs - this._baseAt));
    const afterwards = elapsed - correctedFor;
    return this._basePositionMs + correctedFor * this._rate + afterwards;
  }

  /**
   * Feed in what a source reports.
   *
   * @param {number} observedMs  the source's idea of the current position
   * @param {object} [meta]
   * @param {boolean} [meta.isPlaying]  defaults to the clock's current state
   * @param {number}  [meta.at]         when the observation was true; defaults
   *   to now. Pass the time the sample was taken rather than the time it
   *   arrived when the two differ — for a polled HTTP API they differ by the
   *   whole round trip.
   * @returns {'snap'|'slew'|'hold'} what the clock did with it.
   */
  observe(observedMs, meta = {}) {
    const at = Number.isFinite(meta.at) ? meta.at : Date.now();
    const position = Math.max(0, Number(observedMs) || 0);
    const playing = meta.isPlaying === undefined ? this._playing : !!meta.isPlaying;

    this._lastObservedAt = at;

    // Nothing to correct against, or a transition that is discontinuous by
    // definition: take the observation as given.
    if (!this._haveFix || playing !== this._playing) {
      this._snap(position, playing, at);
      return 'snap';
    }

    if (!playing) {
      // Paused: the position should not be moving, so any change is the truth
      // rather than an error to absorb.
      this._basePositionMs = position;
      this._baseAt = at;
      this._lastErrorMs = 0;
      return 'hold';
    }

    const predicted = this.positionMs(at);
    const error = position - predicted;
    this._lastErrorMs = error;

    if (Math.abs(error) >= this.options.snapThresholdMs) {
      this._snap(position, playing, at);
      return 'snap';
    }

    // Re-anchor on the *predicted* position, not the observed one, and put the
    // correction into the rate. Anchoring on the observation would be the jump
    // this class exists to avoid.
    this._basePositionMs = predicted;
    this._baseAt = at;
    this._rate = this._clampRate(1 + error / this.options.absorbMs);
    return 'slew';
  }

  /**
   * Tell the clock playback stopped, without a position. Freezes where it is.
   * `observe` handles the usual case; this is for a source that reports a stop
   * with no number attached.
   */
  pause(now = Date.now()) {
    if (!this._haveFix) return;
    this._basePositionMs = this.positionMs(now);
    this._baseAt = now;
    this._playing = false;
    this._rate = 1;
  }

  _snap(positionMs, playing, at) {
    this._basePositionMs = positionMs;
    this._baseAt = at;
    this._playing = playing;
    this._rate = 1;
    this._lastErrorMs = 0;
    if (this._haveFix) this._snaps++;
    this._haveFix = true;
  }

  _clampRate(rate) {
    const { maxSlew } = this.options;
    return Math.max(1 - maxSlew, Math.min(1 + maxSlew, rate));
  }

  /** A snapshot for the UI and for logs. */
  getStatus() {
    return {
      hasFix: this._haveFix,
      isPlaying: this._playing,
      positionMs: Math.round(this.positionMs()),
      driftMs: Math.round(this._lastErrorMs),
      rate: Number(this._rate.toFixed(4)),
      snaps: this._snaps,
    };
  }
}

module.exports = PlaybackClock;
module.exports.DEFAULTS = DEFAULTS;
