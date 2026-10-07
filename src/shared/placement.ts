import type { Profile } from '../types/rig.ts';

const UNIVERSE_SIZE = 512;

const LAST_UNIVERSE = 32767;

// Internal universes render unaddressed fixtures without transmitting them on Art-Net.
const INTERNAL_UNIVERSE = 60000;

function isInternalUniverse(universe: number): boolean {
  return universe >= INTERNAL_UNIVERSE;
}

function hasNoAddress(fixture: { output?: { protocol: string } | null }): boolean {
  return !!fixture.output && fixture.output.protocol === 'hue';
}

const HUE_BRIDGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface Strip {
  width: number;
  perUniverse: number;
  universes: number;
}

type Placeable = Pick<Profile, 'channelCount' | 'channelMap' | 'cells'>;

const strips = new WeakMap<object, Strip | null>();

function stripOf(profile: Placeable): Strip | null {
  if (!profile || profile.channelCount <= UNIVERSE_SIZE) return null;
  let strip = strips.get(profile);
  if (strip === undefined) {
    strip = readStrip(profile);
    strips.set(profile, strip);
  }
  return strip;
}

function readStrip(profile: Placeable): Strip | null {
  const cells = profile.cells;
  if (!Array.isArray(cells) || cells.length < 2) return null;
  if (Object.keys(profile.channelMap || {}).length) return null;
  const width = profile.channelCount / cells.length;
  if (!Number.isInteger(width) || width < 1 || width > UNIVERSE_SIZE) return null;
  for (let c = 0; c < cells.length; c++) {
    for (const offset of Object.values(cells[c].channelMap)) {
      if (offset === undefined || offset < c * width || offset >= (c + 1) * width) return null;
    }
  }
  const perUniverse = Math.floor(UNIVERSE_SIZE / width);
  return { width, perUniverse, universes: Math.ceil(cells.length / perUniverse) };
}

function stripIssue(profile: Placeable): string | null {
  if (profile.channelCount <= UNIVERSE_SIZE || stripOf(profile)) return null;
  return `is ${profile.channelCount} channels, longer than a ${UNIVERSE_SIZE}-channel universe, and only a strip of `
    + 'equal cells (no channels for the whole fixture, each cell\'s channels together) can run on into the next';
}

function universeCount(profile: Placeable): number {
  const strip = stripOf(profile);
  return strip ? strip.universes : 1;
}

function cellPlace(strip: Strip | null, address: number, c: number): { universe: number; shift: number } {
  if (!strip) return { universe: 0, shift: address - 1 };
  const universe = Math.floor(c / strip.perUniverse);
  return { universe, shift: -universe * strip.perUniverse * strip.width };
}

function channelPlace(strip: Strip | null, address: number, offset: number): { universe: number; index: number } {
  if (!strip) return { universe: 0, index: address - 1 + offset };
  const cell = Math.floor(offset / strip.width);
  const { universe, shift } = cellPlace(strip, address, cell);
  return { universe, index: offset + shift };
}

function fitIssue(label: string, address: number, profile: Placeable, universe?: number): string | null {
  const count = profile.channelCount;
  if (count <= UNIVERSE_SIZE) {
    const end = address + count - 1;
    if (address >= 1 && end <= UNIVERSE_SIZE) return null;
    return `"${label}" at address ${address} needs ${count} channels and would end at ${end}, past the ${UNIVERSE_SIZE}-channel universe`;
  }
  const issue = stripIssue(profile);
  if (issue) return `"${label}" ${issue}`;
  if (address !== 1) {
    return `"${label}" is a strip of ${count} channels, longer than a universe, so it starts at channel 1 and runs on into the next`;
  }
  const last = universe === undefined ? null : universe + universeCount(profile) - 1;
  if (last !== null && !isInternalUniverse(universe as number) && last > LAST_UNIVERSE) {
    return `"${label}" runs over ${universeCount(profile)} universes from ${universe}, past universe ${LAST_UNIVERSE}, the last there is`;
  }
  return null;
}

function universesOf(universe: number, profile: Placeable): number[] {
  const out: number[] = [];
  for (let k = 0; k < universeCount(profile); k++) out.push(universe + k);
  return out;
}

function footprintOf(universe: number, address: number, profile: Placeable): { universe: number; first: number; last: number }[] {
  const strip = stripOf(profile);
  if (!strip) return [{ universe, first: address, last: address + profile.channelCount - 1 }];
  const cells = profile.channelCount / strip.width;
  const out: { universe: number; first: number; last: number }[] = [];
  for (let k = 0; k < strip.universes; k++) {
    const here = Math.min(strip.perUniverse, cells - k * strip.perUniverse);
    out.push({ universe: universe + k, first: 1, last: here * strip.width });
  }
  return out;
}

function overlaps(a: ReturnType<typeof footprintOf>, b: ReturnType<typeof footprintOf>): boolean {
  return a.some((x) => b.some((y) => x.universe === y.universe && x.first <= y.last && y.first <= x.last));
}

interface Placed {
  address: number;
  universe?: number;
  profileId: string;
  output?: { protocol: string } | null;
}

// Internal placement can be rebuilt because no external consumer refers to these addresses.
function placeAddressless<F extends Placed>(fixtures: readonly F[], profileOf: (fixture: F) => Placeable): boolean {
  let moved = false;
  let universe = INTERNAL_UNIVERSE;
  let next = 1;
  for (const fix of fixtures) {
    if (!hasNoAddress(fix)) continue;
    const profile = profileOf(fix);
    const span = universeCount(profile);
    let address = next;
    if (span > 1 || address + profile.channelCount - 1 > UNIVERSE_SIZE) {
      if (address > 1) universe += 1;
      address = 1;
    }
    if (fix.universe !== universe || fix.address !== address) {
      fix.universe = universe;
      fix.address = address;
      moved = true;
    }
    if (span > 1) {
      universe += span;
      next = 1;
    } else {
      next = address + profile.channelCount;
    }
  }
  return moved;
}

function channelReader(universe: number, address: number, profile: Placeable,
  frames: (universe: number) => ArrayLike<number> | null | undefined): (offset: number | undefined) => number {
  const strip = stripOf(profile);
  if (!strip) {
    const frame = frames(universe);
    const base = address - 1;
    return (offset) => (offset === undefined || !frame ? 0 : (frame[base + offset] || 0));
  }
  return (offset) => {
    if (offset === undefined) return 0;
    const place = channelPlace(strip, address, offset);
    const frame = frames(universe + place.universe);
    return frame ? (frame[place.index] || 0) : 0;
  };
}

export {
  UNIVERSE_SIZE,
  INTERNAL_UNIVERSE,
  HUE_BRIDGE_ID_RE,
  isInternalUniverse,
  hasNoAddress,
  placeAddressless,
  stripOf,
  stripIssue,
  universeCount,
  cellPlace,
  channelPlace,
  fitIssue,
  universesOf,
  footprintOf,
  overlaps,
  channelReader,
};
