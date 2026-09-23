// DDP to WLED: the packets, the transmitter sending a WLED's universes as one
// run of pixels instead of on Art-Net, and the patch keeping those universes
// the WLED's alone.

import test from 'node:test';
import assert from 'node:assert';
import dgram from 'node:dgram';

import { buildDdpPackets, parseDdpPacket, sendDdp, DDP_MAX_DATA } from '../../src/server/ddp.ts';
import { ddpRoutes, ddpConflict } from '../../src/server/ddp-routes.ts';
import { createTransmitter } from '../../src/server/transmit.ts';
import { state } from '../../src/server/state.ts';
import { snapshotShow, applyShow } from '../../src/server/show-store.ts';
import { stopEngine } from '../../src/server/engine.ts';
import { fixtureMessageSchema, validate } from '../../src/server/validation.ts';

state.artnet.enabled = false;
state.running = false;
test.after(() => stopEngine());

/** A plain strip of `cells` pixels, `width` channels each (3 RGB, 4 RGBW). */
function strip(cells, width = 3, id = `wled-${cells}`) {
  const names = ['red', 'green', 'blue', 'white'];
  return {
    id, name: 'WLED', channelCount: cells * width, channelMap: {},
    cells: Array.from({ length: cells }, (_, c) => ({
      channelMap: Object.fromEntries(names.slice(0, width).map((n, k) => [n, c * width + k])),
    })),
  };
}

