'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { state } = require('../../src/server/state');
const { snapshotShow, applyShow } = require('../../src/server/show-store');
const { captureLook, recallLook } = require('../../src/server/cues');
const { stopEngine } = require('../../src/server/engine');

// These tests inspect state and DMX buffers, never the physical rig.
state.artnet.enabled = false;
state.running = false;
test.after(() => stopEngine());

function withFixtures(fixtures, fn) {
  const before = state.fixtures;
  const nextBefore = state.nextFixtureId;
  state.fixtures = fixtures;
  try { return fn(); } finally {
    state.fixtures = before;
    state.nextFixtureId = nextBefore;
  }
}

test('show snapshots preserve fixture ids across a reload', () => {
  withFixtures([
    { id: 4, label: 'Front', address: 1, universe: 0, profileId: 'cameo-root-par-6-12ch', maxBrightness: 255, override: null },
    { id: 9, label: 'Back', address: 13, universe: 0, profileId: 'cameo-root-par-6-12ch', maxBrightness: 255, override: null },
  ], () => {
    const saved = snapshotShow();
    assert.deepStrictEqual(saved.fixtures.map((fixture) => fixture.id), [4, 9]);

    applyShow(saved);
    assert.deepStrictEqual(state.fixtures.map((fixture) => fixture.id), [4, 9]);
    assert.ok(state.nextFixtureId >= 10);
  });
});

test('a cue follows fixture ids when a fixture before it is removed', () => {
  withFixtures([
    { id: 10, label: 'A', address: 1, universe: 0, profileId: 'cameo-root-par-6-12ch', maxBrightness: 255, override: null },
    { id: 20, label: 'B', address: 13, universe: 0, profileId: 'cameo-root-par-6-12ch', maxBrightness: 255, override: null },
  ], () => {
    state.fixtures[1].override = {
      enabled: true, r: 0, g: 255, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0, blackout: false,
    };
    const cue = captureLook();
    state.fixtures = [state.fixtures[1]];
    state.fixtures[0].override = null;

    recallLook(cue);

    assert.strictEqual(state.fixtures[0].id, 20);
    assert.strictEqual(state.fixtures[0].override.g, 255);
  });
});

test('duplicate fixture ids in a show are rejected', () => {
  assert.throws(() => applyShow({ fixtures: [
    { id: 7, address: 1, profileId: 'cameo-root-par-6-12ch' },
    { id: 7, address: 13, profileId: 'cameo-root-par-6-12ch' },
  ] }), /duplicate fixture ids/);
});

test('a fixture group and stage position survive a save and reload', () => {
  withFixtures([
    { id: 4, label: 'Front', address: 1, universe: 0, profileId: 'cameo-root-par-6-12ch', maxBrightness: 255, override: null,
      group: 'front', position: { x: 20, y: 90 } },
    { id: 9, label: 'Back', address: 13, universe: 0, profileId: 'cameo-root-par-6-12ch', maxBrightness: 255, override: null },
  ], () => {
    const saved = JSON.parse(JSON.stringify(snapshotShow()));   // as it goes to disk
    applyShow(saved);
    assert.deepStrictEqual(state.fixtures.map((f) => f.group), ['front', null]);
    assert.deepStrictEqual(state.fixtures[0].position, { x: 20, y: 90 });
  });
});

// ── LED bars ─────────────────────────────────────────────────────────────────

const barProfile = {
  id: 'acme-bar-4', name: 'Bar', channelCount: 12, channelMap: {},
  cells: Array.from({ length: 4 }, (_, i) => ({ channelMap: { red: i * 3, green: i * 3 + 1, blue: i * 3 + 2 } })),
};

test('a bar\'s line on the stage survives a save and reload', () => {
  withFixtures([
    { id: 1, label: 'Bar', address: 1, universe: 0, profileId: 'acme-bar-4', maxBrightness: 255, override: null,
      position: { x: 40, y: 20 }, geometry: { length: 30, angle: 90 } },
    { id: 2, label: 'Par', address: 13, universe: 0, profileId: 'cameo-root-par-6-12ch', maxBrightness: 255, override: null },
  ], () => {
    const saved = JSON.parse(JSON.stringify({ ...snapshotShow(), profiles: [barProfile] }));
    applyShow(saved);
    assert.deepStrictEqual(state.fixtures[0].geometry, { length: 30, angle: 90 });
    assert.strictEqual(state.fixtures[1].geometry, null);
    assert.strictEqual(state.fixtures[0].profileId, 'acme-bar-4', 'on the profile the show brought');
  });
});

test('a show with more cells than the engine renders is refused whole', () => {
  const huge = {
    id: 'acme-strip-170', name: 'Strip', channelCount: 510, channelMap: {},
    cells: Array.from({ length: 170 }, (_, i) => ({ channelMap: { red: i * 3, green: i * 3 + 1, blue: i * 3 + 2 } })),
  };
  withFixtures([
    { id: 1, label: 'Par', address: 1, universe: 0, profileId: 'cameo-root-par-6-12ch', maxBrightness: 255, override: null },
  ], () => {
    const fixtures = Array.from({ length: 13 }, (_, i) => ({ id: i, address: 1, universe: i, profileId: 'acme-strip-170' }));
    assert.throws(() => applyShow({ profiles: [huge], fixtures }), /more than the 2048/);
    assert.strictEqual(state.fixtures.length, 1, 'and nothing on the rig changed');
  });
});
