// Slew small observation errors so polling jitter cannot replay timeline events.

export interface PlaybackClockOptions {
  snapThresholdMs: number;
  absorbMs: number;
  maxSlew: number;
  staleMs: number;
}

export interface Observation {
  isPlaying?: boolean;
  at?: number;
  now?: number;
}

export interface PlaybackClockStatus {
  hasFix: boolean;
  isPlaying: boolean;
  positionMs: number;
  driftMs: number;
  rate: number;
  snaps: number;
}

const DEFAULTS: PlaybackClockOptions = {
  // Snap large errors because gradually absorbing a real seek would leave the show out of sync.
  snapThresholdMs: 1200,
  absorbMs: 2000,
  maxSlew: 0.05,
  staleMs: 5000,
};

class PlaybackClock {
  declare options: PlaybackClockOptions;
  declare _basePositionMs: number;
  declare _baseAt: number;
  declare _rate: number;
  declare _playing: boolean;
  declare _haveFix: boolean;
  declare _lastObservedAt: number;
  declare _lastErrorMs: number;
  declare _snaps: number;

  constructor(options: Partial<PlaybackClockOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.reset();
  }

  reset(): void {
    this._basePositionMs = 0;
    this._baseAt = 0;
    this._rate = 1;
    this._playing = false;
    this._haveFix = false;
    this._lastObservedAt = 0;
    this._lastErrorMs = 0;
    this._snaps = 0;
  }

  get hasFix(): boolean { return this._haveFix; }

  get isPlaying(): boolean { return this._playing; }

  get driftMs(): number { return this._lastErrorMs; }

  get rate(): number { return this._rate; }

  get snaps(): number { return this._snaps; }

  // Positive rates keep the cursor monotonic between explicit snaps.
  positionMs(now = Date.now()): number {
    if (!this._haveFix) return 0;
    if (!this._playing) return this._basePositionMs;
    const elapsed = Math.max(0, now - this._baseAt);
    if (this._rate === 1) return this._basePositionMs + elapsed;

    // Close the corrected interval at expiry so changing the rate does not jump the position.
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
   * @param {number}  [meta.now]        when the observation arrived; defaults
   *   to `at`. The error is measured at `at`, but the correction starts from
   *   `now`: re-anchoring back at `at` would apply the new speed to time that
   *   has already been read out, and the position could step backwards.
   * @returns {'snap'|'slew'|'hold'} what the clock did with it.
   */
  observe(observedMs: unknown, meta: Observation = {}): 'snap' | 'slew' | 'hold' {
    const at = typeof meta.at === 'number' && Number.isFinite(meta.at) ? meta.at : Date.now();
    const now = typeof meta.now === 'number' && Number.isFinite(meta.now) ? Math.max(meta.now, at) : at;
    const position = Math.max(0, Number(observedMs) || 0);
    const playing = meta.isPlaying === undefined ? this._playing : !!meta.isPlaying;

    this._lastObservedAt = now;

    if (!this._haveFix || playing !== this._playing) {
      this._snap(playing ? position + (now - at) : position, playing, now);
      return 'snap';
    }

    if (!playing) {
      this._basePositionMs = position;
      this._baseAt = now;
      this._lastErrorMs = 0;
      return 'hold';
    }

    const error = position - this.positionMs(at);
    this._lastErrorMs = error;

    if (Math.abs(error) >= this.options.snapThresholdMs) {
      this._snap(position + (now - at), playing, now);
      return 'snap';
    }

    // Anchor corrections to the predicted position to avoid a discontinuity.
    this._basePositionMs = this.positionMs(now);
    this._baseAt = now;
    this._rate = this._clampRate(1 + error / this.options.absorbMs);
    return 'slew';
  }

  pause(now = Date.now()): void {
    if (!this._haveFix) return;
    this._basePositionMs = this.positionMs(now);
    this._baseAt = now;
    this._playing = false;
    this._rate = 1;
  }

  _snap(positionMs: number, playing: boolean, at: number): void {
    this._basePositionMs = positionMs;
    this._baseAt = at;
    this._playing = playing;
    this._rate = 1;
    this._lastErrorMs = 0;
    if (this._haveFix) this._snaps++;
    this._haveFix = true;
  }

  _clampRate(rate: number): number {
    const { maxSlew } = this.options;
    return Math.max(1 - maxSlew, Math.min(1 + maxSlew, rate));
  }

  getStatus(): PlaybackClockStatus {
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

export default PlaybackClock;
export { DEFAULTS };