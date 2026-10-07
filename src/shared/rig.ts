import { isPlaced, stagePositions, spatialLayout, washFixtures } from './stage.ts';
import type { ChannelMap, Geometry, Grid, GridPoint, PixelMap, Point, Profile, ProfileCell, StageFixture } from '../types/rig.ts';


const EMITTERS = ['red', 'green', 'blue', 'white', 'amber', 'uv', 'warmWhite', 'coolWhite'];

const PIXEL_MAPS = ['stage', 'bar', 'mirror'] as const;

const MAX_CELLS_PER_FIXTURE = 4096;

const MAX_PROFILE_CHANNELS = 16384;

export interface Unit {
  fixture: number;
  cell: number;
}

export interface UnitRange {
  start: number;
  count: number;
}

// Plan coordinates use plot x/y and floor-to-ceiling z in 0..1 so effect geometry agrees with placement.
export interface StagePlan {
  x: number[];
  y: number[];
  z?: number[];
  group: (string | null)[];
}

export interface Layout {
  wash: Set<number>;
  // Folded slots pair symmetric fixtures so stepped patterns travel outward from the centre.
  fixtures: { members: number[]; order: number[]; xs: number[] | null; folded?: number[][]; plan: StagePlan | null; noFlash: boolean[] | null };
  units: { list: number[]; xs: number[] | null; ys: number[] | null; plan: StagePlan | null; noFlash: boolean[] | null };
  lamps?: LayoutLamps;
}

export interface LayoutLamps {
  slots: number[][];
  lampOf: number[];
  cellAlong: number[];
  xs: number[] | null;
  plan: StagePlan | null;
}

export interface Rig<F extends StageFixture = StageFixture> {
  fixtures: readonly F[];
  units: Unit[];
  ranges: UnitRange[];
  cellMaps: (ChannelMap[] | null)[];
  points: Point[];
  local: number[];
  localY: number[];
  grids: (Grid | null)[];
  zoned: boolean[];
  hasPixels: boolean;
  hasPars: boolean;
  hasPanels: boolean;
  layout(split?: number | null, pixelMap?: PixelMap | string | null, only?: LayerPart | null): Layout;
}

export type LayerPart = 'pars' | 'cells' | 'strips' | 'panels' | 'unpanelled';

export type ProfileLookup<F> = (fixture: F) => Pick<Profile, 'cells' | 'grid' | 'zoned'> | null | undefined;

function cellsOf(profile: Pick<Profile, 'cells'> | null | undefined): ProfileCell[] | null {
  const cells = profile && profile.cells;
  return Array.isArray(cells) && cells.length >= 2 ? cells : null;
}

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

function unitCount(profile: Pick<Profile, 'cells'> | null | undefined): number {
  const cells = cellsOf(profile);
  return cells ? cells.length : 1;
}

function countUnits<F>(fixtures: Iterable<F>, profileOf: ProfileLookup<F>): number {
  let total = 0;
  for (const fixture of fixtures) total += unitCount(profileOf(fixture));
  return total;
}


