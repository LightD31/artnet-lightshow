// A fixture with no strobe channel is flashed in software through the strobe
// pattern and every strobing burst, where it used to sit there steady.

import test from 'node:test';
import assert from 'node:assert';

import { createRenderer, softStrobeHz, SOFT_STROBE_MAX_HZ } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile, profilesRevision, registerProfile, unregisterProfile, BUILTIN_PROFILE_ID } from '../../src/server/profiles.ts';
import { HUE_COLOR } from './hue-test-lamps.js';
import { barProfile } from '../../src/server/bar-profile.ts';
import { FRAME_MS } from '../../src/server/frame-clock.ts';

const BAR = barProfile({ id: 'soft-strobe-bar', name: 'No-strobe Bar', cells: 4, firstChannel: 2, order: 'RGB', dimmer: 1 });

const fixture = (id, address, profileId, extra = {}) => ({
  id, address, universe: 0, profileId, maxBrightness: 255, override: null,
  position: null, group: null, geometry: null, ...extra,
});

const baseInput = (fixtures, patch = {}) => ({
  running: true, pattern: 'strobe', colorA: 1, colorB: 1, colorC: 1, colorD: 1, split: null, pixelMap: 'stage',
  beatDivision: 1, strobeSpeed: 255, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false,
  energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null, universes: [0], fixtures, ...patch,
});

/** Render `seconds` of frames; for each fixture, whether it was lit on each frame. */
function run(fixtures, patch = {}, seconds = 1) {
  registerProfile(BAR);
  try {
    const store = universes.createUniverseStore(universes.allocateShared());
    const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
    const lit = fixtures.map(() => []);
    const input = baseInput(fixtures, patch);
    for (let t = 0; t < seconds * 1000; t += FRAME_MS) {
      renderer.frame(input, { beatPos: t / 500, bpm: 120, epoch: 0 }, t, store);
      const dmx = store.getBuffer(0);
      fixtures.forEach((f, i) => {
        const p = getProfile(f);
        const ch = p.cells ? p.cells[0].channelMap : p.channelMap;
        lit[i].push(dmx[f.address - 1 + ch.red] > 0);
      });
    }
    return lit;
  } finally {
    unregisterProfile(BAR.id);
  }
}

const onsets = (frames) => frames.filter((on, i) => on && !frames[i - 1]).length;

test('the flash rate follows the strobe value, one to twenty a second', () => {
  assert.ok(Math.abs(softStrobeHz(1) - 1) < 0.1);
  assert.strictEqual(softStrobeHz(255), SOFT_STROBE_MAX_HZ);
  assert.strictEqual(SOFT_STROBE_MAX_HZ, 20);
});

test('a bar with no strobe channel flashes at the rate asked for', () => {
  const [fast] = run([fixture(0, 1, BAR.id)], { strobeSpeed: 255 }, 2);
  const flashes = onsets(fast) / 2;
  assert.ok(flashes >= 15 && flashes <= 21, `${flashes} flashes a second at full speed`);
  assert.ok(fast.some((on) => !on) && fast.some((on) => on), 'dark between flashes');

  const [slow] = run([fixture(0, 1, BAR.id)], { strobeSpeed: 1 }, 3);
  const slowRate = onsets(slow) / 3;
  assert.ok(slowRate >= 0.6 && slowRate <= 1.4, `${slowRate} flashes a second at the slowest`);
});

test('a flash is short, not a blink', () => {
  const [slow] = run([fixture(0, 1, BAR.id)], { strobeSpeed: 1 }, 3);
  let longest = 0; let run_ = 0;
  for (const on of slow) { run_ = on ? run_ + 1 : 0; longest = Math.max(longest, run_); }
  assert.ok(longest * FRAME_MS <= 50 + FRAME_MS, `a flash lasted ${longest} frames`);
});

test('a strobing burst flashes it too', () => {
  const [lit] = run([fixture(0, 1, BAR.id)], { pattern: 'solid', strobeSpeed: 0, energy: 'color-strobe' }, 1);
  assert.ok(onsets(lit) >= 5, `${onsets(lit)} flashes in a colour-strobe second`);
});

