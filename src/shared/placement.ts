/**
 * Where a fixture's channels are on the wire.
 *
 * A fixture sits on one universe from its address: channel `offset` of its
 * profile is channel `address + offset` of that universe. That is every par
 * and bar there has ever been, and it has to fit — a DMX fixture cannot run
 * on into the next universe.
 *
 * A pixel strip can. Three hundred RGB pixels is 900 channels, and a pixel
 * controller (or WLED listening to Art-Net) takes the first 170 pixels on one
 * universe and the other 130 on the next: whole pixels per universe, never one
 * split across two. So a profile longer than a universe has to be a strip —
 * nothing but cells of equal width, one after another — and starts at
 * channel 1, running on through as many universes as it needs.
 *
 * Browser-safe: the engine writes through this, and the DMX monitor, the
 * fixture swatches and the Hue lamps read through it.
 */

import type { Profile } from '../types/rig.ts';

/** One DMX universe. */
const UNIVERSE_SIZE = 512;

/** The highest universe Art-Net can address (15 bits). */
const LAST_UNIVERSE = 32767;

/**
 * The first of the server's own universes. A fixture with no DMX address — a
 * Philips Hue lamp, which the bridge drives — still has to be rendered
 * somewhere for its Hue channel to read its colour back, so the server puts it
 * on universes from here. They are rendered like any other and never sent: a
 * fixture's universe is an Art-Net one, 32767 at most. Still under 65536, so
 * the page's DMX frames (dmx-frame.ts), which carry a universe in 16 bits,
 * can show them.
 */
const INTERNAL_UNIVERSE = 60000;

/** Whether a universe is one of the server's own, never put on the wire. */
function isInternalUniverse(universe: number): boolean {
  return universe >= INTERNAL_UNIVERSE;
}

/** A fixture with no DMX address: shown on a Hue lamp and nowhere else. */
function hasNoAddress(fixture: { output?: { protocol: string } | null }): boolean {
  return !!fixture.output && fixture.output.protocol === 'hue';
}

/** How a strip longer than a universe is laid out. */
export interface Strip {
  /** Channels per cell. */
  width: number;
  /** Whole cells one universe carries. */
  perUniverse: number;
  /** Universes the strip covers. */
  universes: number;
}

type Placeable = Pick<Profile, 'channelCount' | 'channelMap' | 'cells'>;

const strips = new WeakMap<object, Strip | null>();

/**
 * The layout of a profile longer than a universe, or null for any other
 * profile (which must fit the universe it is patched on). Also null for a
 * long profile that is not a strip of equal cells: it cannot be patched.
 */
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

/** Why a profile of this length is not one that can be patched, or null. */
function stripIssue(profile: Placeable): string | null {
  if (profile.channelCount <= UNIVERSE_SIZE || stripOf(profile)) return null;
  return `is ${profile.channelCount} channels, longer than a ${UNIVERSE_SIZE}-channel universe, and only a strip of `
    + 'equal cells (no channels for the whole fixture, each cell\'s channels together) can run on into the next';
}

/** How many universes a fixture on this profile covers. */
function universeCount(profile: Placeable): number {
  const strip = stripOf(profile);
  return strip ? strip.universes : 1;
}

/**
 * Where cell `c` of a fixture is: the universe (from the fixture's own) and
 * what to add to the cell's channel offsets to index that universe. A fixture
 * that does not span is one universe from its address.
 */
function cellPlace(strip: Strip | null, address: number, c: number): { universe: number; shift: number } {
  if (!strip) return { universe: 0, shift: address - 1 };
  const universe = Math.floor(c / strip.perUniverse);
  return { universe, shift: -universe * strip.perUniverse * strip.width };
}

/** Where profile channel `offset` of a fixture is: universe (from its own) and 0-based channel. */
function channelPlace(strip: Strip | null, address: number, offset: number): { universe: number; index: number } {
  if (!strip) return { universe: 0, index: address - 1 + offset };
  const cell = Math.floor(offset / strip.width);
  const { universe, shift } = cellPlace(strip, address, cell);
  return { universe, index: offset + shift };
}

/**
 * Why a fixture patched at `address` on this profile does not fit, in words an
 * operator can act on, or null when it does. With `universe`, a strip that
 * would run past the last universe does not fit either.
 */
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

/** The universes a fixture covers, from `universe` (its own). */
function universesOf(universe: number, profile: Placeable): number[] {
  const out: number[] = [];
  for (let k = 0; k < universeCount(profile); k++) out.push(universe + k);
  return out;
}

/**
 * The channels a fixture occupies on each universe it covers, as [first, last]
 * 1-based: for telling whether two fixtures overlap.
 */
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

/** Do two footprints share a channel? */
function overlaps(a: ReturnType<typeof footprintOf>, b: ReturnType<typeof footprintOf>): boolean {
  return a.some((x) => b.some((y) => x.universe === y.universe && x.first <= y.last && y.first <= x.last));
}

interface Placed {
  address: number;
  universe?: number;
  profileId: string;
  output?: { protocol: string } | null;
}

/**
 * Give every fixture with no DMX address its place on the internal universes:
 * one after another in patch order, each on a universe it fits, a strip from
 * channel 1 of universes of its own. Changes `fixtures` in place, and says
 * whether anything moved. Placement is the server's, so it is simply redone
 * whenever the patch changes; nothing outside refers to these addresses.
 */
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

/**
 * A reader for a fixture's channels in rendered universes: `frames(universe)`
 * gives a universe's bytes (a buffer or a plain array; missing reads as 0).
 */
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
