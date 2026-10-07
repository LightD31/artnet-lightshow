// The hold strobe on the rig and in the rehearsal preview: flashes in the
// look's colours on the beat grid over the running look, a par flashed and
// a Hue lamp pulsed, and both sides driving the same bytes.

import test from 'node:test';
import assert from 'node:assert';

import { createRenderer } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile, profilesRevision, registerProfile, BUILTIN_PROFILE_ID } from '../../src/server/profiles.ts';
import { HUE_COLOR } from './hue-test-lamps.js';
import { COLOR_PRESETS, ENERGY_EFFECTS } from '../../src/server/presets.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { HOLD_STROBE, HOLD_FLASH_MS, HOLD_BLACK_MS, HUE_PULSE_MS, HUE_PULSE_FLOOR, holdStrobeFlash, holdStrobeLook, resolveEnergyOverride } from '../../src/shared/look-math.ts';

const RED = COLOR_PRESETS[0];
const BLUE = COLOR_PRESETS[5];

const fixture = (id, address, profileId, extra = {}) => ({
  id, address, universe: 0, profileId, maxBrightness: 255, override: null,
  position: null, group: null, geometry: null, ...extra,
});

const PAR = fixture(0, 1, BUILTIN_PROFILE_ID);
registerProfile(HUE_COLOR);
const LAMP = fixture(1, 20, HUE_COLOR.id, { output: { protocol: 'hue', channel: 1 } });

// Red over blue, so a flash in colour B is told from the look in colour A.
const LOOK = { pattern: 'solid', colorA: 0, colorB: 5, colorC: 0, colorD: 5, bpm: 120, beatDivision: 1 };

const input = (patch = {}) => ({
  running: true, ...LOOK, split: null, pixelMap: 'stage', strobeSpeed: 0, strobeFunction: 'standard',
  masterDimmer: 255, masterBlackout: false, energy: HOLD_STROBE, showDynamics: null, patternAnchor: null,
  fade: null, syncTest: null, universes: [0], fixtures: [PAR, LAMP], ...patch,
});

/** What the rig puts on the par and the lamp at `ms` into the music at 120 BPM. */
function rigAt(ms, patch) {
  const store = universes.createUniverseStore(universes.allocateShared());
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
  renderer.frame(input(patch), { beatPos: ms / 500, bpm: 120, epoch: 0 }, ms, store);
  const dmx = store.getBuffer(0);
  const read = (fix) => {
    const ch = getProfile(fix).channelMap;
    const base = fix.address - 1;
    return { dim: dmx[base + ch.dimmer], r: dmx[base + ch.red], g: dmx[base + ch.green], b: dmx[base + ch.blue] };
  };
  return [read(PAR), read(LAMP)];
}

test('a par flashes in the look\'s colours on the half beat, black after, the look between', () => {
  // 120 BPM: half beats, a flash every 250 ms.
  assert.deepStrictEqual(rigAt(0)[0], { dim: 255, r: 255, g: 0, b: 0 }, 'colour A on the beat');
  assert.deepStrictEqual(rigAt(100)[0], { dim: 0, r: 0, g: 0, b: 0 }, 'black after the flash');
  assert.deepStrictEqual(rigAt(200)[0], { dim: 255, r: 255, g: 0, b: 0 }, 'the running look (solid A) between');
  assert.deepStrictEqual(rigAt(250)[0], { dim: 255, r: 0, g: 85, b: 255 }, 'colour B on the half beat');
  assert.deepStrictEqual(rigAt(450)[0], { dim: 255, r: 255, g: 0, b: 0 });
  assert.deepStrictEqual(rigAt(500)[0], { dim: 255, r: 255, g: 0, b: 0 }, 'A again on the next beat');
});

test('a Hue lamp takes each flash at full and falls to the floor, never black', () => {
  assert.deepStrictEqual(rigAt(0)[1], { dim: 255, r: 255, g: 0, b: 0 });
  assert.deepStrictEqual(rigAt(100)[1], { dim: 148, r: 148, g: 0, b: 0 });
  assert.deepStrictEqual(rigAt(200)[1], { dim: 40, r: 40, g: 0, b: 0 });
  assert.deepStrictEqual(rigAt(240)[1], { dim: 40, r: 40, g: 0, b: 0 }, 'held');
  assert.deepStrictEqual(rigAt(250)[1], { dim: 255, r: 0, g: 85, b: 255 }, 'then colour B');
  for (let ms = 0; ms < 2000; ms += 25) assert.ok(rigAt(ms)[1].dim >= 40, `${rigAt(ms)[1].dim} at ${ms} ms`);
});

