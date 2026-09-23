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

// ── LED bars in the browser ─────────────────────────────────────────────────

const barState = (snapshot, extra = {}) => ({
  masterDimmer: 255,
  masterBlackout: false,
  profiles: {
    bar: {
      channelMap: { dimmer: 0 },
      cells: [
        { channelMap: { red: 1, green: 2, blue: 3 } },
        { channelMap: { red: 4, green: 5, blue: 6 } },
      ],
    },
    par: { channelMap: { dimmer: 0, red: 1, green: 2, blue: 3 } },
  },
  dmxSnapshot: { 0: snapshot },
  ...extra,
});

test('a bar\'s cells are read out of the snapshot through their own channels', () => {
  const state = barState([128, 255, 0, 0, 0, 0, 255]);
  const fix = { profileId: 'bar', address: 1, universe: 0 };
  const lights = utils.fixtureCellLights(fix, state);
  assert.deepEqual(lights.map((l) => [l.r, l.g, l.b]), [[128, 0, 0], [0, 0, 128]], 'through the bar\'s dimmer');
  assert.deepEqual(utils.fixtureCellColors(fix, state), ['rgb(128,0,0)', 'rgb(0,0,128)']);
  assert.equal(utils.fixtureOutputColor(fix, state), 'rgb(64,0,64)', 'its swatch is the mean');
  assert.equal(utils.fixtureCellColors({ profileId: 'par', address: 1, universe: 0 }, state), null, 'a par is one light');
});

test('a pinned or blacked-out bar shows the same on every cell', () => {
  const fix = {
    profileId: 'bar', address: 1, universe: 0,
    override: { enabled: true, r: 200, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, blackout: false },
  };
  assert.deepEqual(utils.fixtureCellColors(fix, barState([])), ['rgb(200,0,0)', 'rgb(200,0,0)']);
  assert.deepEqual(utils.fixtureCellColors(fix, barState([], { masterBlackout: true })), ['rgb(0,0,0)', 'rgb(0,0,0)']);
});

test('a par reads exactly as it always did', () => {
  const state = barState([128, 200, 100, 50]);
  assert.equal(utils.fixtureOutputColor({ profileId: 'par', address: 1, universe: 0 }, state), 'rgb(100,50,25)');
});
