import { UNIVERSE_SIZE, fitIssue } from '../shared/placement.ts';
import { HUE_COLOR_PROFILE_ID, HUE_PROFILE_IDS, HUE_WHITE_AMBIANCE_PROFILE_ID, HUE_WHITE_PROFILE_ID } from '../shared/rig.ts';
import type { Fixture, Profile } from '../types/rig.ts';

const BUILTIN_PROFILE_ID = 'cameo-root-par-6-12ch';

// Validate the full DMX footprint so sparse offsets cannot write beyond the reserved channels.

// Bound patch growth so a stuck client cannot expand rendering and broadcasts indefinitely.
const MAX_FIXTURES = 64;

const MAX_UNITS = 4096;

function endChannel(address: number, channelCount: number): number {
  return address + channelCount - 1;
}

function fitsInUniverse(address: number, channelCount: number): boolean {
  return address >= 1 && endChannel(address, channelCount) <= UNIVERSE_SIZE;
}

function universeOverflow(label: string, address: number, profile: Pick<Profile, 'channelCount' | 'channelMap' | 'cells'>,
  universe?: number): string | null {
  return fitIssue(label, address, profile, universe);
}

// Share UV compensation with the preview so both use the same emitter arithmetic.
import { UV_BOOST } from '../shared/look-math.ts';
import { countUnits } from '../shared/rig.ts';

const RESERVED_PROFILE_IDS = new Set(['__proto__', 'constructor', 'prototype']);

// A null prototype keeps uploaded profile IDs such as __proto__ from changing the map’s prototype.
const fixtureProfiles: Record<string, Profile> = Object.assign(Object.create(null), {
  [BUILTIN_PROFILE_ID]: {
    id: BUILTIN_PROFILE_ID,
    name: 'ROOT PAR 6',
    manufacturer: 'Cameo',
    modeName: '12-channel (D12CH)',
    channelCount: 12,
    channelMap: {
      dimmer: 0, dimmerFine: 1, strobe: 2,
      red: 3, green: 4, blue: 5,
      white: 6, amber: 7, uv: 8,
      macro: 9, sound: 10, delay: 11,
    },
    channelList: [
      { offset: 0,  name: 'Dimmer',      attribute: 'dimmer' },
      { offset: 1,  name: 'Dimmer Fine', attribute: 'dimmerFine' },
      { offset: 2,  name: 'Strobe',      attribute: 'strobe' },
      { offset: 3,  name: 'Red',         attribute: 'red' },
      { offset: 4,  name: 'Green',       attribute: 'green' },
      { offset: 5,  name: 'Blue',        attribute: 'blue' },
      { offset: 6,  name: 'White',       attribute: 'white' },
      { offset: 7,  name: 'Amber',       attribute: 'amber' },
      { offset: 8,  name: 'UV',          attribute: 'uv' },
      { offset: 9,  name: 'Color Macro', attribute: 'macro' },
      { offset: 10, name: 'Sound',       attribute: 'sound' },
      { offset: 11, name: 'DMX Delay',   attribute: 'delay' },
    ],
  },

  // Keep white and UV channels so Hue retains show content; fold them to RGB only at transport output.
  [HUE_COLOR_PROFILE_ID]: {
    id: HUE_COLOR_PROFILE_ID,
    name: 'Generic Lamp',
    manufacturer: 'Philips Hue',
    modeName: '7-channel (dimmer + RGBWW + UV)',
    channelCount: 7,
    channelMap: {
      dimmer: 0,
      red: 1, green: 2, blue: 3,
      warmWhite: 4, coolWhite: 5,
      uv: 6,
    },
    channelList: [
      { offset: 0, name: 'Dimmer',     attribute: 'dimmer' },
      { offset: 1, name: 'Red',        attribute: 'red' },
      { offset: 2, name: 'Green',      attribute: 'green' },
      { offset: 3, name: 'Blue',       attribute: 'blue' },
      { offset: 4, name: 'Warm White', attribute: 'warmWhite' },
      { offset: 5, name: 'Cool White', attribute: 'coolWhite' },
      { offset: 6, name: 'UV (shown as violet)', attribute: 'uv' },
    ],
  },

  [HUE_WHITE_AMBIANCE_PROFILE_ID]: {
    id: HUE_WHITE_AMBIANCE_PROFILE_ID,
    name: 'Generic White Ambiance Lamp',
    manufacturer: 'Philips Hue',
    modeName: '3-channel (dimmer + tunable white)',
    channelCount: 3,
    channelMap: {
      dimmer: 0,
      warmWhite: 1, coolWhite: 2,
    },
    channelList: [
      { offset: 0, name: 'Dimmer',     attribute: 'dimmer' },
      { offset: 1, name: 'Warm White', attribute: 'warmWhite' },
      { offset: 2, name: 'Cool White', attribute: 'coolWhite' },
    ],
  },

  [HUE_WHITE_PROFILE_ID]: {
    id: HUE_WHITE_PROFILE_ID,
    name: 'Generic White Lamp',
    manufacturer: 'Philips Hue',
    modeName: '1-channel (dimmer)',
    channelCount: 1,
    channelMap: {
      dimmer: 0,
    },
    channelList: [
      { offset: 0, name: 'Dimmer', attribute: 'dimmer' },
    ],
  },
});

