'use strict';

const { isPlaced, stagePositions, spatialLayout, washFixtures } = require('./stage');

/**
 * The rig as the pattern layer sees it: fixtures, and the cells inside them.
 *
 * A par is one light. An LED bar is eight or sixteen, each with its own red,
 * green and blue channels, and a look only uses a bar properly when every one
 * of them can be a different colour. A profile says so with `cells`: one
 * channel map per cell, in the order the cells sit along the bar, beside the
 * fixture-level `channelMap` that keeps the channels the whole bar shares (a
 * master dimmer, a strobe). A profile without `cells` is one cell — its
 * channel map is the fixture's — which is every profile that existed before.
 *
 * Browser-safe: the server's engine and the rehearsal preview in the browser
 * both build their picture of the rig from here.
 */

// The channels that make light. A cell is only a cell if it has one of them.
const EMITTERS = ['red', 'green', 'blue', 'white', 'amber', 'uv', 'warmWhite', 'coolWhite'];

// How a pixel effect is laid over the cells: across the whole stage, along each
// bar on its own, or mirrored about the centre of the stage.
const PIXEL_MAPS = ['stage', 'bar', 'mirror'];

// A universe holds 170 three-channel cells; no single fixture has more.
const MAX_CELLS_PER_FIXTURE = 170;

/** The profile's cells, or null for a fixture that is one light. */
function cellsOf(profile) {
  const cells = profile && profile.cells;
  return Array.isArray(cells) && cells.length >= 2 ? cells : null;
}

/** How many lights a fixture on this profile is: its cells, or one. */
function unitCount(profile) {
  const cells = cellsOf(profile);
  return cells ? cells.length : 1;
}

/** How many lights a patch is in total. */
function countUnits(fixtures, profileOf) {
  let total = 0;
  for (const fixture of fixtures) total += unitCount(profileOf(fixture));
  return total;
}

// ── Where every light is ─────────────────────────────────────────────────────

/**
 * A bar's line on the stage plot: its own geometry, or a default that grows
 * with the number of cells — and, for a bar nobody has placed, stays short
 * enough not to run into its neighbours in the default spread.
 */
function lineOf(fixture, cells, unplaced) {
  const g = fixture.geometry;
  if (g && Number.isFinite(g.length) && Number.isFinite(g.angle)) return { length: g.length, angle: g.angle };
  let length = Math.max(8, Math.min(25, 1.5 * cells));
  if (unplaced) length = Math.min(length, (0.9 * 100) / (unplaced + 1));
  return { length, angle: 0 };
}

/**
 * The rig as lights: one unit per par, one per cell of a bar.
 *
 *   units[u]   — { fixture, cell }: patch order, and a bar's cells in the order
 *                its profile lists them
 *   ranges[i]  — { start, count }: fixture i's units
 *   cellMaps[i]— the channel map of each of fixture i's cells, or null
 *   points[u]  — where the unit is on the stage plot, in stage percent
 *   local[u]   — 0…1 along its own bar, left to right on the plot (0.5 for a
 *                par)
 *   hasPixels  — is any fixture more than one light
 *
 * A rig of pars has exactly one unit per fixture, at the same index, so
 * everything built on units is what it was built on fixtures before bars.
 */
