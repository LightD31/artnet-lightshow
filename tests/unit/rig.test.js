// The rig as lights: a par is one, each cell of an LED bar another. What the
// pattern layer sees, and so the order every pattern travels in.

import test from 'node:test';
import assert from 'node:assert';
import { buildRig, lineOf } from '../../src/shared/rig.ts';
import { spatialLayout } from '../../src/shared/stage.ts';

const bar = (n) => ({ cells: Array.from({ length: n }, (_, i) => ({ channelMap: { red: i * 3, green: i * 3 + 1, blue: i * 3 + 2 } })) });
const profiles = { bar4: bar(4), bar8: bar(8) };
const profileOf = (f) => profiles[f.profileId] || null;

test('a rig of pars is one light per fixture, in the order it always was', () => {
  const fixtures = [{ position: { x: 80, y: 20 } }, { position: { x: 10, y: 50 } }, { position: { x: 45, y: 40 } }];
  const rig = buildRig(fixtures, () => null);
  assert.strictEqual(rig.hasPixels, false);
  assert.deepStrictEqual(rig.units.map((u) => u.fixture), [0, 1, 2]);
  const { order, xs } = spatialLayout(fixtures);
  const layout = rig.layout(null, 'mirror');
  assert.deepStrictEqual(layout.units.list, order, 'units travel exactly as fixtures did');
  assert.deepStrictEqual(layout.units.xs, xs);
  assert.strictEqual(layout.units.ys, null);
  assert.deepStrictEqual(rig.layout(null, 'bar'), layout, 'a pixel map means nothing without pixels');
});

test('a bar is its cells, spread along its line, in profile order', () => {
  const rig = buildRig([{ profileId: 'par' }, { profileId: 'bar4' }, { profileId: 'par' }], profileOf);
  assert.strictEqual(rig.hasPixels, true);
  assert.deepStrictEqual(rig.ranges, [{ start: 0, count: 1 }, { start: 1, count: 4 }, { start: 5, count: 1 }]);
  assert.deepStrictEqual(rig.units.slice(1, 5).map((u) => u.cell), [0, 1, 2, 3]);
  const xs = rig.points.slice(1, 5).map((p) => p.x);
  assert.ok(xs.every((x, i) => i === 0 || x > xs[i - 1]), `left to right: ${xs}`);
  assert.ok(xs[0] > rig.points[0].x && xs[3] < rig.points[5].x, 'between its neighbours in the default spread');
  assert.deepStrictEqual(rig.layout().units.list, [0, 1, 2, 3, 4, 5], 'a chase of cells walks the stage');
  assert.strictEqual(rig.cellMaps[1].length, 4);
  assert.strictEqual(rig.cellMaps[0], null);
});

test('a bar turned round travels the other way across the stage', () => {
  const placed = { position: { x: 50, y: 50 } };
  const forward = buildRig([{ ...placed, profileId: 'bar4', geometry: { length: 20, angle: 0 } }], profileOf);
  const reversed = buildRig([{ ...placed, profileId: 'bar4', geometry: { length: 20, angle: 180 } }], profileOf);
  assert.deepStrictEqual(forward.layout().units.list, [0, 1, 2, 3]);
  assert.deepStrictEqual(reversed.layout().units.list, [3, 2, 1, 0], 'cell 4 is now at stage left');
  const expected = [1, 2 / 3, 1 / 3, 0];
  assert.ok(reversed.local.every((v, i) => Math.abs(v - expected[i]) < 1e-9), 'and along the bar reads from stage left too');
  const upright = buildRig([{ ...placed, profileId: 'bar4', geometry: { length: 20, angle: 90 } }], profileOf);
  assert.strictEqual(upright.layout().units.xs, null, 'no width to travel across');
  assert.ok(Math.abs(upright.points[3].y - upright.points[0].y - 15) < 1e-9, 'it runs back to front');
});

test('each pixel map lays the effect over the cells its own way', () => {
  const fixtures = [
    { profileId: 'bar4', position: { x: 20, y: 50 }, geometry: { length: 20, angle: 0 } },
    { profileId: 'bar4', position: { x: 80, y: 50 }, geometry: { length: 20, angle: 0 } },
  ];
  const rig = buildRig(fixtures, profileOf);
  const stage = rig.layout(null, 'stage').units;
  assert.strictEqual(stage.xs[0], 0);
  assert.strictEqual(stage.xs[7], 1);
  assert.ok(stage.ys.every((y) => y === 0.5), 'one row, centred');
  const perBar = rig.layout(null, 'bar').units;
  assert.deepStrictEqual(perBar.xs, [0, 1 / 3, 2 / 3, 1, 0, 1 / 3, 2 / 3, 1], 'each bar on its own');
  const mirror = rig.layout(null, 'mirror').units;
  assert.ok(Math.abs(mirror.xs[0] - 1) < 1e-9 && Math.abs(mirror.xs[7] - 1) < 1e-9, 'both ends are the edge');
  assert.ok(Math.abs(mirror.xs[3] - mirror.xs[4]) < 1e-9, 'the two halves meet in the middle');
  assert.strictEqual(Math.min(...mirror.xs), mirror.xs[3], 'which is as far from the edge as it gets');
});

test('a split look\'s wash takes a whole bar out of the travel', () => {
  const fixtures = [
    { profileId: 'bar4', group: 'front' }, { profileId: 'par', group: 'back' }, { profileId: 'par', group: 'front' },
  ];
  const rig = buildRig(fixtures, profileOf);
  const layout = rig.layout(1, 'stage');           // seed 1 of [front, back] → back holds the wash
  assert.deepStrictEqual([...layout.wash], [1]);
  assert.deepStrictEqual(layout.units.list, [0, 1, 2, 3, 5]);
  assert.deepStrictEqual(layout.fixtures.members, [0, 2]);
});

test('a bar nobody has placed keeps out of its neighbours\' way', () => {
  assert.deepStrictEqual(lineOf({}, 16, 0), { length: 24, angle: 0 });
  assert.deepStrictEqual(lineOf({}, 4, 0), { length: 8, angle: 0 }, 'never shorter than 8');
  assert.deepStrictEqual(lineOf({}, 60, 0), { length: 25, angle: 0 }, 'never longer than 25');
  assert.ok(lineOf({}, 16, 8).length < 100 / 9, 'shorter than the gap in the default spread');
  assert.deepStrictEqual(lineOf({ geometry: { length: 40, angle: 30 } }, 16, 8), { length: 40, angle: 30 });
});
