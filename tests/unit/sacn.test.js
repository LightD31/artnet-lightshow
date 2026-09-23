import test from 'node:test';
import assert from 'node:assert';

import { PACKET_SIZE, buildE131Packet, multicastAddress, cidFromUuid, generateCid } from '../../src/server/sacn.ts';

const CID = cidFromUuid('7b2d4c1e-9f30-4a55-8c11-a0b3d5e7f902');

function build(overrides = {}, dmx = Buffer.alloc(512)) {
  return buildE131Packet({
    universe: 1,
    cid: CID,
    sourceName: 'ArtNet Lightshow',
    priority: 100,
    sequence: 1,
    ...overrides,
  }, dmx);
}

test('the root layer identifies an E1.31 data packet', () => {
  const p = build();

  assert.strictEqual(p.length, PACKET_SIZE, '638 bytes: 38 root + 77 framing + 523 DMP');
  assert.strictEqual(p.readUInt16BE(0), 0x0010, 'preamble size');
  assert.strictEqual(p.readUInt16BE(2), 0x0000, 'post-amble size');
  assert.strictEqual(p.subarray(4, 16).toString('latin1'), 'ASC-E1.17\0\0\0');
  assert.strictEqual(p.readUInt32BE(18), 4, 'VECTOR_ROOT_E131_DATA');
  assert.deepStrictEqual(p.subarray(22, 38), CID, 'the source CID');
});

// Each PDU's length field counts from its own first byte to the end of the
// packet. Get one wrong and a receiver drops the frame with no diagnostic.
test('every PDU declares the 0x7 flags and its own length', () => {
  const p = build();

  assert.strictEqual(p.readUInt16BE(16), 0x7000 | (PACKET_SIZE - 16), 'root PDU');
  assert.strictEqual(p.readUInt16BE(38), 0x7000 | (PACKET_SIZE - 38), 'framing PDU');
  assert.strictEqual(p.readUInt16BE(115), 0x7000 | (PACKET_SIZE - 115), 'DMP PDU');
});

test('the framing layer carries source name, priority, sequence and universe', () => {
  const p = build({ universe: 4231, priority: 150, sequence: 77, sourceName: 'Booth' });

  assert.strictEqual(p.readUInt32BE(40), 2, 'VECTOR_E131_DATA_PACKET');
  assert.strictEqual(p.subarray(44, 108).toString('utf8').replace(/\0+$/, ''), 'Booth');
  assert.strictEqual(p[108], 150, 'priority');
  assert.strictEqual(p.readUInt16BE(109), 0, 'no synchronization address');
  assert.strictEqual(p[111], 77, 'sequence');
  assert.strictEqual(p[112], 0, 'options: not preview, not terminated');
  assert.strictEqual(p.readUInt16BE(113), 4231, 'universe');
});

// The name field is 64 bytes and null-terminated, so a long one must lose its
// tail rather than the terminator.
test('a long source name is truncated with its terminator intact', () => {
  const p = build({ sourceName: 'x'.repeat(200) });

  assert.strictEqual(p[107], 0, 'the last byte of the name field stays null');
  assert.strictEqual(p.subarray(44, 107).toString('utf8'), 'x'.repeat(63));
});

test('the DMP layer carries a zero start code and all 512 slots', () => {
  const dmx = Buffer.alloc(512);
  dmx[0] = 255;
  dmx[511] = 42;
  const p = build({}, dmx);

  assert.strictEqual(p[117], 0x02, 'VECTOR_DMP_SET_PROPERTY');
  assert.strictEqual(p[118], 0xa1, 'address & data type');
  assert.strictEqual(p.readUInt16BE(119), 0, 'first property address');
  assert.strictEqual(p.readUInt16BE(121), 1, 'address increment');
  assert.strictEqual(p.readUInt16BE(123), 513, 'start code plus 512 slots');
  assert.strictEqual(p[125], 0x00, 'DMX start code');
  assert.strictEqual(p[126], 255, 'slot 1');
  assert.strictEqual(p[637], 42, 'slot 512, at the very end of the packet');
});

// E1.31 §9.3.1: 239.255.<universe high byte>.<universe low byte>.
test('the multicast group is derived from the universe number', () => {
  assert.strictEqual(multicastAddress(1), '239.255.0.1');
  assert.strictEqual(multicastAddress(255), '239.255.0.255');
  assert.strictEqual(multicastAddress(256), '239.255.1.0');
  assert.strictEqual(multicastAddress(63999), '239.255.249.255');
});