// Keep built-ins when loading shows because saved files may contain only imported profiles.
const BUILTIN_PROFILE_IDS = new Set([
  BUILTIN_PROFILE_ID,
  HUE_COLOR_PROFILE_ID,
  HUE_WHITE_AMBIANCE_PROFILE_ID,
  HUE_WHITE_PROFILE_ID,
]);

const HUE_BY_HAND = 'A Hue lamp is added from its bridge: Rig → Outputs → Philips Hue, Add to patch';

function hueProfileFor(kind: 'color' | 'ambiance' | 'white'): string {
  if (kind === 'ambiance') return HUE_WHITE_AMBIANCE_PROFILE_ID;
  if (kind === 'white') return HUE_WHITE_PROFILE_ID;
  return HUE_COLOR_PROFILE_ID;
}

function isBuiltinProfile(id: string): boolean {
  return BUILTIN_PROFILE_IDS.has(id);
}

let revision = 0;

function profilesRevision(): number {
  return revision;
}

function getProfile(fixture: Pick<Fixture, 'profileId'>): Profile {
  return fixtureProfiles[fixture.profileId] || fixtureProfiles[BUILTIN_PROFILE_ID];
}

function registerProfile(profile: Profile | null | undefined): boolean {
  if (!profile || !profile.id || !profile.name || !profile.channelCount) return false;
  if (RESERVED_PROFILE_IDS.has(profile.id)) return false;
  // Reject built-in replacements so saved shows and uploads cannot pin or overwrite shipped profiles.
  if (isBuiltinProfile(profile.id)) return false;
  fixtureProfiles[profile.id] = profile;
  revision++;
  return true;
}

function unregisterProfile(id: string): boolean {
  if (isBuiltinProfile(id)) return false;
  delete fixtureProfiles[id];
  revision++;
  return true;
}

function listProfiles(): Record<string, Profile> {
  return fixtureProfiles;
}

function clearNonBuiltinProfiles(): void {
  Object.keys(fixtureProfiles).forEach((id) => {
    if (!isBuiltinProfile(id)) delete fixtureProfiles[id];
  });
  revision++;
}

function unitCapOverflow<F extends Pick<Fixture, 'profileId'>>(fixtures: Iterable<F>,
  profileOf: (fixture: F) => Pick<Profile, 'cells'> | null | undefined = getProfile): string | null {
  const total = countUnits(fixtures, profileOf);
  if (total <= MAX_UNITS) return null;
  return `The patch would have ${total} lights (cells), more than the ${MAX_UNITS} the engine renders`;
}

export {
  BUILTIN_PROFILE_ID,
  BUILTIN_PROFILE_IDS,
  HUE_COLOR_PROFILE_ID,
  HUE_WHITE_AMBIANCE_PROFILE_ID,
  HUE_WHITE_PROFILE_ID,
  HUE_PROFILE_IDS,
  hueProfileFor,
  HUE_BY_HAND,
  isBuiltinProfile,
  UNIVERSE_SIZE,
  MAX_FIXTURES,
  MAX_UNITS,
  unitCapOverflow,
  profilesRevision,
  endChannel,
  fitsInUniverse,
  universeOverflow,
  UV_BOOST,
  RESERVED_PROFILE_IDS,
  getProfile,
  registerProfile,
  unregisterProfile,
  listProfiles,
  clearNonBuiltinProfiles,
};
