// Identify: a fixture shows itself on the rig — a par blinks, a bar marks its
// first cell green and its last red with a dot running between — over the
// look, the master and a blackout, and a device not yet patched gets the same
// picture streamed to it.

import test from 'node:test';
import assert from 'node:assert';

import {
  identifyLights, identifyParLit, identifyDot, identifyPixels, identifySeconds, fixturesOnUniverses,
  createIdentify, createPixelIdentify, IDENTIFY_SECONDS, IDENTIFY_MAX_SECONDS, IDENTIFY_SWEEP_MS,
} from '../../src/server/identify.ts';
import { createRenderer } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile, profilesRevision, registerProfile, unregisterProfile, BUILTIN_PROFILE_ID } from '../../src/server/profiles.ts';
import { barProfile } from '../../src/server/bar-profile.ts';

const BAR = barProfile({ id: 'identify-bar', name: 'Identify Bar', cells: 8, firstChannel: 3, order: 'RGB', dimmer: 1, strobe: 2 });

test('a par blinks, steady and slow', () => {
  assert.strictEqual(identifyParLit(0), true);
  assert.strictEqual(identifyParLit(399), true);
  assert.strictEqual(identifyParLit(400), false);
  assert.strictEqual(identifyParLit(699), false);
  assert.strictEqual(identifyParLit(700), true, 'and again');
  const [light] = identifyLights(1, 100);
  assert.deepStrictEqual([light.col.r, light.col.g, light.col.b, light.dim], [255, 255, 255, 255]);
  assert.strictEqual(identifyLights(1, 500)[0].dim, 0);
});

test('a bar marks its ends and runs a dot from the first cell to the last', () => {
  const at = (ms) => identifyLights(8, ms);
  for (const ms of [0, 300, 900, 1400]) {
    const lights = at(ms);
    assert.deepStrictEqual([lights[0].col.g, lights[0].col.r], [255, 0], 'the first cell is green');
    assert.deepStrictEqual([lights[7].col.r, lights[7].col.g], [255, 0], 'the last is red');
  }
  const dots = [];
  for (let ms = 0; ms < IDENTIFY_SWEEP_MS; ms += 50) dots.push(identifyDot(8, ms));
  assert.deepStrictEqual([...new Set(dots)], [0, 1, 2, 3, 4, 5, 6, 7], 'the dot visits every cell, in wiring order');
  const middle = at(IDENTIFY_SWEEP_MS * 0.45);
  const lit = middle.map((l, c) => (l.dim ? c : null)).filter((c) => c !== null);
  assert.deepStrictEqual(lit, [0, 3, 7], 'the ends and the dot, nothing else');
});

test('the picture as pixels: RGB, and white on its own die for RGBW', () => {
  const rgb = identifyPixels(4, false, 0);
  assert.strictEqual(rgb.length, 12);
  assert.deepStrictEqual([...rgb.subarray(0, 3)], [0, 255, 0]);
  assert.deepStrictEqual([...rgb.subarray(9, 12)], [255, 0, 0]);
  const rgbw = identifyPixels(10, true, IDENTIFY_SWEEP_MS * 0.45);
  assert.strictEqual(rgbw.length, 40);
  const dot = identifyDot(10, IDENTIFY_SWEEP_MS * 0.45);
  assert.deepStrictEqual([...rgbw.subarray(dot * 4, dot * 4 + 4)], [0, 0, 0, 255]);
});

test('seconds from a request: the default, 0 to stop, capped', () => {
  assert.strictEqual(identifySeconds(undefined), IDENTIFY_SECONDS);
  assert.strictEqual(identifySeconds('x'), IDENTIFY_SECONDS);
  assert.strictEqual(identifySeconds(0), 0);
  assert.strictEqual(identifySeconds(3.4), 3);
  assert.strictEqual(identifySeconds(999), IDENTIFY_MAX_SECONDS);
});

test('the fixtures on some universes, a strip on every one it runs over', () => {
  const long = barProfile({ id: 'identify-strip', name: 'Strip', cells: 300, firstChannel: 1, order: 'RGB' });
  const profiles = { par: { channelCount: 12, channelMap: { dimmer: 0 } }, strip: long };
  const fixtures = [
    { id: 1, address: 1, universe: 0, profileId: 'par' },
    { id: 2, address: 1, universe: 1, profileId: 'strip' },
    { id: 3, address: 20, universe: 3, profileId: 'par' },
  ];
  const on = (list) => fixturesOnUniverses(fixtures, list, (f) => profiles[f.profileId], (f) => f.universe);
  assert.deepStrictEqual(on([0]), [1]);
  assert.deepStrictEqual(on([2]), [2], 'the strip runs on into universe 2');
  assert.deepStrictEqual(on([1, 3]), [2, 3]);
  assert.deepStrictEqual(on([9]), []);
});

test('identify runs for its time, is replaced by the next, and says so', () => {
  let t = 1000;
  const timers = [];
  const identify = createIdentify({
    clock: () => t,
    setTimer: (fn, ms) => { const h = { fn, ms, cleared: false }; timers.push(h); return h; },
    clearTimer: (h) => { h.cleared = true; },
  });
  let changes = 0;
  identify.onChange(() => changes++);

  const status = identify.start([4, 4, 7], 5);
  assert.deepStrictEqual(status, { ids: [4, 7], remainingMs: 5000 });
  const first = identify.request();
  assert.strictEqual(first.ms, 5000);
  t += 2000;
  assert.strictEqual(identify.status().remainingMs, 3000);

  identify.start([9], 8);
  assert.ok(timers[0].cleared, 'the first one\'s end is called off');
  assert.ok(identify.request().seq > first.seq);
  timers[1].fn();
  assert.strictEqual(identify.request(), null);
  assert.deepStrictEqual(identify.status(), { ids: [], remainingMs: 0 });

  identify.start([1], 5);
  identify.stop();
  assert.deepStrictEqual(identify.request().ids, [], 'a stop is a request the renderer adopts');
  assert.strictEqual(changes, 5, "every start, every end and the stop");
});

