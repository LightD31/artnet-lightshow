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
    runs: [{ at: 0, count: 300 }],
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
  assert.deepStrictEqual(routes[0], { host: 'wled.local', port: 4049, rgbw: true, parts: [{ universe: 2, from: 0, bytes: 512 }], runs: [{ at: 0, count: 128 }] });

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
  assert.match(ddpConflict([wled, { ...wled, id: 3, label: 'Garden', universe: 4, output: { protocol: 'ddp', host: '10.0.0.51' } }], profileOf, universeOf),
    /"Garden" and "Porch" both send universe 4 to a WLED/);
  assert.match(ddpConflict([wled, { ...wled, id: 3, label: 'Garden', universe: 10 }], profileOf, universeOf),
    /"Garden" and "Porch" both drive LEDs 1–300 of the WLED at 10.0.0.50; give each a segment of its own/,
    'one WLED twice over');
});

test('segments of one WLED go as one frame: each run where it belongs, shown once', () => {
  const profiles = { front: strip(4), side: strip(2), half: { ...strip(4), grid: { columns: 2, rows: 2 } } };
  const fixtures = [
    { id: 1, label: 'Front', address: 1, universe: 1, profileId: 'front', output: { protocol: 'ddp', host: '10.0.0.60', at: 0 } },
    { id: 2, label: 'Side', address: 1, universe: 2, profileId: 'side', output: { protocol: 'ddp', host: '10.0.0.60', at: 10 } },
    { id: 3, label: 'Half', address: 1, universe: 3, profileId: 'half', output: { protocol: 'ddp', host: '10.0.0.61', at: 2, rowStride: 4 } },
  ];
  const routes = ddpRoutes(fixtures, (f) => profiles[f.profileId], (f) => f.universe);
  assert.deepStrictEqual(routes.map((r) => r.runs), [[{ at: 0, count: 4 }], [{ at: 10, count: 2 }], [{ at: 2, count: 2 }, { at: 6, count: 2 }]],
    'a rectangle of a panel is a run for each row');
  assert.strictEqual(ddpConflict(fixtures, (f) => profiles[f.profileId], (f) => f.universe), null);
  assert.match(ddpConflict([...fixtures, { ...fixtures[1], id: 4, label: 'Overlap', universe: 5, output: { protocol: 'ddp', host: '10.0.0.60', at: 3 } }],
    (f) => profiles[f.profileId], (f) => f.universe), /"Overlap" and "Front" both drive LEDs 4–4 of the WLED at 10.0.0.60/);

  const { sent, wires } = fakeWires();
  const tx = createTransmitter({ wires });
  const config = outputs(routes);
  for (const u of [1, 2, 3]) tx.send(u, Buffer.alloc(512, u), config);
  tx.endFrame(config);
  assert.strictEqual(sent.ddp.length, 2, 'one frame to each WLED');
  const booth = sent.ddp[0];
  assert.deepStrictEqual(booth.runs, [{ at: 0, from: 0, bytes: 12 }, { at: 30, from: 12, bytes: 6 }]);
  const packets = buildDdpPackets(booth.data, { sequence: 1, runs: booth.runs }).map(parseDdpPacket);
  assert.deepStrictEqual(packets.map((p) => [p.offset, p.data.length, p.push, p.data[0]]), [[0, 12, false, 1], [30, 6, true, 2]],
    'the second segment\'s pixels land at LED 11, and only the last packet says show it');
  assert.deepStrictEqual(sent.ddp[1].runs, [{ at: 6, from: 0, bytes: 6 }, { at: 18, from: 6, bytes: 6 }]);

  // One segment leaves the patch: its LEDs are sent dark, the rest go on.
  const fewer = outputs(routes.slice(0, 1).concat(routes.slice(2)));
  for (const u of [1, 3]) tx.send(u, Buffer.alloc(512, u), fewer);
  tx.endFrame(fewer);
  const dark = sent.ddp.find((d, k) => k >= 2 && d.runs && d.runs[0].at === 30);
  assert.ok(dark && dark.data.every((v) => v === 0), 'the side that left goes dark');
});

