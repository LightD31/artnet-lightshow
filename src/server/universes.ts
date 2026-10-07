import { UNIVERSE_SIZE } from './profiles.ts';

// Retire universes with one zero frame so receivers cannot hold their last look indefinitely.

const MAX_UNIVERSES = 64;

const FREE = -1;

const ZERO_FRAME = Buffer.alloc(UNIVERSE_SIZE, 0);

export interface SharedUniverses {
  data: SharedArrayBuffer;
  slots: SharedArrayBuffer;
}

export interface UniverseStore {
  shared: SharedUniverses;
  getBuffer(universe: number): Buffer;
  list(): number[];
  count(): number;
  clearAll(): void;
  sync(active: Iterable<number>): void;
  drainRetired(): [number, Buffer][];
  reset(): void;
  setWritable(value: boolean): void;
}

function allocateShared(): SharedUniverses {
  const slots = new SharedArrayBuffer(MAX_UNIVERSES * Int32Array.BYTES_PER_ELEMENT);
  new Int32Array(slots).fill(FREE);
  return { data: new SharedArrayBuffer(MAX_UNIVERSES * UNIVERSE_SIZE), slots };
}

// Only the renderer allocates shared universe slots; readers cannot change allocation.
function createUniverseStore(shared: SharedUniverses = allocateShared(), { readOnly = false } = {}): UniverseStore {
  const table = new Int32Array(shared.slots);
  const views = Array.from({ length: MAX_UNIVERSES }, (_, i) => Buffer.from(shared.data, i * UNIVERSE_SIZE, UNIVERSE_SIZE));
  const retiring = new Set<number>();     // universes owed a final blackout frame
  // Discard over-cap writes in an untransmitted buffer so they cannot corrupt another universe.
  const overflow = Buffer.alloc(UNIVERSE_SIZE);
  let writable = !readOnly;

  function slotOf(universe: number): number {
    for (let i = 0; i < MAX_UNIVERSES; i++) if (Atomics.load(table, i) === universe) return i;
    return -1;
  }

  function allocate(universe: number): number {
    for (let i = 0; i < MAX_UNIVERSES; i++) {
      if (Atomics.load(table, i) === FREE) {
        views[i].fill(0);
        Atomics.store(table, i, universe);
        return i;
      }
    }
    return -1;
  }

  function getBuffer(universe: number): Buffer {
    let slot = slotOf(universe);
    if (slot < 0) {
      if (!writable) return ZERO_FRAME;
      slot = allocate(universe);
      if (slot < 0) return overflow;
    }
    return views[slot];
  }

  function list(): number[] {
    const out: number[] = [];
    for (let i = 0; i < MAX_UNIVERSES; i++) {
      const universe = Atomics.load(table, i);
      if (universe !== FREE) out.push(universe);
    }
    return out.sort((a, b) => a - b);
  }

  function count() { return list().length; }

  function clearAll() {
    for (let i = 0; i < MAX_UNIVERSES; i++) if (Atomics.load(table, i) !== FREE) views[i].fill(0);
  }

  function sync(active: Iterable<number>): void {
    const wanted = new Set(active);
    for (const universe of list()) {
      if (!wanted.has(universe)) retiring.add(universe);
    }
    for (const universe of wanted) {
      retiring.delete(universe);
      if (slotOf(universe) < 0) allocate(universe);
    }
  }

  function drainRetired(): [number, Buffer][] {
    if (!retiring.size) return [];
    const out: [number, Buffer][] = [];
    for (const universe of retiring) {
      const slot = slotOf(universe);
      if (slot >= 0) Atomics.store(table, slot, FREE);
      out.push([universe, ZERO_FRAME]);
    }
    retiring.clear();
    return out;
  }

  function reset() {
    for (let i = 0; i < MAX_UNIVERSES; i++) Atomics.store(table, i, FREE);
    retiring.clear();
  }

  return {
    shared,
    getBuffer,
    list,
    count,
    clearAll,
    sync,
    drainRetired,
    reset,
    setWritable(value: boolean) { writable = !!value; },
  };
}

const store = createUniverseStore();

export const shared = store.shared;
export const getBuffer = store.getBuffer;
export const list = store.list;
export const count = store.count;
export const clearAll = store.clearAll;
export const sync = store.sync;
export const drainRetired = store.drainRetired;
export const reset = store.reset;
export const setWritable = store.setWritable;

export {
  MAX_UNIVERSES,
  UNIVERSE_SIZE,
  ZERO_FRAME,
  allocateShared,
  createUniverseStore,
};
