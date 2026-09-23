'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const {
  NodeTable, createDiscovery, interfaces, isBroadcastTarget, isLoopbackTarget, EXPIRE_MS,
} = require('../../src/server/artnet-nodes');
const { createTransmitter } = require('../../src/server/transmit');

const node = (outputs, extra = {}) => ({ shortName: 'N', longName: 'Node', outputs, universe: outputs[0], bindIndex: 0, ...extra });

test('interfaces know their own broadcast address', () => {
  const list = interfaces({
    eth0: [{ family: 'IPv4', address: '192.168.1.20', netmask: '255.255.255.0', internal: false }],
    eth1: [{ family: 'IPv4', address: '2.0.0.5', netmask: '255.0.0.0', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
    v6: [{ family: 'IPv6', address: 'fe80::1', netmask: 'ffff::', internal: false }],
  });
  assert.deepStrictEqual(list.map((i) => i.broadcast), ['192.168.1.255', '2.255.255.255']);
});

test('broadcast targets are told apart from one node and from this machine', () => {
  const ifaces = [{ broadcast: '10.0.1.127' }];
  assert.ok(isBroadcastTarget('2.255.255.255', ifaces));
  assert.ok(isBroadcastTarget('192.168.1.255', ifaces));
  assert.ok(isBroadcastTarget('255.255.255.255', ifaces));
  assert.ok(isBroadcastTarget('10.0.1.127', ifaces), 'a subnet\'s own broadcast');
  assert.ok(!isBroadcastTarget('192.168.1.50', ifaces));
  assert.ok(!isBroadcastTarget('node.local', ifaces));
  assert.ok(isLoopbackTarget('127.0.0.1'));
  assert.ok(isLoopbackTarget('localhost'));
  assert.ok(!isLoopbackTarget('192.168.1.2'));
});

test('the table routes each universe to the nodes that output it', () => {
  const table = new NodeTable();
  table.add(node([0, 1]), '192.168.1.50', 0);
  table.add(node([1, 2]), '192.168.1.9', 0);
  table.add(node([16], { bindIndex: 2 }), '192.168.1.50', 0);
  assert.deepStrictEqual(table.routes(0), {
    0: ['192.168.1.50'],
    1: ['192.168.1.9', '192.168.1.50'],
    2: ['192.168.1.9'],
    16: ['192.168.1.50'],
  });
  assert.strictEqual(table.list(0).length, 3, 'a second bind index is another entry');
});

test('a node that stops answering drops out', () => {
  const table = new NodeTable();
  table.add(node([0]), '10.0.0.2', 0);
  table.add(node([1]), '10.0.0.3', EXPIRE_MS);
  assert.deepStrictEqual(Object.keys(table.routes(EXPIRE_MS + 1)), ['1']);
  assert.deepStrictEqual(table.list(EXPIRE_MS + 1).map((n) => n.from), ['10.0.0.3']);
});

/** A dgram socket stand-in that records what is sent and lets a test answer. */
function fakeSocket() {
  const s = new EventEmitter();
  s.sent = [];
  s.bound = null;
  s.closed = false;
  s.bind = (port, cb) => { s.bound = port; setImmediate(cb); };
  s.setBroadcast = () => {};
  s.send = (buf, off, len, port, address, cb) => { s.sent.push({ op: buf.readUInt16LE(8), port, address }); if (cb) cb(null); };
  s.close = () => { s.closed = true; };
  s.unref = () => {};
  return s;
}

function reply(outputs) {
  const buf = Buffer.alloc(239);
  buf.write('Art-Net\0', 0, 'ascii');
  buf.writeUInt16LE(0x2100, 8);
  outputs.forEach((swOut, i) => { buf[174 + i] = 0x80; buf[190 + i] = swOut; });
  return buf;
}

test('discovery holds the port only while it should poll', async () => {
  let wanted = false;
  const sockets = [];
  const discovery = createDiscovery({
    shouldPoll: () => wanted,
    targets: () => ['192.168.1.255', '2.255.255.255', '192.168.1.255'],
    createSocket: () => { const s = fakeSocket(); sockets.push(s); return s; },
    now: () => 1000,
    pollIntervalMs: 60000,
  });
  discovery.start();
  try {
    assert.strictEqual(sockets.length, 0, 'a unicast target leaves the port alone');
    assert.strictEqual(discovery.routes(), null);

    wanted = true;
    discovery.pollNow();
    await new Promise((r) => setImmediate(r));
    const s = sockets[0];
    assert.strictEqual(s.bound, 6454, 'replies come back to the Art-Net port');
    const polls = s.sent.filter((p) => p.op === 0x2000).map((p) => p.address);
    assert.deepStrictEqual([...new Set(polls)], ['192.168.1.255', '2.255.255.255'], 'every target, once each');

    s.emit('message', reply([0, 1]), { address: '192.168.1.50' });
    s.emit('message', Buffer.from('not art-net'), { address: '192.168.1.51' });
    assert.deepStrictEqual(discovery.routes(), { 0: ['192.168.1.50'], 1: ['192.168.1.50'] });
    assert.strictEqual(discovery.status().nodes.length, 1);
  } finally {
    discovery.stop();
  }
  assert.ok(sockets[0].closed, 'stop lets the port go');
});

test('a port another program holds is reported, and nothing is routed', async () => {
  const discovery = createDiscovery({
    shouldPoll: () => true,
    targets: () => ['10.255.255.255'],
    createSocket: () => {
      const s = fakeSocket();
      s.bind = () => setImmediate(() => s.emit('error', new Error('bind EADDRINUSE 0.0.0.0:6454')));
      return s;
    },
    pollIntervalMs: 60000,
  });
  discovery.start();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  try {
    assert.match(discovery.status().error, /EADDRINUSE/);
    assert.strictEqual(discovery.routes(), null, 'frames keep going to the broadcast target');
  } finally {
    discovery.stop();
  }
});

// ── The transmitter follows the routes ──────────────────────────────────────

function recordingTransmitter() {
  const log = [];
  const transmitter = createTransmitter({
    wires: {
      artnet: (target, frame) => { log.push({ kind: 'dmx', hosts: target.hosts, universe: target.universe, first: frame[0] }); return true; },
      artnetSync: (target) => { log.push({ kind: 'sync', host: target.host }); return true; },
      sacn: () => true,
    },
  });
  return { transmitter, log };
}

const config = (artnet) => ({ artnet: { enabled: true, host: '2.255.255.255', port: 6454, sync: false, routes: null, ...artnet }, sacn: { enabled: false }, delayMs: 0 });

test('a claimed universe goes to its nodes; the rest to the target', () => {
  const { transmitter, log } = recordingTransmitter();
  const c = config({ routes: { 0: ['192.168.1.50', '192.168.1.51'] } });
  transmitter.send(0, Buffer.alloc(512), c);
  transmitter.send(1, Buffer.alloc(512), c);
  assert.deepStrictEqual(log.map((l) => [l.universe, l.hosts]), [
    [0, ['192.168.1.50', '192.168.1.51']],
    [1, ['2.255.255.255']],
  ]);
});

test('with ArtSync on, a frame closes with one sync to every place it went', () => {
  const { transmitter, log } = recordingTransmitter();
  const c = config({ sync: true, routes: { 0: ['192.168.1.50'] } });
  transmitter.send(0, Buffer.alloc(512), c);
  transmitter.send(1, Buffer.alloc(512), c);
  transmitter.send(2, Buffer.alloc(512), c);
  transmitter.endFrame(c);
  const syncs = log.filter((l) => l.kind === 'sync').map((l) => l.host);
  assert.deepStrictEqual(syncs.sort(), ['192.168.1.50', '2.255.255.255']);
  assert.strictEqual(log[log.length - 1].kind, 'sync', 'after the frame, not during it');

  log.length = 0;
  transmitter.endFrame(c);
  assert.deepStrictEqual(log, [], 'and only once');
});

test('with ArtSync off, nothing but frames', () => {
  const { transmitter, log } = recordingTransmitter();
  const c = config({ sync: false });
  transmitter.send(0, Buffer.alloc(512), c);
  transmitter.endFrame(c);
  assert.deepStrictEqual(log.map((l) => l.kind), ['dmx']);
});
