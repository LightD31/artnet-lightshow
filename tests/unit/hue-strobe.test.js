import test from 'node:test';
import assert from 'node:assert';

import { createRenderer } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile, profilesRevision, registerProfile, BUILTIN_PROFILE_ID } from '../../src/server/profiles.ts';
import { HUE_COLOR } from './hue-test-lamps.js';
import { FRAME_MS } from '../../src/server/frame-clock.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { PATTERN_FUNCS } from '../../src/shared/patterns.ts';
import { HOLD_STROBE, HUE_PULSE_FLOOR, HUE_PULSE_MS } from '../../src/shared/look-math.ts';

// A Hue lamp's profile is built from its bridge; this one is laid out as the
// generic colour lamp the expectations were taken with.
registerProfile(HUE_COLOR);

const fixture = (id, address, profileId = BUILTIN_PROFILE_ID, extra = {}) => ({
  id, address, universe: 0, profileId, maxBrightness: 255, override: null,
  position: null, group: null, geometry: null, ...extra,
});

const LEFT = fixture(0, 1);
const LAMP = fixture(1, 20, HUE_COLOR.id, { output: { protocol: 'hue', bridge: 'b1', channels: [1] } });
const RIGHT = fixture(2, 40);
const HUE_RIG = [LEFT, LAMP, RIGHT];
const PAR_RIG = [LEFT, fixture(1, 20), RIGHT];

const SAFETY = { safety: { hdFlashIntervalMs: 350, acknowledged: true } };

const input = (fixtures, patch) => ({
  running: true, pattern: 'solid', colorA: 0, colorB: 5, colorC: 0, colorD: 5, beatDivision: 1,
  split: null, pixelMap: 'stage', strobeSpeed: 0, strobeFunction: 'standard',
  masterDimmer: 255, masterBlackout: false, energy: null, showDynamics: null, patternAnchor: null,
  fade: null, syncTest: null, universes: [0], fixtures, ...patch,
});

const spec = (raw) => validateSpec(raw);
const voice = (id, effect, extra = {}) => ({
  id, spec: effect, targets: null, tier: 'voice', launchSeq: 1, startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: seedFrom(id), ...extra,
});

function trace(fixtures, patch, ms = 3000) {
  const store = universes.createUniverseStore(universes.allocateShared());
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
  const fix = fixtures[1];
  const ch = getProfile(fix).channelMap;
  const out = [];
  for (let k = 0; k * FRAME_MS <= ms; k++) {
    const t = k * FRAME_MS;
    renderer.frame(input(fixtures, patch), { beatPos: t / 500, bpm: 120, epoch: 0 }, t, store, 0);
    const dmx = store.getBuffer(0);
    const at = (name) => (ch[name] === undefined ? 0 : dmx[fix.address - 1 + ch[name]]);
    out.push({ t, dim: at('dimmer'), rgb: [at('red'), at('green'), at('blue')], strobe: at('strobe') });
  }
  return out;
}

// Coarse-only Hue dimmers round differently from the pars' sixteen-bit dimmers.
function assertAsPar(lamp, par) {
  assert.strictEqual(lamp.length, par.length);
  for (let k = 0; k < lamp.length; k++) {
    assert.ok(Math.abs(lamp[k].dim - par[k].dim) <= 1, JSON.stringify({ lamp: lamp[k], par: par[k] }));
  }
}

function assertPulsed(frames) {
  const perFrame = Math.ceil((255 - HUE_PULSE_FLOOR) / HUE_PULSE_MS * FRAME_MS) + 1;
  const first = frames.findIndex((f) => f.dim >= 255 - perFrame);
  assert.ok(first >= 0);
  for (let k = first + 1; k < frames.length; k++) {
    const before = frames[k - 1].dim, now = frames[k].dim;
    if (before <= HUE_PULSE_FLOOR) continue;
    assert.ok(now >= HUE_PULSE_FLOOR, JSON.stringify(frames[k]));
    assert.ok(before - now <= perFrame, JSON.stringify({ before, ...frames[k] }));
  }
}

const FLASHING = [
  ['strobe voice', { voices: [voice('strobe', spec({ kind: 'strobe' }), { tier: 'strobe' })], ...SAFETY }],
  ['Palette Strobe', { energy: HOLD_STROBE, ...SAFETY }],
  ['LDJ TrueStrobe base', { pattern: 'look', effect: spec({ kind: 'ldj.TrueStrobe', palette: ['#FFFFFF'] }), ...SAFETY }],
  ['LDJ PaletteTrueStrobe voice', { voices: [voice('pad', spec({ kind: 'ldj.PaletteTrueStrobe', palette: ['#FF0000', '#00FFFF'] }))], ...SAFETY }],
  ['Ring Strobe', { pattern: 'ring-strobe' }],
  ['Ring Backlit', { pattern: 'ring-backlit' }],
  ['Flashes', { pattern: 'flashes', beatDivision: 4 }],
  ['Flash Chase', { pattern: 'flash-chase' }],
  ['Flash Scatter', { pattern: 'flash-scatter' }],
  ['Flash Fill', { pattern: 'flash-fill' }],
  ['Flash Alternate', { pattern: 'flash-alternate' }],
  ['Ramp', { pattern: 'ramp' }],
  ['Strobe Core', { pattern: 'core' }],
];

