'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  BUILTIN_PROFILE_ID, getProfile, registerProfile, unregisterProfile,
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
});

// AUDIT.md M7: on a plain object literal, obj["__proto__"] = v reassigns the
// prototype instead of adding a key, so every unknown-profile lookup would then
// resolve to the attacker's object.
test('a __proto__ id cannot hijack the registry', () => {
  const hostile = { id: '__proto__', name: 'evil', channelCount: 99, channelMap: { red: 0 } };
  assert.strictEqual(registerProfile(hostile), false, 'rejected outright');

  // And the fallback still resolves to the built-in, not to anything injected.
  assert.strictEqual(getProfile({ profileId: 'unknown-after-attack' }).id, BUILTIN_PROFILE_ID);
  assert.strictEqual(getProfile({ profileId: 'unknown-after-attack' }).channelCount, 12);
  clearNonBuiltinProfiles();
  assert.deepStrictEqual(Object.keys(listProfiles()), [BUILTIN_PROFILE_ID]);
});