test('the random strobe flashes each fixture on its own, the same way every time', () => {
  const [a, b] = run([fixture(0, 1, BAR.id), fixture(1, 20, BAR.id)], { strobeFunction: 'random' }, 4);
  const rate = onsets(a) / 4;
  assert.ok(rate >= 4 && rate <= 12, `${rate} random flashes a second`);
  assert.notDeepStrictEqual(a, b, 'not in lockstep');
  assert.deepStrictEqual(run([fixture(0, 1, BAR.id)], { strobeFunction: 'random' }, 4)[0], a, 'the dice are the music\'s');
});

test('without a strobe asked for, nothing is gated', () => {
  const [lit] = run([fixture(0, 1, BAR.id)], { pattern: 'solid', strobeSpeed: 0 }, 1);
  assert.ok(lit.every(Boolean));
});

test('a fixture with its own strobe channel is left to it', () => {
  const [lit] = run([fixture(0, 1, BUILTIN_PROFILE_ID)], { strobeSpeed: 255 }, 1);
  assert.ok(lit.every(Boolean), 'lit every frame; its strobe channel does the flashing');
});

test('a Hue lamp is never flashed', () => {
  registerProfile(HUE_COLOR);
  try {
    const [lamp] = run([fixture(0, 1, HUE_COLOR.id)], { strobeSpeed: 255 }, 1);
    assert.ok(lamp.every(Boolean));
  } finally {
    unregisterProfile(HUE_COLOR.id);
  }
});

// ── The functions the show draws itself ─────────────────────────────────────
// After a ROOT PAR 6's multifunction strobe channel, but drawn on every
// fixture's dimmer, locked to the beat — never asked of the fixture.

/** Render `beats` at 120 BPM; per fixture, per frame, its brightest emitter and its strobe channel. */
function levels(fixtures, patch = {}, beats = 8) {
  registerProfile(BAR);
  try {
    const store = universes.createUniverseStore(universes.allocateShared());
    const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
    const out = fixtures.map(() => []);
    // In red, which every fixture here draws at full on its red emitter.
    const input = baseInput(fixtures, { colorA: 0, colorB: 0, colorC: 0, colorD: 0, ...patch });
    for (let t = 0; t < beats * 500; t += FRAME_MS) {
      const beatPos = t / 500;
      renderer.frame(input, { beatPos, bpm: 120, epoch: 0 }, t, store);
      const dmx = store.getBuffer(0);
      fixtures.forEach((f, i) => {
        const p = getProfile(f);
        const cells = p.cells ? p.cells.map((c) => c.channelMap) : [p.channelMap];
        const base = f.address - 1;
        const level = cells.map((ch) => Math.max(...['red', 'green', 'blue', 'white'].map((k) => (ch[k] === undefined ? 0 : dmx[base + ch[k]]))));
        out[i].push({ beatPos, level: level[0], cells: level, strobe: p.channelMap.strobe === undefined ? null : dmx[base + p.channelMap.strobe] });
      });
    }
    return out;
  } finally {
    unregisterProfile(BAR.id);
  }
}

/** The frame nearest a point in the music. */
const near = (frames, beatPos) => frames.reduce((a, b) => (Math.abs(b.beatPos - beatPos) < Math.abs(a.beatPos - beatPos) ? b : a));

test('a ramp is drawn on the fixture itself, and its strobe channel is left open', () => {
  for (const fn of ['ramp-up-down', 'ramp-up', 'ramp-down', 'ramp-up-rnd', 'random', 'break']) {
    const [par] = levels([fixture(0, 1, BUILTIN_PROFILE_ID)], { strobeFunction: fn, strobeSpeed: 1 }, 8);
    assert.ok(par.every((f) => f.strobe === 0), `${fn}: no strobe-channel program is asked of the fixture`);
    assert.ok(par.some((f) => f.level === 0) && par.some((f) => f.level > 200), `${fn}: drawn from black to full`);
  }
});

test('the ramps are the same on a fixture with a strobe channel and on one without', () => {
  const [par, bar] = levels([fixture(0, 1, BUILTIN_PROFILE_ID), fixture(1, 20, BAR.id)], { strobeFunction: 'ramp-up', strobeSpeed: 1 }, 4);
  for (let k = 0; k < par.length; k += 7) assert.ok(Math.abs(par[k].level - bar[k].level) <= 2, `frame ${k}: ${par[k].level} against ${bar[k].level}`);
});

