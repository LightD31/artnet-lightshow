'use strict';

// LED bars on the rig: every cell of a bar is a light of its own, driven so
// that it looks exactly like a par would at the same level.

const test = require('node:test');
const assert = require('node:assert');

const { state } = require('../../src/server/state');
const universes = require('../../src/server/universes');
const { renderFrame, resizeFixtureBuffers } = require('../../src/server/engine');
const { conductor } = require('../../src/server/conductor');
const { applyPatch, applyOverride } = require('../../src/server/patch');
const { registerProfile, unregisterProfile } = require('../../src/server/profiles');
const { hueChannelColors, configureHue } = require('../../src/server/output');
const { cellDrive } = require('../../src/shared/look-math');

// Eight RGB cells behind a master dimmer and a strobe channel.
const BAR = {
  id: 'test-bar-8', name: 'Test bar', channelCount: 26,
  channelMap: { dimmer: 0, strobe: 1 },
  cells: Array.from({ length: 8 }, (_, i) => ({ channelMap: { red: 2 + i * 3, green: 3 + i * 3, blue: 4 + i * 3 } })),
};
// The same, with no dimmer anywhere: the colour carries the level alone.
const BARE = {
  id: 'test-bar-bare', name: 'Bare bar', channelCount: 12, channelMap: {},
  cells: Array.from({ length: 4 }, (_, i) => ({ channelMap: { red: i * 3, green: i * 3 + 1, blue: i * 3 + 2 } })),
};

const PAR = { profileId: 'cameo-root-par-6-12ch' };   // dimmer 0, strobe 2, red 3, green 4, blue 5
let beat = 0;
let saved;

test.before(() => {
  registerProfile(BAR);
  registerProfile(BARE);
  saved = { fixtures: state.fixtures, artnet: state.artnet.enabled };
  state.artnet.enabled = false;
  conductor.setProlinkSource(() => ({ beatPos: beat, bpm: 120 }));
});
test.after(() => {
  conductor.setProlinkSource(null);
  state.fixtures = saved.fixtures;
  state.artnet.enabled = saved.artnet;
  resizeFixtureBuffers();
  unregisterProfile(BAR.id);
  unregisterProfile(BARE.id);
});

const fixture = (id, address, profileId, extra = {}) => ({
  id, label: `F${id}`, address, universe: 0, profileId, maxBrightness: 255, override: null, ...extra,
});

function rig(...fixtures) {
  state.fixtures = fixtures;
  resizeFixtureBuffers();
}

const LOOK = {
  running: true, masterDimmer: 255, masterBlackout: false, energyOverride: null, showDynamics: null,
  split: null, pixelMap: 'stage', colorA: 1, colorB: 5, colorC: 1, colorD: 5, beatDivision: 1, strobeSpeed: 0,
};

/** Set a look at beat 0, then render the frame at `at` beats. */
function show(patch, at = 0.25) {
  beat = 0;
  applyPatch({ ...LOOK, ...patch });
  beat = at;
  renderFrame();
  return universes.getBuffer(0);
}

const cellRGB = (dmx, base, c) => [dmx[base + 2 + c * 3], dmx[base + 3 + c * 3], dmx[base + 4 + c * 3]];

test('a look the same on every cell drives a bar exactly as it drives a par', () => {
  rig(fixture(0, 1, PAR.profileId), fixture(1, 13, BAR.id));
  const dmx = show({ pattern: 'solid', masterDimmer: 180 });
  const par = [dmx[3], dmx[4], dmx[5]];
  assert.ok(par.some((v) => v > 0), 'the par is lit');
  assert.strictEqual(dmx[12], dmx[0], 'the bar\'s dimmer is the par\'s');
  for (let c = 0; c < 8; c++) assert.deepStrictEqual(cellRGB(dmx, 12, c), par, `cell ${c + 1}`);
});

test('a wave rolls along a bar rather than lighting it as one', () => {
  rig(fixture(0, 1, BAR.id));
  const dmx = show({ pattern: 'wave' }, 1.5);
  const reds = Array.from({ length: 8 }, (_, c) => cellRGB(dmx, 0, c)[0]);
  assert.ok(new Set(reds).size >= 4, `the cells differ: ${reds}`);
});

// A chase steps through fixtures: a bar is one slot, all its cells together.
test('a chase lights a whole bar at once', () => {
  rig(fixture(0, 1, PAR.profileId), fixture(1, 13, BAR.id), fixture(2, 39, PAR.profileId));
  const dmx = show({ pattern: 'chase' }, 1.5);       // step 1: the bar's turn
  const cells = Array.from({ length: 8 }, (_, c) => cellRGB(dmx, 12, c).join());
  assert.strictEqual(new Set(cells).size, 1, 'every cell the same');
  assert.strictEqual(dmx[12], 255, 'at full');
});

