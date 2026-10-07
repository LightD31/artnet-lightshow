import { hash01 } from './hash.ts';
import type { AudioMode, Curve, Direction, HdParams, Seed } from './types.ts';

const TICK = 1 / 960;

const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);
const atLeast = (min: number, x: number) => (x > min ? x : min);
const nonNegative = (x: number) => atLeast(0, x);

export function curveApply(x: number, curve: Curve): number {
  const t = clamp01(x);
  switch (curve) {
    case 'cut': return t > 0 ? 1 : 0;
    case 'easeIn': return t * t;
    case 'easeOut': return 1 - (1 - t) * (1 - t);
    case 'easeInOut': return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    default: return t;
  }
}

export function curveInverse(x: number, curve: Curve): number {
  return 1 - curveApply(x, curve);
}

export function envelopeLength(p: HdParams): number {
  return nonNegative(p.attack) + nonNegative(p.hold) + nonNegative(p.release);
}

export function eventInterval(p: HdParams, loopLength: number, musicMode: AudioMode): number {
  const repetitions = atLeast(1, Math.floor(p.repetitions));
  const source = musicMode !== 'off' && p.trigger.mode === 'beatAccent' ? atLeast(TICK, p.trigger.beatInterval) : atLeast(TICK, loopLength);
  return atLeast(TICK, source / repetitions);
}

export function sampleEnvelope(age: number, p: HdParams): number {
  if (!(age >= 0)) return 0;
  const attack = nonNegative(p.attack), hold = nonNegative(p.hold), release = nonNegative(p.release);
  const length = attack + hold + release;
  if (length === 0) return age < TICK / 2 ? 1 : 0;
  if (p.curve === 'cut') return age < attack + hold ? 1 : 0;
  if (attack > 0 && age < attack) return curveApply(age / attack, p.curve);
  if (age < attack + hold) return 1;
  if (release > 0 && age < length) return curveInverse((age - attack - hold) / release, p.curve);
  return 0;
}

export function isReversed(direction: Direction, event: number, seed: Seed): boolean {
  switch (direction) {
    case 'reverse': return true;
    case 'alternate': return Math.abs(event % 2) === 1;
    case 'random': return hash01(seed, 0, event) >= 0.5;
    default: return false;
  }
}

export function staggerOffset(stagger: number, orderedIndex: number, n: number, reversed: boolean): number {
  return nonNegative(stagger) * (reversed ? nonNegative(n - 1 - orderedIndex) : orderedIndex);
}

export interface ActiveEvent { index: number; start: number; age: number }

// Bound backward traversal so degenerate presets cannot stall a frame.
const MAX_ACTIVE_EVENTS = 4096;

export function activeEvents(pos: number, interval: number, envLen: number, maxStagger: number): ActiveEvent[] {
  const out: ActiveEvent[] = [];
  const step = atLeast(TICK, interval);
  const span = atLeast(TICK, envLen) + nonNegative(maxStagger);
  if (!Number.isFinite(pos) || !Number.isFinite(step) || !Number.isFinite(span)) return out;
  for (let index = Math.floor(pos / step) + 1; out.length < MAX_ACTIVE_EVENTS; index--) {
    const start = index * step;
    const age = pos - start;
    if (age >= span) break;
    out.push({ index, start, age });
  }
  return out;
}

// Near-equal strengths favor the later event so its palette position remains stable.
export function composeEvents(
  events: readonly ActiveEvent[],
  sample: (e: ActiveEvent, age: number) => { strength: number; palettePos: number } | null,
): { strength: number; palettePos: number; index: number } {
  let strength = 0, palettePos = 0, index = Number.MIN_SAFE_INTEGER;
  for (const e of events) {
    if (!(e.age >= 0)) continue;
    const s = sample(e, e.age);
    if (s === null) continue;
    if (s.strength > strength || (Math.abs(s.strength - strength) < 1e-6 && e.index > index)) {
      strength = s.strength;
      palettePos = s.palettePos;
      index = e.index;
    }
  }
  return { strength, palettePos, index };
}

// Decide admission once per event so flashes cannot appear or vanish mid-envelope.
export class EventAdmission {
  declare minIntervalMs: number;
  declare _answers: Map<number, boolean>;
  declare _admitted: { index: number; ms: number }[];
  declare _newest: number;

  constructor(minIntervalMs: number) {
    this.minIntervalMs = minIntervalMs;
    this._answers = new Map();
    this._admitted = [];
    this._newest = -Infinity;
  }

  admit(eventIndex: number, startMs: number): boolean {
    const known = this._answers.get(eventIndex);
    if (known !== undefined) return known;
    const at = this._insertionPoint(eventIndex);
    const prev = this._admitted[at - 1], next = this._admitted[at];
    // Late older events must also respect newer admissions that already spent the interval.
    const ok = Number.isFinite(startMs)
      && (!prev || startMs - prev.ms + 1e-6 >= this.minIntervalMs)
      && (!next || next.ms - startMs + 1e-6 >= this.minIntervalMs);
    if (ok) this._admitted.splice(at, 0, { index: eventIndex, ms: startMs });
    this._answers.set(eventIndex, ok);
    if (eventIndex > this._newest) this._newest = eventIndex;
    if (this._answers.size > 2 * MAX_ACTIVE_EVENTS) this._forget();
    return ok;
  }

  reset(): void {
    this._answers.clear();
    this._admitted = [];
    this._newest = -Infinity;
  }

  _insertionPoint(eventIndex: number): number {
    let lo = 0, hi = this._admitted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this._admitted[mid].index < eventIndex) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // Keep the newest old admission when pruning so the next event still respects spacing.
  _forget(): void {
    const floor = this._newest - MAX_ACTIVE_EVENTS;
    for (const index of this._answers.keys()) if (index < floor) this._answers.delete(index);
    let drop = 0;
    while (drop < this._admitted.length - 1 && this._admitted[drop + 1].index < floor) drop++;
    this._admitted.splice(0, drop);
  }
}
