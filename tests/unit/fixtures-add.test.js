// Adding fixtures: one generic par as the "+" always has, or a run of one
// profile from an address — on into the next universe when one fills, and a
// strip on universes of its own.

import test from 'node:test';
import assert from 'node:assert';
import express from 'express';

import { attachRoutes } from '../../src/server/routes.ts';
import { state } from '../../src/server/state.ts';
import { showStore } from '../../src/server/show-store.ts';
import { registerProfile, unregisterProfile, BUILTIN_PROFILE_ID } from '../../src/server/profiles.ts';
import { barProfile } from '../../src/server/bar-profile.ts';

showStore.scheduleSave = () => {};   // never the real show file

const STRIP = barProfile({ id: 'add-strip-300', name: 'Strip 300', cells: 300, firstChannel: 1, order: 'RGB' });
const BAR = barProfile({ id: 'add-bar-16', name: 'Bar 16', cells: 16, firstChannel: 3, order: 'RGB', dimmer: 1, strobe: 2 });

async function withApp(fixtures, fn) {
  const saved = state.fixtures;
  state.fixtures = fixtures.map((f) => ({ ...f }));
  registerProfile(STRIP);
  registerProfile(BAR);
  let broadcasts = 0;
  const app = express();
  app.use(express.json());
  attachRoutes(app, { integrations: { broadcast() { broadcasts++; } } });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const add = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/fixtures`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  try {
    await fn({ add, broadcasts: () => broadcasts });
  } finally {
    await new Promise((r) => server.close(r));
    state.fixtures = saved;
    unregisterProfile(STRIP.id);
    unregisterProfile(BAR.id);
  }
}

const par = (id, address, universe = 0) => ({ id, label: `Par ${id}`, address, universe, profileId: BUILTIN_PROFILE_ID, maxBrightness: 255, override: null });

test('no body: one generic par behind what is on the default universe', async () => {
  await withApp([par(0, 1)], async ({ add, broadcasts }) => {
    const res = await add();
    assert.strictEqual(res.body.ok, true);
    assert.deepStrictEqual(res.body.placed, [{ universe: state.artnet.universe, address: 13 }]);
    const added = state.fixtures.find((f) => f.id === res.body.fixtures[0]);
    assert.strictEqual(added.profileId, BUILTIN_PROFILE_ID);
    assert.strictEqual(broadcasts(), 1);
  });
});

test('a run of bars from an address, on into the next universe when one fills', async () => {
  await withApp([par(0, 1)], async ({ add }) => {
    const res = await add({ profileId: BAR.id, count: 12, universe: 2, address: 1, label: 'Bar' });
    assert.strictEqual(res.body.ok, true, res.body.error);
    const width = BAR.channelCount;
    const perUniverse = Math.floor(512 / width);
    assert.deepStrictEqual(res.body.placed.slice(0, 2), [{ universe: 2, address: 1 }, { universe: 2, address: 1 + width }]);
    assert.deepStrictEqual(res.body.placed[perUniverse], { universe: 3, address: 1 }, 'the first that does not fit starts the next universe');
    const labels = res.body.fixtures.map((id) => state.fixtures.find((f) => f.id === id).label);
    assert.deepStrictEqual(labels.slice(0, 3), ['Bar 1', 'Bar 2', 'Bar 3']);
  });
});

test('strips take channel 1 of universes of their own', async () => {
  await withApp([par(0, 1, 0)], async ({ add }) => {
    const res = await add({ profileId: STRIP.id, count: 2, universe: 0 });
    assert.strictEqual(res.body.ok, true, res.body.error);
    assert.deepStrictEqual(res.body.placed, [{ universe: 1, address: 1 }, { universe: 3, address: 1 }]);
  });
});

test('refused: an unknown profile, an address that cannot fit, a bad body', async () => {
  await withApp([par(0, 1)], async ({ add }) => {
    assert.strictEqual((await add({ profileId: 'nope' })).status, 400);
    const late = await add({ profileId: BAR.id, address: 500 });
    assert.strictEqual(late.status, 400);
    assert.match(late.body.error, /past the 512-channel universe/);
    assert.strictEqual((await add({ count: 0 })).status, 400);
    assert.strictEqual((await add({ colour: 'red' })).status, 400);
    assert.strictEqual(state.fixtures.length, 1, 'nothing added by a refusal');
  });
});
