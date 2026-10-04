// The renderer owns one stepper. Keeping both kind and palette state here means
// preview checkpoints, expiry and reset all see the same instance lifetime.

import { preparePalette } from './palette.ts';
import type { PreparedPalette } from './palette.ts';
import type { EffectSpec, Seed } from './types.ts';

export interface EffectInstance {
  id: string;
  spec: EffectSpec;
  seed: Seed;
  anchorBeat: number;
  startedAtMs: number;
  /** Slot indices; null covers the room. */
  targets: number[] | null;
}

interface InstanceState {
  initialized: boolean;
  value: unknown;
  lastSeen: number;
  palette?: { key: string; prepared: PreparedPalette };
}

// Stateful kinds use class instances containing Maps and arrays. A plain
// structured clone would discard their methods and break resumed previews.
function copyState<T>(value: T, seen = new Map<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value) as T;
  if (value instanceof Map) {
    const copy = new Map(); seen.set(value, copy);
    for (const [key, item] of value) copy.set(copyState(key, seen), copyState(item, seen));
    return copy as T;
  }
  if (value instanceof Set) {
    const copy = new Set(); seen.set(value, copy);
    for (const item of value) copy.add(copyState(item, seen));
    return copy as T;
  }
  const copy = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if ('value' in descriptor) descriptor.value = copyState(descriptor.value, seen);
    Object.defineProperty(copy, key, descriptor);
  }
  return copy;
}

export class EffectStepper {
  private states = new Map<string, InstanceState>();

  private touch(id: string, nowMs: number): InstanceState {
    let entry = this.states.get(id);
    if (!entry) {
      entry = { initialized: false, value: undefined, lastSeen: nowMs };
      this.states.set(id, entry);
    }
    entry.lastSeen = nowMs;
    return entry;
  }

  get<S>(id: string, make: () => S, nowMs: number): S {
    const entry = this.touch(id, nowMs);
    // Undefined and null are valid kind states, not signs of an absent entry.
    if (!entry.initialized) { entry.value = make(); entry.initialized = true; }
    return entry.value as S;
  }

  /** Internal rendering data stays separate from get's raw kind state and its id namespace. */
  palette(id: string, spec: EffectSpec, nowMs: number): PreparedPalette {
    const entry = this.touch(id, nowMs);
    // Compare palette contents because snapshots may rebuild the spec object,
    // while an editor may change its colours without replacing that object.
    const key = JSON.stringify(spec.palette ?? null);
    if (!entry.palette || entry.palette.key !== key) entry.palette = { key, prepared: preparePalette(spec) };
    return entry.palette.prepared;
  }

  sweep(nowMs: number, keepMs = 2000): void {
    for (const [id, entry] of this.states) if (nowMs - entry.lastSeen > keepMs) this.states.delete(id);
  }

  reset(): void { this.states.clear(); }

  clone(): EffectStepper {
    const clone = new EffectStepper();
    clone.states = copyState(this.states);
    return clone;
  }
}
