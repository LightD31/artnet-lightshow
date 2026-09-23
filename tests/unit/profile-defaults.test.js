// A profile's defaults: channels the show does not drive but must not leave at
// 0 — an imported shutter that is closed at 0, a dimmer left at full. They are
// written under every frame, so the channels the show drives still win.

import test from 'node:test';
import assert from 'node:assert';

import { createRenderer } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { profileSchema, validate } from '../../src/server/validation.ts';

// Dimmer, a shutter that is open at 10 and strobes from 20, red, and a spare
// dimmer held at full.
const PROFILE = {
  id: 'held', name: 'Held', channelCount: 5,
  channelMap: { dimmer: 0, strobe: 1, red: 2 },
  defaults: [{ offset: 1, value: 10 }, { offset: 3, value: 255 }],
};

function render(patch, { address = 1, profile = PROFILE } = {}) {
  const store = universes.createUniverseStore(universes.allocateShared());
  const renderer = createRenderer({ profileOf: () => profile, now: 0 });
  const fixture = {
    id: 0, address, universe: 0, profileId: profile.id, maxBrightness: 255, override: null,
    position: null, group: null, geometry: null,
  };
  const input = {
    running: true, pattern: 'solid', colorA: 1, colorB: 1, colorC: 1, colorD: 1, split: null, pixelMap: 'stage',
    beatDivision: 1, strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false,
    energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null, universes: [0], fixtures: [fixture],
    ...patch,
  };
  renderer.frame(input, { beatPos: 0, bpm: 120, epoch: 0 }, 0, store);
  return Array.from(store.getBuffer(0).subarray(address - 1, address - 1 + profile.channelCount));
}

test('undriven channels sit at their defaults, at the fixture\'s own address', () => {
  const [dimmer, shutter, red, spare, rest] = render({}, { address: 101 });
  assert.ok(dimmer > 0 && red > 0, 'the show still drives its channels');
  assert.deepStrictEqual([shutter, spare, rest], [10, 255, 0]);
});

test('a driven channel with a default is the show\'s while it drives it', () => {
  const [, shutter] = render({ pattern: 'strobe', strobeSpeed: 255 });
  assert.strictEqual(shutter, 250, 'the standard strobe at full speed, not the default');
});

test('a blackout is dark on every channel, defaults too', () => {
  assert.deepStrictEqual(render({ masterBlackout: true }), [0, 0, 0, 0, 0]);
});

test('a profile without defaults renders as it always has', () => {
  const { defaults: _d, ...plain } = PROFILE;
  const [, shutter, , spare] = render({}, { profile: plain });
  assert.deepStrictEqual([shutter, spare], [0, 0]);
});

test('defaults stay inside the footprint and are bytes', () => {
  validate(profileSchema, PROFILE, 'profile');
  assert.throws(() => validate(profileSchema, { ...PROFILE, defaults: [{ offset: 5, value: 1 }] }, 'profile'), /defaults holds channels outside the profile's 5-channel footprint: 5/);
  assert.throws(() => validate(profileSchema, { ...PROFILE, defaults: [{ offset: 1, value: 256 }] }, 'profile'), /defaults/);
  assert.throws(() => validate(profileSchema, { ...PROFILE, defaults: [{ offset: 1, value: 3, extra: 1 }] }, 'profile'), /defaults/);
});
