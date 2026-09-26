import { footprintOf, stripOf } from '../shared/placement.ts';
import { DDP_PORT } from './ddp.ts';
import type { DdpOutput, Fixture, Profile } from '../types/rig.ts';

/**
 * Which universes go to a WLED over DDP rather than out on Art-Net and sACN.
 *
 * A WLED is patched as a fixture like any other — a strip of its pixels, on
 * universes of its own, from channel 1 — with `output: { protocol: 'ddp',
 * host }`. The engine renders it into those universes as it renders any strip
 * (so the monitor, the previews and the Hue lamps see it as they see anything
 * else), and the transmitter sends them to the WLED as one run of pixels
 * instead of as universes. Built on the main thread from the patch, and
 * handed to the transmitter with every frame.
 */

/**
 * One fixture on a WLED: where the WLED is, which bytes of which universes
 * are the fixture's pixels, in order, and where those pixels go among the
 * WLED's LEDs — from 0 for a whole WLED, from its first LED for a segment, a
 * row at a time for a rectangle of a panel.
 */
export interface DdpRoute {
  host: string;
  port: number;
  rgbw: boolean;
  parts: { universe: number; from: number; bytes: number }[];
  /** Runs of the fixture's LEDs, in order: `count` of them from LED `at`. */
  runs: { at: number; count: number }[];
  /** A wash or zones: its few cells, spread over the LEDs of its runs. */
  spread?: Spread;
}

/**
 * `cells` pixels spread over `leds` LEDs: each an equal share of them in
 * order, or with `columns`, of rows that many LEDs wide, a band of columns —
 * or with `areas`, the rectangle of those rows each names. `white` cells are
 * one byte, their white level, which an RGB WLED is sent on all three dies.
 */
export interface Spread {
  cells: number;
  leds: number;
  columns: number | null;
  areas?: [number, number, number, number][];
  white?: number[];
}

type ProfileOf = (fixture: Pick<Fixture, 'profileId'>) => Profile;
type UniverseOf = (fixture: Pick<Fixture, 'universe'>) => number;

/** The DDP routes of a patch. */
function ddpRoutes(fixtures: readonly Fixture[], profileOf: ProfileOf, universeOf: UniverseOf): DdpRoute[] {
  const routes: DdpRoute[] = [];
  for (const fix of fixtures) {
    const output = fix.output;
    if (!output || output.protocol !== 'ddp') continue;
    const profile = profileOf(fix);
    const parts = footprintOf(universeOf(fix), fix.address, profile)
      .map((part) => ({ universe: part.universe, from: part.first - 1, bytes: part.last - part.first + 1 }));
    const width = pixelWidth(profile) || profile.channelCount;
    const spread = spreadOf(output, profile, width);
    routes.push({
      host: output.host, port: output.port ?? DDP_PORT, rgbw: width === 4, parts, runs: runsOf(output, profile, width),
      ...(spread ? { spread } : {}),
    });
  }
  return routes;
}

/** How many pixels a profile's channels are. */
function pixelsOf(profile: Profile, width: number): number {
  return Math.max(1, Math.round(profile.channelCount / Math.max(1, width)));
}

/** Where a fixture's LEDs are among its WLED's (see DdpRoute.runs). */
function runsOf(output: DdpOutput, profile: Profile, width: number): { at: number; count: number }[] {
  const at = output.at ?? 0;
  const pixels = pixelsOf(profile, width);
  const leds = output.leds && output.leds > pixels ? output.leds : pixels;
  // The rectangle its LEDs make: the output's rows, or the profile's grid.
  const columns = leds !== pixels ? output.columns : profile.grid && profile.grid.columns * profile.grid.rows === pixels ? profile.grid.columns : undefined;
  if (output.rowStride && columns && leds % columns === 0 && output.rowStride > columns) {
    return Array.from({ length: leds / columns }, (_, r) => ({ at: at + r * (output.rowStride as number), count: columns }));
  }
  return [{ at, count: leds }];
}

/** A fixture's cells spread over more LEDs than it has, or null. */
function spreadOf(output: DdpOutput, profile: Profile, width: number): Spread | null {
  const cells = pixelsOf(profile, width);
  if (!output.leds || output.leds <= cells) return null;
  const columns = output.columns && output.leds % output.columns === 0 ? output.columns : null;
  const white = (profile.cells || []).flatMap((cell, c) => (cell.channelMap.white !== undefined && cell.channelMap.red === undefined ? [c] : []));
  return {
    cells, leds: output.leds, columns,
    ...(columns && output.areas && output.areas.length === cells ? { areas: output.areas } : {}),
    ...(white.length ? { white } : {}),
  };
}

