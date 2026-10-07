import { footprintOf } from '../shared/placement.ts';
import { pixelWidth } from './ddp-routes.ts';
import type { Fixture, OpenRgbOutput, Profile } from '../types/rig.ts';

export const OPENRGB_PORT = 6742;

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

function openrgbRoutes(fixtures: readonly Fixture[], profileOf: ProfileOf, universeOf: UniverseOf): OpenRgbRoute[] {
  const routes: OpenRgbRoute[] = [];
  for (const fix of fixtures) {
    const output = fix.output;
    if (!output || output.protocol !== 'openrgb') continue;
    const profile = profileOf(fix);
    const parts = footprintOf(universeOf(fix), fix.address, profile)
      .map((part) => ({ universe: part.universe, from: part.first - 1, bytes: part.last - part.first + 1 }));
    const map = profile.cells && profile.cells.length ? profile.cells[0].channelMap : profile.channelMap;
    routes.push({
      host: output.host, port: output.port ?? OPENRGB_PORT, device: output.device, ...(output.name ? { name: output.name } : {}), leds: output.leds, parts,
      width: pixelWidth(profile) || profile.channelCount,
      rgb: [map.red ?? -1, map.green ?? -1, map.blue ?? -1],
    });
  }
  return routes;
}

const openrgbKey = (route: Pick<OpenRgbRoute, 'host' | 'port' | 'device' | 'name'>) => `${route.host.toLowerCase()}:${route.port}#${route.device}${route.name ? ` ${route.name}` : ''}`;
const openrgbHostKey = (route: Pick<OpenRgbRoute, 'host' | 'port'>) => `${route.host.toLowerCase()}:${route.port}`;

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
