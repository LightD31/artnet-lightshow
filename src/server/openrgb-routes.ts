import { footprintOf } from '../shared/placement.ts';
import { pixelWidth } from './ddp-routes.ts';
import type { Fixture, OpenRgbOutput, Profile } from '../types/rig.ts';

/**
 * Which universes go to an OpenRGB device rather than out on Art-Net and
 * sACN — as ddp-routes.ts does for WLEDs.
 *
 * A device is patched as a fixture like any other — its LEDs as cells, on
 * universes of its own, from channel 1 — with `output: { protocol:
 * 'openrgb', host, device, name, leds }`. The engine renders it into those
 * universes as it renders any strip, and the transmitter sends them to the
 * device as one UPDATELEDS packet a frame (transmit.ts, openrgb.ts). Built
 * on the main thread from the patch, and handed to the transmitter with
 * every frame.
 */

// The SDK server's port. Here rather than in openrgb.ts, which the transmitter
// loads only once a frame goes to a device (transmit.ts).
export const OPENRGB_PORT = 6742;

/**
 * One fixture on an OpenRGB device: which server and device (its number when
 * added, and its name then, to find it again when OpenRGB has renumbered),
 * how many LEDs, which bytes of which universes are its cells in order, how
 * many channels each cell is, and where red, green and blue sit in a cell
 * (-1 for none).
 */
export interface OpenRgbRoute {
  host: string;
  port: number;
  device: number;
  name?: string;
  leds: number;
  parts: { universe: number; from: number; bytes: number }[];
  width: number;
  rgb: [number, number, number];
}

type ProfileOf = (fixture: Pick<Fixture, 'profileId'>) => Profile;
type UniverseOf = (fixture: Pick<Fixture, 'universe'>) => number;

/** The OpenRGB routes of a patch. */
function openrgbRoutes(fixtures: readonly Fixture[], profileOf: ProfileOf, universeOf: UniverseOf): OpenRgbRoute[] {
  const routes: OpenRgbRoute[] = [];
  for (const fix of fixtures) {
    const output = fix.output;
    if (!output || output.protocol !== 'openrgb') continue;
    const profile = profileOf(fix);
    const parts = footprintOf(universeOf(fix), fix.address, profile)
      .map((part) => ({ universe: part.universe, from: part.first - 1, bytes: part.last - part.first + 1 }));
    // The first cell says where a cell's colour is: a profile patched here by
    // hand (a par's) still lights the first LED its colour.
    const map = profile.cells && profile.cells.length ? profile.cells[0].channelMap : profile.channelMap;
    routes.push({
      host: output.host, port: output.port ?? OPENRGB_PORT, device: output.device, ...(output.name ? { name: output.name } : {}), leds: output.leds, parts,
      width: pixelWidth(profile) || profile.channelCount,
      rgb: [map.red ?? -1, map.green ?? -1, map.blue ?? -1],
    });
  }
  return routes;
}

/** What makes one device another (its number, and its name when patched under one), and one server another. */
const openrgbKey = (route: Pick<OpenRgbRoute, 'host' | 'port' | 'device' | 'name'>) => `${route.host.toLowerCase()}:${route.port}#${route.device}${route.name ? ` ${route.name}` : ''}`;
const openrgbHostKey = (route: Pick<OpenRgbRoute, 'host' | 'port'>) => `${route.host.toLowerCase()}:${route.port}`;

/**
 * A route's LEDs, three bytes each, from the universes' frames: its cells'
 * bytes in order, red, green and blue picked out of each. A LED past the
 * fixture's cells is dark.
 */
function openrgbPixels(route: OpenRgbRoute, frameOf: (universe: number) => Uint8Array): Uint8Array {
  const own = new Uint8Array(route.parts.reduce((n, part) => n + part.bytes, 0));
  let cursor = 0;
  for (const part of route.parts) {
    own.set(frameOf(part.universe).subarray(part.from, part.from + part.bytes), cursor);
    cursor += part.bytes;
  }
  const out = new Uint8Array(route.leds * 3);
  const [r, g, b] = route.rgb;
  for (let i = 0; i < route.leds; i++) {
    const base = i * route.width;
    if (base + route.width > own.length) break;
    if (r >= 0) out[i * 3] = own[base + r];
    if (g >= 0) out[i * 3 + 1] = own[base + g];
    if (b >= 0) out[i * 3 + 2] = own[base + b];
  }
  return out;
}

/** Why a patch cannot go out as it is, or null: two fixtures on one device would fight over it. */
function openrgbConflict(fixtures: readonly Fixture[]): string | null {
  const taken = new Map<string, Fixture>();
  for (const fix of fixtures) {
    const output = fix.output;
    if (!output || output.protocol !== 'openrgb') continue;
    const key = openrgbKey({ host: output.host, port: output.port ?? OPENRGB_PORT, device: output.device, ...(output.name ? { name: output.name } : {}) });
    const other = taken.get(key);
    if (other) return `"${fix.label}" and "${other.label}" are both OpenRGB device #${output.device}${output.name ? ` ${output.name}` : ''} at ${output.host}; remove one`;
    taken.set(key, fix);
  }
  return null;
}

/** The output of a fixture that is an OpenRGB device, or null. */
function openrgbOutputOf(fixture: Pick<Fixture, 'output'>): OpenRgbOutput | null {
  return fixture.output && fixture.output.protocol === 'openrgb' ? fixture.output : null;
}

export {
  openrgbRoutes,
  openrgbKey,
  openrgbHostKey,
  openrgbPixels,
  openrgbConflict,
  openrgbOutputOf,
};