test('a device not in the patch is streamed its picture, then left alone', () => {
  let t = 0;
  const ticks = [];
  const sent = [];
  const pixels = createPixelIdentify({
    send: (target, data) => sent.push({ ...target, data }),
    clock: () => t,
    every: (fn) => { ticks.push(fn); return { id: ticks.length }; },
    stopEvery: (h) => { ticks[h.id - 1] = null; },
  });
  pixels.start('wled-porch.local', { leds: 30, rgbw: false }, 2);
  assert.strictEqual(sent.length, 1, 'a frame straight away');
  assert.strictEqual(sent[0].data.length, 90);
  t = 1000; ticks[0]();
  assert.deepStrictEqual(pixels.active(), ['wled-porch.local']);
  t = 2100; ticks[0]();
  assert.strictEqual(sent.length, 2, 'nothing sent once its time is up');
  assert.strictEqual(ticks[0], null, 'and the timer is stopped');
  assert.deepStrictEqual(pixels.active(), []);
  assert.deepStrictEqual(sent.map((s) => s.sequence), [1, 2]);
});

// ── In the renderer ──────────────────────────────────────────────────────────

const fixture = (id, address, profileId) => ({
  id, address, universe: 0, profileId, maxBrightness: 255, override: null, position: null, group: null, geometry: null, hue: false,
});

const input = (fixtures, patch = {}) => ({
  running: true, pattern: 'solid', colorA: 1, colorB: 1, colorC: 1, colorD: 1, split: null, pixelMap: 'stage',
  beatDivision: 1, strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false,
  energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null, identify: null,
  universes: [0], fixtures, ...patch,
});

function renderAt(fixtures, patch, times) {
  registerProfile(BAR);
  try {
    const store = universes.createUniverseStore(universes.allocateShared());
    const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
    return times.map((t) => {
      renderer.frame(input(fixtures, patch), { beatPos: t / 500, bpm: 120, epoch: 0 }, t, store);
      return Buffer.from(store.getBuffer(0));
    });
  } finally {
    unregisterProfile(BAR.id);
  }
}

test('an identified par blinks white through a blackout and a closed master; the rest is untouched', () => {
  const par = fixture(1, 1, BUILTIN_PROFILE_ID);
  const other = fixture(2, 13, BUILTIN_PROFILE_ID);
  const ch = getProfile(par).channelMap;
  const request = { seq: 1, ids: [1], at: 0, ms: 5000 };
  const [lit, dark] = renderAt([par, other], { masterBlackout: true, masterDimmer: 0, identify: request }, [100, 500]);
  assert.strictEqual(lit[ch.dimmer], 255, 'at full through the blackout');
  assert.strictEqual(lit[ch.red], 255);
  assert.strictEqual(lit[12 + ch.dimmer], 0, 'the other fixture stays blacked out');
  assert.strictEqual(dark[ch.dimmer], 0, 'and blinks');

  const [live] = renderAt([par, other], { identify: request, colorA: 2 }, [100]);
  assert.strictEqual(live[ch.red], 255);
  assert.strictEqual(live[ch.green], 255, 'white, whatever the look');
  const [plain] = renderAt([par, other], { colorA: 2 }, [100]);
  assert.deepStrictEqual(live.subarray(12, 24), plain.subarray(12, 24), 'the other fixture shows the look');
});

test('an identified bar shows its first cell green and its last red; identify ends on time', () => {
  const bar = fixture(3, 1, BAR.id);
  const cells = BAR.cells.map((c) => c.channelMap);
  const request = { seq: 1, ids: [3], at: 0, ms: 1000 };
  const [during, after] = renderAt([bar], { identify: request, masterDimmer: 40 }, [100, 1200]);
  assert.deepStrictEqual([during[cells[0].red], during[cells[0].green]], [0, 255]);
  assert.deepStrictEqual([during[cells[7].red], during[cells[7].green]], [255, 0]);
  assert.strictEqual(during[BAR.channelMap.dimmer], 255, 'its dimmer open, master or not');
  assert.notDeepStrictEqual([after[cells[0].red], after[cells[0].green]], [0, 255], 'back to the look after');
});

test('a stop request lets go on the next frame', () => {
  const par = fixture(1, 1, BUILTIN_PROFILE_ID);
  const ch = getProfile(par).channelMap;
  registerProfile(BAR);
  try {
    const store = universes.createUniverseStore(universes.allocateShared());
    const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
    const reading = { beatPos: 0, bpm: 120, epoch: 0 };
    renderer.frame(input([par], { masterBlackout: true, identify: { seq: 1, ids: [1], at: 0, ms: 9000 } }), reading, 100, store);
    assert.strictEqual(store.getBuffer(0)[ch.dimmer], 255);
    renderer.frame(input([par], { masterBlackout: true, identify: { seq: 2, ids: [], at: 110, ms: 0 } }), reading, 120, store);
    assert.strictEqual(store.getBuffer(0)[ch.dimmer], 0);
  } finally {
    unregisterProfile(BAR.id);
  }
});
