'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { state, dmx } = require('../../src/server/state');
const { startEngine, stopEngine, restartBeatTimer, resizeFixtureBuffers } = require('../../src/server/engine');
const { applyPatch } = require('../../src/server/patch');

// renderDmx isn't exported — it runs on the engine's own 25 ms interval, so the
// tests drive it by starting the engine and waiting for a frame.
const FRAME_MS = 25;
const frames = (n = 2) => new Promise((r) => setTimeout(r, FRAME_MS * n + 20));

/** The DMX slice a fixture at `address` with `count` channels occupies. */
function channels(address, count) {
  return Array.from(dmx.slice(address - 1, address - 1 + count));
}

const anyLit = (vals) => vals.some((v) => v !== 0);

test.before(() => {
  applyPatch({ pattern: 'solid', running: true, masterDimmer: 255, colorA: 1, masterBlackout: false });
  startEngine();
});

test.after(() => stopEngine());

test('a deleted fixture stops being driven instead of latching its last look', async () => {
  applyPatch({ masterBlackout: false });
  restartBeatTimer({ tickNow: true });
  await frames();

  const doomed = state.fixtures[state.fixtures.length - 1];
  const { address } = doomed;
  assert.ok(anyLit(channels(address, 12)), 'fixture should be lit before removal');

  // Exactly what DELETE /api/fixtures/:id does.
  state.fixtures = state.fixtures.filter((f) => f.id !== doomed.id);
  state.fixtures.forEach((f, i) => { f.id = i; });
  resizeFixtureBuffers();
  await frames();

  // Art-Net receivers latch the last frame, so a non-zero value here is a
  // fixture stuck on for the rest of the show with no way to clear it.
  assert.deepStrictEqual(
    channels(address, 12), new Array(12).fill(0),
    'channels of a removed fixture must be cleared, not left latched',
  );
});

test('re-addressing a fixture clears the channels it moved away from', async () => {
  const fix = state.fixtures[0];
  const from = fix.address;
  applyPatch({ masterBlackout: false });
  restartBeatTimer({ tickNow: true });
  await frames();
  assert.ok(anyLit(channels(from, 12)), 'fixture should be lit at its original address');

  const to = 200;
  fix.address = to;
  await frames();

  assert.deepStrictEqual(
    channels(from, 12), new Array(12).fill(0),
    'the vacated channels must go dark',
  );
  assert.ok(anyLit(channels(to, 12)), 'the fixture should now be driven at its new address');

  fix.address = from;
});

test('master blackout clears the whole universe, not just patched channels', async () => {
  applyPatch({ masterBlackout: false });
  restartBeatTimer({ tickNow: true });
  await frames();

  // Strand a value outside every fixture's footprint, as a removed or
  // re-addressed fixture used to.
  dmx[400] = 255;

  applyPatch({ masterBlackout: true });
  await frames();

  assert.deepStrictEqual(
    Array.from(dmx), new Array(512).fill(0),
    'blackout must mean every channel at zero',
  );
  applyPatch({ masterBlackout: false });
});

test('stopEngine leaves the rig dark rather than holding the last look', async () => {
  applyPatch({ masterBlackout: false });
  restartBeatTimer({ tickNow: true });
  startEngine();
  await frames();
  assert.ok(anyLit(Array.from(dmx)), 'something should be lit before shutdown');

  stopEngine();
  assert.deepStrictEqual(Array.from(dmx), new Array(512).fill(0), 'shutdown must black out');

  startEngine();   // restore for any later test
});
