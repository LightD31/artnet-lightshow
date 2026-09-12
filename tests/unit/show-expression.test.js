'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// Observe actual DMX frames without sending them to a fixture or network.
// The stub has to cover everything the engine calls, Hue included — it is a
// stand-in for the whole output layer, not just the Art-Net path.
const outputPath = require.resolve('../../src/server/output');
require.cache[outputPath] = {
  id: outputPath, filename: outputPath, loaded: true,
  exports: { sendUniverse() {}, sendHue() {}, stopHue() {} },
};
const { state } = require('../../src/server/state');
const { startEngine, stopEngine } = require('../../src/server/engine');
const { applyPatch } = require('../../src/server/patch');
const { getProfile } = require('../../src/server/profiles');
const universes = require('../../src/server/universes');

test('music dims the rendered scene; silence closes it; master still scales an override', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  const fixture = state.fixtures[0];
  const channel = getProfile(fixture).channelMap;
  const read = name => universes.getBuffer(state.artnet.universe)[fixture.address - 1 + channel[name]];
  try {
    applyPatch({ pattern: 'ensemble', running: true, masterBlackout: false, masterDimmer: 128,
      colorA: 0, energyOverride: null, showDynamics: { level: .8, bass: .8, vocal: .6, air: .5 } });
    startEngine(); t.mock.timers.tick(500);
    assert.ok(read('dimmer') > 0 && read('dimmer') < 128);
    applyPatch({ showDynamics: { level: 0 } }); t.mock.timers.tick(25);
    assert.equal(read('dimmer'), 0);
    // An override renders at full and is still scaled by the master — it is the
    // one moment you most want the master to keep meaning something. `blinder`
    // is the non-strobing one, so the strobe channel stays closed.
    applyPatch({ showDynamics: { level: .8 }, energyOverride: 'blinder' }); t.mock.timers.tick(25);
    assert.equal(read('dimmer'), 128);
    assert.equal(read('strobe'), 0);
    applyPatch({ masterBlackout: true }); t.mock.timers.tick(25);
    assert.equal(read('dimmer'), 0);
    applyPatch({ masterBlackout: false, showDynamics: null, energyOverride: null });
    t.mock.timers.tick(25);
    assert.equal(state.masterDimmer, 128);
    assert.ok(read('dimmer') > 0);
  } finally { stopEngine(); t.mock.timers.reset(); }
});