/**
 * A fixture's cells, `width` bytes each, as the bytes of the LEDs they are
 * spread over: LED i lights cell ⌊i·cells/leds⌋, or across rows ⌊x·cells/columns⌋
 * for its column x.
 */
function spreadPixels(cells: Uint8Array, width: number, spread: Spread): Uint8Array {
  const out = new Uint8Array(spread.leds * width);
  const n = spread.cells;
  const owner = spread.areas && spread.columns ? areaOwners(spread.areas, spread.columns, spread.leds) : null;
  const white = spread.white && width === 3 ? new Set(spread.white) : null;
  for (let i = 0; i < spread.leds; i++) {
    const cell = owner ? owner[i]
      : spread.columns ? Math.floor(((i % spread.columns) * n) / spread.columns)
        : Math.floor((i * n) / spread.leds);
    if (cell < 0) continue;
    if (white && white.has(cell)) out.fill(cells[cell * width], i * width, i * width + width);
    else out.set(cells.subarray(cell * width, cell * width + width), i * width);
  }
  return out;
}

/** Which cell each LED is lit by, from the cells' rectangles; -1 for none. */
function areaOwners(areas: readonly [number, number, number, number][], columns: number, leds: number): Int32Array {
  const owner = new Int32Array(leds).fill(-1);
  areas.forEach(([x, y, w, h], c) => {
    for (let r = y; r < y + h; r++) {
      for (let k = x; k < Math.min(columns, x + w); k++) {
        const i = r * columns + k;
        if (i < leds) owner[i] = c;
      }
    }
  });
  return owner;
}

/** Channels to a pixel, when the profile is one pixel after another; 0 otherwise. */
function pixelWidth(profile: Profile): number {
  const strip = stripOf(profile);
  if (strip) return strip.width;
  const cells = profile.cells;
  if (!Array.isArray(cells) || cells.length < 2) return 0;
  const width = profile.channelCount / cells.length;
  return Number.isInteger(width) ? width : 0;
}

/**
 * Why a patch cannot go out as it is, or null: a universe that carries a WLED
 * over DDP is that WLED's alone, since nothing on it goes out on Art-Net or
 * sACN — a par patched there would silently never light.
 */
function ddpConflict(fixtures: readonly Fixture[], profileOf: ProfileOf, universeOf: UniverseOf): string | null {
  // Two fixtures on one WLED are two of its segments, and may not share a LED.
  const leds = new Map<string, { fixture: Fixture; from: number; to: number }[]>();
  for (const fix of fixtures) {
    const output = fix.output;
    if (!output || output.protocol !== 'ddp') continue;
    const profile = profileOf(fix);
    const key = `${output.host.toLowerCase()}:${output.port ?? DDP_PORT}`;
    const taken = leds.get(key) || [];
    for (const run of runsOf(output, profile, pixelWidth(profile) || profile.channelCount)) {
      const clash = taken.find((t) => t.fixture !== fix && run.at <= t.to && t.from <= run.at + run.count - 1);
      if (clash) {
        return `"${fix.label}" and "${clash.fixture.label}" both drive LEDs ${Math.max(run.at, clash.from) + 1}–`
          + `${Math.min(run.at + run.count - 1, clash.to) + 1} of the WLED at ${output.host}; give each a segment of its own`;
      }
      taken.push({ fixture: fix, from: run.at, to: run.at + run.count - 1 });
    }
    leds.set(key, taken);
  }
  const owner = new Map<number, Fixture>();
  for (const fix of fixtures) {
    if (!fix.output || fix.output.protocol !== 'ddp') continue;
    for (const part of footprintOf(universeOf(fix), fix.address, profileOf(fix))) {
      const other = owner.get(part.universe);
      if (other) return `"${fix.label}" and "${other.label}" both send universe ${part.universe} to a WLED; give each universes of its own`;
      owner.set(part.universe, fix);
    }
  }
  for (const fix of fixtures) {
    if (fix.output && fix.output.protocol === 'ddp') continue;
    for (const part of footprintOf(universeOf(fix), fix.address, profileOf(fix))) {
      const wled = owner.get(part.universe);
      if (wled) {
        return `"${fix.label}" is on universe ${part.universe}, which goes to "${wled.label}"'s WLED over DDP and nowhere else; `
          + 'patch it on another universe';
      }
    }
  }
  return null;
}

export {
  ddpRoutes,
  ddpConflict,
  runsOf,
  spreadPixels,
  pixelWidth,
};