test('a frame is packets of 480 pixels, the last one saying show it', () => {
  const data = Uint8Array.from({ length: 1500 }, (_, i) => i % 251);
  const packets = buildDdpPackets(data, { sequence: 3 });
  assert.strictEqual(packets.length, 2);
  const [a, b] = packets.map(parseDdpPacket);
  assert.deepStrictEqual([a.push, a.sequence, a.rgbw, a.offset, a.data.length], [false, 3, false, 0, DDP_MAX_DATA]);
  assert.deepStrictEqual([b.push, b.sequence, b.offset, b.data.length], [true, 3, 1440, 60]);
  assert.deepStrictEqual([...packets[0].subarray(0, 4)], [0x40, 3, 0x0b, 1], 'version 1, sequence, RGB 8-bit, the display');
  assert.deepStrictEqual(Buffer.concat([a.data, b.data]), Buffer.from(data));

  const rgbw = buildDdpPackets(new Uint8Array(8), { sequence: 16, rgbw: true });
  assert.deepStrictEqual([...rgbw[0].subarray(0, 3)], [0x41, 1, 0x1b], 'one packet pushes; 16 comes round to 1; RGBW');
  assert.strictEqual(parseDdpPacket(rgbw[0]).rgbw, true);
  assert.strictEqual(buildDdpPackets(new Uint8Array(0), { sequence: 1 }).length, 1, 'an empty frame still says show it');
  assert.strictEqual(parseDdpPacket(Buffer.from([0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null, 'not version 1');
});

function fakeWires() {
  const sent = { artnet: [], sacn: [], ddp: [] };
  return {
    sent,
    wires: {
      artnet: (target) => { sent.artnet.push(target.universe); return true; },
      artnetSync: () => true,
      sacn: (target) => { sent.sacn.push(target.universe); return true; },
      sacnDiscovery: () => true,
      ddp: (target, data) => { sent.ddp.push({ ...target, data: Buffer.from(data) }); return true; },
    },
  };
}

const outputs = (ddp, extra = {}) => ({
  artnet: { enabled: true, host: '10.0.0.9', port: 6454, sync: false },
  sacn: { enabled: false, host: '', priority: 100, sourceName: 'x', universeOffset: 1, cid: '', interface: '' },
  delayMs: 0,
  ddp,
  ...extra,
});

test('a WLED\'s universes go to it as one run of pixels, and nowhere else', () => {
  const fixtures = [
    { id: 1, label: 'Porch', address: 1, universe: 3, profileId: 'wled-300', output: { protocol: 'ddp', host: '10.0.0.50' } },
    { id: 2, label: 'Par', address: 1, universe: 0, profileId: 'par' },
  ];
  const profiles = { 'wled-300': strip(300), par: { id: 'par', name: 'Par', channelCount: 12, channelMap: { red: 0 } } };
  const routes = ddpRoutes(fixtures, (f) => profiles[f.profileId], (f) => f.universe);
  assert.deepStrictEqual(routes, [{
    host: '10.0.0.50', port: 4048, rgbw: false,
    parts: [{ universe: 3, from: 0, bytes: 510 }, { universe: 4, from: 0, bytes: 390 }],
  }]);

  const { sent, wires } = fakeWires();
  const tx = createTransmitter({ wires });
  const frame = (fill) => Buffer.alloc(512, fill);
  for (let n = 0; n < 2; n++) {
    assert.deepStrictEqual(tx.send(0, frame(9), outputs(routes)), ['artnet']);
    assert.deepStrictEqual(tx.send(3, frame(1), outputs(routes)), ['ddp']);
    assert.deepStrictEqual(tx.send(4, frame(2), outputs(routes)), ['ddp']);
    tx.endFrame(outputs(routes));
  }
  assert.deepStrictEqual(sent.artnet, [0, 0], 'the WLED\'s universes never go out on Art-Net');
  assert.strictEqual(sent.ddp.length, 2);
  const [first, second] = sent.ddp;
  assert.deepStrictEqual([first.host, first.port, first.sequence, second.sequence], ['10.0.0.50', 4048, 1, 2]);
  assert.strictEqual(first.data.length, 900);
  assert.ok(first.data.subarray(0, 510).every((v) => v === 1) && first.data.subarray(510).every((v) => v === 2));

  // Gone from the patch: one dark frame, then silence.
  tx.endFrame(outputs([]));
  tx.endFrame(outputs([]));
  assert.strictEqual(sent.ddp.length, 3);
  assert.ok(sent.ddp[2].data.length === 900 && sent.ddp[2].data.every((v) => v === 0));
});

test('an RGBW WLED says so, and one held back for Hue waits for all its universes', () => {
  const profile = strip(128, 4);
  const routes = ddpRoutes([{ id: 1, label: 'W', address: 1, universe: 2, profileId: 'w', output: { protocol: 'ddp', host: 'wled.local', port: 4049 } }],
    () => profile, (f) => f.universe);
  assert.deepStrictEqual(routes[0], { host: 'wled.local', port: 4049, rgbw: true, parts: [{ universe: 2, from: 0, bytes: 512 }] });

  let clock = 0;
  const { sent, wires } = fakeWires();
  const tx = createTransmitter({ wires, now: () => clock });
  const config = outputs(routes, { delayMs: 50 });
  tx.send(2, Buffer.alloc(512, 7), config);
  tx.endFrame(config);
  assert.strictEqual(sent.ddp.length, 0, 'still in the delay line');
  clock = 60;
  tx.send(2, Buffer.alloc(512, 8), config);
  tx.endFrame(config);
  assert.strictEqual(sent.ddp.length, 1);
  assert.ok(sent.ddp[0].data.every((v) => v === 7), 'the frame from 50 ms ago');
});

test('a universe that goes to a WLED is the WLED\'s alone', () => {
  const profiles = { long: strip(300), par: { id: 'par', name: 'Par', channelCount: 12, channelMap: { red: 0 } } };
  const profileOf = (f) => profiles[f.profileId];
  const universeOf = (f) => f.universe;
  const wled = { id: 1, label: 'Porch', address: 1, universe: 3, profileId: 'long', output: { protocol: 'ddp', host: '10.0.0.50' } };
  assert.strictEqual(ddpConflict([wled, { id: 2, label: 'Par', address: 1, universe: 5, profileId: 'par' }], profileOf, universeOf), null);
  assert.match(ddpConflict([wled, { id: 2, label: 'Par', address: 400, universe: 4, profileId: 'par' }], profileOf, universeOf),
    /"Par" is on universe 4, which goes to "Porch"'s WLED over DDP and nowhere else/);
  assert.match(ddpConflict([wled, { ...wled, id: 3, label: 'Garden', universe: 4 }], profileOf, universeOf),
    /"Garden" and "Porch" both send universe 4 to a WLED/);
});

test('frames reach a WLED over UDP', async () => {
  const receiver = dgram.createSocket('udp4');
  await new Promise((resolve) => receiver.bind(0, '127.0.0.1', resolve));
  const got = [];
  const done = new Promise((resolve) => receiver.on('message', (msg) => { got.push(parseDdpPacket(msg)); if (got.length === 2) resolve(); }));
  try {
    assert.ok(sendDdp({ host: '127.0.0.1', port: receiver.address().port, sequence: 5 }, new Uint8Array(1500).fill(4)));
    await done;
    assert.deepStrictEqual(got.map((p) => [p.offset, p.data.length, p.push, p.sequence]), [[0, 1440, false, 5], [1440, 60, true, 5]]);
  } finally {
    receiver.close();
  }
});

test('a WLED is saved with the show, and a show that puts a par on its universes is refused', () => {
  const before = { fixtures: state.fixtures, next: state.nextFixtureId };
  const profile = strip(300, 3, 'acme-wled-300');
  try {
    applyShow({
      profiles: [profile],
      fixtures: [{ id: 1, label: 'Porch', address: 1, universe: 3, profileId: 'acme-wled-300', output: { protocol: 'ddp', host: '10.0.0.50' } }],
    });
    assert.deepStrictEqual(state.fixtures[0].output, { protocol: 'ddp', host: '10.0.0.50' });
    assert.deepStrictEqual(snapshotShow().fixtures[0].output, { protocol: 'ddp', host: '10.0.0.50' });
    assert.throws(() => applyShow({
      profiles: [profile],
      fixtures: [
        { id: 1, label: 'Porch', address: 1, universe: 3, profileId: 'acme-wled-300', output: { protocol: 'ddp', host: '10.0.0.50' } },
        { id: 2, label: 'Par', address: 1, universe: 4, profileId: 'cameo-root-par-6-12ch' },
      ],
    }), /"Par" is on universe 4, which goes to "Porch"'s WLED/);
    assert.strictEqual(state.fixtures.length, 1, 'and nothing on the rig changed');
  } finally {
    state.fixtures = before.fixtures;
    state.nextFixtureId = before.next;
  }
});

test('a fixture\'s output names a host, and nothing else', () => {
  validate(fixtureMessageSchema, { id: 1, output: { protocol: 'ddp', host: 'wled-porch.local' } }, 'fixture');
  validate(fixtureMessageSchema, { id: 1, output: null }, 'fixture');
  assert.throws(() => validate(fixtureMessageSchema, { id: 1, output: { protocol: 'ddp', host: 'http://x/' } }, 'fixture'), /hostname/);
  assert.throws(() => validate(fixtureMessageSchema, { id: 1, output: { protocol: 'artnet', host: 'x' } }, 'fixture'), /protocol/);
});
