'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  BUILTIN_PROFILE_ID, BUILTIN_PROFILE_IDS, HUE_COLOR_PROFILE_ID,
  HUE_WHITE_AMBIANCE_PROFILE_ID, HUE_WHITE_PROFILE_ID,
  isBuiltinProfile, getProfile, registerProfile, unregisterProfile,
  listProfiles, clearNonBuiltinProfiles,
} = require('../../src/server/profiles');

test('built-in profile is always resolvable', () => {
  assert.strictEqual(getProfile({ profileId: BUILTIN_PROFILE_ID }).channelCount, 12);
  assert.strictEqual(getProfile({ profileId: 'does-not-exist' }).id, BUILTIN_PROFILE_ID);
  assert.strictEqual(getProfile({}).id, BUILTIN_PROFILE_ID);
});

test('profiles register, list and unregister', () => {
  assert.strictEqual(registerProfile({ id: 'p1', name: 'P', channelCount: 4 }), true);
  assert.ok(listProfiles().p1);
  assert.strictEqual(unregisterProfile('p1'), true);
  assert.strictEqual(listProfiles().p1, undefined);

  assert.strictEqual(registerProfile({ id: 'x' }), false, 'incomplete profile rejected');
  assert.strictEqual(unregisterProfile(BUILTIN_PROFILE_ID), false, 'built-in cannot be removed');
  assert.strictEqual(unregisterProfile(HUE_COLOR_PROFILE_ID), false, 'and neither can the Hue ones');
  assert.strictEqual(unregisterProfile(HUE_WHITE_AMBIANCE_PROFILE_ID), false);
  assert.strictEqual(unregisterProfile(HUE_WHITE_PROFILE_ID), false);
});

// On a plain object literal, obj["__proto__"] = v reassigns the
// prototype instead of adding a key, so every unknown-profile lookup would then
// resolve to the attacker's object.
test('a __proto__ id cannot hijack the registry', () => {
  const hostile = { id: '__proto__', name: 'evil', channelCount: 99, channelMap: { red: 0 } };
  assert.strictEqual(registerProfile(hostile), false, 'rejected outright');

  // And the fallback still resolves to the built-in, not to anything injected.
  assert.strictEqual(getProfile({ profileId: 'unknown-after-attack' }).id, BUILTIN_PROFILE_ID);
  assert.strictEqual(getProfile({ profileId: 'unknown-after-attack' }).channelCount, 12);
  clearNonBuiltinProfiles();
  assert.deepStrictEqual(Object.keys(listProfiles()).sort(), [...BUILTIN_PROFILE_IDS].sort());
});

// ── Built-in Hue lamp profiles ──────────────────────────────────────────────
// A Hue channel follows a rig fixture, so a Hue-only lamp still needs one in
// the patch. These exist so that fixture describes a light bulb rather than
// standing in as a twelve-channel par.

test('the Hue lamp profiles ship with the server and are built in', () => {
  assert.strictEqual(isBuiltinProfile(HUE_COLOR_PROFILE_ID), true);
  assert.strictEqual(isBuiltinProfile(HUE_WHITE_PROFILE_ID), true);
  assert.strictEqual(isBuiltinProfile(BUILTIN_PROFILE_ID), true);
  assert.strictEqual(isBuiltinProfile('something-imported'), false);
});

// The colour bulbs are RGBWW in hardware: red, green and blue dies plus a warm
// white and a cool white one. Modelling only RGB threw show content away — the
// presets carry most of their white in the white and amber components, so
// "Cool White" arrived as a dim dark blue.
test('the colour lamp carries both white dies as well as RGB', () => {
  const profile = getProfile({ profileId: HUE_COLOR_PROFILE_ID });
  assert.strictEqual(profile.channelCount, 7);
  assert.deepStrictEqual(profile.channelMap, {
    dimmer: 0, red: 1, green: 2, blue: 3, warmWhite: 4, coolWhite: 5, uv: 6,
  });
  assert.strictEqual(profile.channelList.length, 7, 'the patch table shows every channel');
});

// Tunable white, no colour dies at all — so both whites and no primaries.
test('the white ambiance lamp is the two whites and nothing else', () => {
  const profile = getProfile({ profileId: HUE_WHITE_AMBIANCE_PROFILE_ID });
  assert.strictEqual(profile.channelCount, 3);
  assert.deepStrictEqual(profile.channelMap, { dimmer: 0, warmWhite: 1, coolWhite: 2 });
  assert.strictEqual(profile.channelMap.red, undefined, 'no colour on a white lamp');
});

// UV and strobe are both things a Hue lamp cannot physically do, and they are
// treated differently on purpose: violet is a real stand-in for a UV wash,
// whereas a strobe value is discarded by the bridge on arrival.
test('the colour lamp carries UV but not strobe', () => {
  const profile = getProfile({ profileId: HUE_COLOR_PROFILE_ID });
  assert.strictEqual(typeof profile.channelMap.uv, 'number', 'UV lands as violet');
  assert.strictEqual(profile.channelMap.strobe, undefined, 'strobe would go nowhere');
});

// The bridge interpolates between frames, so a strobe value would go nowhere.
// A channel that cannot do anything reads as broken rather than absent.
test('no Hue profile claims a strobe channel', () => {
  for (const id of [HUE_COLOR_PROFILE_ID, HUE_WHITE_AMBIANCE_PROFILE_ID, HUE_WHITE_PROFILE_ID]) {
    assert.strictEqual(getProfile({ profileId: id }).channelMap.strobe, undefined, id);
  }
});

// White Hue bulbs dim but have no colour. The Hue output already reads a
// fixture with no colour channels as neutral white at its dimmer level, so this
// profile needs no special case anywhere.
test('the white lamp is a single dimmer channel and no colour', () => {
  const profile = getProfile({ profileId: HUE_WHITE_PROFILE_ID });
  assert.strictEqual(profile.channelCount, 1);
  assert.deepStrictEqual(profile.channelMap, { dimmer: 0 });
  assert.strictEqual(profile.channelMap.red, undefined);
});

// Loading a show swaps the profile registry for the one the file brought. A
// show using the Hue profiles carries no copy of them, so they have to survive.
test('loading a show cannot wipe the built-in profiles', () => {
  registerProfile({ id: 'from-a-show', name: 'Imported', channelCount: 8 });
  clearNonBuiltinProfiles();
  const left = listProfiles();
  assert.strictEqual(left['from-a-show'], undefined, 'imported profiles go');
  assert.ok(left[HUE_COLOR_PROFILE_ID], 'built-in Hue profiles stay');
  assert.ok(left[HUE_WHITE_AMBIANCE_PROFILE_ID]);
  assert.ok(left[HUE_WHITE_PROFILE_ID]);
  assert.ok(left[BUILTIN_PROFILE_ID]);
});