test('the flash limit still holds the rig to its three large flashes a second', () => {
  const store = universes.createUniverseStore(universes.allocateShared());
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
  const bright = [];
  for (let ms = 0; ms < 2000; ms += 25) {
    renderer.frame(input({ flashLimit: true, fixtures: [PAR] }), { beatPos: ms / 500, bpm: 120, epoch: 0 }, ms, store);
    bright.push(store.getBuffer(0)[3] > 200);
  }
  const rises = bright.filter((on, i) => on && !bright[i - 1]).length;
  assert.ok(rises <= 8, `${rises} large flashes in two seconds`);
});

test('the preview drives the same bytes as the rig, par and lamp alike', () => {
  const sample = createPreviewSampler([
    { timeMs: 0, action: 'patch', data: LOOK },
    { timeMs: 0, action: 'energy', data: { id: HOLD_STROBE, durationMs: 5000 } },
  ]);
  const fixtures = [PAR, LAMP];
  const rig = buildRig(fixtures, getProfile);
  for (const ms of [0, 60, 100, 170, 200, 250, 320, 480, 760, 1010]) {
    const preview = sample(ms, fixtures, COLOR_PRESETS, rig);
    const [par, lamp] = rigAt(ms);
    assert.deepStrictEqual([par.r, par.g, par.b], [preview[0].r, preview[0].g, preview[0].b], `the par at ${ms} ms`);
    assert.deepStrictEqual([lamp.r, lamp.g, lamp.b], [preview[1].r, preview[1].g, preview[1].b], `the lamp at ${ms} ms`);
  }
});

// ── Its timing and its look, per lamp ───────────────────────────────────────

test('the hold strobe is an energy effect the look resolves per lamp', () => {
  assert.ok(ENERGY_EFFECTS.some((e) => e.id === HOLD_STROBE));
  assert.strictEqual(resolveEnergyOverride(HOLD_STROBE, RED, 1), null, 'not one look for every fixture');
});

test('its flashes fall on the finest division of the beat under five a second', () => {
  const period = (bpm) => holdStrobeFlash(0, bpm).periodMs;
  assert.strictEqual(period(128), 60000 / 128 / 2, 'half beats at 128: 4.3 a second');
  assert.strictEqual(period(174), 60000 / 174, 'beats at 174: 2.9 a second, halves would be 5.8');
  assert.strictEqual(period(300), 200, 'exactly five at 300');
  assert.strictEqual(period(30), 250, 'eighths at 30');
  assert.strictEqual(period(null), 250, '120 without a tempo');
  for (const bpm of [30, 60, 90, 128, 150, 174, 200, 300]) assert.ok(1000 / period(bpm) <= 5 + 1e-9, `${bpm}`);
  assert.deepStrictEqual(holdStrobeFlash(0.5, 128), { index: 1, sinceMs: 0, periodMs: 60000 / 128 / 2 }, 'the second flash on the half beat');
  assert.strictEqual(holdStrobeFlash(0.6, 128).index, 1);
  assert.ok(Math.abs(holdStrobeFlash(0.6, 128).sinceMs - 0.1 * (60000 / 128)) < 1e-9);
});

test('each flash is a colour of the look at full, then black, then the look shows through', () => {
  const pal = [RED, BLUE];
  const flash = (index, sinceMs) => holdStrobeLook(pal, { index, sinceMs, periodMs: 250 }, false);
  assert.deepStrictEqual(flash(0, 0), { col: RED, dim: 255, strobe: 0 });
  assert.deepStrictEqual(flash(0, HOLD_FLASH_MS - 1), { col: RED, dim: 255, strobe: 0 });
  assert.strictEqual(flash(0, HOLD_FLASH_MS).dim, 0, 'black');
  assert.strictEqual(flash(0, HOLD_FLASH_MS + HOLD_BLACK_MS - 1).dim, 0);
  assert.strictEqual(flash(0, HOLD_FLASH_MS + HOLD_BLACK_MS), null, 'the running look');
  assert.strictEqual(flash(1, 0).col, BLUE, 'the colours in turn');
  assert.strictEqual(flash(2, 0).col, RED);
  assert.strictEqual(flash(-1, 0).col, BLUE);
  // A Hue lamp: the colour at full falling to the floor, held there.
  const hue = (sinceMs) => holdStrobeLook(pal, { index: 0, sinceMs, periodMs: 250 }, true);
  assert.deepStrictEqual(hue(0), { col: RED, dim: 255, strobe: 0 });
  assert.strictEqual(hue(100).dim, 148);
  assert.strictEqual(hue(HUE_PULSE_MS).dim, HUE_PULSE_FLOOR);
  assert.strictEqual(hue(240).dim, HUE_PULSE_FLOOR);
});
