// Strips longer than a universe: whole cells to a universe, from channel 1,
// running on into the next ones — and everything that reads or writes a
// fixture's channels going through the same placement.

import test from 'node:test';
import assert from 'node:assert';

import {
  stripOf, stripIssue, channelPlace, cellPlace, fitIssue, universesOf, footprintOf, overlaps, channelReader,
} from '../../src/shared/placement.ts';
import { createRenderer } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { profileSchema, validate } from '../../src/server/validation.ts';
import { barProfile } from '../../src/server/bar-profile.ts';
import { countUniverses } from '../../src/server/state.ts';

/** A plain strip: `cells` pixels of `order` ('RGB', 'RGBW'). */
function strip(cells, order = 'RGB') {
  const names = { R: 'red', G: 'green', B: 'blue', W: 'white' };
  const w = order.length;
  return {
    id: `strip-${cells}-${order}`, name: 'Strip', channelCount: cells * w, channelMap: {},
    cells: Array.from({ length: cells }, (_, c) => ({
      channelMap: Object.fromEntries([...order].map((l, k) => [names[l], c * w + k])),
    })),
  };
}

const PAR = { id: 'par', name: 'Par', channelCount: 12, channelMap: { dimmer: 0, red: 2 } };

test('a strip longer than a universe carries whole cells to each: 170 RGB, 128 RGBW', () => {
  assert.deepStrictEqual(stripOf(strip(300)), { width: 3, perUniverse: 170, universes: 2 });
  assert.deepStrictEqual(stripOf(strip(300, 'RGBW')), { width: 4, perUniverse: 128, universes: 3 });
  assert.deepStrictEqual(stripOf(strip(1024)), { width: 3, perUniverse: 170, universes: 7 });
  assert.strictEqual(stripOf(strip(170)), null, 'one that fits a universe is placed as any fixture is');
  assert.strictEqual(stripOf(PAR), null);

  // Pixel 170 is the last of universe one, 171 the first of the next.
  const s = stripOf(strip(300));
  assert.deepStrictEqual(channelPlace(s, 1, 169 * 3 + 2), { universe: 0, index: 509 });
  assert.deepStrictEqual(channelPlace(s, 1, 170 * 3), { universe: 1, index: 0 });
  assert.deepStrictEqual(cellPlace(s, 1, 299), { universe: 1, shift: -510 });
  assert.deepStrictEqual(channelPlace(null, 40, 2), { universe: 0, index: 41 }, 'anything else: from its address');
});

test('only a strip of equal cells may be longer than a universe', () => {
  const withMaster = { ...strip(300), channelCount: 901, channelMap: { dimmer: 900 } };
  assert.strictEqual(stripOf(withMaster), null);
  assert.match(stripIssue(withMaster), /901 channels, longer than a 512-channel universe, and only a strip of equal cells/);
  const scrambled = strip(300);
  scrambled.cells[5] = { channelMap: { red: 3 } };
  assert.strictEqual(stripOf(scrambled), null, 'each cell\'s channels together, in order');

  assert.strictEqual(validate(profileSchema, strip(300), 'profile').channelCount, 900);
  assert.throws(() => validate(profileSchema, withMaster, 'profile'), /channelCount .*only a strip of equal cells/);
  assert.throws(() => validate(profileSchema, strip(1025), 'profile'), /cells/, 'no more than 1,024 cells');
});

test('where a strip may be patched', () => {
  assert.strictEqual(fitIssue('Strip', 1, strip(300), 0), null);
  assert.match(fitIssue('Strip', 4, strip(300), 0), /"Strip" is a strip of 900 channels, longer than a universe, so it starts at channel 1/);
  assert.match(fitIssue('Strip', 1, strip(300), 32767), /runs over 2 universes from 32767, past universe 32767/);
  assert.match(fitIssue('Par', 505, PAR, 0), /"Par" at address 505 needs 12 channels and would end at 516, past the 512-channel universe/);
  assert.deepStrictEqual(universesOf(3, strip(300)), [3, 4]);
  assert.deepStrictEqual(universesOf(3, PAR), [3]);
});

