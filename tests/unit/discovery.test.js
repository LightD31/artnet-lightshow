// Finding the rig on the network and making it show itself: Art-Net's locate
// command, the other sACN sources and the universes they share with the rig,
// and the routes that identify a fixture, a node, a WLED or a Hue lamp.

import test from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import express from 'express';

import { buildArtAddress, OP_ADDRESS, AC_LED_LOCATE, AC_LED_NORMAL } from '../../src/server/artnet.ts';
import { buildE131Packet, buildDiscoveryPackets, cidFromUuid } from '../../src/server/sacn.ts';
import { parseSacn, createSacnWatch } from '../../src/server/sacn-watch.ts';
import { attachRigRoutes } from '../../src/server/rig-routes.ts';
import { createIdentify } from '../../src/server/identify.ts';
import { state } from '../../src/server/state.ts';
import * as output from '../../src/server/output.ts';
import { BUILTIN_PROFILE_ID } from '../../src/server/profiles.ts';

test('ArtAddress: locate or normal, and nothing else about the node changed', () => {
  const packet = buildArtAddress(AC_LED_LOCATE, 2);
  assert.strictEqual(packet.length, 107);
  assert.strictEqual(packet.subarray(0, 8).toString('latin1'), 'Art-Net\0');
  assert.strictEqual(packet.readUInt16LE(8), OP_ADDRESS);
  assert.strictEqual(packet.readUInt16BE(10), 14);
  assert.strictEqual(packet[12], 0x7f, 'net switch: no change');
  assert.strictEqual(packet[13], 2, 'bind index');
  assert.ok(packet.subarray(14, 96).every((b) => b === 0), 'names blank: no change');
  assert.ok(packet.subarray(96, 105).every((b) => b === 0x7f), 'port switches: no change');
  assert.strictEqual(packet[105], 255, 'sACN priority: no change');
  assert.strictEqual(packet[106], AC_LED_LOCATE);
  assert.strictEqual(buildArtAddress(AC_LED_NORMAL)[106], 0x02);
});

const CONSOLE = '6f1b1e8a-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
const US = '11111111-2222-3333-4444-555555555555';

test('sACN packets read back: data with its priority, discovery with its universes', () => {
  const data = parseSacn(buildE131Packet({
    universe: 7, cid: cidFromUuid(CONSOLE), sourceName: 'grandMA3', priority: 120, sequence: 1,
  }, Buffer.alloc(512)));
  assert.deepStrictEqual(data, { kind: 'data', cid: CONSOLE, sourceName: 'grandMA3', priority: 120, universe: 7, terminated: false });

  const [page] = buildDiscoveryPackets({ cid: cidFromUuid(CONSOLE), sourceName: 'grandMA3', universes: [3, 1, 2] });
  const discovery = parseSacn(page);
  assert.strictEqual(discovery.kind, 'discovery');
  assert.deepStrictEqual(discovery.universes, [1, 2, 3]);
  assert.deepStrictEqual([discovery.page, discovery.lastPage], [0, 0]);

  assert.strictEqual(parseSacn(Buffer.from('not sacn at all, not even close, and long enough to be read as a header of some kind......................................')), null);
  assert.strictEqual(parseSacn(null), null);
});

function fakeSocket() {
  const s = new EventEmitter();
  s.memberships = [];
  s.bind = (_port, cb) => { cb(); };
  s.addMembership = (group, iface) => { s.memberships.push(iface ? `${group}@${iface}` : group); };
  s.closed = false;
  s.close = () => { s.closed = true; };
  return s;
}