function lineOf(fixture: StageFixture, cells: number, unplaced: number): Geometry {
  const g = fixture.geometry;
  if (g && Number.isFinite(g.length) && Number.isFinite(g.angle)) return { length: g.length, angle: g.angle };
  let length = Math.max(8, Math.min(25, 1.5 * cells));
  if (unplaced) length = Math.min(length, (0.9 * 100) / (unplaced + 1));
  return { length, angle: 0 };
}

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
  const zoned: boolean[] = [];
  let hasPixels = false;
  let hasPars = false;
  let hasPanels = false;

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
      zoned.push(false);
      return;
    }
    hasPixels = true;
    const n = cells.length;
    const grid = gridOf(profile);
    const { length, angle } = lineOf(fixture, grid ? grid.columns : n, isPlaced(fixture.position) ? 0 : unplaced);
    const cos = Math.cos((angle * Math.PI) / 180);
    const sin = Math.sin((angle * Math.PI) / 180);
    const forward = Math.abs(cos) > 1e-9 ? cos > 0 : sin > 0;
    if (grid) {
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
    zoned.push(!!grid && !!(profile && profile.zoned));
    if (grid && !(profile && profile.zoned)) hasPanels = true;
  });

  const layouts = new Map<string, Layout>();
  return {
    fixtures, units, ranges, cellMaps, points, local, localY, grids, zoned, hasPixels, hasPars, hasPanels,
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

function rigSignature(fixtures: readonly StageFixture[], revision: number | string = 0): string {
  let key = `${revision}|${fixtures.length}`;
  for (const f of fixtures) {
    const p = f.position;
    const g = f.geometry;
    key += `|${f.profileId};${p ? `${p.x},${p.y},${p.height ?? ''}` : ''};${f.group || ''};${g ? `${g.length},${g.angle}` : ''};${isHue(f) ? 'h' : ''}`;
  }
  return key;
}

function isHue(fixture: StageFixture): boolean {
  return !!fixture.hue || !!(fixture.output && fixture.output.protocol === 'hue');
}

const HUE_COLOR_PROFILE_ID = 'generic-hue-lamp-7ch';
const HUE_WHITE_AMBIANCE_PROFILE_ID = 'generic-hue-white-ambiance-3ch';
const HUE_WHITE_PROFILE_ID = 'generic-hue-white-lamp-1ch';
const HUE_PROFILE_IDS: ReadonlySet<string> = new Set([HUE_COLOR_PROFILE_ID, HUE_WHITE_AMBIANCE_PROFILE_ID, HUE_WHITE_PROFILE_ID]);

function isHueLamp(fixture: StageFixture): boolean {
  return isHue(fixture) || (fixture.profileId !== undefined && HUE_PROFILE_IDS.has(fixture.profileId));
}

function hueFlags(flags: boolean[]): boolean[] | null {
  return flags.some(Boolean) ? flags : null;
}

function layoutOf(rig: Rig, split: number | null | undefined, pixelMap: string | null | undefined,
  only: LayerPart | null = null): Layout {
  const { fixtures, ranges, points, local, localY } = rig;
  const wash = washFixtures(fixtures, split);
  const part = (i: number) => {
    switch (only) {
      case 'pars': return !rig.cellMaps[i];
      case 'cells': return !!rig.cellMaps[i];
      case 'strips': return !!rig.cellMaps[i] && (!rig.grids[i] || rig.zoned[i]);
      case 'panels': return !!rig.grids[i] && !rig.zoned[i];
      case 'unpanelled': return !rig.grids[i] || rig.zoned[i];
      default: return true;
    }
  };
  const members = fixtures.map((_, i) => i).filter((i) => !wash.has(i) && part(i));
  const { order, xs } = spatialLayout(members.map((i) => fixtures[i]));
  const perBar = pixelMap === 'bar' && rig.hasPixels;
  const mirrored = pixelMap === 'mirror' && members.length >= 3;
  const planned = !perBar && !mirrored && members.some((i) => isPlaced(fixtures[i].position));
  const fixturePlan: StagePlan | null = planned ? {
    x: order.map((k) => centreOf(rig, members[k]).x / 100),
    y: order.map((k) => centreOf(rig, members[k]).y / 100),
    z: order.map((k) => heightOf(fixtures[members[k]])),
    group: order.map((k) => fixtures[members[k]].group || null),
  } : null;
  const layoutFixtures: Layout['fixtures'] = {
    members, order, xs, plan: fixturePlan, noFlash: hueFlags(order.map((k) => isHue(fixtures[members[k]]))),
  };
  if (pixelMap === 'mirror' && members.length >= 3) {
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
    const unitXs = pixelMap === 'mirror' && list.length >= 3
      ? (xs || list.map((_, k) => k / (list.length - 1))).map((x) => Math.abs(2 * x - 1))
      : xs;
    return { wash, fixtures: layoutFixtures, units: { list, xs: unitXs, ys: null, plan: fixturePlan, noFlash: layoutFixtures.noFlash } };
  }

  const list: number[] = [];
  for (const k of order) {
    const { start, count } = ranges[members[k]];
    const cells: number[] = [];
    for (let u = start; u < start + count; u++) cells.push(u);
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
    unitXs = list.map((u) => local[u]);
    unitYs = list.map((u) => localY[u]);
  } else if (pixelMap === 'mirror') {
    const n = list.length;
    const base = unitXs || list.map((_, k) => (n > 1 ? k / (n - 1) : 0.5));
    unitXs = base.map((x) => Math.abs(2 * x - 1));
  }
  const unitPlan: StagePlan | null = planned ? {
    x: list.map((u) => points[u].x / 100),
    y: list.map((u) => points[u].y / 100),
    z: list.map((u) => heightOf(fixtures[rig.units[u].fixture])),
    group: list.map((u) => fixtures[rig.units[u].fixture].group || null),
  } : null;
  const noFlash = hueFlags(list.map((u) => isHue(fixtures[rig.units[u].fixture])));
  const layout: Layout = { wash, fixtures: layoutFixtures, units: { list, xs: unitXs, ys: unitYs, plan: unitPlan, noFlash } };
  if (list.length > members.length) {
    const lampIndex = new Map(order.map((k, i) => [members[k], i]));
    const slots = order.map(() => [] as number[]);
    const lampOf = list.map((u, i) => {
      const lamp = lampIndex.get(rig.units[u].fixture)!;
      slots[lamp].push(i);
      return lamp;
    });
    layout.lamps = {
      slots, lampOf, cellAlong: list.map((u) => local[u]),
      xs: mirrored ? (xs ?? order.map((_, i) => i / (order.length - 1))).map((x) => Math.abs(2 * x - 1)) : xs,
      plan: !mirrored && members.some((i) => isPlaced(fixtures[i].position)) ? {
        x: order.map((k) => centreOf(rig, members[k]).x / 100),
        y: order.map((k) => centreOf(rig, members[k]).y / 100),
        z: order.map((k) => heightOf(fixtures[members[k]])),
        group: order.map((k) => fixtures[members[k]].group || null),
      } : null,
    };
  }
  return layout;
}

function heightOf(fixture: StageFixture): number {
  return (fixture.position?.height ?? 50) / 100;
}

function centreOf(rig: Rig, i: number): Point {
  const { start, count } = rig.ranges[i];
  let x = 0;
  let y = 0;
  for (let u = start; u < start + count; u++) {
    x += rig.points[u].x;
    y += rig.points[u].y;
  }
  return { x: x / Math.max(1, count), y: y / Math.max(1, count) };
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
  isHue,
  isHueLamp,
  HUE_COLOR_PROFILE_ID,
  HUE_WHITE_AMBIANCE_PROFILE_ID,
  HUE_WHITE_PROFILE_ID,
  HUE_PROFILE_IDS,
};
