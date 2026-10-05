import test from 'node:test';
import assert from 'node:assert';
import { getClientState, getLiveState, getCatalogs, getDmxSnapshot, universeOf, state } from '../../src/server/state.ts';
import { conductor } from '../../src/server/conductor.ts';
import { applyPatch } from '../../src/server/patch.ts';

const STATIC = ['colorPresets', 'patterns', 'energyEffects', 'strobeFunctions', 'palettes',
  'syncOffsetLimitMs', 'builtinProfileIds', 'hueProfileIds'];

// The static catalogues were 63% of a 7 KB payload and went out
// ten times a second unchanged.
test('the live payload carries no static catalogues and no DMX snapshot', () => {
  const live = getLiveState();
  for (const key of [...STATIC, 'dmxSnapshot']) {
    assert.strictEqual(live[key], undefined, `${key} must not ride the live payload`);
  }
  // But everything the other socket clients read must still be there.
  for (const key of ['bpm', 'energyOverride', 'fixtures', 'masterBlackout', 'pattern', 'running']) {
    assert.ok(key in live, `Companion reads ${key}`);
  }
  for (const key of ['artnet', 'profiles', 'fixtures', 'universes']) {
    assert.ok(key in live, `the settings page reads ${key}`);
  }
});

test('the full snapshot still carries everything, for REST and first connect', () => {
  const full = getClientState();
  for (const key of [...STATIC, 'dmxSnapshot', 'bpm', 'fixtures', 'profiles']) {
    assert.ok(full[key] !== undefined, `${key} present in the full snapshot`);
  }
  assert.ok(JSON.stringify(getLiveState()).length < JSON.stringify(full).length, 'live is the smaller payload');
});

test('catalogues are the static half and the DMX snapshot is bytes keyed by universe', () => {
  const cat = getCatalogs();
  assert.deepStrictEqual(Object.keys(cat).sort(), [...STATIC].sort());
  assert.ok(cat.colorPresets.length > 0 && cat.patterns.length > 0);
  // The UI decides which profiles may be deleted from this rather than from a
  // hardcoded id, so it has to name every profile that ships with the server.
  assert.ok(cat.builtinProfileIds.includes('cameo-root-par-6-12ch'));
  assert.ok(cat.builtinProfileIds.includes('generic-hue-lamp-7ch'));

  const snap = getDmxSnapshot();
  assert.ok(!Array.isArray(snap) && typeof snap === 'object');
  const universes = Object.keys(snap);
  assert.ok(universes.length > 0, 'the default universe is always transmitted');
  for (const values of Object.values(snap)) {
    assert.ok(Array.isArray(values));
    assert.ok(values.every((v) => Number.isInteger(v) && v >= 0 && v <= 255));
  }
});

// A fixture patched onto its own universe gets its own 512 channels, rather
// than colliding with the same address on universe 0.
test('the snapshot carries one entry per universe the patch spans', () => {
  const original = state.fixtures.map((f) => f.universe);
  try {
    state.fixtures[state.fixtures.length - 1].universe = state.artnet.universe + 7;
    const live = getLiveState();
    assert.ok(live.universes.includes(state.artnet.universe + 7), 'the new universe is transmitted');
    assert.ok(live.universes.includes(state.artnet.universe), 'the default universe still is');

    const snap = getDmxSnapshot();
    assert.ok(String(state.artnet.universe + 7) in snap, 'and shows up in the DMX snapshot');
  } finally {
    state.fixtures.forEach((f, i) => { f.universe = original[i]; });
  }
});

// A show saved before universes existed has fixtures with no universe field at
// all. Those belong on the rig's default universe, where they used to live.
test('a fixture with no universe falls back to the default', () => {
  const fix = state.fixtures[0];
  const original = fix.universe;
  try {
    delete fix.universe;
    assert.strictEqual(universeOf(fix), state.artnet.universe);
    assert.strictEqual(getLiveState().fixtures[0].universe, state.artnet.universe);
  } finally {
    fix.universe = original;
  }
});

// These objects used to leave the module by reference.
test('callers cannot mutate engine state through the snapshot', () => {
  const originalHost = state.artnet.host;
  const originalLabel = state.fixtures[0].label;

  const snap = getClientState();
  snap.artnet.host = '10.10.10.10';
  snap.fixtures[0].label = 'mutated by a caller';

  assert.strictEqual(state.artnet.host, originalHost, 'artnet is copied');
  assert.strictEqual(state.fixtures[0].label, originalLabel, 'fixtures are copied');
});

// The visuals keep their own beat: the clock says where its beat is and when
// that was read, so a screen carries it on as beatPos + (now - at) / 60000 * bpm.
test('the clock carries its beat position, its epoch and when it was read', () => {
  const before = Date.now();
  const { clock } = getLiveState();
  const after = Date.now();
  assert.deepStrictEqual(Object.keys(clock).sort(), ['at', 'beatPos', 'bpm', 'epoch', 'source']);
  for (const key of ['at', 'beatPos', 'bpm', 'epoch']) assert.ok(Number.isFinite(clock[key]), `${key}: ${clock[key]}`);
  assert.ok(before <= clock.at && clock.at <= after, `read at ${clock.at}, between ${before} and ${after}`);
  assert.deepStrictEqual({ source: clock.source, bpm: clock.bpm }, conductor.status());

  // Carried on to a later read, it lands where the clock is then.
  const later = conductor.phase();
  const readAt = Date.now();
  const carried = clock.beatPos + ((readAt - clock.at) / 60000) * clock.bpm;
  assert.ok(Math.abs(later.beatPos - carried) < (3 / 60000) * clock.bpm, `${carried} vs ${later.beatPos}`);
  assert.strictEqual(later.epoch, clock.epoch);
  assert.deepStrictEqual(getClientState().clock.source, clock.source, 'GET /api/state carries it too');
});

test('a tempo change keeps the clock\'s beat moving forward, in its epoch', async () => {
  const bpm = state.bpm;
  const seen = [getLiveState().clock];
  try {
    for (const tempo of [60, 174, 90, 128]) {
      await new Promise((r) => setTimeout(r, 15));
      seen.push(getLiveState().clock);
      applyPatch({ bpm: tempo });
      seen.push(getLiveState().clock);
    }
  } finally {
    applyPatch({ bpm });
  }
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].beatPos >= seen[i - 1].beatPos, `read ${i}: ${seen[i - 1].beatPos} → ${seen[i].beatPos}`);
    assert.strictEqual(seen[i].epoch, seen[0].epoch);
    assert.ok(seen[i].at >= seen[i - 1].at);
  }
});
