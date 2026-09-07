'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildArtDmxPacket } = require('../../src/server/artnet');

test('Art-Net packet header is well formed', () => {
  const dmx = Buffer.alloc(512);
  dmx[0] = 255;
  const p = buildArtDmxPacket(0, dmx, 1);

  assert.strictEqual(p.length, 18 + 512);
  assert.strictEqual(p.subarray(0, 8).toString('ascii'), 'Art-Net\0');
  assert.strictEqual(p.readUInt16LE(8), 0x5000, 'opcode OpDmx');
  assert.strictEqual(p.readUInt16BE(10), 14, 'protocol version');
  assert.strictEqual(p.readUInt16BE(16), 512, 'data length');
  assert.strictEqual(p[18], 255, 'DMX payload starts at byte 18');
});

test('universe is masked to 15 bits', () => {
  const dmx = Buffer.alloc(512);
  assert.strictEqual(buildArtDmxPacket(5, dmx, 1).readUInt16LE(14), 5);
  assert.strictEqual(buildArtDmxPacket(0xffff, dmx, 1).readUInt16LE(14), 0x7fff);
});

// A hardcoded 0 tells receivers sequencing is disabled, so they
// cannot detect out-of-order UDP.
test('sequence counter advances 1..255 and never emits 0', () => {
  const dmx = Buffer.alloc(512);
  const seen = [];
  for (let i = 0; i < 300; i++) seen.push(buildArtDmxPacket(0, dmx)[12]);

  assert.ok(seen.every((v) => v >= 1 && v <= 255), 'stays in 1..255');
  const wrap = seen.indexOf(255);
  assert.strictEqual(seen[wrap + 1], 1, 'wraps from 255 back to 1, skipping 0');
});