test('CIDs come from UUIDs, and junk is rejected rather than half-parsed', () => {
  assert.strictEqual(cidFromUuid('7b2d4c1e-9f30-4a55-8c11-a0b3d5e7f902').length, 16);
  assert.strictEqual(cidFromUuid('7b2d4c1e9f304a558c11a0b3d5e7f902').length, 16, 'dashes optional');
  assert.strictEqual(cidFromUuid(''), null);
  assert.strictEqual(cidFromUuid('not-a-uuid'), null);
  assert.strictEqual(cidFromUuid(null), null);
  assert.strictEqual(cidFromUuid(generateCid()).length, 16, 'what we generate parses back');
});

// ── Stream termination and universe discovery ──────────────────────────────

import { buildDiscoveryPackets, sendSacn, OPTION_STREAM_TERMINATED, TERMINATION_PACKETS, DISCOVERY_UNIVERSE, PORT } from '../../src/server/sacn.ts';

test('a terminated packet sets options bit 6 and nothing else', () => {
  assert.strictEqual(build({ terminated: true })[112], OPTION_STREAM_TERMINATED);
  assert.strictEqual(OPTION_STREAM_TERMINATED, 0x40);
});

test('a discovery packet lists the universes under the extended vectors', () => {
  const [p, ...more] = buildDiscoveryPackets({ cid: CID, sourceName: 'Booth', universes: [7, 1, 3, 3, 0, 64000] });
  assert.strictEqual(more.length, 0, 'one page');
  assert.strictEqual(p.length, 120 + 3 * 2, 'three universes: 0 and 64000 are not sACN universes, 3 is listed once');
  assert.strictEqual(p.readUInt16BE(0), 0x0010);
  assert.strictEqual(p.subarray(4, 16).toString('latin1'), 'ASC-E1.17\0\0\0');
  assert.strictEqual(p.readUInt16BE(16), 0x7000 | (p.length - 16), 'root PDU length');
  assert.strictEqual(p.readUInt32BE(18), 8, 'VECTOR_ROOT_E131_EXTENDED');
  assert.deepStrictEqual(p.subarray(22, 38), CID);
  assert.strictEqual(p.readUInt16BE(38), 0x7000 | (p.length - 38), 'framing PDU length');
  assert.strictEqual(p.readUInt32BE(40), 2, 'VECTOR_E131_EXTENDED_DISCOVERY');
  assert.strictEqual(p.subarray(44, 108).toString('utf8').replace(/\0+$/, ''), 'Booth');
  assert.strictEqual(p.readUInt32BE(108), 0, 'reserved');
  assert.strictEqual(p.readUInt16BE(112), 0x7000 | (p.length - 112), 'discovery PDU length');
  assert.strictEqual(p.readUInt32BE(114), 1, 'VECTOR_UNIVERSE_DISCOVERY_UNIVERSE_LIST');
  assert.strictEqual(p[118], 0, 'page');
  assert.strictEqual(p[119], 0, 'last page');
  assert.deepStrictEqual([p.readUInt16BE(120), p.readUInt16BE(122), p.readUInt16BE(124)], [1, 3, 7], 'sorted');
});

test('more than 512 universes go out as pages', () => {
  const universes = Array.from({ length: 600 }, (_, i) => i + 1);
  const pages = buildDiscoveryPackets({ cid: CID, sourceName: 'x', universes });
  assert.strictEqual(pages.length, 2);
  assert.deepStrictEqual(pages.map((p) => [p[118], p[119]]), [[0, 1], [1, 1]]);
  assert.strictEqual(pages[0].length, 120 + 512 * 2);
  assert.strictEqual(pages[1].readUInt16BE(120), 513);
  assert.strictEqual(DISCOVERY_UNIVERSE, 64214);
});

