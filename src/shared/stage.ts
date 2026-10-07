/**
 * Where the fixtures stand, and the order the patterns travel across them.
 *
 * Every pattern writes to slots 0…n−1 and used to reach the fixture at that
 * index in the patch — so a chase ran in the order lamps were *patched*, which
 * matches the room only if someone patched them left to right. On a rig of pars
 * along a truss plus Hue lamps around the room, it did not: the chase jumped
 * from the back corner to the far side and back. The operator places fixtures
 * on the stage plot, and that placement is what decides the order now.
 *
 * Shared by the engine, the browser's rehearsal sampler and the stage plot
 * itself, so the picture the operator arranges is the order the rig runs in —
 * three copies of the default spread would be three chances to disagree.
 */

import type { Point, StageFixture } from '../types/rig.ts';

const isPlaced = (p: Point | null | undefined): p is Point => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

// How close two fixtures' x positions must be, in percent of the stage width,
// to count as one column. A few percent is the precision of a drag on the plot.
const COLUMN_TOLERANCE = 3;

/**
 * Where a never-placed fixture sits: spread evenly across the stage among the
 * *other unplaced* fixtures, at a nominal depth.
 */
function defaultPosition(k: number, unplaced: number): Point {
  return { x: 100 * (k + 1) / (unplaced + 1), y: 35 };
}

/** Every fixture's position, stored or default, in patch order. */
function stagePositions(fixtures: readonly StageFixture[]): Point[] {
  const unplaced = fixtures.filter((f) => !isPlaced(f.position));
  return fixtures.map((f) => (isPlaced(f.position)
    ? f.position
    : defaultPosition(unplaced.indexOf(f), unplaced.length)));
}

/**
 * The order patterns travel in, and where each slot sits across the rig.
 *
 *   order[k] — the patch index of the k-th fixture from stage left
 *   xs[k]    — that fixture's position across the rig's own span, 0…1, for the
 *              patterns that move continuously; null to use even spacing
 *
 * Left to right; front before back where two share a column; patch order last,
 * so the result is stable from frame to frame.
 *
 * A rig with nothing placed gets the identity order and no `xs`, which is
 * byte-for-byte what every pattern did before positions existed. That is a
 * guarantee rather than a coincidence of the default spread — rounding in
 * normalised positions could otherwise move a DMX value by one.
 */
/** The order patterns travel in, and where each slot sits across the rig. */
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

  // Fixtures dragged to roughly the same x are one column — a par on the front
  // truss and the lamp hung above it — and a column is walked front to back.
  // Ordering on raw x instead let a fraction of a percent decide, so the chase
  // went back-then-front in one column and front-then-back in the next.
  const order: number[] = [];
  for (let i = 0; i < byX.length;) {
    let j = i + 1;
    while (j < byX.length && pos[byX[j]].x - pos[byX[i]].x <= COLUMN_TOLERANCE) j++;
    order.push(...byX.slice(i, j).sort((a, b) => pos[b].y - pos[a].y || a - b));
    i = j;
  }
  // The span comes from the x-sorted list: inside a column the order is by
  // depth, so the first and last in `order` need not be the extremes.
  const lo = pos[byX[0]].x;
  const hi = pos[byX[n - 1]].x;
  // A rig placed in one column has no width to travel across; even spacing is
  // the only order that still moves.
  const xs = hi - lo > 1e-6 ? order.map((i) => (pos[i].x - lo) / (hi - lo)) : null;
  return { order, xs };
}

// ── Groups ───────────────────────────────────────────────────────────────────
// Where a fixture hangs, from a fixed set so the show and the operator mean the
// same thing by each name. Ungrouped fixtures are simply part of the rig.
const FIXTURE_GROUPS = ['front', 'back', 'room', 'floor'] as const;

/**
 * Which fixtures hold the wash when the show splits a look.
 *
 * A split look has one group holding a steady wash in the contrast colour
 * while everything else runs the pattern — two layers rather than one look on
 * every lamp. The show plans without knowing the rig, so it asks for a split
 * with a seed and this picks the group from the ones actually in use. Fewer
 * than two groups in use means there is nothing to split between, and the
 * whole rig runs the pattern exactly as it would unsplit.
 *
 * @returns {Set<number>} patch indices of the wash fixtures (empty: no split)
 */
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
