'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { state, universeOf } = require('../../src/server/state');
const universes = require('../../src/server/universes');
const { startEngine, stopEngine, restartBeatTimer, resizeFixtureBuffers } = require('../../src/server/engine');
const { applyPatch, applyOverride, setFixtureMaxBrightness } = require('../../src/server/patch');

// renderDmx isn't exported — it runs on the engine's own 25 ms interval, so the
// tests drive it by starting the engine and waiting for a frame.
const FRAME_MS = 25;
const frames = (n = 2) => new Promise((r) => setTimeout(r, FRAME_MS * n + 20));

/** The universe-0 buffer, which is what the default patch renders into. */
const dmx = () => universes.getBuffer(state.artnet.universe);

/** The DMX slice a fixture at `address` with `count` channels occupies. */
function channels(address, count, universe = state.artnet.universe) {
  const buf = universes.getBuffer(universe);
  return Array.from(buf.subarray(address - 1, address - 1 + count));
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
  dmx()[400] = 255;

  applyPatch({ masterBlackout: true });
  await frames();

  assert.deepStrictEqual(
    Array.from(dmx()), new Array(512).fill(0),
    'blackout must mean every channel at zero',
  );
  applyPatch({ masterBlackout: false });
});

// Before universes, every fixture shared one 512-byte buffer, so address 1 on
// two different nodes was the same wire. It is not.
test('a fixture on another universe writes into that universe, not universe 0', async () => {
  const fix = state.fixtures[0];
  const home = universeOf(fix);
  const away = home + 3;
  const { address } = fix;

  applyPatch({ masterBlackout: false });
  restartBeatTimer({ tickNow: true });
  await frames();
  assert.ok(anyLit(channels(address, 12, home)), 'fixture is lit on its own universe first');

  fix.universe = away;
  await frames();

  assert.ok(anyLit(channels(address, 12, away)), 'the fixture drives its new universe');
  assert.deepStrictEqual(
    channels(address, 12, home), new Array(12).fill(0),
    'and the universe it left goes dark rather than latching',
  );

  fix.universe = home;
  await frames();
});

// A universe nobody is patched on any more must be blacked out once and then
// dropped, or its node holds the last look it was sent for the rest of the set.
test('a universe that leaves the patch is retired with a final blackout frame', async () => {
  const fix = state.fixtures[0];
  const home = universeOf(fix);
  const away = home + 11;

  fix.universe = away;
  await frames();
  assert.ok(universes.list().includes(away), 'the universe is transmitted while in use');

  fix.universe = home;
  await frames(3);
  assert.ok(!universes.list().includes(away), 'and is dropped once nothing is patched on it');
});

test('stopEngine leaves the rig dark rather than holding the last look', async () => {
  applyPatch({ masterBlackout: false });
  restartBeatTimer({ tickNow: true });
  startEngine();
  await frames();
  assert.ok(anyLit(Array.from(dmx())), 'something should be lit before shutdown');

  stopEngine();
  for (const universe of universes.list()) {
    assert.deepStrictEqual(
      Array.from(universes.getBuffer(universe)), new Array(512).fill(0),
      `shutdown must black out universe ${universe}`,
    );
  }

  startEngine();   // restore for any later test
});

// ── Brightness ceilings ─────────────────────────────────────────────────────
// Two of them sit above whatever is driving a fixture: the grand master, and
// the fixture's own trim. Both used to be bypassed by an energy override, which
// meant the blinder came up at full no matter where the master sat.

/** The dimmer channel of `fix`, which is offset 0 in the built-in profile. */
const dimmerOf = (fix) => universes.getBuffer(universeOf(fix))[fix.address - 1];

/** The red channel, which carries the master + trim scaling as well. */
const redOf = (fix) => universes.getBuffer(universeOf(fix))[fix.address - 1 + 3];

test('a fixture max brightness trims its output without overriding it', async () => {
  const fix = state.fixtures[0];
  applyPatch({ pattern: 'solid', colorA: 9, masterDimmer: 255, masterBlackout: false });
  restartBeatTimer({ tickNow: true });
  await frames();

  const full = dimmerOf(fix);
  assert.ok(full > 0, 'the fixture should be lit at no trim');

  try {
    setFixtureMaxBrightness(fix.id, 128);
    await frames();

    assert.strictEqual(fix.override, null, 'trimming must not put the fixture into override mode');
    const trimmed = dimmerOf(fix);
    assert.ok(trimmed < full, `trim should pull the dimmer down (${trimmed} < ${full})`);
    assert.ok(Math.abs(trimmed - Math.round(full * (128 / 255))) <= 1, 'and by the ratio it was set to');

    // The neighbour is untouched: this is a per-fixture ceiling, not a master.
    assert.strictEqual(dimmerOf(state.fixtures[1]), full, 'other fixtures keep their level');
  } finally {
    setFixtureMaxBrightness(fix.id, 255);
  }
});

