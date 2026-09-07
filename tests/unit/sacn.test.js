'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  PACKET_SIZE,
  buildE131Packet,
  multicastAddress,
  cidFromUuid,
  generateCid,
} = require('../../src/server/sacn');

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
