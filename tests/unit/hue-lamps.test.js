// Hue lamps: patched from the bridge's entertainment area, one fixture per
// channel on the profile for what the lamp can show, with no DMX address. The
// server places them on universes of its own, renders them there so their
// channels can read their colour back, and never sends those universes
// anywhere — nor asks the operator for an address, nor lets them take up DMX
// channels a fixture could use. Nothing becomes a Hue lamp by hand.

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';

import {
  INTERNAL_UNIVERSE, isInternalUniverse, hasNoAddress, placeAddressless, fitIssue,
} from '../../src/shared/placement.ts';
import { createTransmitter } from '../../src/server/transmit.ts';
import { attachRoutes } from '../../src/server/routes.ts';
import { attachSockets } from '../../src/server/sockets.ts';
import { state, getLiveState, getCatalogs, getDmxSnapshot, wireUniverses, activeUniverses, placeAddresslessFixtures } from '../../src/server/state.ts';
import { createPublisher } from '../../src/server/protocol.ts';
import { showStore, snapshotShow, applyShow } from '../../src/server/show-store.ts';
import { BUILTIN_PROFILE_ID, HUE_COLOR_PROFILE_ID, HUE_WHITE_PROFILE_ID, HUE_WHITE_AMBIANCE_PROFILE_ID, getProfile } from '../../src/server/profiles.ts';
import { barProfile } from '../../src/server/bar-profile.ts';
import { fixtureAddSchema, fixtureMessageSchema, fixtureRestoreSchema, validate } from '../../src/server/validation.ts';
import * as output from '../../src/server/output.ts';
import * as universes from '../../src/server/universes.ts';
import { startEngine, stopEngine } from '../../src/server/engine.ts';
import { applyPatch } from '../../src/server/patch.ts';

showStore.scheduleSave = () => {};   // never the real show file
state.artnet.enabled = false;

const HUE = { protocol: 'hue', channel: 0 };
const par = (id, address, universe = 0) => ({ id, label: `Par ${id}`, address, universe, profileId: BUILTIN_PROFILE_ID, maxBrightness: 255, override: null });
const lamp = (id, channel = id, profileId = HUE_COLOR_PROFILE_ID) => ({
  id, label: `Lamp ${id}`, address: 1, universe: 0, profileId, maxBrightness: 255, override: null, output: { protocol: 'hue', channel },
});

/** Run `fn` on this patch, and put the rig back after. */
async function withPatch(fixtures, fn) {
  const saved = { fixtures: state.fixtures, next: state.nextFixtureId };
  state.fixtures = fixtures.map((f) => ({ ...f }));
  state.nextFixtureId = Math.max(0, ...state.fixtures.map((f) => f.id + 1));
  placeAddresslessFixtures();
  try {
    return await fn();
  } finally {
    state.fixtures = saved.fixtures;
    state.nextFixtureId = saved.next;
  }
}

// ── Placement ────────────────────────────────────────────────────────────────

test('the internal universes are past every Art-Net universe, and fit the page\'s 16-bit DMX frames', () => {
  assert.ok(INTERNAL_UNIVERSE > 32767 && INTERNAL_UNIVERSE + 64 < 65536);
  assert.strictEqual(isInternalUniverse(32767), false);
  assert.strictEqual(isInternalUniverse(INTERNAL_UNIVERSE), true);
  assert.strictEqual(hasNoAddress({ output: HUE }), true);
  assert.strictEqual(hasNoAddress({ output: { protocol: 'ddp', host: 'x' } }), false);
  assert.strictEqual(hasNoAddress({ output: null }), false);
});