test('a fixture max brightness of 0 puts that fixture out', async () => {
  const fix = state.fixtures[0];
  applyPatch({ pattern: 'solid', colorA: 9, masterDimmer: 255, masterBlackout: false });
  restartBeatTimer({ tickNow: true });
  await frames();

  try {
    setFixtureMaxBrightness(fix.id, 0);
    await frames();
    assert.deepStrictEqual(
      channels(fix.address, 12), new Array(12).fill(0),
      'a fixture trimmed to zero must output nothing at all',
    );
  } finally {
    setFixtureMaxBrightness(fix.id, 255);
  }
});

test('an energy override follows the grand master', async () => {
  const fix = state.fixtures[0];
  applyPatch({ masterBlackout: false, masterDimmer: 255, energyOverride: 'blinder' });
  await frames();
  const atFull = redOf(fix);
  assert.ok(atFull > 200, 'the blinder should be near full with the master up');

  try {
    applyPatch({ masterDimmer: 64 });
    await frames();
    const atQuarter = redOf(fix);
    assert.ok(
      atQuarter < atFull / 2,
      `an energy override must follow the master (${atQuarter} vs ${atFull})`,
    );
    assert.ok(Math.abs(atQuarter - Math.round(255 * (64 / 255))) <= 2, 'and scale by it');
  } finally {
    applyPatch({ energyOverride: null, masterDimmer: 255 });
  }
});

test('an energy override follows a fixture max brightness', async () => {
  const trimmed = state.fixtures[0];
  const untouched = state.fixtures[1];
  applyPatch({ masterBlackout: false, masterDimmer: 255, energyOverride: 'blinder' });
  await frames();

  try {
    setFixtureMaxBrightness(trimmed.id, 100);
    await frames();

    assert.ok(
      redOf(trimmed) < redOf(untouched),
      'the trimmed fixture must come up lower than its untrimmed neighbour',
    );
    assert.ok(redOf(untouched) > 200, 'and the neighbour still blinds');
  } finally {
    setFixtureMaxBrightness(trimmed.id, 255);
    applyPatch({ energyOverride: null });
  }
});

// A trim scales, it does not clip. Under a clamping implementation a fixture
// already sitting below the trim would come out untouched — the level would
// only bend once it crossed the line, so the bottom of every fader throw would
// feel dead and two fixtures at different trims would converge as they dimmed.
// Scaling keeps the whole range proportional: half the trim is half the output
// at every level, not only at the top.
test('a fixture max brightness scales the whole range rather than clipping it', async () => {
  const fix = state.fixtures[0];
  applyPatch({ masterBlackout: false, masterDimmer: 255 });

  try {
    // Well under the trim: a clamp would leave this at 100 and only bite above 128.
    applyOverride(fix.id, { enabled: true, r: 200, g: 0, b: 0, w: 0, dim: 100, strobe: 0 });
    setFixtureMaxBrightness(fix.id, 255);
    await frames();
    assert.strictEqual(dimmerOf(fix), 100, 'untrimmed, the override level passes through');
    assert.strictEqual(redOf(fix), Math.round(200 * (100 / 255)));

    setFixtureMaxBrightness(fix.id, 128);
    await frames();
    assert.strictEqual(
      dimmerOf(fix), Math.round(100 * (128 / 255)),
      'a level below the trim must still be scaled by it, not passed through',
    );
    assert.strictEqual(
      redOf(fix), Math.round(200 * (100 / 255) * (128 / 255)),
      'and the colour channels scale with it',
    );
  } finally {
    applyOverride(fix.id, null);
    setFixtureMaxBrightness(fix.id, 255);
  }
});

// The same rule for the grand master, which is the trim's sibling: two fixtures
// trimmed differently must stay in proportion as the master comes down, rather
// than meeting at the bottom.
test('trims stay in proportion to each other as the master falls', async () => {
  const half = state.fixtures[0];
  const full = state.fixtures[1];
  applyPatch({ pattern: 'solid', colorA: 9, masterDimmer: 255, masterBlackout: false });
  restartBeatTimer({ tickNow: true });

  try {
    setFixtureMaxBrightness(half.id, 128);
    await frames();
    const ratioAtFull = dimmerOf(half) / dimmerOf(full);

    applyPatch({ masterDimmer: 64 });
    await frames();
    const ratioAtQuarter = dimmerOf(half) / dimmerOf(full);

    assert.ok(
      Math.abs(ratioAtFull - ratioAtQuarter) < 0.05,
      `the two fixtures keep their ratio (${ratioAtFull} vs ${ratioAtQuarter})`,
    );
  } finally {
    setFixtureMaxBrightness(half.id, 255);
    applyPatch({ masterDimmer: 255 });
  }
});
