import { footprintOf, stripOf } from '../shared/placement.ts';
import { DDP_PORT } from './ddp.ts';
import { openrgbConflict } from './openrgb-routes.ts';
import type { DdpOutput, Fixture, Profile } from '../types/rig.ts';

export interface DdpRoute {
  host: string;
  port: number;
  rgbw: boolean;
  parts: { universe: number; from: number; bytes: number }[];
  runs: { at: number; count: number }[];
  spread?: Spread;
}

export interface Spread {
  cells: number;
  leds: number;
  columns: number | null;
  areas?: [number, number, number, number][];
  white?: number[];
}

type ProfileOf = (fixture: Pick<Fixture, 'profileId'>) => Profile;
type UniverseOf = (fixture: Pick<Fixture, 'universe'>) => number;

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

function pixelsOf(profile: Profile, width: number): number {
  return Math.max(1, Math.round(profile.channelCount / Math.max(1, width)));
}

function runsOf(output: DdpOutput, profile: Profile, width: number): { at: number; count: number }[] {
  const at = output.at ?? 0;
  const pixels = pixelsOf(profile, width);
  const leds = output.leds && output.leds > pixels ? output.leds : pixels;
  const columns = leds !== pixels ? output.columns : profile.grid && profile.grid.columns * profile.grid.rows === pixels ? profile.grid.columns : undefined;
  if (output.rowStride && columns && leds % columns === 0 && output.rowStride > columns) {
    return Array.from({ length: leds / columns }, (_, r) => ({ at: at + r * (output.rowStride as number), count: columns }));
  }
  return [{ at, count: leds }];
}

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

function pixelWidth(profile: Profile): number {
  const strip = stripOf(profile);
  if (strip) return strip.width;
  const cells = profile.cells;
  if (!Array.isArray(cells) || cells.length < 2) return 0;
  const width = profile.channelCount / cells.length;
  return Number.isInteger(width) ? width : 0;
}

const toDevice = (fix: Fixture) => !!fix.output && (fix.output.protocol === 'ddp' || fix.output.protocol === 'openrgb');
const deviceName = (fix: Fixture) => (fix.output?.protocol === 'openrgb' ? 'an OpenRGB device' : 'a WLED');

// Reserve device universes exclusively so DMX fixtures cannot be patched onto channels never sent to DMX.
function ddpConflict(fixtures: readonly Fixture[], profileOf: ProfileOf, universeOf: UniverseOf): string | null {
  const twice = openrgbConflict(fixtures);
  if (twice) return twice;
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
    if (!toDevice(fix)) continue;
    for (const part of footprintOf(universeOf(fix), fix.address, profileOf(fix))) {
      const other = owner.get(part.universe);
      if (other) return `"${fix.label}" and "${other.label}" both send universe ${part.universe} to ${deviceName(fix)}; give each universes of its own`;
      owner.set(part.universe, fix);
    }
  }
  for (const fix of fixtures) {
    if (toDevice(fix)) continue;
    for (const part of footprintOf(universeOf(fix), fix.address, profileOf(fix))) {
      const device = owner.get(part.universe);
      if (device) {
        const where = device.output?.protocol === 'openrgb' ? 'OpenRGB device' : 'WLED over DDP';
        return `"${fix.label}" is on universe ${part.universe}, which goes to "${device.label}"'s ${where} and nowhere else; `
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