test('fixtures with no address are packed one after another on the internal universes, in patch order', () => {
  const profiles = { p: { channelCount: 12, channelMap: {} }, w: { channelCount: 1, channelMap: {} }, big: { channelCount: 500, channelMap: {} } };
  const fixtures = [
    { profileId: 'p', address: 1, universe: 0, output: HUE },
    { profileId: 'p', address: 13, universe: 0 },            // a par on DMX, left where it is
    { profileId: 'w', address: 7, universe: 3, output: HUE },
    { profileId: 'big', address: 1, universe: 0, output: HUE },
    { profileId: 'w', address: 1, universe: 0, output: HUE },
  ];
  assert.strictEqual(placeAddressless(fixtures, (f) => profiles[f.profileId]), true);
  assert.deepStrictEqual(fixtures.map((f) => [f.universe, f.address]), [
    [INTERNAL_UNIVERSE, 1],
    [0, 13],
    [INTERNAL_UNIVERSE, 13],
    [INTERNAL_UNIVERSE + 1, 1],           // 500 channels do not fit behind 13: the next one
    [INTERNAL_UNIVERSE + 1, 501],
  ]);
  assert.strictEqual(placeAddressless(fixtures, (f) => profiles[f.profileId]), false, 'placed already: nothing moves');
});

test('a strip with no address takes internal universes of its own, and fits wherever it lands', () => {
  const strip = barProfile({ id: 'hue-strip', name: 'Strip', cells: 300, firstChannel: 1, order: 'RGB' });
  const small = { channelCount: 4, channelMap: {} };
  const fixtures = [
    { profileId: 's', address: 1, output: HUE },
    { profileId: 'strip', address: 1, output: HUE },
    { profileId: 's', address: 1, output: HUE },
  ];
  placeAddressless(fixtures, (f) => (f.profileId === 'strip' ? strip : small));
  assert.deepStrictEqual(fixtures.map((f) => [f.universe, f.address]), [
    [INTERNAL_UNIVERSE, 1], [INTERNAL_UNIVERSE + 1, 1], [INTERNAL_UNIVERSE + 3, 1],
  ]);
  assert.strictEqual(fitIssue('Strip', 1, strip, INTERNAL_UNIVERSE + 1), null, 'not held to the last Art-Net universe');
});

// ── Never on the wire ────────────────────────────────────────────────────────

test('an internal universe goes out on no wire, whatever is on', () => {
  const sent = [];
  const wire = (name) => (target) => { sent.push([name, target.universe]); return true; };
  const tx = createTransmitter({
    wires: { artnet: wire('artnet'), artnetSync: () => true, sacn: wire('sacn'), sacnDiscovery: () => true, ddp: wire('ddp') },
  });
  const config = {
    artnet: { enabled: true, host: '10.0.0.9', port: 6454, sync: false },
    sacn: { enabled: true, host: '', priority: 100, sourceName: 'x', universeOffset: 1, cid: '', interface: '' },
    delayMs: 0,
    ddp: [],
  };
  assert.deepStrictEqual(tx.send(INTERNAL_UNIVERSE, Buffer.alloc(512, 9), config), []);
  assert.deepStrictEqual(tx.send(INTERNAL_UNIVERSE, Buffer.alloc(512), config, { immediate: true, terminate: true }), [],
    'not even the blackout when it leaves the patch');
  assert.deepStrictEqual(tx.send(0, Buffer.alloc(512, 9), config), ['artnet', 'sacn']);
  assert.ok(sent.every(([, universe]) => universe !== INTERNAL_UNIVERSE));
});

test('the rig lists only the universes on the wire; the DMX feed carries the lamps for the swatches', async () => {
  await withPatch([par(0, 1), lamp(1)], () => {
    assert.ok(activeUniverses().includes(INTERNAL_UNIVERSE), 'rendered');
    assert.deepStrictEqual(wireUniverses(), [state.artnet.universe]);
    assert.deepStrictEqual(getLiveState().universes, [state.artnet.universe]);
    assert.ok(Object.keys(getDmxSnapshot()).map(Number).includes(INTERNAL_UNIVERSE));
    assert.ok(getCatalogs().hueProfileIds.includes(HUE_COLOR_PROFILE_ID));
  });
});

