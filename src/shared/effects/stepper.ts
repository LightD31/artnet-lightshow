// The renderer owns one stepper. Keeping both kind and palette state here means
// preview checkpoints, expiry and reset all see the same instance lifetime.

import { preparePalette } from './palette.ts';
import type { PreparedPalette } from './palette.ts';
import type { EffectSlot, EffectSpec, Seed } from './types.ts';

export interface EffectInstance {
  id: string;
  spec: EffectSpec;
  seed: Seed;
  anchorBeat: number;
  startedAtMs: number;
  /** Slot indices; null covers the room. */
  targets: number[] | null;
}

export interface HardwareRun {
  stepper: EffectStepper; nowMs: number; beatPos: number; anchorBeat: number; lastMs: number; lastBeat: number; held: Map<number, EffectSlot>;
}

interface InstanceState {
  hardware?: Map<string, HardwareRun>;
  initialized: boolean;
  value: unknown;
  lastSeen: number;
  palette?: { key: string; prepared: PreparedPalette };
}

const tableValues = new WeakMap<ConstantTable, Float64Array>();

/**
 * A table of numbers fixed when it is made: its values sit where no caller
 * can reach them and no method writes them, and the instance is frozen. A
 * kind's state may hold one, and a checkpoint shares it instead of copying it
 * (Light DJ's noise field is 301 × 301 numbers, too many to copy per sample).
 */
export class ConstantTable {
  readonly rows: number;
  readonly columns: number;

  constructor(rows: number, columns: number, valueAt: (row: number, column: number) => number) {
    if (!(Number.isSafeInteger(rows) && rows >= 0 && Number.isSafeInteger(columns) && columns >= 0)) {
      throw new RangeError('a table has a whole number of rows and columns');
    }
    this.rows = rows;
    this.columns = columns;
    const values = new Float64Array(rows * columns);
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) values[row * columns + column] = valueAt(row, column);
    tableValues.set(this, values);
    Object.freeze(this);
  }

  /** The value at a row and column; undefined outside the table. */
  at(row: number, column: number): number | undefined {
    if (!(Number.isInteger(row) && row >= 0 && row < this.rows && Number.isInteger(column) && column >= 0 && column < this.columns)) return undefined;
    return tableValues.get(this)![row * this.columns + column];
  }
}

// Stateful kinds use class instances containing Maps and arrays. A plain
// structured clone would discard their methods and break resumed previews.
function copyState<T>(value: T, seen = new Map<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value) as T;
  // Only the class itself: a subclass could add state of its own.
  if (Object.getPrototypeOf(value) === ConstantTable.prototype) return value;
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
  return (plainCopy(value, seen) ?? descriptorCopy(value, seen)) as T;
}

const plainData = (d: PropertyDescriptor | undefined): d is PropertyDescriptor & { value: unknown } =>
  !!d && 'value' in d && !!d.writable && !!d.enumerable && !!d.configurable;

/**
 * An array without holes, or an object, whose own properties are all plain
 * data (writable, enumerable, configurable values; no symbols), copied by
 * assignment: what the kinds build, and several times quicker than
 * redefining every property. Null for anything else.
 */
function plainCopy(value: object, seen: Map<object, unknown>): object | null {
  if (!Object.isExtensible(value) || Object.getOwnPropertySymbols(value).length) return null;
  const proto = Object.getPrototypeOf(value) as object | null;
  const names = Object.getOwnPropertyNames(value);
  if (Array.isArray(value)) {
    const n = value.length;
    // Every index present and one name more, its length: no hole, nothing else on it.
    if (proto !== Array.prototype || names.length !== n + 1) return null;
    const items = new Array<unknown>(n);
    for (let i = 0; i < n; i++) {
      const d = Object.getOwnPropertyDescriptor(value, i);
      if (!plainData(d)) return null;
      items[i] = d.value;
    }
    seen.set(value, items);
    for (let i = 0; i < n; i++) items[i] = copyState(items[i], seen);
    return items;
  }
  const items: unknown[] = [];
  for (const name of names) {
    const d = Object.getOwnPropertyDescriptor(value, name);
    if (!plainData(d)) return null;
    items.push(d.value);
  }
  const copy = Object.create(proto) as Record<string, unknown>;
  seen.set(value, copy);
  for (let i = 0; i < names.length; i++) {
    const item = copyState(items[i], seen);
    // A name the prototype chain knows (a setter, __proto__) is defined, never assigned.
    if (names[i] in copy) Object.defineProperty(copy, names[i], { value: item, writable: true, enumerable: true, configurable: true });
    else copy[names[i]] = item;
  }
  return copy;
}

/** Property by property, descriptors and all: getters, frozen and hidden properties, holes, symbols. */
function descriptorCopy(value: object, seen: Map<object, unknown>): object {
  const copy = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if ('value' in descriptor) descriptor.value = copyState(descriptor.value, seen);
    Object.defineProperty(copy, key, descriptor);
  }
  // Frozen or sealed stays so: its properties came over as they were.
  if (!Object.isExtensible(value)) Object.preventExtensions(copy);
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

  hardware(id: string, nowMs: number): Map<string, HardwareRun> {
    const entry = this.touch(id, nowMs);
    return entry.hardware ??= new Map();
  }

  values(id: string): unknown[] {
    const entry = this.states.get(id);
    return entry?.hardware ? [...entry.hardware.values()].flatMap((run) => run.stepper.values(id))
      : entry?.initialized ? [entry.value] : [];
  }

  /** The state an instance already has, without creating one; null before its first initialization. */
  peek<S>(id: string): { value: S } | null {
    const entry = this.states.get(id);
    return entry?.initialized ? { value: entry.value as S } : null;
  }

  /** When an instance with state was last rendered or kept; null for none. */
  seenAt(id: string): number | null {
    const entry = this.states.get(id);
    return entry && (entry.initialized || entry.hardware?.size) ? entry.lastSeen : null;
  }

  /** Mark an instance seen without rendering it (a held base look), so a sweep keeps it. */
  keep(id: string, nowMs: number): void {
    const entry = this.states.get(id);
    if (entry) entry.lastSeen = nowMs;
  }

  /** One instance starts again: its kind state and palette cache, and nothing else. */
  forget(id: string): void { this.states.delete(id); }

  /** Hand one instance's state on to another id (the strobe's permit outliving a relaunch). */
  move(from: string, to: string): void {
    if (from === to) return;
    const entry = this.states.get(from);
    this.states.delete(to);
    if (!entry) return;
    this.states.delete(from);
    this.states.set(to, entry);
    for (const run of entry.hardware?.values() ?? []) run.stepper.move(from, to);
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