for (const [name, patch] of FLASHING) {
  test(`${name}: Flash gives Hue the par's hard cuts`, () => {
    const lamp = trace(HUE_RIG, { ...patch, hueStrobe: 'flash' });
    assertAsPar(lamp, trace(PAR_RIG, { ...patch, hueStrobe: 'flash' }));
    assert.ok(lamp.some((f, k) => k > 0 && lamp[k - 1].dim - f.dim >= 100));
  });

  test(`${name}: Pulse softens Hue cuts over 200 ms`, () => {
    assertPulsed(trace(HUE_RIG, { ...patch, hueStrobe: 'pulse' }));
  });
}

for (const [name, patch] of FLASHING.filter(([, p]) => !p.voices && !p.effect && !p.energy)) {
  test(`${name}: Pulse leaves neighbouring pars unchanged`, () => {
    const read = (hueStrobe) => {
      const store = universes.createUniverseStore(universes.allocateShared());
      const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
      const seen = [];
      for (let k = 0; k * FRAME_MS <= 2000; k++) {
        const t = k * FRAME_MS;
        renderer.frame(input(HUE_RIG, { ...patch, hueStrobe }), { beatPos: t / 500, bpm: 120, epoch: 0 }, t, store, 0);
        seen.push(Array.from(store.getBuffer(0).subarray(0, 12)), Array.from(store.getBuffer(0).subarray(39, 51)));
      }
      return seen;
    };
    assert.deepStrictEqual(read('pulse'), read('flash'));
  });
}

for (const [kind, params] of [['hd.frequencyBurst', {}], ['hd.twinkle', { probability: 1 }]]) {
  test(`${kind}: authored envelopes remain equal in both modes`, () => {
    const patch = { pattern: 'look', effect: spec({ kind, palette: ['#FFFFFF'], params }), ...SAFETY };
    const flash = trace(HUE_RIG, { ...patch, hueStrobe: 'flash' });
    assert.deepStrictEqual(trace(HUE_RIG, { ...patch, hueStrobe: 'pulse' }), flash);
    assertAsPar(flash, trace(PAR_RIG, { ...patch, hueStrobe: 'flash' }));
    assert.ok(flash.some((f) => f.dim > 0));
  });
}

for (const [name, patch] of [
  ['White Strobe', { energy: 'white-strobe', ...SAFETY }],
  ['Colour Strobe', { energy: 'color-strobe', ...SAFETY }],
  ['Strobe look', { pattern: 'strobe', strobeSpeed: 121 }],
]) {
  test(`${name}: hardware strobes keep Hue steady in both modes`, () => {
    const flash = trace(HUE_RIG, { ...patch, hueStrobe: 'flash' }, 1000);
    assert.deepStrictEqual(trace(HUE_RIG, { ...patch, hueStrobe: 'pulse' }, 1000), flash);
    assert.ok(flash.every((f) => f.dim === 255));
    assert.ok(trace(PAR_RIG, { ...patch, hueStrobe: 'flash' }, 100).every((f) => f.strobe > 0));
  });
}

const RED = { r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0 };
const BLUE = { r: 0, g: 0, b: 255, w: 0, a: 0, uv: 0 };

function patternAt(pattern, ms, extra = {}) {
  const out = [];
  PATTERN_FUNCS[pattern]({
    colors: [RED, BLUE], fixtureCount: 3, step: Math.floor(ms / 500), stepPos: ms / 500,
    stepPhase: ms / 500 % 1, stepMs: 500, hue: 0, twinkle: [0, 0, 0], xs: null, ys: null,
    dynamics: null, noFlash: [true, true, true], hueStrobe: 'pulse',
    write: (i, colour, dim) => { out[i] = { colour, dim }; }, ...extra,
  });
  return out;
}

test('Flash Chase keeps the previous lap colour until the next flash', () => {
  assert.deepStrictEqual(patternAt('flash-chase', 650)[1], { colour: RED, dim: 40 });
  assert.deepStrictEqual(patternAt('flash-chase', 500 + 500 / 3 + 100)[1], { colour: BLUE, dim: 148 });
});

test('Flash Chase leaves an unreached Hue lamp dark', () => {
  assert.strictEqual(patternAt('flash-chase', 0)[1].dim, 0);
});

test('Flash Alternate leaves the unflashed half dark', () => {
  assert.strictEqual(patternAt('flash-alternate', 0)[1].dim, 0);
});

test('Flash Alternate holds the inactive half in its own colour', () => {
  assert.deepStrictEqual(patternAt('flash-alternate', 600)[1], { colour: BLUE, dim: 40 });
});

test('Flash Fill preserves its tail before the next fill arrives', () => {
  assert.deepStrictEqual(patternAt('flash-fill', 400)[2], { colour: RED, dim: 148 });
  assert.deepStrictEqual(patternAt('flash-fill', 550)[2], { colour: RED, dim: 40 });
  assert.deepStrictEqual(patternAt('flash-fill', 650)[2], { colour: BLUE, dim: 255 });
});

test('Ramp retains the previous colour until the new swell overtakes it', () => {
  assert.deepStrictEqual(patternAt('ramp', 600)[1], { colour: RED, dim: 148 });
  assert.deepStrictEqual(patternAt('ramp', 750)[1], { colour: BLUE, dim: 64 });
});

test('Strobe Core decays to its native glow', () => {
  assert.strictEqual(patternAt('core', 100)[1].dim, 157);
  assert.deepStrictEqual(patternAt('core', 200)[1], { colour: RED, dim: 59 });
});

test('Strobe Core follows the analysed kick envelope in Pulse', () => {
  const pulse = { mix: 0.5, kick: 0.3, snare: 0, hats: 0 };
  assert.strictEqual(patternAt('core', 100, { pulse })[1].dim, 128);
  assert.strictEqual(patternAt('core', 100, { pulse, hueStrobe: 'flash' })[1].dim, 59);
});
