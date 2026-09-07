'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { patchSchema, profileSchema, overrideSchema, validate } = require('../../src/server/validation');

const ok = (schema, v) => { validate(schema, v, 't'); return true; };
const rejects = (schema, v) => assert.throws(() => validate(schema, v, 't'));

test('patch schema bounds the control ranges', () => {
  assert.ok(ok(patchSchema, { bpm: 120, masterDimmer: 255, colorA: 0 }));
  rejects(patchSchema, { bpm: 19 });
  rejects(patchSchema, { bpm: 301 });
  rejects(patchSchema, { masterDimmer: 256 });
  rejects(patchSchema, { colorA: -1 });
  rejects(patchSchema, { unknownField: 1 });      // .strict()
});

// A mistyped host used to reach dgram, fail DNS, and kill the
// process. Dotted-numeric strings are held to IPv4 rules so a typo is caught.
test('artnet host accepts addresses and hostnames, rejects mistyped IPs', () => {
  for (const host of ['2.255.255.255', '192.168.1.50', '10.0.0.1', 'artnet-node.local', 'node1']) {
    assert.ok(ok(patchSchema, { artnet: { host } }), host);
  }
  for (const host of ['2.255.255.256', '999.1.1.1', '1.2.3', '1.2.3.4.5', 'not a host!', '', 'http://x']) {
    rejects(patchSchema, { artnet: { host } });
  }
});

// "__proto__" as a profile id reassigned the registry's prototype.
test('reserved profile ids are rejected', () => {
  const good = { id: 'acme-par', name: 'PAR', channelCount: 4, channelMap: { red: 0 } };
  assert.ok(ok(profileSchema, good));
  for (const id of ['__proto__', 'constructor', 'prototype']) {
    rejects(profileSchema, { ...good, id });
  }
});

test('fixture override clamps to byte range and requires enabled', () => {
  assert.ok(ok(overrideSchema, { enabled: true, r: 255, g: 0, b: 0 }));
  rejects(overrideSchema, { enabled: true, r: 256 });
  rejects(overrideSchema, { r: 1 });               // `enabled` is required
  const parsed = validate(overrideSchema, { enabled: true }, 't');
  assert.strictEqual(parsed.dim, 255, 'dim defaults to full');
  assert.strictEqual(parsed.blackout, false);
});
