// Hue Dynamics limits each lamp's bright rises, not the frames of a held light.
// The caller supplies predicted post-master output and applies this only to HD.

export class HdFlashGuard {
  private intervalMs: number;
  private units = new Map<number, { bright: boolean; lastRise: number | null }>();
  private bright = 0;

  constructor(intervalMs: number) { this.intervalMs = intervalMs; }

  /** Lamps the guard holds a history for. */
  get size(): number { return this.units.size; }

  /** Lamps held bright since their last admitted rise: a caller with none, and nothing of Hue Dynamics' playing, can skip the guard. */
  get brightCount(): number { return this.bright; }

  /** A changed setting applies from the next rise; the rises already admitted still count. */
  setInterval(intervalMs: number): void {
    if (!(Number.isFinite(intervalMs) && intervalMs >= 0)) throw new RangeError('the flash interval must be a finite number of ms, 0 or more');
    this.intervalMs = intervalMs;
  }

  apply(unit: number, output01: number, nowMs: number): number {
    if (this.intervalMs <= 0) return output01;
    let state = this.units.get(unit);
    if (!state) { state = { bright: false, lastRise: null }; this.units.set(unit, state); }
    if (!(output01 >= 0.55)) { this.dim(state); return output01; }
    if (state.bright) return output01;
    // A blocked rise stays dark until it can be admitted. It must not latch
    // bright or advance the last rise while returning zero.
    if (state.lastRise !== null && nowMs - state.lastRise < this.intervalMs) return 0;
    state.bright = true;
    this.bright++;
    state.lastRise = nowMs;
    return output01;
  }

  private dim(state: { bright: boolean }): void {
    if (state.bright) { state.bright = false; this.bright--; }
  }

  /**
   * Another layer (or a blackout) drew the lamp this frame: a held rise ends
   * there, so coming back bright is a new rise, but nothing is spent and a
   * lamp the guard has never seen gets no entry.
   */
  clear(unit: number): void {
    const state = this.units.get(unit);
    if (state) this.dim(state);
  }

  reset(): void { this.units.clear(); this.bright = 0; }

  /** An independent copy with the same interval and histories: a preview checkpoint carries its guard. */
  clone(): HdFlashGuard {
    const copy = new HdFlashGuard(this.intervalMs);
    for (const [unit, state] of this.units) copy.units.set(unit, { ...state });
    copy.bright = this.bright;
    return copy;
  }
}
