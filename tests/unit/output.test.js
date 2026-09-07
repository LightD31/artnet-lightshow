'use strict';

const test = require('node:test');
const assert = require('node:assert');

const output = require('../../src/server/output');

// Art-Net counts universes from 0, sACN from 1. Getting the offset wrong sends
// every fixture one universe away from where the console is listening.
test('the default offset lines Art-Net universe 0 up with sACN universe 1', () => {
  assert.strictEqual(output.sacnUniverseFor(0, 1), 1);
  assert.strictEqual(output.sacnUniverseFor(7, 1), 8);
});

test('an offset can map the rig anywhere in the sACN range', () => {
  assert.strictEqual(output.sacnUniverseFor(0, 100), 100);
  assert.strictEqual(output.sacnUniverseFor(5, -4), 1);
});

// Universe 0 is reserved in E1.31 and 64000+ does not exist, so a frame that
// would land there is dropped rather than sent somewhere it does not belong.
test('a universe outside the E1.31 range maps to nothing', () => {
  assert.strictEqual(output.sacnUniverseFor(0, 0), null, 'sACN has no universe 0');
  assert.strictEqual(output.sacnUniverseFor(0, -1), null);
  assert.strictEqual(output.sacnUniverseFor(32767, 63999), null, 'past 63999');
});

test('configureSacn merges over the defaults and reads back', () => {
  const before = output.getSacnConfig();
  try {
    output.configureSacn({ enabled: true, priority: 200 });
    const config = output.getSacnConfig();
    assert.strictEqual(config.enabled, true);
    assert.strictEqual(config.priority, 200);
    assert.strictEqual(config.sourceName, before.sourceName, 'untouched keys survive');
  } finally {
    output.configureSacn(before);
  }
});
