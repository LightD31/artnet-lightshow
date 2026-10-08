// What a frame costs on the largest rig this is built for: sixty-four LED bars
// of sixteen RGBW cells, 1,024 lights, rendered forty-four times a second.
// The render loop has 22.7 ms per frame (frame-clock.js FRAME_MS); the
// assertion is deliberately loose so a slow CI runner does not fail it, and
// the numbers are printed so a regression shows up long before it would.
//
// It is judged on the CPU time the process spent rendering, not the wall
// clock: the test files run side by side, and on a small CI runner another
// file's work preempting this one made a 2.7 ms frame read as 17 ms of wall
// time. CPU time is not immune either: with every core busy, a 2 ms frame
// reads as 10 ms. So a fixed piece of arithmetic is timed the same way first,
// and the budget is scaled by how much slower it ran than on a quiet machine.
// Busy neighbours slow both alike; a slow renderer slows only the frames. The
// figures printed are the ones measured, unscaled.

import test from 'node:test';
import assert from 'node:assert';

import { state } from '../../src/server/state.ts';
import { renderFrame, resizeFixtureBuffers } from '../../src/server/engine.ts';
import { conductor } from '../../src/server/conductor.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { registerProfile, unregisterProfile } from '../../src/server/profiles.ts';

const CELLS = 16;

// What calibrate() takes on a quiet machine, in ms of CPU: a 2024 desktop core
// does it in about 2. A slower machine or a busy one scales the budget up by
// the ratio; a faster one never scales it down below the 8 ms it is written for.
const QUIET_CALIBRATION_MS = 2;
const FRAME_BUDGET_MS = 8;

/** CPU ms for a fixed piece of arithmetic, the cheapest of a few tries. */
function calibrate(tries = 5) {
  let best = Infinity;
  let sink = 0;
  for (let t = 0; t < tries; t++) {
    const cpu0 = process.cpuUsage();
    for (let i = 0; i < 1_000_000; i++) sink += Math.sqrt(i) * 1e-9;
    const used = process.cpuUsage(cpu0);
    best = Math.min(best, (used.user + used.system) / 1000);
  }
  if (sink < 0) throw new Error('unreachable');
  return best;
}
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
    const run = (label, patch, frames = 80, batches = 5) => {
      applyPatch({ running: true, masterDimmer: 255, masterBlackout: false, colorA: 1, colorB: 5, colorC: 3, colorD: 8, ...patch });
      const ms = [];
      let cpu = Infinity;
      for (let b = 0; b < batches; b++) {
        const cpu0 = process.cpuUsage();
        for (let f = 0; f < frames; f++) {
          beat += 0.1;
          const t0 = performance.now();
          renderFrame();
          ms.push(performance.now() - t0);
        }
        const used = process.cpuUsage(cpu0);
        cpu = Math.min(cpu, (used.user + used.system) / 1000 / frames);
      }
      ms.sort((a, b) => a - b);
      timings[label] = {
        cpu,
        mean: ms.reduce((a, b) => a + b, 0) / ms.length,
        p95: ms[Math.floor(ms.length * 0.95)],
      };
    };

    const calibration = calibrate();
    run('warm-up', { pattern: 'solid' }, 20, 1);
    run('wave', { pattern: 'wave' });
    run('ribbon', { pattern: 'ribbon', showDynamics: { level: 0.8, width: 0.6, air: 0.5, motion: 0.6 } });
    run('chase', { pattern: 'chase', showDynamics: null });
    run('twinkle', { pattern: 'twinkle' });
    run('gradient', { pattern: 'gradient', pixelMap: 'stage' });
    run('plasma', { pattern: 'plasma', pixelMap: 'mirror' });
    run('comet', { pattern: 'comet', pixelMap: 'bar' });
    run('two-part', { pattern: 'hit', pixelPattern: 'impact', pixelMap: 'stage' });
    run('crossfade', { pattern: 'wave', colorA: 6, fadeMs: 5000 });

    delete timings['warm-up'];
    const slowdown = Math.max(1, calibration / QUIET_CALIBRATION_MS);
    const budget = FRAME_BUDGET_MS * slowdown;
    console.log(`[budget] ${state.fixtures.length} bars × ${CELLS} cells; calibration ${calibration.toFixed(2)} ms, budget ${budget.toFixed(1)} ms:`);
    for (const [label, { cpu, mean, p95 }] of Object.entries(timings)) {
      console.log(`[budget]   ${label.padEnd(10)} cpu ${cpu.toFixed(2)} ms  wall mean ${mean.toFixed(2)} ms  p95 ${p95.toFixed(2)} ms`);
      assert.ok(cpu < budget, `${label} takes ${cpu.toFixed(2)} ms of CPU a frame on average, over ${budget.toFixed(1)} ms (machine ${slowdown.toFixed(1)}× slower than quiet)`);
    }
  } finally {
    conductor.setProlinkSource(null);
    state.fixtures = before.fixtures;
    state.artnet.enabled = before.artnet;
    resizeFixtureBuffers();
    unregisterProfile(BAR.id);
  }
});
