// Hue lamps with no DMX address: the server places them on universes of its
// own, renders them there so their Hue channels can read their colour back,
// and never sends those universes anywhere — nor asks the operator for an
// address, nor lets them take up DMX channels a fixture could use.

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';

import {
  INTERNAL_UNIVERSE, isInternalUniverse, hasNoAddress, placeAddressless, freeSpot, footprintOf, fitIssue,
} from '../../src/shared/placement.ts';
import { createTransmitter } from '../../src/server/transmit.ts';
import { attachRoutes } from '../../src/server/routes.ts';
import { attachSockets } from '../../src/server/sockets.ts';
import { state, getLiveState, getCatalogs, getDmxSnapshot, wireUniverses, activeUniverses, placeAddresslessFixtures } from '../../src/server/state.ts';
import { createPublisher } from '../../src/server/protocol.ts';
import { showStore, snapshotShow, applyShow } from '../../src/server/show-store.ts';
import { BUILTIN_PROFILE_ID, HUE_COLOR_PROFILE_ID, HUE_WHITE_PROFILE_ID, getProfile } from '../../src/server/profiles.ts';
import { barProfile } from '../../src/server/bar-profile.ts';
import { fixtureAddSchema, fixtureMessageSchema, validate } from '../../src/server/validation.ts';
import * as output from '../../src/server/output.ts';
import * as universes from '../../src/server/universes.ts';
import { startEngine, stopEngine } from '../../src/server/engine.ts';
import { applyPatch } from '../../src/server/patch.ts';

showStore.scheduleSave = () => {};   // never the real show file
state.artnet.enabled = false;

const HUE = { protocol: 'hue' };
const par = (id, address, universe = 0) => ({ id, label: `Par ${id}`, address, universe, profileId: BUILTIN_PROFILE_ID, maxBrightness: 255, override: null });
const lamp = (id, profileId = HUE_COLOR_PROFILE_ID) => ({ id, label: `Lamp ${id}`, address: 1, universe: 0, profileId, maxBrightness: 255, override: null, output: HUE });

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

test('a free spot is behind the last fixture on a universe, or on the next with room', () => {
  const taken = [{ universe: 0, first: 1, last: 505 }, { universe: 1, first: 1, last: 12 }];
  assert.deepStrictEqual(freeSpot(taken, { channelCount: 12, channelMap: {} }, 0), { universe: 1, address: 13 });
  assert.deepStrictEqual(freeSpot(taken, { channelCount: 12, channelMap: {} }, 5), { universe: 5, address: 1 });
  assert.deepStrictEqual(freeSpot([], { channelCount: 4, channelMap: {} }, 2), { universe: 2, address: 1 });
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
  const hueBefore = output.getHueConfig();
  await withPatch([par(0, 1), lamp(1)], async () => {
    output.configureHue({ channels: [{ channel: 5, fixture: 1 }] });
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
      output.configureHue({ channels: hueBefore.channels });
    }
  });
});

// ── Adding, removing, saving ─────────────────────────────────────────────────

