'use strict';

// The rehearsal preview and the live engine have to resolve a look to the same
// emitter values. They are separate code paths — one writes DMX buffers through
// a profile's channel map, the other returns colours for the browser — so the
// only thing keeping them honest is that both compute through
// src/shared/look-math.js, and the only thing keeping *that* true is this file.
//
// Before the shared module existed the two had already drifted: the preview
// showed a blinder as pure RGB white where the rig drives white and amber dies
// as well, and it omitted the UV boost entirely, so a UV wash previewed at a
// little over half the level it reaches on stage.

const test = require('node:test');
const assert = require('node:assert');

const { state } = require('../../src/server/state');
const universes = require('../../src/server/universes');
const { getProfile } = require('../../src/server/profiles');
const { startEngine, stopEngine, restartBeatTimer } = require('../../src/server/engine');
const { applyPatch } = require('../../src/server/patch');
const { COLOR_PRESETS } = require('../../src/server/presets');
const { createPreviewSampler } = require('../../src/shared/preview');

const FRAME_MS = 25;
const frames = (n = 3) => new Promise((r) => setTimeout(r, FRAME_MS * n + 20));

const EMITTERS = ['red', 'green', 'blue', 'white', 'amber', 'uv'];
const AS_KEY = { red: 'r', green: 'g', blue: 'b', white: 'w', amber: 'a', uv: 'uv' };

/** What the rig is actually driving the first fixture's emitters at. */
function rigEmitters() {
  const fix = state.fixtures[0];
  const buf = universes.getBuffer(fix.universe ?? state.artnet.universe);
  const ch = getProfile(fix).channelMap;
  const base = fix.address - 1;
  const out = {};
  for (const name of EMITTERS) {
    if (ch[name] !== undefined) out[AS_KEY[name]] = buf[base + ch[name]];
  }
  return out;
}

/** The same look, resolved by the browser's sampler instead. */
function previewEmitters(colorA, burstId) {
  const timeline = [
    { timeMs: 0, action: 'patch', data: { pattern: 'solid', colorA, bpm: 120, beatDivision: 1 } },
  ];
  if (burstId) {
    timeline.push({ timeMs: 0, action: 'energy', data: { id: burstId, durationMs: 5000 } });
  }
  const sample = createPreviewSampler(timeline);
  const [first] = sample(10, [{ maxBrightness: 255 }], COLOR_PRESETS);
  const out = {};
  for (const name of EMITTERS) out[AS_KEY[name]] = first[AS_KEY[name]];
  return out;
}

/** Only the emitters this fixture's profile actually has. */
const comparable = (rig, preview) => {
  const picked = {};
  for (const key of Object.keys(rig)) picked[key] = preview[key];
  return picked;
};

test.before(() => {
  state.artnet.enabled = false;
  state.masterBlackout = false;
  // Master at full, so the one thing the preview deliberately ignores cannot
  // account for a difference. Everything else must match exactly.
  applyPatch({
    pattern: 'solid', running: true, masterDimmer: 255, colorA: 1,
    masterBlackout: false, showDynamics: null, energyOverride: null,
  });
  startEngine();
});

test.after(() => stopEngine());

// Every burst the director can reach for. `color-strobe` and `glow` derive from
// the look's slot A, so they are the ones that catch a preview reading the wrong
// colour rather than the wrong constant.
for (const burst of ['blinder', 'white-strobe', 'uv-wash', 'kill', 'color-strobe', 'glow']) {
  test(`${burst} previews as the rig drives it`, async () => {
    applyPatch({ colorA: 1, energyOverride: burst, masterDimmer: 255, masterBlackout: false });
    restartBeatTimer({ tickNow: true });
    await frames();

    const rig = rigEmitters();
    assert.ok(Object.keys(rig).length > 0, 'the test fixture should have emitters');
    assert.deepStrictEqual(comparable(rig, previewEmitters(1, burst)), rig);
  });
}

