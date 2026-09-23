// Panels: a profile's cells in rows and columns, laid on the stage plot as a
// rectangle that turns and stretches as a bar's line does.

import test from 'node:test';
import assert from 'node:assert';

import { buildRig, gridOf } from '../../src/shared/rig.ts';
import { profileSchema, validate } from '../../src/server/validation.ts';

/** A panel of `columns` × `rows` RGB cells, listed row by row unless `at` places them. */
function panel(columns, rows, at) {
  const n = columns * rows;
  return {
    id: `panel-${columns}x${rows}`, name: 'Panel', channelCount: n * 3, channelMap: {},
    grid: { columns, rows },
    cells: Array.from({ length: n }, (_, c) => ({
      channelMap: { red: 3 * c, green: 3 * c + 1, blue: 3 * c + 2 },
      ...(at ? { at: at(c) } : {}),
    })),
  };
}

const fixture = (geometry, position = { x: 50, y: 50 }) => ({ id: 0, profileId: 'p', position, geometry, group: null });
const near = (a, b) => Math.abs(a - b) < 1e-9;
const pointsOf = (rig) => rig.points.map((p) => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]);

test('a panel is a rectangle of square cells, its columns along its line and its rows below', () => {
  const rig = buildRig([fixture({ length: 20, angle: 0 })], () => panel(4, 2));
  assert.deepStrictEqual(rig.grids, [{ columns: 4, rows: 2 }]);
  // 20 wide, so 10 deep; cells 5 apart each way, centred on 50, 50.
  assert.deepStrictEqual(pointsOf(rig), [
    [42.5, 47.5], [47.5, 47.5], [52.5, 47.5], [57.5, 47.5],
    [42.5, 52.5], [47.5, 52.5], [52.5, 52.5], [57.5, 52.5],
  ]);
  assert.deepStrictEqual(rig.local.map((v) => Math.round(v * 3)), [0, 1, 2, 3, 0, 1, 2, 3]);
  assert.deepStrictEqual(rig.localY, [0, 0, 0, 0, 1, 1, 1, 1]);
});

test('a panel turns about its centre', () => {
  const rig = buildRig([fixture({ length: 20, angle: 90 })], () => panel(4, 2));
  // Its columns now run down the plot, and its rows step to the left of them.
  assert.deepStrictEqual(pointsOf(rig).slice(0, 4), [[52.5, 42.5], [52.5, 47.5], [52.5, 52.5], [52.5, 57.5]]);
  assert.deepStrictEqual(pointsOf(rig)[4], [47.5, 42.5]);
});

test('cells go where `at` puts them, whatever order they are listed in', () => {
  // Wired as a serpentine: the second row runs back from right to left.
  const snake = (c) => (c < 3 ? { x: c, y: 0 } : { x: 5 - c, y: 1 });
  const rig = buildRig([fixture({ length: 30, angle: 0 })], () => panel(3, 2, snake));
  assert.deepStrictEqual(pointsOf(rig).slice(3), [[60, 55], [50, 55], [40, 55]]);
  assert.deepStrictEqual(gridOf(panel(3, 2, snake)).at[5], { x: 0, y: 1 });
});

test('each panel draws the whole picture across and down itself', () => {
  const rig = buildRig([fixture({ length: 20, angle: 0 })], () => panel(2, 2));
  const layout = rig.layout(null, 'bar');
  // Column by column, top to bottom within each.
  assert.deepStrictEqual(layout.units.list, [0, 2, 1, 3]);
  assert.deepStrictEqual(layout.units.xs, [0, 0, 1, 1]);
  assert.deepStrictEqual(layout.units.ys, [0, 1, 0, 1]);
});

test('a bar is a line as it always was', () => {
  const bar = { ...panel(4, 1), grid: undefined };
  const rig = buildRig([fixture({ length: 20, angle: 0 })], () => bar);
  assert.deepStrictEqual(rig.grids, [null]);
  assert.ok(rig.localY.every((y) => y === 0.5));
  assert.ok(rig.points.every((p) => near(p.y, 50)));
});

test('a grid holds every cell, each in a place of its own', () => {
  validate(profileSchema, panel(4, 2), 'profile');
  validate(profileSchema, panel(3, 2, (c) => (c < 3 ? { x: c, y: 0 } : { x: 5 - c, y: 1 })), 'profile');
  assert.throws(() => validate(profileSchema, { ...panel(4, 2), grid: { columns: 3, rows: 2 } }, 'profile'),
    /cells\.6 sits at column 1, row 3, outside the 3 × 2 grid/);
  assert.throws(() => validate(profileSchema, panel(2, 2, () => ({ x: 1, y: 1 })), 'profile'), /cells\.1 sits where cell 1 does/);
  assert.throws(() => validate(profileSchema, { ...panel(2, 2, (c) => ({ x: c % 2, y: 0 })), grid: undefined }, 'profile'),
    /places cells in a grid but has no grid/);
  assert.throws(() => validate(profileSchema, { id: 'x', name: 'X', channelCount: 3, channelMap: { red: 0 }, grid: { columns: 2, rows: 2 } }, 'profile'),
    /is a grid of cells, but the profile has none/);
});