test('the watch hears other sources, leaves out its own, and says which universes clash', () => {
  const socket = fakeSocket();
  let t = 1000;
  const watch = createSacnWatch({ createSocket: () => socket, now: () => t });
  watch.listen({ seconds: 10, universes: [1, 2], ownCid: US, iface: '10.0.0.2' });
  assert.deepStrictEqual(socket.memberships, ['239.255.250.214@10.0.0.2', '239.255.0.1@10.0.0.2', '239.255.0.2@10.0.0.2']);

  const from = (address) => ({ address });
  socket.emit('message', buildE131Packet({ universe: 1, cid: cidFromUuid(US), sourceName: 'us', priority: 100, sequence: 1 }, Buffer.alloc(512)), from('10.0.0.2'));
  socket.emit('message', buildE131Packet({ universe: 2, cid: cidFromUuid(CONSOLE), sourceName: 'grandMA3', priority: 150, sequence: 1 }, Buffer.alloc(512)), from('10.0.0.9'));
  for (const packet of buildDiscoveryPackets({ cid: cidFromUuid(CONSOLE), sourceName: 'grandMA3', universes: [2, 40] })) {
    socket.emit('message', packet, from('10.0.0.9'));
  }
  t += 3000;
  const status = watch.status();
  assert.strictEqual(status.listening, true);
  assert.strictEqual(status.remainingMs, 7000);
  assert.strictEqual(status.sources.length, 1, 'our own packets are not a source');
  assert.deepStrictEqual(status.sources[0], {
    cid: CONSOLE, name: 'grandMA3', address: '10.0.0.9', priority: 150, universes: [2, 40], sending: [2], lastSeenAgoMs: 3000,
  });
  assert.deepStrictEqual(status.conflicts, [{ universe: 2, sources: ['grandMA3'] }, { universe: 40, sources: ['grandMA3'] }]);
  watch.stop();
  assert.ok(socket.closed);
  assert.strictEqual(watch.status().listening, false);
  assert.strictEqual(watch.status().sources.length, 1, 'what was heard is kept');
});

test('a bind failure is the answer, not a crash', () => {
  const socket = fakeSocket();
  const watch = createSacnWatch({ createSocket: () => socket });
  watch.listen({ seconds: 5 });
  socket.emit('error', new Error('EADDRINUSE'));
  assert.deepStrictEqual([watch.status().listening, watch.status().error], [false, 'EADDRINUSE']);
});

// ── The routes ───────────────────────────────────────────────────────────────