test('a lamp with no address is rendered, and read back by its Hue channel', async () => {
  await withPatch([par(0, 1), lamp(1, 5)], async () => {
    applyPatch({ pattern: 'solid', running: true, masterDimmer: 255, colorA: 1, masterBlackout: false });
    startEngine();
    try {
      await new Promise((r) => setTimeout(r, 120));
      const at = getProfile({ profileId: HUE_COLOR_PROFILE_ID }).channelMap;
      const frame = universes.getBuffer(INTERNAL_UNIVERSE);
      const lit = [at.red, at.green, at.blue].some((offset) => frame[offset] > 0);
      assert.ok(lit, 'rendered on the internal universe like any other fixture');
      const [color] = output.hueChannelColors();
      assert.strictEqual(color.id, 5);
      assert.ok(color.r + color.g + color.b > 0, 'and its Hue channel shows it');
    } finally {
      stopEngine();
    }
  });
});

// ── Adding, removing, saving ─────────────────────────────────────────────────

const AREA = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
/** The bridge's area, as hue.ts reads it: a colour lamp, an ambiance one, a white one. */
const areas = async () => [{
  id: AREA, name: 'Living room', status: 'inactive', channels: [
    { id: 0, name: 'Shelf', position: null, devices: ['d0'], product: 'Hue color lamp', kind: 'color' },
    { id: 1, name: 'Desk', position: null, devices: ['d1'], product: 'Hue white ambiance', kind: 'ambiance' },
    { id: 2, name: 'Hall', position: null, devices: ['d2'], product: 'Hue white lamp', kind: 'white' },
  ],
}];

async function withApp(fixtures, fn) {
  await withPatch(fixtures, async () => {
    const hueBefore = output.getHueConfig();
    output.configureHue({ host: 'bridge.test', username: 'app-key', entertainmentId: AREA });
    const app = express();
    app.use(express.json());
    attachRoutes(app, { integrations: { broadcast() {} }, hueAreas: areas });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const call = (method, path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json() }));
    try {
      await fn(call);
    } finally {
      await new Promise((r) => server.close(r));
      output.configureHue(hueBefore);
    }
  });
}

test('a lamp is added from the bridge, on the profile for what it can show, with no address', async () => {
  await withApp([par(0, 1)], async (call) => {
    const listed = await call('GET', '/api/hue/lamps');
    assert.strictEqual(listed.body.ok, true, listed.body.error);
    assert.deepStrictEqual(listed.body.lamps.map((l) => [l.id, l.kind]), [[0, 'color'], [1, 'ambiance'], [2, 'white']]);

    const one = await call('POST', '/api/hue/add', { channels: [1] });
    assert.strictEqual(one.body.ok, true, one.body.error);
    assert.deepStrictEqual(one.body.fixtures.map((f) => [f.label, f.profileId, f.output]), [
      ['Desk', HUE_WHITE_AMBIANCE_PROFILE_ID, { protocol: 'hue', channel: 1 }],
    ]);
    const again = await call('POST', '/api/hue/add', { channels: [1] });
    assert.strictEqual(again.status, 409, 'a channel is patched once');

    const rest = await call('POST', '/api/hue/add', {});
    assert.deepStrictEqual(rest.body.fixtures.map((f) => [f.label, f.profileId, f.output.channel]), [
      ['Shelf', HUE_COLOR_PROFILE_ID, 0], ['Hall', HUE_WHITE_PROFILE_ID, 2],
    ], 'every lamp not patched yet');
    const lamps = state.fixtures.filter(hasNoAddress);
    assert.deepStrictEqual(lamps.map((f) => [f.universe, f.address]), [[INTERNAL_UNIVERSE, 1], [INTERNAL_UNIVERSE, 4], [INTERNAL_UNIVERSE, 11]]);
    assert.strictEqual((await call('POST', '/api/hue/add', {})).status, 409, 'nothing left to add');
    assert.strictEqual((await call('POST', '/api/hue/add', { channels: [7] })).status, 404, 'no such channel');

    const next = await call('POST', '/api/fixtures', {});
    assert.deepStrictEqual(next.body.placed, [{ universe: state.artnet.universe, address: 13 }], 'the next par goes right behind the first');
  });
});

