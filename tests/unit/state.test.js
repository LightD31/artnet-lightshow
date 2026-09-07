'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getClientState, getLiveState, getCatalogs, getDmxSnapshot, state } = require('../../src/server/state');

const STATIC = ['colorPresets', 'patterns', 'energyEffects', 'strobeFunctions'];

// AUDIT.md M1: the static catalogues were 63% of a 7 KB payload and went out
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
  for (const key of ['artnet', 'profiles', 'fixtures']) {
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

test('catalogues are the static half and the DMX snapshot is an array of bytes', () => {
  const cat = getCatalogs();
  assert.deepStrictEqual(Object.keys(cat).sort(), [...STATIC].sort());
  assert.ok(cat.colorPresets.length > 0 && cat.patterns.length > 0);

  const snap = getDmxSnapshot();
  assert.ok(Array.isArray(snap));
  assert.ok(snap.every((v) => Number.isInteger(v) && v >= 0 && v <= 255));
});

// AUDIT.md L12: these objects used to leave the module by reference.
test('callers cannot mutate engine state through the snapshot', () => {
  const originalHost = state.artnet.host;
  const originalLabel = state.fixtures[0].label;

  const snap = getClientState();
  snap.artnet.host = '10.10.10.10';
  snap.fixtures[0].label = 'mutated by a caller';

  assert.strictEqual(state.artnet.host, originalHost, 'artnet is copied');
  assert.strictEqual(state.fixtures[0].label, originalLabel, 'fixtures are copied');
});
