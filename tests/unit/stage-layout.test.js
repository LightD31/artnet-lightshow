// Patterns travel across the stage as the operator placed it, not in the order
// the fixtures were patched. On a rig of pars along a truss plus Hue lamps
// around the room, patch order sent a chase from the back corner to the far
// side and back.

import test from 'node:test';
import assert from 'node:assert';

import { spatialLayout, stagePositions } from '../../src/shared/stage.js';
import { PATTERN_FUNCS } from '../../src/shared/patterns.js';
import { createPreviewSampler } from '../../src/shared/preview.js';
import { COLOR_PRESETS } from '../../src/server/presets.js';

const at = (x, y = 35) => ({ position: { x, y } });

test('with nothing placed, the order is the patch and there are no positions', () => {
  assert.deepStrictEqual(spatialLayout([{}, {}, {}, {}]), { order: [0, 1, 2, 3], xs: null });
});

test('placed fixtures are ordered left to right, front before back in a column', () => {
  const { order } = spatialLayout([at(80), at(10), at(50, 20), at(50, 70)]);
  // x 10, then the x-50 pair front (y 70) before back (y 20), then x 80.
  assert.deepStrictEqual(order, [1, 3, 2, 0]);
});

test('unplaced fixtures spread among themselves and take their place in the order', () => {
  // Four unplaced pars and two placed lamps at the far left: the pars spread
  // at 20/40/60/80 rather than being squeezed into the first 40% of the stage.
  const rig = [{}, {}, {}, {}, at(5), at(12)];
  assert.deepStrictEqual(stagePositions(rig).slice(0, 4).map((p) => p.x), [20, 40, 60, 80]);
  assert.deepStrictEqual(spatialLayout(rig).order, [4, 5, 0, 1, 2, 3]);
});

test('positions are normalised across the rig\'s own span', () => {
  const { xs } = spatialLayout([at(30), at(70), at(50)]);
  assert.deepStrictEqual(xs, [0, 0.5, 1]);
});

test('a rig placed in one column falls back to even spacing', () => {
  assert.strictEqual(spatialLayout([at(50, 10), at(50, 60), at(50, 90)]).xs, null);
});

test('every pattern renders an unplaced rig exactly as it did before positions existed', () => {
  // The identity order and no xs must be a no-op, value for value.
  const colors = [COLOR_PRESETS[1], COLOR_PRESETS[4], COLOR_PRESETS[6], COLOR_PRESETS[10]];
  const dynamics = { level: .8, bass: .6, vocal: .4, air: .5, width: .7, motion: .5, decay: .3 };
  for (const [name, fn] of Object.entries(PATTERN_FUNCS)) {
    if (['twinkle', 'sparkle', 'random-flash'].includes(name)) continue;  // stochastic
    for (const step of [0, 3, 7]) {
      const run = (extra) => {
        const out = [];
        fn({ colors, fixtureCount: 6, step, hue: 60, phase: .37, dynamics, twinkle: new Array(6).fill(0),
          write: (i, c, d) => { out[i] = [c, d]; }, ...extra });
        return out;
      };
      const { order, xs } = spatialLayout([{}, {}, {}, {}, {}, {}]);
      const routed = [];
      fn({ colors, fixtureCount: 6, step, hue: 60, phase: .37, dynamics, twinkle: new Array(6).fill(0),
        xs, write: (k, c, d) => { routed[order[k]] = [c, d]; } });
      assert.deepStrictEqual(routed, run({}), `${name} at step ${step}`);
    }
  }
});

test('ensemble finds the centre of the stage, not the middle of the patch list', () => {
  // Patched stage-right to stage-left, with the middle lamp placed off-centre.
  const rig = [at(100), at(60), at(0)];
  const { order, xs } = spatialLayout(rig);
  assert.deepStrictEqual(order, [2, 1, 0]);
  assert.deepStrictEqual(xs, [0, 0.6, 1]);
});

test('the rehearsal sampler travels a chase in stage order', () => {
  // Patched right-to-left: patch index 3 stands stage-left.
  const rig = [at(90), at(60), at(30), at(10)].map((f) => ({ ...f, maxBrightness: 255 }));
  const sample = createPreviewSampler([
    { timeMs: 0, action: 'patch', data: { pattern: 'chase', colorA: 1, colorB: 4, colorC: 6, colorD: 10, bpm: 60, beatDivision: 1 } },
  ]);
  const lit = [];
  for (const second of [0.5, 1.5, 2.5, 3.5]) {
    const out = sample(second * 1000, rig, COLOR_PRESETS);
    const brightness = out.map((c) => c.r + c.g + c.b + c.w + c.a);
    lit.push(brightness.indexOf(Math.max(...brightness)));
  }
  assert.deepStrictEqual(lit, [3, 2, 1, 0], 'left to right across the room');
});

test('fixtures dragged to nearly the same x are one column, walked front to back', () => {
  // A par on the front truss (y 100) with a lamp hung above it (y ~72), dragged
  // by hand so their x differ by a fraction of a percent — one way round in the
  // first column, the other way round in the second.
  const rig = [
    at(22.12, 100), at(21.97, 72),   // column 1: par slightly right of its lamp
    at(58.23, 100), at(58.90, 74),   // column 2: par slightly left of its lamp
  ];
  assert.deepStrictEqual(spatialLayout(rig).order, [0, 1, 2, 3], 'front then back, in both columns');
});

test('the normalised span uses the true extremes even when a column is reordered', () => {
  const { xs } = spatialLayout([at(10.5, 100), at(10, 50), at(90, 100)]);
  // Order is [0 (front), 1 (back), 2]; x 10 is the leftmost, so it maps to 0.
  assert.deepStrictEqual(xs.map((x) => +x.toFixed(4)), [0.0063, 0, 1]);
});

// ── Split looks ──────────────────────────────────────────────────────────────
import { washFixtures } from '../../src/shared/stage.js';

test('a split picks its wash group from the groups the rig actually uses', () => {
  const rig = [{ group: 'front' }, { group: 'back' }, { group: 'front' }, {}, { group: 'back' }];
  assert.deepStrictEqual([...washFixtures(rig, 0)], [0, 2], 'seed 0: the first group in use');
  assert.deepStrictEqual([...washFixtures(rig, 1)], [1, 4], 'seed 1: the next');
  assert.deepStrictEqual([...washFixtures(rig, 2)], [0, 2], 'and round again');
});

test('with fewer than two groups in use there is nothing to split', () => {
  assert.strictEqual(washFixtures([{ group: 'front' }, {}, { group: 'front' }], 3).size, 0);
  assert.strictEqual(washFixtures([{}, {}], 0).size, 0);
  assert.strictEqual(washFixtures([{ group: 'front' }, { group: 'back' }], null).size, 0, 'no split asked for');
});