function buildRig(fixtures, profileOf) {
  const centres = stagePositions(fixtures);
  const unplaced = fixtures.filter((f) => !isPlaced(f.position)).length;
  const units = [];
  const ranges = [];
  const cellMaps = [];
  const points = [];
  const local = [];
  let hasPixels = false;

  fixtures.forEach((fixture, i) => {
    const start = units.length;
    const cells = cellsOf(profileOf(fixture));
    if (!cells) {
      units.push({ fixture: i, cell: 0 });
      points.push(centres[i]);
      local.push(0.5);
      ranges.push({ start, count: 1 });
      cellMaps.push(null);
      return;
    }
    hasPixels = true;
    const n = cells.length;
    const { length, angle } = lineOf(fixture, n, isPlaced(fixture.position) ? 0 : unplaced);
    const cos = Math.cos((angle * Math.PI) / 180);
    const sin = Math.sin((angle * Math.PI) / 180);
    // Along the bar reads left to right on the plot; a bar standing upright
    // reads from the back of the stage to the front.
    const forward = Math.abs(cos) > 1e-9 ? cos > 0 : sin > 0;
    for (let c = 0; c < n; c++) {
      const t = (c + 0.5) / n - 0.5;
      units.push({ fixture: i, cell: c });
      points.push({ x: centres[i].x + t * length * cos, y: centres[i].y + t * length * sin });
      const along = n > 1 ? c / (n - 1) : 0.5;
      local.push(forward ? along : 1 - along);
    }
    ranges.push({ start, count: n });
    cellMaps.push(cells.map((cell) => cell.channelMap));
  });

  const layouts = new Map();
  return {
    fixtures, units, ranges, cellMaps, points, local, hasPixels,
    /** The travel order for a look, cached per split and pixel map. */
    layout(split = null, pixelMap = 'stage') {
      const key = `${split}|${hasPixels ? pixelMap : ''}`;
      if (!layouts.has(key)) layouts.set(key, layoutOf(this, split, pixelMap));
      return layouts.get(key);
    },
  };
}

/**
 * The order the patterns travel in, for fixtures and for units.
 *
 *   wash      — the fixtures holding the split look's wash (patch indices)
 *   fixtures  — { members, order, xs }: exactly today's stage order among the
 *               fixtures not holding the wash; slot k is members[order[k]]
 *   units     — { list, xs, ys }: every unit of those fixtures, in the same
 *               stage order with a bar's cells left to right, and where each
 *               sits across the rig (ys on the same scale, so a ring drawn
 *               from them is round)
 *
 * With no bars in the rig, units are the fixtures and xs is the fixtures' own:
 * byte for byte what the patterns got before.
 */
function layoutOf(rig, split, pixelMap) {
  const { fixtures, ranges, points, local } = rig;
  const wash = washFixtures(fixtures, split);
  const members = fixtures.map((_, i) => i).filter((i) => !wash.has(i));
  const { order, xs } = spatialLayout(members.map((i) => fixtures[i]));
  const layout = { wash, fixtures: { members, order, xs } };

  if (!rig.hasPixels) {
    layout.units = { list: order.map((k) => ranges[members[k]].start), xs, ys: null };
    return layout;
  }

  const list = [];
  for (const k of order) {
    const { start, count } = ranges[members[k]];
    const cells = [];
    for (let u = start; u < start + count; u++) cells.push(u);
    cells.sort((a, b) => points[a].x - points[b].x || a - b);
    list.push(...cells);
  }

  let unitXs = null;
  let unitYs = null;
  if (list.length) {
    let lo = Infinity; let hi = -Infinity; let top = Infinity; let bottom = -Infinity;
    for (const u of list) {
      lo = Math.min(lo, points[u].x); hi = Math.max(hi, points[u].x);
      top = Math.min(top, points[u].y); bottom = Math.max(bottom, points[u].y);
    }
    const span = hi - lo;
    if (span > 1e-6) {
      const mid = (top + bottom) / 2;
      unitXs = list.map((u) => (points[u].x - lo) / span);
      unitYs = list.map((u) => (points[u].y - mid) / span + 0.5);
    }
  }

  if (pixelMap === 'bar') {
    unitXs = list.map((u) => local[u]);
    unitYs = list.map(() => 0.5);
  } else if (pixelMap === 'mirror') {
    const n = list.length;
    const base = unitXs || list.map((_, k) => (n > 1 ? k / (n - 1) : 0.5));
    unitXs = base.map((x) => Math.abs(2 * x - 1));
  }
  layout.units = { list, xs: unitXs, ys: unitYs };
  return layout;
}

module.exports = {
  EMITTERS,
  PIXEL_MAPS,
  MAX_CELLS_PER_FIXTURE,
  cellsOf,
  unitCount,
  countUnits,
  lineOf,
  buildRig,
};
