'use strict';

const { UNIVERSE_SIZE } = require('./profiles');

/**
 * DMX output buffers, one per universe.
 *
 * The rig used to be a single 512-byte buffer, which put a hard ceiling on it:
 * a fixture could not be patched past channel 512, so twelve ROOT PARs was the
 * end of the road no matter what the node could carry. Fixtures now name the
 * universe they live on and each one gets its own buffer here.
 *
 * Buffers are created on demand and, once a universe stops being used, are
 * *retired* rather than dropped on the spot: Art-Net and sACN receivers latch
 * the last frame they were sent, so a universe that simply stopped being
 * transmitted would hold its final look forever. `drainRetired()` hands the
 * engine the universes that need one last all-zero frame before they go.
 *
 * The buffers live in shared memory: `MAX_UNIVERSES` slots of 512 bytes, and a
 * table saying which universe each slot holds. The engine renders in a worker
 * thread (see engine.js), and the main thread reads the very same bytes for
 * the DMX monitor and the Hue lamps without a copy crossing between them. Only
 * the thread that renders allocates or frees a slot; the other opens the same
 * memory read-only. A read that lands mid-frame sees a mix of two consecutive
 * frames, which for a monitor and a Hue lamp is indistinguishable from either.
 */

// Every extra universe is another packet at the render rate. A show that wants
// more than this is not a light show any more, and the cap keeps a typo in the
// universe field (or a scripted loop) from turning into a packet storm.
const MAX_UNIVERSES = 32;

const FREE = -1;

/** A frame of nothing, for retiring a universe. Never written to. */
const ZERO_FRAME = Buffer.alloc(UNIVERSE_SIZE, 0);

/** Fresh shared memory for a store: pass it to another thread to share it. */
function allocateShared() {
  const slots = new SharedArrayBuffer(MAX_UNIVERSES * Int32Array.BYTES_PER_ELEMENT);
  new Int32Array(slots).fill(FREE);
  return { data: new SharedArrayBuffer(MAX_UNIVERSES * UNIVERSE_SIZE), slots };
}

/**
 * A universe store over `shared` (from allocateShared). `readOnly` is the
 * thread that does not render: it never allocates, and a universe the renderer
 * has not allocated reads as a frame of nothing.
 */
function createUniverseStore(shared = allocateShared(), { readOnly = false } = {}) {
  const table = new Int32Array(shared.slots);
  const views = Array.from({ length: MAX_UNIVERSES }, (_, i) => Buffer.from(shared.data, i * UNIVERSE_SIZE, UNIVERSE_SIZE));
  const retiring = new Set();     // universes owed a final blackout frame
  // A write past the cap goes here rather than into another universe's slot,
  // and is never transmitted.
  const overflow = Buffer.alloc(UNIVERSE_SIZE);
  let writable = !readOnly;

  function slotOf(universe) {
    for (let i = 0; i < MAX_UNIVERSES; i++) if (Atomics.load(table, i) === universe) return i;
    return -1;
  }

  function allocate(universe) {
    for (let i = 0; i < MAX_UNIVERSES; i++) {
      if (Atomics.load(table, i) === FREE) {
        views[i].fill(0);
        Atomics.store(table, i, universe);
        return i;
      }
    }
    return -1;
  }

  /** The buffer for `universe`, allocated on first use. */
  function getBuffer(universe) {
    let slot = slotOf(universe);
    if (slot < 0) {
      if (!writable) return ZERO_FRAME;
      slot = allocate(universe);
      if (slot < 0) return overflow;
    }
    return views[slot];
  }

  /** Universes currently allocated, ascending. */
  function list() {
    const out = [];
    for (let i = 0; i < MAX_UNIVERSES; i++) {
      const universe = Atomics.load(table, i);
      if (universe !== FREE) out.push(universe);
    }
    return out.sort((a, b) => a - b);
  }

  function count() { return list().length; }

  /** Zero every buffer. The engine does this once per frame before rendering. */
  function clearAll() {
    for (let i = 0; i < MAX_UNIVERSES; i++) if (Atomics.load(table, i) !== FREE) views[i].fill(0);
  }

  /**
   * Reconcile the allocated buffers with the universes actually in use.
   *
   * Universes that appear are allocated; universes that disappear are queued
   * for one final blackout frame. Called every frame, so a fixture moved
   * between universes takes effect immediately and nothing has to remember to
   * call it.
   */
  function sync(active) {
    const wanted = new Set(active);
    for (const universe of list()) {
      if (!wanted.has(universe)) retiring.add(universe);
    }
    for (const universe of wanted) {
      // A universe that came back before its blackout frame went out is not
      // retiring any more.
      retiring.delete(universe);
      if (slotOf(universe) < 0) allocate(universe);
    }
  }

  /**
   * Universes that have left the patch, together with the frame to send them.
   * Removes them, so each is only blacked out once.
   */
  function drainRetired() {
    if (!retiring.size) return [];
    const out = [];
    for (const universe of retiring) {
      const slot = slotOf(universe);
      if (slot >= 0) Atomics.store(table, slot, FREE);
      out.push([universe, ZERO_FRAME]);
    }
    retiring.clear();
    return out;
  }

  /** Drop everything. Tests only — a running show has no reason to do this. */
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
    /** Whether this thread may allocate: false while the worker renders. */
    setWritable(value) { writable = !!value; },
  };
}

// The main thread's store. The engine's worker opens the same memory.
const store = createUniverseStore();

module.exports = {
  MAX_UNIVERSES,
  UNIVERSE_SIZE,
  ZERO_FRAME,
  allocateShared,
  createUniverseStore,
  shared: store.shared,
  getBuffer: store.getBuffer,
  list: store.list,
  count: store.count,
  clearAll: store.clearAll,
  sync: store.sync,
  drainRetired: store.drainRetired,
  reset: store.reset,
  setWritable: store.setWritable,
};
