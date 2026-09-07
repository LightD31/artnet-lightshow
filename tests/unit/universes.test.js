'use strict';

const test = require('node:test');
const assert = require('node:assert');

const universes = require('../../src/server/universes');

test.beforeEach(() => universes.reset());
test.after(() => universes.reset());

test('buffers are 512 bytes, allocated on demand and stable across calls', () => {
  const a = universes.getBuffer(4);
  assert.strictEqual(a.length, 512);
  assert.strictEqual(universes.getBuffer(4), a, 'the same universe hands back the same buffer');
  assert.notStrictEqual(universes.getBuffer(5), a, 'a different universe gets its own');
  assert.deepStrictEqual(universes.list(), [4, 5], 'listed in ascending order');
});

test('sync allocates the universes in use', () => {
  universes.sync([0, 3, 1]);
  assert.deepStrictEqual(universes.list(), [0, 1, 3]);
});

// Receivers latch the last frame they were sent, so a universe that simply
// stopped being transmitted would hold its look for the rest of the night.
test('a universe that leaves the patch is handed back once for a blackout frame', () => {
  universes.sync([0, 7]);
  universes.getBuffer(7)[0] = 255;

  universes.sync([0]);
  const retired = universes.drainRetired();
  assert.deepStrictEqual(retired.map(([u]) => u), [7], 'universe 7 is owed a final frame');
  assert.deepStrictEqual(Array.from(retired[0][1]), new Array(512).fill(0), 'and that frame is empty');

  assert.deepStrictEqual(universes.list(), [0], 'then it is gone');
  assert.deepStrictEqual(universes.drainRetired(), [], 'and is only blacked out once');
});

test('a universe that comes back before its blackout frame is not retired', () => {
  universes.sync([0, 2]);
  universes.sync([0]);
  universes.sync([0, 2]);

  assert.deepStrictEqual(universes.drainRetired(), []);
  assert.deepStrictEqual(universes.list(), [0, 2]);
});

test('clearAll zeroes every buffer', () => {
  universes.sync([0, 1]);
  universes.getBuffer(0)[10] = 200;
  universes.getBuffer(1)[10] = 200;

  universes.clearAll();

  assert.strictEqual(universes.getBuffer(0)[10], 0);
  assert.strictEqual(universes.getBuffer(1)[10], 0);
});

// Every universe is another packet at the render rate. A typo in the universe
// field should not turn into a packet storm.
test('sync refuses to allocate past the transmit cap', () => {
  universes.sync(Array.from({ length: universes.MAX_UNIVERSES + 10 }, (_, i) => i));
  assert.strictEqual(universes.count(), universes.MAX_UNIVERSES);
});