test('ramp up climbs to the beat and cuts on it, ramp down hits on the beat and dies away', () => {
  // At the slowest, a ramp is four beats long.
  const [up] = levels([fixture(0, 1, BAR.id)], { strobeFunction: 'ramp-up', strobeSpeed: 1 }, 8);
  assert.ok(near(up, 0.5).level < near(up, 2).level && near(up, 2).level < near(up, 3.8).level, 'climbing');
  assert.ok(near(up, 3.95).level > 230, 'full just before the beat');
  assert.ok(near(up, 4.02).level < 10, 'black on it');

  const [down] = levels([fixture(0, 1, BAR.id)], { strobeFunction: 'ramp-down', strobeSpeed: 1 }, 8);
  assert.ok(near(down, 4.02).level > 230, 'full on the beat');
  assert.ok(near(down, 5).level > near(down, 6).level && near(down, 6).level > near(down, 7.5).level, 'dying away');
  assert.ok(near(down, 7.97).level < 10, 'gone by the next');

  const [swell] = levels([fixture(0, 1, BAR.id)], { strobeFunction: 'ramp-up-down', strobeSpeed: 1 }, 8);
  assert.ok(near(swell, 4).level > 240 && near(swell, 6).level < 10, 'peaking on the beat, dark between');
});

test('the speed picks how many beats a ramp takes, four at the slowest to a quarter at the fastest', () => {
  const cycles = (frames) => frames.filter((f, k) => k && f.level < 20 && frames[k - 1].level > 150).length;
  const [slow] = levels([fixture(0, 1, BAR.id)], { strobeFunction: 'ramp-up', strobeSpeed: 1 }, 16);
  const [fast] = levels([fixture(0, 1, BAR.id)], { strobeFunction: 'ramp-up', strobeSpeed: 255 }, 16);
  assert.ok(cycles(slow) >= 3 && cycles(slow) <= 4, `${cycles(slow)} ramps in 16 beats at the slowest`);
  assert.ok(cycles(fast) >= 56 && cycles(fast) <= 64, `${cycles(fast)} ramps in 16 beats at the fastest`);
});

test('the random ramps run every cell of a bar on its own', () => {
  const [bar] = levels([fixture(0, 1, BAR.id)], { strobeFunction: 'ramp-up-down-rnd', strobeSpeed: 128 }, 16);
  const cell = (c) => bar.map((f) => f.cells[c]);
  assert.notDeepStrictEqual(cell(0), cell(1));
  assert.notDeepStrictEqual(cell(1), cell(2));
  for (let c = 0; c < 4; c++) assert.ok(cell(c).some((v) => v > 200) && cell(c).some((v) => v === 0), `cell ${c} swells`);
});

test('a burst flashes on the beat, then breaks', () => {
  // At the fastest, half a beat of flashes on every beat and half a beat dark.
  const [bar] = levels([fixture(0, 1, BAR.id)], { strobeFunction: 'break', strobeSpeed: 255 }, 8);
  for (const f of bar) {
    const into = f.beatPos % 1;
    if (into > 0.55 && into < 0.98) assert.strictEqual(f.level, 0, `dark in the break, ${f.beatPos.toFixed(2)}`);
  }
  const burst = bar.filter((f) => f.beatPos >= 2 && f.beatPos < 2.5).map((f) => f.level > 0);
  assert.ok(onsets(burst) >= 2, `${onsets(burst)} flashes in a burst`);
  assert.ok(near(bar, 2.01).level > 200, 'the first on the beat');
});

test('a colour strobe burst still runs the standard strobe, whatever function the look has', () => {
  const [par] = levels([fixture(0, 1, BUILTIN_PROFILE_ID)], { pattern: 'solid', strobeSpeed: 0, strobeFunction: 'ramp-up', energy: 'color-strobe' }, 2);
  assert.ok(par.every((f) => f.strobe >= 128), 'the fixture strobes itself');
});

test('a Hue lamp is never ramped', () => {
  registerProfile(HUE_COLOR);
  try {
    const [lamp] = run([fixture(0, 1, HUE_COLOR.id)], { strobeFunction: 'ramp-up', strobeSpeed: 255 }, 1);
    assert.ok(lamp.every(Boolean));
  } finally {
    unregisterProfile(HUE_COLOR.id);
  }
});
