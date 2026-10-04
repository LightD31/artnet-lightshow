import test from 'node:test';
import assert from 'node:assert';
import { BUILTIN_PROFILE_ID, BUILTIN_PROFILE_IDS, isBuiltinProfile, getProfile, registerProfile, unregisterProfile, listProfiles, clearNonBuiltinProfiles } from '../../src/server/profiles.ts';
import { profilesRevision, unitCapOverflow, MAX_UNITS } from '../../src/server/profiles.ts';
import { cellsOf, unitCount } from '../../src/shared/rig.ts';

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

test('only the par ships with the server; anything else is imported', () => {
  assert.strictEqual(isBuiltinProfile(BUILTIN_PROFILE_ID), true);
  assert.strictEqual(isBuiltinProfile('something-imported'), false);
});

// Loading a show swaps the profile registry for the one the file brought. A
// show carries no copy of the built-ins, so they have to survive.
test('loading a show cannot wipe the built-in profiles', () => {
  registerProfile({ id: 'from-a-show', name: 'Imported', channelCount: 8 });
  clearNonBuiltinProfiles();
  const left = listProfiles();
  assert.strictEqual(left['from-a-show'], undefined, 'imported profiles go');
  assert.ok(left[BUILTIN_PROFILE_ID]);
});

// A built-in is defined in code; an upload or a show file with the same id
// must not replace it for every fixture patched to it.
test('a built-in profile cannot be overwritten', () => {
  const before = getProfile({ profileId: BUILTIN_PROFILE_ID });
  const ok = registerProfile({ id: BUILTIN_PROFILE_ID, name: 'Impostor', channelCount: 1, channelMap: {} });
  assert.strictEqual(ok, false);
  assert.strictEqual(getProfile({ profileId: BUILTIN_PROFILE_ID }), before);
});

// ── Cells ─────────────────────────────────────────────────────────────────────

test('anything that caches the rig can tell when a profile under it changed', () => {
  const before = profilesRevision();
  registerProfile({ id: 'rev-test', name: 'Rev', channelCount: 3, channelMap: { red: 0 } });
  const registered = profilesRevision();
  assert.ok(registered > before, 'registering');
  unregisterProfile('rev-test');
  assert.ok(profilesRevision() > registered, 'removing');
  const removed = profilesRevision();
  clearNonBuiltinProfiles();
  assert.ok(profilesRevision() > removed, 'clearing for a show load');
  assert.strictEqual(registerProfile({ id: 'cameo-root-par-6-12ch', name: 'x', channelCount: 1, channelMap: {} }), false);
  assert.strictEqual(profilesRevision(), removed + 1, 'a refused registration changes nothing');
});

// Each cell is rendered every frame; sixty-four copies of one outsized
// profile must not be able to ask for eleven thousand of them.
test('a patch may not have more cells than the engine renders', () => {
  const big = { cells: Array.from({ length: 170 }, (_, i) => ({ channelMap: { red: i } })) };
  assert.strictEqual(unitCount(big), 170);
  assert.strictEqual(unitCount({ cells: [{ channelMap: { red: 0 } }] }), 1, 'one cell is a single light');
  assert.strictEqual(cellsOf({}), null);
  const fixtures = (n) => Array.from({ length: n }, () => ({ profileId: 'big' }));
  const profileOf = () => big;
  assert.strictEqual(unitCapOverflow(fixtures(24), profileOf), null, `${24 * 170} fits in ${MAX_UNITS}`);
  assert.match(unitCapOverflow(fixtures(25), profileOf), /4250 lights .* more than the 4096/);
});