test('a Hue lamp profile is not patched by hand', async () => {
  await withApp([par(0, 1)], async (call) => {
    const res = await call('POST', '/api/fixtures', { profileId: HUE_COLOR_PROFILE_ID });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /added from its bridge/);
  });
});

test('a lamp removed and put back comes back with no address, and the others close up', async () => {
  await withApp([par(0, 1), lamp(1), lamp(2)], async (call) => {
    assert.strictEqual(state.fixtures[2].address, 8);
    const removed = await call('DELETE', '/api/fixtures/1');
    assert.strictEqual(removed.body.ok, true);
    assert.strictEqual(removed.body.fixture.address, undefined, 'no address to hand back');
    assert.strictEqual(removed.body.fixture.universe, undefined);
    assert.strictEqual(state.fixtures.find((f) => f.id === 2).address, 1, 'the other lamp closes up');

    const back = await call('POST', '/api/fixtures/restore', { index: removed.body.index, fixture: removed.body.fixture });
    assert.strictEqual(back.body.ok, true, back.body.error);
    assert.deepStrictEqual(state.fixtures.map((f) => [f.id, f.universe, f.address]), [
      [0, 0, 1], [1, INTERNAL_UNIVERSE, 1], [2, INTERNAL_UNIVERSE, 8],
    ]);
    const noAddress = await call('POST', '/api/fixtures/restore', { index: 0, fixture: { label: 'Par', profileId: BUILTIN_PROFILE_ID } });
    assert.strictEqual(noAddress.status, 400, 'a fixture on DMX still needs its address');
    const twice = await call('POST', '/api/fixtures/restore', { index: 0, fixture: { ...removed.body.fixture, id: 9 } });
    assert.strictEqual(twice.status, 409, 'nor is a channel patched twice by an undo');
    const onDmx = await call('POST', '/api/fixtures/restore', {
      index: 0, fixture: { label: 'Stand-in', address: 100, universe: 0, profileId: HUE_COLOR_PROFILE_ID },
    });
    assert.strictEqual(onDmx.status, 400, 'nor a Hue lamp profile put on DMX');
  });
});

test('a show keeps its lamps without addresses, and a Hue profile off the bridge is refused', () => {
  const saved = { fixtures: state.fixtures, next: state.nextFixtureId };
  try {
    applyShow({
      fixtures: [
        { id: 0, label: 'Par', address: 1, universe: 0, profileId: BUILTIN_PROFILE_ID },
        { id: 1, label: 'Shelf', profileId: HUE_COLOR_PROFILE_ID, output: { protocol: 'hue', channel: 0 } },
        { id: 2, label: 'Desk', profileId: HUE_WHITE_PROFILE_ID, output: { protocol: 'hue', channel: 3 } },
      ],
    });
    assert.deepStrictEqual(state.fixtures.map((f) => [f.label, f.output, f.universe, f.address]), [
      ['Par', null, 0, 1],
      ['Shelf', { protocol: 'hue', channel: 0 }, INTERNAL_UNIVERSE, 1],
      ['Desk', { protocol: 'hue', channel: 3 }, INTERNAL_UNIVERSE, 8],
    ]);
    const show = snapshotShow();
    assert.deepStrictEqual(show.fixtures.map((f) => [f.label, f.address, f.universe]), [['Par', 1, 0], ['Shelf', undefined, undefined], ['Desk', undefined, undefined]]);
    applyShow(JSON.parse(JSON.stringify(show)));
    assert.deepStrictEqual(state.fixtures.map((f) => [f.universe, f.address]), [[0, 1], [INTERNAL_UNIVERSE, 1], [INTERNAL_UNIVERSE, 8]],
      'and loads back the same');

    assert.throws(() => applyShow({ fixtures: [{ id: 0, label: 'Shelf', address: 13, universe: 0, profileId: HUE_COLOR_PROFILE_ID }] }),
      /on a Hue lamp profile but not a Hue lamp/);
    assert.throws(() => applyShow({ fixtures: [{ id: 0, label: 'Par', profileId: BUILTIN_PROFILE_ID, output: { protocol: 'hue', channel: 0 } }] }),
      /is a Hue lamp on a profile that is not one/);
    assert.throws(() => applyShow({ fixtures: [lamp(0, 4), lamp(1, 4)] }), /both Hue channel 4/);
    assert.throws(() => applyShow({ fixtures: [{ id: 0, label: 'Old', profileId: HUE_COLOR_PROFILE_ID, output: { protocol: 'hue' } }] }),
      /channel/, 'a Hue lamp names its channel');
  } finally {
    state.fixtures = saved.fixtures;
    state.nextFixtureId = saved.next;
  }
});

