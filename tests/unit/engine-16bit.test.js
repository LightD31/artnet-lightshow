// A 16-bit dimmer gets its fine byte. It used to be written 0, which left a
// fixture that can do 65,536 levels stepping through 256 of them — and the
// steps are what a slow fade to black looks like on an LED.

import test from 'node:test';
import assert from 'node:assert';

import { writeDimmer, createRenderer } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile, profilesRevision, BUILTIN_PROFILE_ID } from '../../src/server/profiles.ts';

const FINE = { dimmer: 0, dimmerFine: 1 };
const COARSE = { dimmer: 0 };

function write(ch, level) {
  const dmx = Buffer.alloc(4);
  writeDimmer(dmx, 0, ch, level);
  return [dmx[0], dmx[1]];
}

const v16 = ([coarse, fine]) => coarse * 256 + fine;

test('full and off are full and off on both bytes', () => {
  assert.deepStrictEqual(write(FINE, 255), [255, 255]);
  assert.deepStrictEqual(write(FINE, 0), [0, 0]);
  assert.deepStrictEqual(write(FINE, 400), [255, 255], 'clamped');
  assert.deepStrictEqual(write(FINE, -3), [0, 0]);
});

test('a whole level lands exactly where an 8-bit console would put it', () => {
  // x·257 is x in both bytes: 128 of 255 is 0x8080 of 0xFFFF.
  for (const level of [1, 64, 128, 200, 254]) assert.deepStrictEqual(write(FINE, level), [level, level]);
});

test('the fine byte carries what the coarse one cannot', () => {
  const got = v16(write(FINE, 127.6));
  assert.ok(Math.abs(got - 127.6 * 257) <= 0.5, `${got} for 127.6`);
  // A fade across one coarse step takes ~257 values instead of one jump.
  const seen = new Set();
  for (let level = 10; level <= 11; level += 0.001) seen.add(v16(write(FINE, level)));
  assert.ok(seen.size > 250, `${seen.size} distinct values across one 8-bit step`);
});

test('the 16-bit value never runs backwards as the level rises', () => {
  let last = -1;
  for (let level = 0; level <= 255; level += 0.01) {
    const now = v16(write(FINE, level));
    assert.ok(now >= last, `level ${level.toFixed(2)} gave ${now} after ${last}`);
    last = now;
  }
});

test('a dimmer with no fine channel rounds as it always has', () => {
  const dmx = Buffer.alloc(4, 7);
  writeDimmer(dmx, 0, COARSE, 127.6);
  assert.deepStrictEqual(Array.from(dmx), [128, 7, 7, 7], 'the next channel is not touched');
});

test('the built-in par renders its master as sixteen bits', () => {
  const store = universes.createUniverseStore(universes.allocateShared());
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
  const fixture = {
    id: 0, address: 1, universe: 0, profileId: BUILTIN_PROFILE_ID, maxBrightness: 255, override: null,
    position: null, group: null, geometry: null,
  };
  const input = {
    running: true, pattern: 'solid', colorA: 1, colorB: 1, colorC: 1, colorD: 1, split: null, pixelMap: 'stage',
    beatDivision: 1, strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 100, masterBlackout: false,
    energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null, universes: [0], fixtures: [fixture],
  };
  renderer.frame(input, { beatPos: 0, bpm: 120, epoch: 0 }, 0, store);
  const ch = getProfile(fixture).channelMap;
  const dmx = store.getBuffer(0);
  assert.deepStrictEqual([dmx[ch.dimmer], dmx[ch.dimmerFine]], [100, 100], 'master 100 of 255 is 100·257');
});