test('a terminated stream is the frame, then three stream-terminated packets', async (t) => {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const got = [];
  socket.on('message', (msg) => got.push({ options: msg[112], sequence: msg[111], universe: msg.readUInt16BE(113) }));
  const bound = await new Promise((resolve) => {
    socket.once('error', () => resolve(false));
    socket.bind(PORT, '127.0.0.1', () => resolve(true));
  });
  if (!bound) { t.skip('the sACN port is taken on this machine'); return; }
  try {
    const target = { universe: 9, cid: '7b2d4c1e-9f30-4a55-8c11-a0b3d5e7f902', sourceName: 'Test', priority: 100, host: '127.0.0.1' };
    // The send socket opens on first use and is ready once it has bound.
    for (let i = 0; i < 20 && !sendSacn(target, Buffer.alloc(512)); i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 30));
    got.length = 0;
    assert.ok(sendSacn({ ...target, terminate: true }, Buffer.alloc(512)));
    await new Promise((r) => setTimeout(r, 60));
    assert.deepStrictEqual(got.map((g) => g.options), [0, ...new Array(TERMINATION_PACKETS).fill(OPTION_STREAM_TERMINATED)]);
    const seqs = got.map((g) => g.sequence);
    assert.deepStrictEqual(seqs, seqs.map((_, i) => (seqs[0] + i) & 0xff), 'each its own sequence number');
  } finally {
    socket.close();
  }
});

// ── The transmitter ends streams and announces them ─────────────────────────

import { createTransmitter } from '../../src/server/transmit.ts';
import dgram from 'node:dgram';

function sacnRecorder(clock) {
  const log = [];
  const transmitter = createTransmitter({
    now: () => clock.t,
    wires: {
      artnet: () => true,
      artnetSync: () => true,
      sacn: (target, frame) => { log.push({ kind: 'data', universe: target.universe, terminate: target.terminate, host: target.host, iface: target.iface, lit: frame.some((v) => v) }); return true; },
      sacnDiscovery: (source) => { log.push({ kind: 'discovery', universes: source.universes }); return true; },
    },
  });
  return { transmitter, log };
}

const sacnConfig = (sacn = {}) => ({
  artnet: { enabled: false },
  sacn: { enabled: true, host: '', priority: 100, sourceName: 'Rig', universeOffset: 1, cid: '', interface: '', ...sacn },
  delayMs: 0,
});
const lit = () => Buffer.alloc(512, 9);

test('a universe that leaves the patch is terminated, not left to time out', () => {
  const clock = { t: 0 };
  const { transmitter, log } = sacnRecorder(clock);
  const c = sacnConfig();
  transmitter.send(0, Buffer.alloc(512), c, { immediate: true, terminate: true });
  assert.deepStrictEqual(log.map((l) => [l.universe, l.terminate]), [[1, true]]);
});

test('discovery lists the universes being sent, every ten seconds', () => {
  const clock = { t: 0 };
  const { transmitter, log } = sacnRecorder(clock);
  const c = sacnConfig({ interface: '10.0.0.5' });
  const frame = () => { transmitter.send(0, lit(), c); transmitter.send(3, lit(), c); transmitter.endFrame(c); };
  frame();
  assert.deepStrictEqual(log.filter((l) => l.kind === 'discovery').map((l) => l.universes), [[1, 4]]);
  assert.strictEqual(log[0].iface, '10.0.0.5', 'multicast leaves on the chosen network');
  for (clock.t = 1000; clock.t < 9000; clock.t += 1000) frame();
  assert.strictEqual(log.filter((l) => l.kind === 'discovery').length, 1, 'not every frame');
  clock.t = 10000;
  frame();
  assert.strictEqual(log.filter((l) => l.kind === 'discovery').length, 2);
});

test('changing the stream ends the old one with its own settings', () => {
  const clock = { t: 0 };
  const { transmitter, log } = sacnRecorder(clock);
  const before = sacnConfig({ universeOffset: 1, host: '10.0.0.9' });
  transmitter.send(0, lit(), before);
  transmitter.endFrame(before);
  log.length = 0;

  const after = sacnConfig({ universeOffset: 100 });
  transmitter.send(0, lit(), after);
  transmitter.endFrame(after);
  const ended = log.filter((l) => l.terminate);
  assert.deepStrictEqual(ended.map((l) => [l.universe, l.host, l.lit]), [[1, '10.0.0.9', false]], 'blacked out and terminated where it was');

  log.length = 0;
  const off = sacnConfig({ enabled: false });
  transmitter.endFrame(off);
  assert.deepStrictEqual(log.filter((l) => l.terminate).map((l) => l.universe), [100], 'turning sACN off ends what it was sending');
  log.length = 0;
  transmitter.endFrame(off);
  assert.deepStrictEqual(log, [], 'once');
});
