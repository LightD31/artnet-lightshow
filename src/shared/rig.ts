import { isPlaced, stagePositions, spatialLayout, washFixtures } from './stage.ts';
import type { ChannelMap, Geometry, Grid, GridPoint, PixelMap, Point, Profile, ProfileCell, StageFixture } from '../types/rig.ts';

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
const PIXEL_MAPS = ['stage', 'bar', 'mirror'] as const;

// The most cells one fixture has: a 4,096-pixel strip, or a 64 × 64 panel. A
// strip longer than a universe runs on into the next (shared/placement.ts).
// The patch as a whole still renders at most MAX_UNITS (server/profiles.ts),
// so a 64 × 32 WLED matrix leaves half of that for the rest of the rig.
const MAX_CELLS_PER_FIXTURE = 4096;

// The longest profile: 4,096 RGBW pixels, 32 universes.
const MAX_PROFILE_CHANNELS = 16384;

/** One light: a par, or one cell of a bar. */
export interface Unit {
  /** The fixture's index in the patch. */
  fixture: number;
  /** Which of its cells (0 for a par). */
  cell: number;
}

/** A fixture's units: `count` of them from `start`. */
export interface UnitRange {
  start: number;
  count: number;
}

/** The order the patterns travel in, for fixtures and for units (see layoutOf). */
export interface Layout {
  wash: Set<number>;
  /**
   * `folded`, when the look is mirrored: the slots a stepped pattern travels
   * through, each one or two fixtures standing symmetrically about the
   * centre of the stage, from the middle out (members indices).
   */
  fixtures: { members: number[]; order: number[]; xs: number[] | null; folded?: number[][] };
  units: { list: number[]; xs: number[] | null; ys: number[] | null };
}

/** The rig as lights (see buildRig). */
export interface Rig<F extends StageFixture = StageFixture> {
  fixtures: readonly F[];
  units: Unit[];
  ranges: UnitRange[];
  cellMaps: (ChannelMap[] | null)[];
  points: Point[];
  local: number[];
  localY: number[];
  grids: (Grid | null)[];
  hasPixels: boolean;
  /** Does the rig have fixtures that are one light, beside any bars. */
  hasPars: boolean;
  layout(split?: number | null, pixelMap?: PixelMap | string | null, only?: LayerPart | null): Layout;
}

/**
 * Which fixtures a layout covers: every one, only those that are one light
 * (the pars), or only those with cells (the bars). A look that gives the bars
 * a picture of their own draws the two parts apart (shared/layer.ts).
 */
export type LayerPart = 'pars' | 'cells';

/** The profile a fixture runs, or nothing when it has none. */
export type ProfileLookup<F> = (fixture: F) => Pick<Profile, 'cells' | 'grid'> | null | undefined;

/** The profile's cells, or null for a fixture that is one light. */
function cellsOf(profile: Pick<Profile, 'cells'> | null | undefined): ProfileCell[] | null {
  const cells = profile && profile.cells;
  return Array.isArray(cells) && cells.length >= 2 ? cells : null;
}

/**
 * A panel's grid and where each of its cells is in it: a cell's own `at`, or
 * row by row in the order the cells are listed. Null for a profile that is
 * not a panel.
 */
function gridOf(profile: Pick<Profile, 'cells' | 'grid'> | null | undefined): (Grid & { at: GridPoint[] }) | null {
  const cells = cellsOf(profile);
  const grid = profile && profile.grid;
  if (!cells || !grid || !(grid.columns >= 1) || !(grid.rows >= 1)) return null;
  return {
    columns: grid.columns,
    rows: grid.rows,
    at: cells.map((cell, c) => cell.at || { x: c % grid.columns, y: Math.floor(c / grid.columns) }),
  };
}

/** How many lights a fixture on this profile is: its cells, or one. */
function unitCount(profile: Pick<Profile, 'cells'> | null | undefined): number {
  const cells = cellsOf(profile);
  return cells ? cells.length : 1;
}