async function withApp(fixtures, fn) {
  await withPatch(fixtures, async () => {
    const app = express();
    app.use(express.json());
    attachRoutes(app, { integrations: { broadcast() {} } });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const call = (method, path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json() }));
    try {
      await fn(call);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
}

test('adding a Hue lamp asks for no address and takes no DMX channels', async () => {
  await withApp([par(0, 1)], async (call) => {
    const res = await call('POST', '/api/fixtures', { profileId: HUE_COLOR_PROFILE_ID, count: 2, label: 'Shelf' });
    assert.strictEqual(res.body.ok, true, res.body.error);
    assert.strictEqual(res.body.addressless, true);
    assert.deepStrictEqual(res.body.placed, []);
    const added = state.fixtures.filter((f) => res.body.fixtures.includes(f.id));
    assert.deepStrictEqual(added.map((f) => [f.label, f.output, f.universe, f.address]), [
      ['Shelf 1', HUE, INTERNAL_UNIVERSE, 1], ['Shelf 2', HUE, INTERNAL_UNIVERSE, 8],
    ]);
    const next = await call('POST', '/api/fixtures', {});
    assert.deepStrictEqual(next.body.placed, [{ universe: state.artnet.universe, address: 13 }], 'the next par goes right behind the first');

    const onDmx = await call('POST', '/api/fixtures', { profileId: HUE_WHITE_PROFILE_ID, output: null });
    assert.deepStrictEqual(onDmx.body.placed, [{ universe: state.artnet.universe, address: 25 }], 'unless asked for on DMX');
    const hueAPar = await call('POST', '/api/fixtures', { output: HUE, label: 'Stand-in' });
    assert.strictEqual(hueAPar.body.addressless, true, 'and any profile can go without an address');
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
  });
});

test('a show keeps its lamps without addresses, and puts Hue lamps saved on DMX off it', () => {
  const saved = { fixtures: state.fixtures, next: state.nextFixtureId };
  const log = console.log;
  const said = [];
  console.log = (line) => said.push(line);
  try {
    applyShow({
      fixtures: [
        { id: 0, label: 'Par', address: 1, universe: 0, profileId: BUILTIN_PROFILE_ID },
        { id: 1, label: 'Shelf', address: 13, universe: 0, profileId: HUE_COLOR_PROFILE_ID },
        { id: 2, label: 'Desk', profileId: HUE_WHITE_PROFILE_ID, output: HUE },
      ],
    });
    assert.deepStrictEqual(state.fixtures.map((f) => [f.label, f.output, f.universe, f.address]), [
      ['Par', null, 0, 1], ['Shelf', HUE, INTERNAL_UNIVERSE, 1], ['Desk', HUE, INTERNAL_UNIVERSE, 8],
    ]);
    assert.ok(said.some((line) => /"Shelf" is a Hue lamp and has no DMX address any more/.test(line)), said.join('\n'));
    const show = snapshotShow();
    assert.deepStrictEqual(show.fixtures.map((f) => [f.label, f.address, f.universe]), [['Par', 1, 0], ['Shelf', undefined, undefined], ['Desk', undefined, undefined]]);
    applyShow(JSON.parse(JSON.stringify(show)));
    assert.deepStrictEqual(state.fixtures.map((f) => [f.universe, f.address]), [[0, 1], [INTERNAL_UNIVERSE, 1], [INTERNAL_UNIVERSE, 8]],
      'and loads back the same');
  } finally {
    console.log = log;
    state.fixtures = saved.fixtures;
    state.nextFixtureId = saved.next;
  }
});

test('the schemas take a Hue output and nothing else new', () => {
  validate(fixtureMessageSchema, { id: 1, output: HUE }, 'fixture');
  validate(fixtureAddSchema, { profileId: HUE_COLOR_PROFILE_ID, output: HUE }, 'fixtures');
  assert.throws(() => validate(fixtureMessageSchema, { id: 1, output: { protocol: 'hue', host: 'x' } }, 'fixture'));
  assert.throws(() => validate(fixtureAddSchema, { output: { protocol: 'ddp', host: 'x' } }, 'fixtures'));
});

// ── Over a socket: off DMX and back ──────────────────────────────────────────

test('a fixture taken off DMX frees its channels, and put back takes the next free ones', async () => {
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
    await withPatch([par(0, 1), par(1, 13), par(2, 25)], async () => {
      await new Promise((r) => socket.once('connect', r));
      socket.emit('fixture', { id: 1, output: HUE });
      await settle();
      const middle = state.fixtures[1];
      assert.deepStrictEqual([middle.output, middle.universe, middle.address], [HUE, INTERNAL_UNIVERSE, 1]);

      socket.emit('fixture', { id: 1, address: 300 });
      await settle();
      assert.strictEqual(state.fixtures[1].address, 1, 'an address sent for a Hue lamp is the server\'s to decide');

      socket.emit('fixture', { id: 1, output: null });
      await settle();
      assert.deepStrictEqual([middle.output, middle.universe, middle.address], [null, state.artnet.universe, 37],
        'back on DMX behind the last fixture, not on top of the one that took its place');

      socket.emit('fixture', { id: 2, profileId: HUE_COLOR_PROFILE_ID });
      await settle();
      assert.deepStrictEqual(state.fixtures[2].output, HUE, 'made a Hue lamp, it leaves DMX');
      assert.deepStrictEqual(errors, []);
      const taken = state.fixtures.filter((f) => !hasNoAddress(f)).flatMap((f) => footprintOf(f.universe, f.address, getProfile(f)));
      assert.ok(taken.every((part) => !isInternalUniverse(part.universe)));
    });
  } finally {
    socket.close();
    io.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
