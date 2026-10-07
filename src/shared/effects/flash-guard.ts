import { HOLD_STROBE_MAX_HZ } from '../look-math.ts';
import { GAP_FRAMES, WINDOW_FRAMES } from './strobe.ts';

// Only bright rises spend the HD guard; held light must not consume another admission.

export class HdFlashGuard {
  private intervalMs: number;
  private units = new Map<number, { bright: boolean; lastRise: number | null }>();
  private bright = 0;

  constructor(intervalMs: number) { this.intervalMs = intervalMs; }

  get size(): number { return this.units.size; }

  get brightCount(): number { return this.bright; }

  // New limits retain admitted rises so edits cannot reset the safety history.
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
    // A blocked rise must not latch bright or advance its admission time.
    if (state.lastRise !== null && nowMs - state.lastRise < this.intervalMs) return 0;
    state.bright = true;
    this.bright++;
    state.lastRise = nowMs;
    return output01;
  }

  private dim(state: { bright: boolean }): void {
    if (state.bright) { state.bright = false; this.bright--; }
  }

  // Other layers end held brightness without spending a rise.
  clear(unit: number): void {
    const state = this.units.get(unit);
    if (state) this.dim(state);
  }

  reset(): void { this.units.clear(); this.bright = 0; }

  clone(): HdFlashGuard {
    const copy = new HdFlashGuard(this.intervalMs);
    for (const [unit, state] of this.units) copy.units.set(unit, { ...state });
    copy.bright = this.bright;
    return copy;
  }
}

// Keep permits per lamp across strobe handovers so replacements cannot reset the rate limit.
export class StrobeLampGuard {
  private units = new Map<number, { raw: number; out: number; rises: number[]; blocked: boolean }>();
  private live = 0;

  get liveCount(): number { return this.live; }

  apply(unit: number, level01: number, frameIndex: number): number {
    let s = this.units.get(unit);
    if (!s) { s = { raw: 0, out: 0, rises: [], blocked: false }; this.units.set(unit, s); }
    const was = s.raw > 0 || s.blocked;
    const level = level01 > 0 ? level01 : 0;
    if (level > s.raw + 1e-9) {
      const last = s.rises[s.rises.length - 1];
      const fifth = s.rises.length >= HOLD_STROBE_MAX_HZ ? s.rises[s.rises.length - HOLD_STROBE_MAX_HZ] : undefined;
      if (last === frameIndex) s.blocked = false;
      else if ((last === undefined || frameIndex - last >= GAP_FRAMES) && (fifth === undefined || frameIndex - fifth >= WINDOW_FRAMES)) {
        s.rises = [...s.rises.slice(1 - HOLD_STROBE_MAX_HZ), frameIndex];
        s.blocked = false;
      } else s.blocked = true;
    }
    const out = s.blocked ? Math.min(level, s.out) : level;
    s.raw = level;
    s.out = out;
    if (level <= 0) s.blocked = false;
    const is = s.raw > 0 || s.blocked;
    if (is !== was) this.live += is ? 1 : -1;
    return out;
  }

  // Clearing output retains rise history so a later strobe cannot bypass the limit.
  clear(unit: number): void {
    const s = this.units.get(unit);
    if (!s) return;
    if (s.raw > 0 || s.blocked) this.live--;
    s.raw = 0; s.out = 0; s.blocked = false;
  }

  reset(): void { this.units.clear(); this.live = 0; }

  clone(): StrobeLampGuard {
    const copy = new StrobeLampGuard();
    for (const [unit, s] of this.units) copy.units.set(unit, { ...s, rises: [...s.rises] });
    copy.live = this.live;
    return copy;
  }
}