/** How many lights a patch is in total. */
function countUnits<F>(fixtures: Iterable<F>, profileOf: ProfileLookup<F>): number {
  let total = 0;
  for (const fixture of fixtures) total += unitCount(profileOf(fixture));
  return total;
}

// ── Where every light is ─────────────────────────────────────────────────────

/**
 * A bar's line on the stage plot: its own geometry, or a default that grows
 * with the number of cells (a panel's columns) — and, for a bar nobody has
 * placed, stays short enough not to run into its neighbours in the default
 * spread. A panel's line is its top edge; its rows run down from it.
 */
function lineOf(fixture: StageFixture, cells: number, unplaced: number): Geometry {
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
function buildRig<F extends StageFixture>(fixtures: readonly F[], profileOf: ProfileLookup<F>): Rig<F> {
  const centres = stagePositions(fixtures);
  const unplaced = fixtures.filter((f) => !isPlaced(f.position)).length;
  const units: Unit[] = [];
  const ranges: UnitRange[] = [];
  const cellMaps: (ChannelMap[] | null)[] = [];
  const points: Point[] = [];
  const local: number[] = [];
  const localY: number[] = [];
  const grids: (Grid | null)[] = [];
  let hasPixels = false;
  let hasPars = false;

  fixtures.forEach((fixture, i) => {
    const start = units.length;
    const profile = profileOf(fixture);
    const cells = cellsOf(profile);
    if (!cells) {
      hasPars = true;
      units.push({ fixture: i, cell: 0 });
      points.push(centres[i]);
      local.push(0.5);
      localY.push(0.5);
      ranges.push({ start, count: 1 });
      cellMaps.push(null);
      grids.push(null);
      return;
    }
    hasPixels = true;
    const n = cells.length;
    const grid = gridOf(profile);
    const { length, angle } = lineOf(fixture, grid ? grid.columns : n, isPlaced(fixture.position) ? 0 : unplaced);
    const cos = Math.cos((angle * Math.PI) / 180);
    const sin = Math.sin((angle * Math.PI) / 180);
    // Along the bar reads left to right on the plot; a bar standing upright
    // reads from the back of the stage to the front.
    const forward = Math.abs(cos) > 1e-9 ? cos > 0 : sin > 0;
    if (grid) {
      // A panel: a rectangle of square cells centred on its position, its
      // columns along the line and its rows at right angles to it.
      const height = (length * grid.rows) / grid.columns;
      for (let c = 0; c < n; c++) {
        const { x, y } = grid.at[c];
        const u = (x + 0.5) / grid.columns - 0.5;
        const v = (y + 0.5) / grid.rows - 0.5;
        units.push({ fixture: i, cell: c });
        points.push({ x: centres[i].x + u * length * cos - v * height * sin, y: centres[i].y + u * length * sin + v * height * cos });
        const across = grid.columns > 1 ? x / (grid.columns - 1) : 0.5;
        local.push(forward ? across : 1 - across);
        localY.push(grid.rows > 1 ? y / (grid.rows - 1) : 0.5);
      }
    } else {
      for (let c = 0; c < n; c++) {
        const t = (c + 0.5) / n - 0.5;
        units.push({ fixture: i, cell: c });
        points.push({ x: centres[i].x + t * length * cos, y: centres[i].y + t * length * sin });
        const along = n > 1 ? c / (n - 1) : 0.5;
        local.push(forward ? along : 1 - along);
        localY.push(0.5);
      }
    }
    ranges.push({ start, count: n });
    cellMaps.push(cells.map((cell) => cell.channelMap));
    grids.push(grid ? { columns: grid.columns, rows: grid.rows } : null);
  });

  const layouts = new Map<string, Layout>();
  return {
    fixtures, units, ranges, cellMaps, points, local, localY, grids, hasPixels, hasPars,
    /** The travel order for a look, cached per split, pixel map and part. */
    layout(split = null, pixelMap = 'stage', only = null) {
      const key = `${split}|${pixelMap}|${only || ''}`;
      let layout = layouts.get(key);
      if (!layout) {
        layout = layoutOf(this, split, pixelMap, only);
        layouts.set(key, layout);
      }
      return layout;
    },
  };
}

/**
 * A short key for everything a rig built by buildRig depends on: which
 * profile each fixture runs (and `revision`, which changes whenever a profile
 * does), where it stands, its group and its line. Two patches with the same
 * key build the same rig, so a cache can compare this once a frame instead of
 * relying on every edit to announce itself.
 */
function rigSignature(fixtures: readonly StageFixture[], revision: number | string = 0): string {
  let key = `${revision}|${fixtures.length}`;
  for (const f of fixtures) {
    const p = f.position;
    const g = f.geometry;
    key += `|${f.profileId};${p ? `${p.x},${p.y}` : ''};${f.group || ''};${g ? `${g.length},${g.angle}` : ''}`;
  }
  return key;
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
function layoutOf(rig: Rig, split: number | null | undefined, pixelMap: string | null | undefined,
  only: LayerPart | null = null): Layout {
  const { fixtures, ranges, points, local, localY } = rig;
  const wash = washFixtures(fixtures, split);
  const part = (i: number) => !only || (only === 'cells') === !!rig.cellMaps[i];
  const members = fixtures.map((_, i) => i).filter((i) => !wash.has(i) && part(i));
  const { order, xs } = spatialLayout(members.map((i) => fixtures[i]));
  const layoutFixtures: Layout['fixtures'] = { members, order, xs };
  if (pixelMap === 'mirror' && members.length >= 3) {
    // Folded about the centre: the two lamps either side of the middle are
    // one slot, the next pair out the next, so a chase runs from the middle
    // to both ends at once and a stack builds out from the centre. With an
    // odd count the middle lamp is a slot of its own.
    const n = order.length;
    const folded: number[][] = [];
    for (let k = 0; k < Math.ceil(n / 2); k++) {
      const left = Math.floor((n - 1) / 2) - k;
      const right = Math.ceil((n - 1) / 2) + k;
      folded.push(left === right ? [order[left]] : [order[left], order[right]]);
    }
    layoutFixtures.folded = folded;
  }

  if (!rig.hasPixels) {
    const list = order.map((k) => ranges[members[k]].start);
    // A picture laid mirrored on a rig of pars is drawn out from the centre,
    // as it is across bars.
    const unitXs = pixelMap === 'mirror' && list.length >= 3
      ? (xs || list.map((_, k) => k / (list.length - 1))).map((x) => Math.abs(2 * x - 1))
      : xs;
    return { wash, fixtures: layoutFixtures, units: { list, xs: unitXs, ys: null } };
  }

  const list: number[] = [];
  for (const k of order) {
    const { start, count } = ranges[members[k]];
    const cells: number[] = [];
    for (let u = start; u < start + count; u++) cells.push(u);
    // A panel's column is a tie across: its cells go top to bottom.
    if (rig.grids[members[k]]) cells.sort((a, b) => points[a].x - points[b].x || points[a].y - points[b].y || a - b);
    else cells.sort((a, b) => points[a].x - points[b].x || a - b);
    list.push(...cells);
  }

  let unitXs: number[] | null = null;
  let unitYs: number[] | null = null;
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
    // Each fixture draws the whole picture itself: along a bar, and across and
    // down a panel.
    unitXs = list.map((u) => local[u]);
    unitYs = list.map((u) => localY[u]);
  } else if (pixelMap === 'mirror') {
    const n = list.length;
    const base = unitXs || list.map((_, k) => (n > 1 ? k / (n - 1) : 0.5));
    unitXs = base.map((x) => Math.abs(2 * x - 1));
  }
  return { wash, fixtures: layoutFixtures, units: { list, xs: unitXs, ys: unitYs } };
}

export {
  EMITTERS,
  PIXEL_MAPS,
  MAX_CELLS_PER_FIXTURE,
  MAX_PROFILE_CHANNELS,
  cellsOf,
  gridOf,
  unitCount,
  countUnits,
  lineOf,
  buildRig,
  rigSignature,
};