test('a strip overlaps what is patched on any universe it runs on into', () => {
  const long = footprintOf(0, 1, strip(300));
  assert.deepStrictEqual(long, [{ universe: 0, first: 1, last: 510 }, { universe: 1, first: 1, last: 390 }]);
  assert.ok(overlaps(long, footprintOf(1, 380, PAR)));
  assert.ok(!overlaps(long, footprintOf(1, 391, PAR)), 'behind its last pixel is free');
  assert.ok(!overlaps(long, footprintOf(2, 1, PAR)));
});

test('a reader finds each channel on the universe it is on', () => {
  const frames = { 5: new Uint8Array(512).fill(1), 6: new Uint8Array(512).fill(2) };
  const read = channelReader(5, 1, strip(300), (u) => frames[u]);
  assert.deepStrictEqual([read(0), read(509), read(510), read(899), read(undefined)], [1, 1, 2, 2, 0]);
  const par = channelReader(5, 11, PAR, (u) => frames[u]);
  assert.strictEqual(par(2), 1);
  assert.strictEqual(channelReader(9, 1, PAR, () => undefined)(0), 0, 'a universe with no frame reads dark');
});

test('the engine writes a long strip across its universes, whole pixels to each', () => {
  const profile = strip(300);
  const store = universes.createUniverseStore(universes.allocateShared());
  const renderer = createRenderer({ profileOf: () => profile, now: 0 });
  const fixture = {
    id: 0, address: 1, universe: 2, profileId: profile.id, maxBrightness: 255, override: null,
    position: null, group: null, geometry: null,
  };
  const input = {
    running: true, pattern: 'solid', colorA: 0, colorB: 0, colorC: 0, colorD: 0, split: null, pixelMap: 'stage',
    beatDivision: 1, strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false,
    energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null, universes: [2, 3], fixtures: [fixture],
  };
  renderer.frame(input, { beatPos: 0, bpm: 120, epoch: 0 }, 0, store);
  const first = store.getBuffer(2);
  const second = store.getBuffer(3);
  const lit = (frame, from, to) => Array.from(frame.subarray(from, to)).some((v) => v > 0);
  assert.ok(lit(first, 0, 3) && lit(first, 507, 510), 'pixels 1 and 170 on the first universe');
  assert.deepStrictEqual([first[510], first[511]], [0, 0], 'no pixel split across two universes');
  assert.ok(lit(second, 0, 3) && lit(second, 387, 390), 'pixels 171 and 300 on the next');
  assert.ok(!lit(second, 390, 512), 'nothing past the last pixel');
  assert.deepStrictEqual(Array.from(first.subarray(0, 3)), Array.from(second.subarray(387, 390)), 'the same colour all along');
});

test('the patch counts every universe a strip runs on into', () => {
  const profiles = { long: strip(400), par: PAR };
  const fixtures = [{ universe: 0, profileId: 'long' }, { universe: 7, profileId: 'par' }];
  // 400 pixels is three universes from 0, and the par's own.
  assert.strictEqual(countUniverses(fixtures, (f) => profiles[f.profileId]), 4);
});

test('the bar maker makes a strip longer than a universe only when it is plain pixels', () => {
  const plain = barProfile({ id: 'long', name: 'Long', cells: 200, firstChannel: 1, order: 'RGB' });
  assert.strictEqual(plain.channelCount, 600);
  assert.deepStrictEqual(stripOf(plain), { width: 3, perUniverse: 170, universes: 2 });
  assert.throws(() => barProfile({ id: 'long', name: 'Long', cells: 200, firstChannel: 2, order: 'RGB', dimmer: 1 }),
    /runs on into the next only as plain pixels from channel 1/);
  assert.throws(() => barProfile({ id: 'long', name: 'Long', cells: 200, firstChannel: 3, order: 'RGB' }),
    /plain pixels from channel 1/);
});
