'use strict';

// What a frame costs on the largest rig this is built for: sixty-four LED bars
// of sixteen RGBW cells, 1,024 lights, rendered forty-four times a second.
// The render loop has 22.7 ms per frame (frame-clock.js FRAME_MS); the
// assertion is deliberately loose so a slow CI runner does not fail it, and
// the numbers are printed so a regression shows up long before it would.

const test = require('node:test');
const assert = require('node:assert');

const { state } = require('../../src/server/state');
const { renderFrame, resizeFixtureBuffers } = require('../../src/server/engine');
const { conductor } = require('../../src/server/conductor');
const { applyPatch } = require('../../src/server/patch');
const { registerProfile, unregisterProfile } = require('../../src/server/profiles');

const CELLS = 16;
const BAR = {
  id: 'budget-bar-16', name: 'Budget bar', channelCount: 2 + CELLS * 4,
  channelMap: { dimmer: 0, strobe: 1 },
  cells: Array.from({ length: CELLS }, (_, i) => ({
    channelMap: { red: 2 + i * 4, green: 3 + i * 4, blue: 4 + i * 4, white: 5 + i * 4 },
  })),
};

test('a thousand cells render well inside a frame', () => {
  registerProfile(BAR);
  const before = { fixtures: state.fixtures, artnet: state.artnet.enabled };
  let beat = 0;
  conductor.setProlinkSource(() => ({ beatPos: beat, bpm: 128 }));
  state.artnet.enabled = false;
  try {
    const perUniverse = Math.floor(512 / BAR.channelCount);
    state.fixtures = Array.from({ length: 64 }, (_, i) => ({
      id: i, label: `Bar ${i + 1}`, profileId: BAR.id, maxBrightness: 255, override: null,
      universe: Math.floor(i / perUniverse), address: 1 + (i % perUniverse) * BAR.channelCount,
      position: { x: 5 + (i % 16) * 6, y: 20 + Math.floor(i / 16) * 20 },
    }));
    resizeFixtureBuffers();

    const timings = {};
    const run = (label, patch, frames = 80) => {
      applyPatch({ running: true, masterDimmer: 255, masterBlackout: false, colorA: 1, colorB: 5, colorC: 3, colorD: 8, ...patch });
      const ms = [];
      for (let f = 0; f < frames; f++) {
        beat += 0.1;
        const t0 = performance.now();
        renderFrame();
        ms.push(performance.now() - t0);
      }
      ms.sort((a, b) => a - b);
      timings[label] = {
        mean: ms.reduce((a, b) => a + b, 0) / ms.length,
        p95: ms[Math.floor(ms.length * 0.95)],
      };
    };

    run('warm-up', { pattern: 'solid' }, 20);
    run('wave', { pattern: 'wave' });
    run('ribbon', { pattern: 'ribbon', showDynamics: { level: 0.8, width: 0.6, air: 0.5, motion: 0.6 } });
    run('chase', { pattern: 'chase', showDynamics: null });
    run('twinkle', { pattern: 'twinkle' });
    run('gradient', { pattern: 'gradient', pixelMap: 'stage' });
    run('plasma', { pattern: 'plasma', pixelMap: 'mirror' });
    run('comet', { pattern: 'comet', pixelMap: 'bar' });
    run('crossfade', { pattern: 'wave', colorA: 6, fadeMs: 5000 });

    delete timings['warm-up'];
    console.log(`[budget] ${state.fixtures.length} bars × ${CELLS} cells:`);
    for (const [label, { mean, p95 }] of Object.entries(timings)) {
      console.log(`[budget]   ${label.padEnd(10)} mean ${mean.toFixed(2)} ms  p95 ${p95.toFixed(2)} ms`);
      assert.ok(mean < 8, `${label} takes ${mean.toFixed(2)} ms a frame on average`);
    }
  } finally {
    conductor.setProlinkSource(null);
    state.fixtures = before.fixtures;
    state.artnet.enabled = before.artnet;
    resizeFixtureBuffers();
    unregisterProfile(BAR.id);
  }
});