test('a plain lit look previews as the rig drives it', async () => {
  applyPatch({ colorA: 3, energyOverride: null, masterDimmer: 255, masterBlackout: false });
  restartBeatTimer({ tickNow: true });
  await frames();

  const rig = rigEmitters();
  assert.deepStrictEqual(comparable(rig, previewEmitters(3, null)), rig);
});

test('the blinder drives every visible emitter, not just the primaries', () => {
  const preview = previewEmitters(1, 'blinder');
  assert.ok(preview.w > 0, 'white die should be driven');
  assert.ok(preview.a > 0, 'amber die should be driven');
});

test('a UV wash previews with the boost the rig applies', () => {
  // 255 * 1.8 clamps to 255 rather than wrapping or previewing at 141.
  assert.strictEqual(previewEmitters(1, 'uv-wash').uv, 255);
});

// Fades have to rehearse as they play: a preview that cut where the rig fades
// would show a breakdown arriving two bars before it does.
test('a crossfade previews partway through, and finishes where the rig does', () => {
  const timeline = [
    { timeMs: 0, action: 'patch', data: { pattern: 'solid', colorA: 0, bpm: 120, beatDivision: 1 } },
    { timeMs: 1000, action: 'patch', data: { colorA: 5, fadeMs: 1000 } },
  ];
  const sample = createPreviewSampler(timeline);
  const at = (ms) => sample(ms, [{ maxBrightness: 255 }], COLOR_PRESETS)[0];

  assert.deepStrictEqual([at(900).r, at(900).b], [255, 0], 'red before the fade');
  const mid = at(1500);
  assert.ok(mid.r > 0 && mid.b > 0, `both halfway: ${JSON.stringify(mid)}`);
  assert.deepStrictEqual([at(2100).r, at(2100).g, at(2100).b], [0, 85, 255], 'blue after it');
});

test('a look without a fade cuts in the preview too', () => {
  const sample = createPreviewSampler([
    { timeMs: 0, action: 'patch', data: { pattern: 'solid', colorA: 0, bpm: 120, beatDivision: 1 } },
    { timeMs: 1000, action: 'patch', data: { colorA: 5, fadeMs: 2000 } },
    { timeMs: 1200, action: 'patch', data: { colorA: 3 } },
  ]);
  const [first] = sample(1250, [{ maxBrightness: 255 }], COLOR_PRESETS);
  assert.deepStrictEqual([first.r, first.g, first.b], [0, 255, 85]);
});

test('the preview blends the same values the engine does', () => {
  // Frozen at the same point of the same fade, both sides go through
  // blendFixture; compare what each makes of it.
  const { blendFixture } = require('../../src/shared/look-math');
  const red = { ...COLOR_PRESETS[0], dim: 255, strobe: 0 };
  const blue = { ...COLOR_PRESETS[5], dim: 255, strobe: 0 };
  const expected = blendFixture(red, blue, 0.5);
  const sample = createPreviewSampler([
    { timeMs: 0, action: 'patch', data: { pattern: 'solid', colorA: 0, bpm: 120, beatDivision: 1 } },
    { timeMs: 1000, action: 'patch', data: { colorA: 5, fadeMs: 1000 } },
  ]);
  const [mid] = sample(1500, [{ maxBrightness: 255 }], COLOR_PRESETS);
  const scale = expected.dim / 255;
  assert.deepStrictEqual([mid.r, mid.g, mid.b],
    [Math.round(expected.r * scale), Math.round(expected.g * scale), Math.round(expected.b * scale)]);
});

test('a split look rehearses as the rig plays it', () => {
  const sample = createPreviewSampler([
    { timeMs: 0, action: 'patch', data: { pattern: 'solid', colorA: 0, colorB: 5, bpm: 120, beatDivision: 1, split: 1 } },
  ]);
  const rig = [{ group: 'front' }, { group: 'back' }, {}];
  const out = sample(100, rig, COLOR_PRESETS);
  assert.deepStrictEqual(out.map((c) => [c.r, c.b]), [[255, 0], [0, 255], [255, 0]]);
});
