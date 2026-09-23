// A fixture with no strobe channel is flashed in software through the strobe
// pattern and every strobing burst, where it used to sit there steady.

import test from 'node:test';
import assert from 'node:assert';

import { createRenderer, softStrobeHz, SOFT_STROBE_MAX_HZ } from '../../src/server/renderer.js';
import * as universes from '../../src/server/universes.js';
import { getProfile, profilesRevision, registerProfile, unregisterProfile, BUILTIN_PROFILE_ID, HUE_COLOR_PROFILE_ID } from '../../src/server/profiles.js';
import { barProfile } from '../../src/server/bar-profile.js';
import { FRAME_MS } from '../../src/server/frame-clock.js';

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

test('the random strobe flashes each fixture on its own at the same average rate', () => {
  const realRandom = Math.random;
  let seed = 7;
  Math.random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  try {
    const [a, b] = run([fixture(0, 1, BAR.id), fixture(1, 20, BAR.id)], { strobeFunction: 'random' }, 4);
    const rate = onsets(a) / 4;
    assert.ok(rate >= 6 && rate <= 20, `${rate} random flashes a second`);
    assert.notDeepStrictEqual(a, b, 'not in lockstep');
  } finally {
    Math.random = realRandom;
  }
});

test('without a strobe asked for, nothing is gated', () => {
  const [lit] = run([fixture(0, 1, BAR.id)], { pattern: 'solid', strobeSpeed: 0 }, 1);
  assert.ok(lit.every(Boolean));
});

test('a fixture with its own strobe channel is left to it', () => {
  const [lit] = run([fixture(0, 1, BUILTIN_PROFILE_ID)], { strobeSpeed: 255 }, 1);
  assert.ok(lit.every(Boolean), 'lit every frame; its strobe channel does the flashing');
});

test('a Hue lamp, or a fixture one follows, is never flashed', () => {
  const [lamp, followed] = run([
    fixture(0, 1, HUE_COLOR_PROFILE_ID),
    fixture(1, 20, BAR.id, { hue: true }),
  ], { strobeSpeed: 255 }, 1);
  assert.ok(lamp.every(Boolean), 'the Hue lamp profile');
  assert.ok(followed.every(Boolean), 'a bar a Hue channel follows');
});
