// The Hue routes with several bridges: each is named in its route, the
// status lists them all without a key, pairing adds one, forgetting takes one
// away (and its lamps only when told to), and the routes from before several
// bridges were possible mean the first one.

import test from 'node:test';
import assert from 'node:assert';
import express from 'express';

import { attachRoutes } from '../../src/server/routes.ts';
import { state, placeAddresslessFixtures } from '../../src/server/state.ts';
import { showStore } from '../../src/server/show-store.ts';
import { settings } from '../../src/server/settings.ts';
import * as output from '../../src/server/output.ts';
import { BUILTIN_PROFILE_ID, registerProfile } from '../../src/server/profiles.ts';
import { areaLamp, HUE_COLOR } from './hue-test-lamps.js';

showStore.scheduleSave = () => {};   // never the real show file
state.artnet.enabled = false;

const AREA = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const areas = async () => [{
  id: AREA, name: 'Living room', status: 'inactive',
  channels: [{ id: 0, name: 'Shelf', position: null, devices: ['d0'], product: 'Hue color lamp', kind: 'color' }],
  lamps: [areaLamp({ id: 'shelf', name: 'Shelf', channels: [0], devices: ['d0'] })],
}];
const B1 = { id: 'b1', label: 'Lounge', enabled: true, host: '10.0.0.9', username: 'app-key', clientKey: 'aabb', applicationId: '', entertainmentId: AREA };
const B2 = { id: 'b2', label: 'Party', enabled: false, host: '10.0.0.10', username: '', clientKey: '', applicationId: '', entertainmentId: '' };

const par = (id, address) => ({ id, label: `Par ${id}`, address, universe: 0, profileId: BUILTIN_PROFILE_ID, maxBrightness: 255, override: null });
registerProfile(HUE_COLOR);
const lamp = (id, bridge, channel = 0) => ({
  id, label: `Lamp ${id}`, address: 1, universe: 0, profileId: HUE_COLOR.id, maxBrightness: 255, override: null,
  output: { protocol: 'hue', bridge, channels: [channel] },
});

/**
 * The routes on a settings store holding these bridges — the real store, its
 * file write stubbed out and its values put back after — with a pairing
 * stand-in, and this patch.
 */
async function withApp({ bridges = [], fixtures = [par(0, 1)], pair = async () => ({ ok: true, username: 'new-key', clientKey: 'ccdd', applicationId: 'app-1' }) }, fn) {
  const saved = { fixtures: state.fixtures, next: state.nextFixtureId, values: settings.all(), hue: output.getHueConfig() };
  settings.save = () => {};
  settings._values = { ...settings.all(), hue: { bridges: JSON.parse(JSON.stringify(bridges)), latencyMs: 0 } };
  output.configureHue(settings.group('hue'));
  state.fixtures = fixtures.map((f) => ({ ...f }));
  state.nextFixtureId = Math.max(0, ...state.fixtures.map((f) => f.id + 1));
  placeAddresslessFixtures();
  const applied = [];
  const applier = {
    applyChanged(changed) { applied.push(...changed); output.configureHue(settings.group('hue')); },
    pendingRestart: () => [],
  };
  const app = express();
  app.use(express.json());
  attachRoutes(app, { integrations: { broadcast() {} }, applier, hueAreas: areas, huePair: pair });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = (method, path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  try {
    await fn({ call, applied });
  } finally {
    await new Promise((r) => server.close(r));
    state.fixtures = saved.fixtures;
    state.nextFixtureId = saved.next;
    settings._values = saved.values;
    delete settings.save;
    output.configureHue(saved.hue);
  }
}

test('the status lists every bridge, what it is set up with and its stream, and never a key', async () => {
  await withApp({ bridges: [B1, B2] }, async ({ call }) => {
    const res = await call('GET', '/api/hue/status');
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.latencyMs, 0);
    assert.deepStrictEqual(res.body.bridges, [
      { id: 'b1', label: 'Lounge', host: '10.0.0.9', enabled: true, paired: true, applicationId: '', area: AREA, configured: true, stream: 'idle', lastError: null },
      { id: 'b2', label: 'Party', host: '10.0.0.10', enabled: false, paired: false, applicationId: '', area: '', configured: false, stream: 'idle', lastError: null },
    ]);
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes('app-key') && !text.includes('aabb'), 'the keys stay on the server');
  });
});

test('pairing adds a bridge, labelled and on; pairing the same bridge again replaces its keys, not the list', async () => {
  let n = 0;
  const pair = async (host) => ({ ok: true, username: `key-${++n}-${host}`, clientKey: 'ccdd', applicationId: 'app-1' });
  await withApp({ bridges: [], pair }, async ({ call, applied }) => {
    const first = await call('POST', '/api/hue/pair', { host: '10.0.0.9' });
    assert.strictEqual(first.body.ok, true, first.body.error);
    assert.deepStrictEqual(first.body.bridge, { id: 'bridge-1', label: '10.0.0.9', host: '10.0.0.9' });
    assert.deepStrictEqual(first.body.areas.map((a) => a.name), ['Living room'], 'the areas come straight back');
    assert.deepStrictEqual(applied, ['hue.bridges'], 'the output was reconfigured');
    assert.deepStrictEqual(settings.get('hue.bridges'), [{
      id: 'bridge-1', label: '10.0.0.9', enabled: true, host: '10.0.0.9', username: 'key-1-10.0.0.9', clientKey: 'ccdd',
      applicationId: 'app-1', entertainmentId: '',
    }]);

    const second = await call('POST', '/api/hue/pair', { host: '10.0.0.10', label: 'Party' });
    assert.deepStrictEqual(second.body.bridge, { id: 'bridge-2', label: 'Party', host: '10.0.0.10' });

    const again = await call('POST', '/api/hue/pair', { host: '10.0.0.9' });
    assert.deepStrictEqual(again.body.bridge, { id: 'bridge-1', label: '10.0.0.9', host: '10.0.0.9' });
    const bridges = settings.get('hue.bridges');
    assert.deepStrictEqual(bridges.map((b) => [b.id, b.username]), [['bridge-1', 'key-3-10.0.0.9'], ['bridge-2', 'key-2-10.0.0.10']]);

    const status = await call('GET', '/api/hue/status');
    assert.deepStrictEqual(status.body.bridges.map((b) => [b.id, b.paired, b.enabled]), [['bridge-1', true, true], ['bridge-2', true, true]]);
  });
});

