'use strict';

// The tempo read-out and the badge beside it, as the browser shows them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let utils;
test.before(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../public-src/utils.js'), 'utf8');
  utils = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
});

test('a whole tempo reads whole, anything else to a tenth', () => {
  assert.equal(utils.formatBpm(128), '128');
  assert.equal(utils.formatBpm(123.7), '123.7');
  assert.equal(utils.formatBpm(123.74), '123.7');
  assert.equal(utils.formatBpm(127.96), '128', 'rounds to the tenth before deciding');
  assert.equal(utils.formatBpm(null), '—');
  assert.equal(utils.formatBpm(undefined), '—');
  assert.equal(utils.formatBpm('junk'), '—');
});

test('the clock badge names every source, and anything else as the free clock', () => {
  assert.deepEqual(['auto', 'cdj', 'track', 'tap'].map((id) => utils.clockSource(id).label), ['Auto', 'CDJ', 'Track', 'Tap']);
  assert.equal(utils.clockSource('track').locked, true);
  assert.equal(utils.clockSource('tap').locked, false);
  assert.equal(utils.clockSource(undefined).id, 'tap');
  assert.equal(utils.clockSource('toString').id, 'tap', 'not a prototype key');
});