async function withRoutes(fn, { fixtures = [], hue = null } = {}) {
  const saved = state.fixtures;
  const savedHue = output.getHueConfig();
  state.fixtures = fixtures;
  if (hue) output.configureHue(hue);
  const calls = { broadcast: 0, locate: [], pixels: [], hue: [], info: [] };
  const identify = createIdentify({ setTimer: () => ({}), clearTimer: () => {} });
  const app = express();
  app.use(express.json());
  attachRigRoutes(app, {
    wled: {
      discover: async () => [],
      info: async (host) => { calls.info.push(host); return { name: 'Porch', version: '0.15', leds: 60, rgbw: false, matrix: null, mac: null }; },
    },
    broadcast: () => { calls.broadcast++; },
    identify,
    sacnWatch: { listen: (opts) => { calls.listen = opts; }, status: () => ({ listening: true, remainingMs: 5000, error: null, sources: [], conflicts: [{ universe: 1, sources: ['grandMA3'] }, { universe: 99, sources: ['x'] }] }), stop() {} },
    sendPixels: (target, data) => calls.pixels.push({ ...target, bytes: data.length }),
    locate: async (opts) => { calls.locate.push(opts); return { ok: true, error: null }; },
    hueIdentify: async (_host, _key, devices) => { calls.hue.push(devices); return devices.length; },
    hueAreas: async () => [{ id: 'a1', name: 'Room', status: 'inactive', channels: [{ id: 0, name: 'Lamp', position: null, devices: ['d1'] }, { id: 1, name: 'Strip', position: null, devices: ['d2', 'd3'] }] }],
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, route, body) => fetch(`${base}${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  try {
    await fn({ call, calls, identify });
  } finally {
    await new Promise((r) => server.close(r));
    state.fixtures = saved;
    output.configureHue(savedHue);
  }
}

const par = (id, address, universe = 0) => ({ id, label: `Par ${id}`, address, universe, profileId: BUILTIN_PROFILE_ID });

test('identify a fixture, or everything on a universe; then stop', async () => {
  await withRoutes(async ({ call, calls, identify }) => {
    const one = await call('POST', '/api/identify', { fixtures: [2], seconds: 5 });
    assert.deepStrictEqual(one.body, { ok: true, ids: [2], remainingMs: 5000 });
    assert.strictEqual(calls.broadcast, 1, 'the pages are told');

    const byUniverse = await call('POST', '/api/identify', { universes: [1] });
    assert.deepStrictEqual(byUniverse.body.ids, [3, 4]);

    const missing = await call('POST', '/api/identify', { fixtures: [99] });
    assert.strictEqual(missing.status, 404);
    const bad = await call('POST', '/api/identify', { fixtures: ['x'] });
    assert.strictEqual(bad.status, 400);

    await call('POST', '/api/identify/stop');
    assert.deepStrictEqual(identify.status().ids, []);
  }, { fixtures: [par(1, 1), par(2, 13), par(3, 1, 1), par(4, 13, 1)] });
});

test('an Art-Net node is asked to locate itself, and the fixtures on its universes flash', async () => {
  await withRoutes(async ({ call, calls }) => {
    const res = await call('POST', '/api/artnet/identify', { address: '10.0.0.40', universes: [1], seconds: 5 });
    assert.strictEqual(res.body.located, true);
    assert.deepStrictEqual(res.body.fixtures, [3]);
    assert.deepStrictEqual(calls.locate[0], { host: '10.0.0.40', command: AC_LED_LOCATE, bindIndex: 1 });

    const stop = await call('POST', '/api/artnet/identify', { address: '10.0.0.40', seconds: 0 });
    assert.strictEqual(stop.body.ok, true);
    assert.strictEqual(calls.locate[1].command, AC_LED_NORMAL);

    const bad = await call('POST', '/api/artnet/identify', { address: 'not an ip' });
    assert.strictEqual(bad.status, 400);
  }, { fixtures: [par(1, 1), par(3, 1, 1)] });
});

test('sACN sources: listening on the rig\'s universes, and only its clashes reported', async () => {
  await withRoutes(async ({ call, calls }) => {
    const res = await call('GET', '/api/sacn/sources?listen=1&seconds=8');
    assert.strictEqual(calls.listen.seconds, 8);
    assert.ok(calls.listen.universes.includes(1), 'rig universe 0 is sACN universe 1');
    assert.deepStrictEqual(res.body.conflicts, [{ universe: 1, sources: ['grandMA3'], rigUniverse: 0 }]);
  }, { fixtures: [par(1, 1)] });
});

test('a WLED: through the patch when it is in it, else streamed directly', async () => {
  await withRoutes(async ({ call, calls }) => {
    const patched = await call('POST', '/api/wled/identify', { host: '10.0.0.50' });
    assert.deepStrictEqual([patched.body.via, patched.body.ids], ['patch', [5]]);
    assert.strictEqual(calls.pixels.length, 0);

    const loose = await call('POST', '/api/wled/identify', { host: 'wled-porch.local', seconds: 3 });
    assert.deepStrictEqual([loose.body.via, loose.body.leds], ['device', 60]);
    assert.deepStrictEqual(calls.pixels[0], { host: 'wled-porch.local', sequence: 1, rgbw: false, bytes: 180 });
    await call('POST', '/api/identify/stop');
  }, { fixtures: [{ ...par(5, 1, 4), output: { protocol: 'ddp', host: '10.0.0.50' } }] });
});

test('a Hue channel: its fixture when it follows one, else the bridge identifies the lamps', async () => {
  const hue = { host: '10.0.0.60', username: 'app-key', entertainmentId: 'a1', channels: [{ channel: 0, fixture: 1 }] };
  await withRoutes(async ({ call, calls }) => {
    const bound = await call('POST', '/api/hue/identify', { channel: 0 });
    assert.deepStrictEqual([bound.body.via, bound.body.ids], ['fixture', [1]]);
    const loose = await call('POST', '/api/hue/identify', { channel: 1 });
    assert.deepStrictEqual([loose.body.via, loose.body.lamps], ['bridge', 2]);
    assert.deepStrictEqual(calls.hue, [['d2', 'd3']]);
    const missing = await call('POST', '/api/hue/identify', { channel: 7 });
    assert.strictEqual(missing.status, 404);
  }, { fixtures: [par(1, 1)], hue });
});

test('Hue identify before pairing says to pair', async () => {
  await withRoutes(async ({ call }) => {
    const res = await call('POST', '/api/hue/identify', { channel: 0 });
    assert.strictEqual(res.status, 409);
  }, { hue: { host: '', username: '' } });
});