test('a bridge whose button was not pressed answers 409 with pressLink, and adds nothing', async () => {
  const pair = async () => ({ ok: false, error: 'Press the round button on the bridge, then try again within 30 seconds.', pressLink: true });
  await withApp({ bridges: [B1], pair }, async ({ call }) => {
    const res = await call('POST', '/api/hue/pair', { host: '10.0.0.10' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.pressLink, true);
    assert.deepStrictEqual(settings.get('hue.bridges').map((b) => b.id), ['b1']);
  });
});

test('areas are read from the bridge named; the old route reads the first; an unpaired bridge says so', async () => {
  await withApp({ bridges: [B1, B2] }, async ({ call }) => {
    const named = await call('GET', '/api/hue/b1/areas');
    assert.deepStrictEqual([named.body.bridge, named.body.areas.map((a) => a.id)], [{ id: 'b1', label: 'Lounge' }, [AREA]]);
    const legacy = await call('GET', '/api/hue/areas');
    assert.deepStrictEqual(legacy.body.bridge, { id: 'b1', label: 'Lounge' });
    assert.strictEqual((await call('GET', '/api/hue/b2/areas')).status, 409, 'not paired yet');
    assert.strictEqual((await call('GET', '/api/hue/zz/areas')).status, 404);
  });
  await withApp({ bridges: [] }, async ({ call }) => {
    assert.strictEqual((await call('GET', '/api/hue/areas')).status, 409, 'nothing paired at all');
  });
});

test('forgetting a bridge refuses while its lamps are patched, unless told to take them; the old route says which', async () => {
  await withApp({ bridges: [B1, { ...B2, username: 'k', clientKey: 'eeff' }], fixtures: [par(0, 1), lamp(1, 'b1'), lamp(2, 'b2')] }, async ({ call, applied }) => {
    const kept = await call('POST', '/api/hue/b1/disconnect', {});
    assert.strictEqual(kept.status, 409);
    assert.match(kept.body.error, /"Lamp 1"/);
    assert.deepStrictEqual(kept.body.fixtures, [1]);
    assert.deepStrictEqual(settings.get('hue.bridges').map((b) => b.id), ['b1', 'b2'], 'still there');

    const which = await call('POST', '/api/hue/disconnect', {});
    assert.strictEqual(which.status, 400);
    assert.match(which.body.error, /\/api\/hue\/:bridge\/disconnect/);

    const gone = await call('POST', '/api/hue/b1/disconnect', { removeFixtures: true });
    assert.deepStrictEqual(gone.body, { ok: true, removed: [1] });
    assert.deepStrictEqual(state.fixtures.map((f) => f.id), [0, 2], 'its lamp went with it');
    assert.deepStrictEqual(settings.get('hue.bridges').map((b) => b.id), ['b2']);
    assert.deepStrictEqual(applied, ['hue.bridges']);
    assert.deepStrictEqual((await call('GET', '/api/hue/status')).body.bridges.map((b) => b.id), ['b2']);
    assert.strictEqual((await call('POST', '/api/hue/b1/disconnect', {})).status, 404, 'forgotten');
    assert.strictEqual((await call('POST', '/api/hue/b2/disconnect', { removeFixtures: 'yes' })).status, 400, 'a flag is a boolean');
  });
  await withApp({ bridges: [B1], fixtures: [lamp(1, 'b1')] }, async ({ call }) => {
    const last = await call('POST', '/api/hue/b1/disconnect', { removeFixtures: true });
    assert.strictEqual(last.status, 400, 'the patch keeps at least one fixture');
    assert.deepStrictEqual(settings.get('hue.bridges').map((b) => b.id), ['b1']);
  });
});

test('the pars delay is saved through the settings, and a bridge list sent back blank keeps its keys', async () => {
  await withApp({ bridges: [B1] }, async ({ call }) => {
    const res = await call('PUT', '/api/settings', { hue: { latencyMs: 40, bridges: [{ ...B1, username: '', clientKey: '', entertainmentId: '' }] } });
    assert.strictEqual(res.body.ok, true, res.body.error);
    assert.deepStrictEqual(res.body.settings.hue.bridges, [{ ...B1, username: '', clientKey: '', entertainmentId: '' }], 'redacted on the way out');
    assert.deepStrictEqual(settings.get('hue.bridges')[0].clientKey, 'aabb', 'kept');
    assert.deepStrictEqual((await call('GET', '/api/hue/status')).body.bridges.map((b) => [b.paired, b.area]), [[true, '']]);
    const old = await call('PUT', '/api/settings', { hue: { host: '10.0.0.9' } });
    assert.strictEqual(old.status, 400);
    assert.match(old.body.error, /hue\.bridges/);
  });
});