test('a wash or zones: each cell lights its share of the LEDs, on the wire', () => {
  const wash = { id: 'wash', name: 'W', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };
  const zones = strip(3);
  const bands = strip(2);
  const fixtures = [
    { id: 1, label: 'Wash', address: 1, universe: 1, profileId: 'wash', output: { protocol: 'ddp', host: '10.0.0.50', leds: 5 } },
    { id: 2, label: 'Zones', address: 1, universe: 2, profileId: 'zones', output: { protocol: 'ddp', host: '10.0.0.51', leds: 7 } },
    // Half of a 4 × 2 panel, two columns wide, in two bands of one column.
    { id: 3, label: 'Bands', address: 1, universe: 3, profileId: 'bands',
      output: { protocol: 'ddp', host: '10.0.0.52', at: 2, rowStride: 4, leds: 4, columns: 2 } },
  ];
  const profiles = { wash, zones, bands };
  const routes = ddpRoutes(fixtures, (f) => profiles[f.profileId], (f) => f.universe);
  assert.deepStrictEqual(routes.map((r) => [r.runs, r.spread]), [
    [[{ at: 0, count: 5 }], { cells: 1, leds: 5, columns: null }],
    [[{ at: 0, count: 7 }], { cells: 3, leds: 7, columns: null }],
    [[{ at: 2, count: 2 }, { at: 6, count: 2 }], { cells: 2, leds: 4, columns: 2 }],
  ]);
  assert.strictEqual(ddpConflict(fixtures, (f) => profiles[f.profileId], (f) => f.universe), null);
  assert.match(ddpConflict([...fixtures, { id: 4, label: 'Pixels', address: 1, universe: 4, profileId: 'zones', output: { protocol: 'ddp', host: '10.0.0.50', at: 4 } }],
    (f) => profiles[f.profileId], (f) => f.universe), /"Pixels" and "Wash" both drive LEDs 5–5/, 'a wash holds every LED it lights');

  const { sent, wires } = fakeWires();
  const tx = createTransmitter({ wires });
  const config = outputs(routes);
  const frame = (...pixels) => { const b = Buffer.alloc(512); pixels.forEach((v, k) => b.fill(v, k * 3, k * 3 + 3)); return b; };
  tx.send(1, frame(9), config);
  tx.send(2, frame(1, 2, 3), config);
  tx.send(3, frame(1, 2), config);
  tx.endFrame(config);
  const leds = (d) => Array.from({ length: d.data.length / 3 }, (_, i) => d.data[i * 3]);
  assert.deepStrictEqual(leds(sent.ddp[0]), [9, 9, 9, 9, 9], 'one colour on every LED');
  assert.deepStrictEqual(leds(sent.ddp[1]), [1, 1, 1, 2, 2, 3, 3], 'three zones along seven LEDs');
  assert.deepStrictEqual([leds(sent.ddp[2]), sent.ddp[2].runs], [[1, 2, 1, 2], [{ at: 6, from: 0, bytes: 6 }, { at: 18, from: 6, bytes: 6 }]],
    'bands across each row of the rectangle');

  // Gone from the patch: every LED it lit goes dark, not just its one cell.
  tx.endFrame(outputs([]));
  assert.ok(sent.ddp.slice(3).some((d) => d.host === '10.0.0.50' && d.data.length === 15 && d.data.every((v) => v === 0)));
});

test('a strobe panel: each zone lights its rectangle, and a white zone all three dies of an RGB WLED', () => {
  // A 4 × 3 panel: a red zone over the top row, a white line in the middle, a
  // blue zone under it.
  const profile = {
    id: 'sp', name: 'SP', channelCount: 9, channelMap: {}, grid: { columns: 1, rows: 3 }, zoned: true,
    cells: [{ channelMap: { red: 0, green: 1, blue: 2 }, at: { x: 0, y: 0 } }, { channelMap: { white: 3 }, at: { x: 0, y: 1 } },
      { channelMap: { red: 6, green: 7, blue: 8 }, at: { x: 0, y: 2 } }],
  };
  const output = { protocol: 'ddp', host: '10.0.0.61', leds: 12, columns: 4, areas: [[0, 0, 4, 1], [0, 1, 4, 1], [0, 2, 4, 1]] };
  const routes = ddpRoutes([{ id: 1, label: 'SP', address: 1, universe: 1, profileId: 'sp', output }], () => profile, (f) => f.universe);
  assert.deepStrictEqual(routes[0].spread, { cells: 3, leds: 12, columns: 4, areas: output.areas, white: [1] });
  assert.deepStrictEqual(validate(fixtureMessageSchema, { id: 1, output }, 'fixture').output, output, 'saved with the show as it is');

  const { sent, wires } = fakeWires();
  const tx = createTransmitter({ wires });
  const frame = Buffer.alloc(512);
  frame.set([200, 0, 0, 90, 0, 0, 0, 0, 150]);
  tx.send(1, frame, outputs(routes));
  tx.endFrame(outputs(routes));
  const leds = Array.from({ length: 12 }, (_, i) => [...sent.ddp[0].data.subarray(i * 3, i * 3 + 3)]);
  assert.deepStrictEqual(leds.slice(0, 4), Array(4).fill([200, 0, 0]));
  assert.deepStrictEqual(leds.slice(4, 8), Array(4).fill([90, 90, 90]), 'white, on every die');
  assert.deepStrictEqual(leds.slice(8), Array(4).fill([0, 0, 150]));
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
