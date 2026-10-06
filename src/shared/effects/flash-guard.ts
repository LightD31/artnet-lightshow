import { HOLD_STROBE_MAX_HZ } from '../look-math.ts';
import { GAP_FRAMES, WINDOW_FRAMES } from './strobe.ts';

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

/**
 * The strobe's permit, held per lamp across every strobe that draws it. Each
 * strobe paces its own flashes, but two can meet on one lamp: one ends and
 * the one under it shows, or a strobe look comes back from under a strobe
 * voice. Here a lamp's rises count whoever drew them: at least GAP_FRAMES
 * engine frames apart and no more than five in any second of frames. A rise
 * refused stays down: the lamp only dims until one is admitted.
 */
export class StrobeLampGuard {
  private units = new Map<number, { raw: number; out: number; rises: number[]; blocked: boolean }>();
  private live = 0;

  /** Lamps a strobe is drawing or holding down: a caller with none, and no strobe on top, can skip the guard. */
  get liveCount(): number { return this.live; }

  /** The level a strobe may show on this lamp on this frame, given the level it asks for (0..1). */
  apply(unit: number, level01: number, frameIndex: number): number {
    let s = this.units.get(unit);
    if (!s) { s = { raw: 0, out: 0, rises: [], blocked: false }; this.units.set(unit, s); }
    const was = s.raw > 0 || s.blocked;
    const level = level01 > 0 ? level01 : 0;
    if (level > s.raw + 1e-9) {
      const last = s.rises[s.rises.length - 1];
      const fifth = s.rises.length >= HOLD_STROBE_MAX_HZ ? s.rises[s.rises.length - HOLD_STROBE_MAX_HZ] : undefined;
      // The same frame drawn again is the rise it already was.
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

  /** Something else drew the lamp, or it is dark: the strobe's level there is none, its rises still count. */
  clear(unit: number): void {
    const s = this.units.get(unit);
    if (!s) return;
    if (s.raw > 0 || s.blocked) this.live--;
    s.raw = 0; s.out = 0; s.blocked = false;
  }

  reset(): void { this.units.clear(); this.live = 0; }

  /** An independent copy: a preview checkpoint carries its guard. */
  clone(): StrobeLampGuard {
    const copy = new StrobeLampGuard();
    for (const [unit, s] of this.units) copy.units.set(unit, { ...s, rises: [...s.rises] });
    copy.live = this.live;
    return copy;
  }
}
