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
 */

// Every extra universe is another packet at the render rate. A show that wants
// more than this is not a light show any more, and the cap keeps a typo in the
// universe field (or a scripted loop) from turning into a packet storm.
const MAX_UNIVERSES = 32;

const buffers = new Map();      // universe number -> Buffer(512)
const retiring = new Set();     // universes owed a final blackout frame

/** A frame of nothing, for retiring a universe. Never written to. */
const ZERO_FRAME = Buffer.alloc(UNIVERSE_SIZE, 0);

/** The buffer for `universe`, allocated on first use. */
function getBuffer(universe) {
  let buf = buffers.get(universe);
  if (!buf) {
    buf = Buffer.alloc(UNIVERSE_SIZE, 0);
    buffers.set(universe, buf);
  }
  return buf;
}

/** Universes currently allocated, ascending. */
function list() {
  return [...buffers.keys()].sort((a, b) => a - b);
}

function count() { return buffers.size; }

/** Zero every buffer. The engine does this once per frame before rendering. */
function clearAll() {
  for (const buf of buffers.values()) buf.fill(0);
}

/**
 * Reconcile the allocated buffers with the universes actually in use.
 *
 * Universes that appear are allocated; universes that disappear are queued for
 * one final blackout frame. Called every frame, so a fixture moved between
 * universes takes effect immediately and nothing has to remember to call it.
 */
function sync(active) {
  const wanted = new Set(active);

  for (const universe of buffers.keys()) {
    if (!wanted.has(universe)) retiring.add(universe);
  }

  for (const universe of wanted) {
    // A universe that came back before its blackout frame went out is not
    // retiring any more.
    retiring.delete(universe);
    if (!buffers.has(universe) && buffers.size >= MAX_UNIVERSES) continue;
    getBuffer(universe);
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
    buffers.delete(universe);
    out.push([universe, ZERO_FRAME]);
  }
  retiring.clear();
  return out;
}

/** Drop everything. Tests only — a running show has no reason to do this. */
function reset() {
  buffers.clear();
  retiring.clear();
}

module.exports = {
  MAX_UNIVERSES,
  UNIVERSE_SIZE,
  ZERO_FRAME,
  getBuffer,
  list,
  count,
  clearAll,
  sync,
  drainRetired,
  reset,
};
