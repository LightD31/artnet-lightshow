// Musical time, as both the rig and the rehearsal preview count it. One
// continuous beat position from the analysed grid, and every step and phase
// derived from it — so nothing accumulates and nothing can drift.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { FRAME_MS } from '../../src/server/frame-clock.ts';
import { makeGrid, gridFromAnalysis, beatPositionAt, trackMsAtBeat, localBpm, anchorStep, stepAt, hitPhase, fadePhase, motionAdvance } from '../../src/shared/beat-clock.ts';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** A steady grid at `bpm`, starting at `offsetSec`. */
function steady(bpm, count, offsetSec = 0.5) {
  return Array.from({ length: count }, (_, i) => offsetSec + (i * 60) / bpm);
}

test('the beat position is a whole number on every beat and linear between', () => {
  const grid = makeGrid([1, 1.5, 2, 2.6, 3.2]);
  assert.strictEqual(beatPositionAt(grid, 1000), 0);
  assert.strictEqual(beatPositionAt(grid, 2000), 2);
  assert.ok(close(beatPositionAt(grid, 1250), 0.5));
  assert.ok(close(beatPositionAt(grid, 2300), 2.5), 'a longer beat is walked at its own speed');
});

test('outside the grid it carries on at the median tempo, never backwards', () => {
  const grid = makeGrid(steady(120, 16, 2));
  assert.ok(close(beatPositionAt(grid, 1000), -2), 'two beats before the first');
  assert.ok(close(beatPositionAt(grid, (2 + 15 * 0.5 + 1) * 1000), 17), 'two past the last');
  let last = -Infinity;
  for (let t = 0; t <= 14000; t += 7) {
    const p = beatPositionAt(grid, t);
    assert.ok(p >= last, `monotonic at ${t} ms`);
    last = p;
  }
});

test('unusable grids are refused rather than guessed at', () => {
  assert.strictEqual(makeGrid(null), null);
  assert.strictEqual(makeGrid([3]), null, 'one beat has no tempo');
  const cleaned = makeGrid([0, NaN, 0.5, 0.505, 1.0, 'x', 1.5]);
  assert.deepStrictEqual(cleaned.beats, [0, 0.5, 1.0, 1.5], 'junk and a doubled beat are dropped');
});

test('a document with only downbeats gets beats spread across each bar', () => {
  const grid = gridFromAnalysis({ downbeats: [0, 2, 4.2], meter: 4 });
  assert.deepStrictEqual(grid.beats.map((b) => Math.round(b * 1000)), [0, 500, 1000, 1500, 2000, 2550, 3100, 3650, 4200]);
  assert.strictEqual(gridFromAnalysis({ beats: [0, 0.5, 1] }).beats.length, 3, 'beats win when present');
  assert.strictEqual(gridFromAnalysis({}), null);
});

test('track time and beat position are inverses', () => {
  const grid = makeGrid([1, 1.5, 2, 2.6, 3.2]);
  for (const ms of [0, 1000, 1400, 2300, 3200, 5000]) {
    assert.ok(close(trackMsAtBeat(grid, beatPositionAt(grid, ms)), ms, 1e-6), `${ms} ms`);
  }
});

test('the local tempo is read off the neighbouring beats', () => {
  const grid = makeGrid(steady(123.7, 64));
  assert.ok(close(localBpm(grid, 10000), 123.7, 1e-6));
  // One misplaced beat does not swing the read-out.
  const beats = steady(128, 32);
  beats[16] += 0.05;
  assert.ok(Math.abs(localBpm(makeGrid(beats), (beats[16]) * 1000) - 128) < 1);
});

// A scene is placed on a downbeat and fires a frame after it: it must start on
// step 0 of that beat, not wait a whole step for the next one.
test('a pattern anchored a little late still starts on step 0 of its beat', () => {
  const anchor = anchorStep(8.02, 2);
  assert.strictEqual(anchor, 16);
  assert.strictEqual(stepAt(8.02, anchor, 2), 0);
  assert.strictEqual(stepAt(8.49, anchor, 2), 0);
  assert.strictEqual(stepAt(8.5, anchor, 2), 1, 'the next eighth');
  // Fired a hair early: nothing negative, it simply waits for the grid.
  assert.strictEqual(stepAt(7.99, anchorStep(7.99, 1), 1), 0);
});

test('float noise does not cost a step', () => {
  assert.strictEqual(stepAt(1 / 3 * 3, 0, 1), 1);
  assert.strictEqual(stepAt(0.1 * 3, 0, 10), 3);
});

test('the hit decays across each step and the fade breathes over eight beats', () => {
  assert.ok(close(hitPhase(4.25, 1), 0.25));
  assert.ok(close(hitPhase(4.25, 2), 0.5));
  assert.strictEqual(hitPhase(4, 1), 0, 'a fresh hit at the top of the step');
  assert.strictEqual(fadePhase(8, 8, 1), 0, 'starts from its trough at the anchor');
  assert.ok(close(fadePhase(12, 8, 1), 0.5));
  assert.ok(close(fadePhase(6, 8, 1), 0.75), 'before the anchor wraps rather than going negative');
});

test('motion is counted in beats: eight per crossing when still, two when driving', () => {
  assert.ok(close(motionAdvance(8, 0), 1));
  assert.ok(close(motionAdvance(2, 1), 1));
  assert.strictEqual(motionAdvance(-1, 0.5), 0, 'time never runs the sweep backwards');
});

// The analysed tracks in the fixtures, walked at the render rate: every change
// of step lands in the first frame after its beat, and the count after four
// minutes is exactly the number of beats — no drift, whatever the tempo does.
test('stepping a real track lands every step on its beat, with no drift', () => {
  const dir = path.join(import.meta.dirname, '..', 'fixtures', 'tracks');
  for (const file of fs.readdirSync(dir)) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const grid = gridFromAnalysis(doc.analysis || doc);
    assert.ok(grid, `${file} has a grid`);
    const frameMs = FRAME_MS;
    const endMs = grid.beats[grid.beats.length - 1] * 1000;
    let last = null;
    let changes = 0;
    for (let t = grid.beats[0] * 1000; t <= endMs; t += frameMs) {
      const step = stepAt(beatPositionAt(grid, t), 0, 1);
      if (last !== null && step !== last) {
        changes++;
        const beatMs = grid.beats[step] * 1000;
        assert.ok(t >= beatMs - 1e-6 && t - beatMs < frameMs, `${file}: step ${step} at ${t} ms, beat at ${beatMs.toFixed(1)} ms`);
      }
      last = step;
    }
    assert.ok(changes >= grid.beats.length - 3, `${file}: ${changes} steps for ${grid.beats.length} beats`);
  }
});
