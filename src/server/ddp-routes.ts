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
  /** Runs of the fixture's pixels, in order: `count` of them from LED `at`. */
  runs: { at: number; count: number }[];
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
    routes.push({ host: output.host, port: output.port ?? DDP_PORT, rgbw: width === 4, parts, runs: runsOf(output, profile, width) });
  }
  return routes;
}

/** Where a fixture's pixels go among its WLED's LEDs (see DdpRoute.runs). */
function runsOf(output: DdpOutput, profile: Profile, width: number): { at: number; count: number }[] {
  const at = output.at ?? 0;
  const pixels = Math.max(1, Math.round(profile.channelCount / Math.max(1, width)));
  const grid = profile.grid;
  if (output.rowStride && grid && grid.columns * grid.rows === pixels && output.rowStride > grid.columns) {
    return Array.from({ length: grid.rows }, (_, r) => ({ at: at + r * (output.rowStride as number), count: grid.columns }));
  }
  return [{ at, count: pixels }];
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
  pixelWidth,
};