test('the schemas take a Hue output only where the bridge or the patch hands one back', () => {
  validate(fixtureRestoreSchema, { index: 0, fixture: { label: 'Lamp', profileId: HUE_COLOR_PROFILE_ID, output: HUE } }, 'restore');
  assert.throws(() => validate(fixtureMessageSchema, { id: 1, output: HUE }, 'fixture'), 'never set on a fixture by hand');
  assert.throws(() => validate(fixtureAddSchema, { profileId: HUE_COLOR_PROFILE_ID, output: HUE }, 'fixtures'));
  assert.throws(() => validate(fixtureRestoreSchema, { index: 0, fixture: { label: 'Lamp', profileId: 'x', output: { protocol: 'hue' } } }, 'restore'),
    'and a Hue output names its channel');
  validate(fixtureMessageSchema, { id: 1, output: { protocol: 'ddp', host: 'wled.local' } }, 'fixture');
});

// ── Over a socket: a Hue lamp stays one ──────────────────────────────────────

test('over a socket, a Hue lamp stays a Hue lamp and a par stays off the bridge', async () => {
  const server = http.createServer();
  const io = new Server(server);
  const publisher = createPublisher(io);
  attachSockets(io, { midi: { onLearn() {}, enabled: false, listPorts: () => [] }, integrations: { broadcast() {}, publisher } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = connect(`http://127.0.0.1:${server.address().port}`, { transports: ['websocket'], forceNew: true });
  const errors = [];
  socket.on('error-msg', (e) => errors.push(e.message));
  const settle = () => new Promise((r) => setTimeout(r, 80));
  try {
    await withPatch([par(0, 1), lamp(1, 2), par(2, 13)], async () => {
      await new Promise((r) => socket.once('connect', r));
      const [first, hue, second] = state.fixtures;

      socket.emit('fixture', { id: 1, output: null });
      await settle();
      assert.deepStrictEqual([hue.output, hue.universe], [{ protocol: 'hue', channel: 2 }, INTERNAL_UNIVERSE], 'not put on DMX');

      socket.emit('fixture', { id: 1, address: 300 });
      await settle();
      assert.strictEqual(hue.address, 1, 'an address sent for a Hue lamp is the server\'s to decide');

      socket.emit('fixture', { id: 1, profileId: BUILTIN_PROFILE_ID });
      await settle();
      assert.strictEqual(hue.profileId, HUE_COLOR_PROFILE_ID, 'nor put on a par\'s profile');
      socket.emit('fixture', { id: 1, profileId: HUE_WHITE_PROFILE_ID });
      await settle();
      assert.strictEqual(hue.profileId, HUE_WHITE_PROFILE_ID, 'but another Hue lamp profile is fine');

      socket.emit('fixture', { id: 2, profileId: HUE_COLOR_PROFILE_ID });
      socket.emit('fixture', { id: 0, output: { protocol: 'hue', channel: 0 } });
      await settle();
      assert.deepStrictEqual([second.profileId, first.output ?? null], [BUILTIN_PROFILE_ID, null], 'a par does not become a Hue lamp');
      assert.strictEqual(errors.length, 4, errors.join('\n'));
      assert.ok(state.fixtures.filter((f) => !isInternalUniverse(f.universe)).length === 2);
    });
  } finally {
    socket.close();
    io.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