test('kill and silence close a bar\'s dimmer as well as its cells', () => {
  rig(fixture(0, 1, BAR.id));
  let dmx = show({ pattern: 'solid', energyOverride: 'kill' });
  assert.strictEqual(dmx[0], 0);
  assert.ok(Array.from(dmx.subarray(2, 26)).every((v) => v === 0));
  dmx = show({ pattern: 'solid', energyOverride: null, showDynamics: { level: 0 } });
  assert.strictEqual(dmx[0], 0, 'silence');
});

test('a pinned bar holds its override on every cell', () => {
  rig(fixture(0, 1, BAR.id));
  applyOverride(0, { enabled: true, r: 200, g: 20, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0, blackout: false });
  const dmx = show({ pattern: 'rainbow' });
  applyOverride(0, null);
  for (let c = 0; c < 8; c++) assert.deepStrictEqual(cellRGB(dmx, 0, c), [200, 20, 0], `cell ${c + 1}`);
});

test('a bar strobes on its own strobe channel', () => {
  rig(fixture(0, 1, BAR.id));
  const dmx = show({ pattern: 'strobe', strobeSpeed: 255, strobeFunction: 'standard' });
  assert.ok(dmx[1] > 0);
});

test('a bar with no dimmer carries the level in its colour', () => {
  rig(fixture(0, 1, BARE.id));
  const dmx = Array.from(show({ pattern: 'solid', masterDimmer: 128 }));
  const full = Array.from(show({ pattern: 'solid', masterDimmer: 255 }));
  assert.ok(Math.abs(dmx[0] - Math.round(full[0] * 128 / 255)) <= 1, `${dmx[0]} is half of ${full[0]}`);
});

test('a fixture switched to a bar profile mid-show is driven on the next frame', () => {
  rig(fixture(0, 1, PAR.profileId));
  show({ pattern: 'wave' });
  state.fixtures[0].profileId = BAR.id;           // no resize: the rig follows the patch itself
  const dmx = show({ pattern: 'wave' }, 1.5);
  const reds = Array.from({ length: 8 }, (_, c) => cellRGB(dmx, 0, c)[0]);
  assert.ok(new Set(reds).size >= 4, `${reds}`);
});

test('each pixel map lays a wave over the bars its own way', () => {
  rig(
    fixture(0, 1, BARE.id, { position: { x: 20, y: 50 }, geometry: { length: 20, angle: 0 } }),
    fixture(1, 13, BARE.id, { position: { x: 80, y: 50 }, geometry: { length: 20, angle: 0 } }),
  );
  const reds = (pixelMap) => {
    const dmx = show({ pattern: 'wave', pixelMap }, 0.5);
    return Array.from({ length: 8 }, (_, c) => dmx[c * 3]);
  };
  const perBar = reds('bar');
  assert.deepStrictEqual(perBar.slice(0, 4), perBar.slice(4), 'per bar: both bars the same');
  const stage = reds('stage');
  assert.notDeepStrictEqual(stage.slice(0, 4), stage.slice(4), 'across the stage: they differ');
});

test('a Hue lamp bound to a bar shows the bar\'s mean glow', () => {
  rig(fixture(0, 1, BARE.id));
  const dmx = universes.getBuffer(0);
  dmx.fill(0);
  dmx[0] = 200;          // cell 1 red
  dmx[4] = 100;          // cell 2 green
  configureHue({ channels: [{ channel: 3, fixture: 0 }] });
  try {
    assert.deepStrictEqual(hueChannelColors(), [{ id: 3, r: 50, g: 25, b: 0 }]);
  } finally {
    configureHue({ channels: [] });
  }
});

// The arithmetic behind "a cell looks like a par would": the light out of a
// cell is dimmer × colour, and it must equal a par's at every level.
test('a cell\'s dimmer and colour multiply to what a par puts out', () => {
  const light = (d, c) => (d / 255) * c;
  for (const [dim, top] of [[255, 255], [128, 255], [30, 200], [200, 200]]) {
    for (const ms of [1, 0.5]) {
      const par = light(dim * ms, 255 * ms * dim / 255);
      const withCellDimmer = cellDrive(dim, top, ms, true, true);
      const out = (top * ms / 255) * (withCellDimmer.cellDim / 255) * 255 * withCellDimmer.scale;
      assert.ok(Math.abs(out - par) < 1.5, `fixture + cell dimmer at ${dim}/${top}: ${out} vs ${par}`);
      const noCellDimmer = cellDrive(dim, top, ms, true, false);
      const out2 = light(top * ms, 255 * noCellDimmer.scale);
      assert.ok(Math.abs(out2 - par) < 1e-6, `fixture dimmer only at ${dim}/${top}`);
    }
  }
  assert.deepStrictEqual(cellDrive(0, 0, 1, true, true), { cellDim: 0, scale: 0 }, 'dark');
});
