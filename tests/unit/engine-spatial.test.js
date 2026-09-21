'use strict';

// The live engine routes pattern slots through the stage layout: a chase on a
// rig patched right-to-left still travels left to right across the room.

const test = require('node:test');
const assert = require('node:assert');

const { state } = require('../../src/server/state');
const universes = require('../../src/server/universes');
const { getProfile } = require('../../src/server/profiles');
const { startEngine, stopEngine, restartBeatTimer } = require('../../src/server/engine');
const { applyPatch } = require('../../src/server/patch');
const { spatialLayout } = require('../../src/shared/stage');

const frames = (n = 3) => new Promise((r) => setTimeout(r, 25 * n + 20));

/** Each fixture's dimmer as the rig is driving it. */
function dimmers() {
  return state.fixtures.map((fix) => {
    const ch = getProfile(fix).channelMap;
    return universes.getBuffer(fix.universe ?? state.artnet.universe)[fix.address - 1 + ch.dimmer];
  });
}

test.before(() => {
  state.artnet.enabled = false;
  // A slow clock, so the beat timer cannot step the chase between the tick
  // this test takes and the frame it reads.
  applyPatch({ pattern: 'chase', running: true, bpm: 20, beatDivision: 1, masterDimmer: 255,
    masterBlackout: false, showDynamics: null, energyOverride: null, colorA: 1, colorB: 4 });
  startEngine();
});

test.after(() => {
  for (const fix of state.fixtures) fix.position = null;
  stopEngine();
});

test('a chase travels in stage order on a rig patched right to left', async () => {
  assert.ok(state.fixtures.length >= 3, 'the default patch has several fixtures');
  const n = state.fixtures.length;
  // Patch index 0 stands stage-right, the last patched stands stage-left.
  state.fixtures.forEach((fix, i) => { fix.position = { x: 100 - (100 * i) / (n - 1), y: 40 }; });
  const { order } = spatialLayout(state.fixtures);
  assert.deepStrictEqual(order, [...order.keys()].map((k) => n - 1 - k));

  const lit = [];
  for (let k = 0; k < n; k++) {
    restartBeatTimer({ tickNow: true });
    await frames();
    const d = dimmers();
    lit.push(d.indexOf(Math.max(...d)));
  }
  // Whatever slot the chase started on, it must walk the fixtures in stage order.
  const start = order.indexOf(lit[0]);
  assert.deepStrictEqual(lit, [...Array(n).keys()].map((k) => order[(start + k) % n]));
});
