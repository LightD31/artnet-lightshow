// Hue Dynamics limits each lamp's bright rises, not the frames of a held light.
// The caller supplies predicted post-master output and applies this only to HD.

export class HdFlashGuard {
  private intervalMs: number;
  private units = new Map<number, { bright: boolean; lastRise: number | null }>();

  constructor(intervalMs: number) { this.intervalMs = intervalMs; }

  apply(unit: number, output01: number, nowMs: number): number {
    if (this.intervalMs <= 0) return output01;
    let state = this.units.get(unit);
    if (!state) { state = { bright: false, lastRise: null }; this.units.set(unit, state); }
    if (!(output01 >= 0.55)) { state.bright = false; return output01; }
    if (state.bright) return output01;
    // A blocked rise stays dark until it can be admitted. It must not latch
    // bright or advance the last rise while returning zero.
    if (state.lastRise !== null && nowMs - state.lastRise < this.intervalMs) return 0;
    state.bright = true;
    state.lastRise = nowMs;
    return output01;
  }

  reset(): void { this.units.clear(); }
}
