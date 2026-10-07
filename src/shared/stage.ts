import type { Point, StageFixture } from '../types/rig.ts';

const isPlaced = (p: Point | null | undefined): p is Point => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

// Group nearby x coordinates so imprecise drags still form one front-to-back column.
const COLUMN_TOLERANCE = 3;

function defaultPosition(k: number, unplaced: number): Point {
  return { x: 100 * (k + 1) / (unplaced + 1), y: 35 };
}

function stagePositions(fixtures: readonly StageFixture[]): Point[] {
  const unplaced = fixtures.filter((f) => !isPlaced(f.position));
  return fixtures.map((f) => (isPlaced(f.position)
    ? f.position
    : defaultPosition(unplaced.indexOf(f), unplaced.length)));
}

export interface SpatialLayout {
  order: number[];
  xs: number[] | null;
}

function spatialLayout(fixtures: readonly StageFixture[]): SpatialLayout {
  const n = fixtures.length;
  if (!fixtures.some((f) => isPlaced(f.position))) {
    return { order: fixtures.map((_, i) => i), xs: null };
  }
  const pos = stagePositions(fixtures);
  const byX = fixtures.map((_, i) => i).sort((a, b) => pos[a].x - pos[b].x || a - b);

  // Sort within columns by depth so drag noise cannot reverse their travel order.
  const order: number[] = [];
  for (let i = 0; i < byX.length;) {
    let j = i + 1;
    while (j < byX.length && pos[byX[j]].x - pos[byX[i]].x <= COLUMN_TOLERANCE) j++;
    order.push(...byX.slice(i, j).sort((a, b) => pos[b].y - pos[a].y || a - b));
    i = j;
  }
  // Read extremes from x order because depth ordering can put interior fixtures at either end.
  const lo = pos[byX[0]].x;
  const hi = pos[byX[n - 1]].x;
  // Use even spacing when the rig has no width so the pattern still travels.
  const xs = hi - lo > 1e-6 ? order.map((i) => (pos[i].x - lo) / (hi - lo)) : null;
  return { order, xs };
}

const FIXTURE_GROUPS = ['front', 'back', 'room', 'floor'] as const;

/** @returns {Set<number>} patch indices of wash fixtures (empty when unsplit). */
function washFixtures(fixtures: readonly StageFixture[], seed: number | null | undefined): Set<number> {
  if (seed == null) return new Set();
  const used = FIXTURE_GROUPS.filter((g) => fixtures.some((f) => f.group === g));
  if (used.length < 2) return new Set();
  const wash = used[((seed % used.length) + used.length) % used.length];
  return new Set(fixtures.map((f, i) => (f.group === wash ? i : -1)).filter((i) => i >= 0));
}

export {
  isPlaced,
  defaultPosition,
  stagePositions,
  spatialLayout,
  FIXTURE_GROUPS,
  washFixtures,
};
