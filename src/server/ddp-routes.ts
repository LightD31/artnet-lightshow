import { footprintOf, stripOf } from '../shared/placement.ts';
import { DDP_PORT } from './ddp.ts';
import type { Fixture, Profile } from '../types/rig.ts';

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

/** One WLED: where it is, and which bytes of which universes are its pixels, in order. */
export interface DdpRoute {
  host: string;
  port: number;
  rgbw: boolean;
  parts: { universe: number; from: number; bytes: number }[];
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
    routes.push({ host: output.host, port: output.port ?? DDP_PORT, rgbw: pixelWidth(profile) === 4, parts });
  }
  return routes;
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
};
