import { UNIVERSE_SIZE, fitIssue } from '../shared/placement.ts';
import type { Fixture, Profile } from '../types/rig.ts';

// The profile a new fixture gets, and the fallback for a profile id nothing
// knows about. The one profile built in — see BUILTIN_PROFILE_IDS.
const BUILTIN_PROFILE_ID = 'cameo-root-par-6-12ch';

// The profiles that ship with the server are DMX fixtures. A Philips Hue
// lamp's profile is built from what its bridge says the lamp can show when it
// is patched (hue-profile.ts), and travels with the show like an imported one.
const LEGACY_HUE_PROFILE_IDS = new Set(['generic-hue-lamp-7ch', 'generic-hue-white-ambiance-3ch', 'generic-hue-white-lamp-1ch']);

// One DMX universe (UNIVERSE_SIZE, from shared/placement.ts). A fixture
// patched past it has its writes silently dropped by the 512-byte buffer,
// leaving it half-controllable with no error, so every path that sets an
// address checks it with universeOverflow — which also lets a pixel strip
// longer than a universe run on into the next.

// A show is a handful of fixtures. The cap exists so a stuck client or a
// scripted loop cannot grow the patch (and with it every state broadcast)
// without bound.
const MAX_FIXTURES = 64;

// Every light the engine renders — a par, or one cell of an LED bar or strip —
// is worked out every frame. Measured on the worker thread: 4,096 cells cost
// 0.5–2 ms a frame for most patterns and 6–7 ms for the heaviest (plasma,
// gradient), of the 22.7 ms a frame has; 8,192 cost twice that, which a
// slower laptop would not keep up with. Sixty-four sixteen-cell bars is 1,024.
const MAX_UNITS = 4096;

/** Last channel a fixture at `address` with `channelCount` channels occupies. */
function endChannel(address: number, channelCount: number): number {
  return address + channelCount - 1;
}

/** Does a fixture patched here fit inside the universe? */
function fitsInUniverse(address: number, channelCount: number): boolean {
  return address >= 1 && endChannel(address, channelCount) <= UNIVERSE_SIZE;
}

/**
 * Why a fixture does not fit where it is patched, in words an operator can act
 * on, or null when it does. One wording for every path that patches a fixture:
 * editing one, restoring a deleted one and loading a show used to say it three
 * ways. A strip longer than a universe fits from channel 1 (shared/placement).
 */
function universeOverflow(label: string, address: number, profile: Pick<Profile, 'channelCount' | 'channelMap' | 'cells'>,
  universe?: number): string | null {
  return fitIssue(label, address, profile, universe);
}

// UV LEDs are physically dimmer than RGBW — boost their DMX value so they
// remain visually competitive at lower dimmer settings.
//
// Defined in src/shared/look-math.js, which is where the arithmetic that
// applies it lives and is reachable from the browser preview too. Re-exported
// here because this is where callers have always asked for it.
import { UV_BOOST } from '../shared/look-math.ts';
import { countUnits } from '../shared/rig.ts';

// Ids that would collide with object-machinery keys. Rejected at registration
// as defence in depth alongside the null-prototype registry below.
const RESERVED_PROFILE_IDS = new Set(['__proto__', 'constructor', 'prototype']);

// Null-prototype map: profile ids come straight from user input (GDTF upload,
// POST /api/profiles), and on a plain object literal an id of "__proto__" would
// reassign this object's prototype instead of adding a key.
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
});

// Every profile that ships with the server. None of them may be deleted, and
// loading a show must not wipe them: a show file carries only the profiles it
// brought with it, so anything built in has to survive the swap or a fixture
// referencing one would land on the fallback instead.
const BUILTIN_PROFILE_IDS = new Set([
  BUILTIN_PROFILE_ID,
]);

/** Why a Hue lamp profile cannot be patched, or a fixture made a Hue lamp, by hand. */
const HUE_BY_HAND = 'A Hue lamp is added from its bridge: Rig → Outputs → Philips Hue, Add to patch';

/** Does this profile ship with the server, rather than being imported? */
function isBuiltinProfile(id: string): boolean {
  return BUILTIN_PROFILE_IDS.has(id);
}

// Bumped whenever the registry changes, so anything that caches what the rig
// looks like (see src/server/rig.js) knows a profile under it has changed.
let revision = 0;

/** Changes whenever a profile is added, replaced or removed. */
function profilesRevision(): number {
  return revision;
}

function getProfile(fixture: Pick<Fixture, 'profileId'>): Profile {
  return fixtureProfiles[fixture.profileId] || fixtureProfiles[BUILTIN_PROFILE_ID];
}

function registerProfile(profile: Profile | null | undefined): boolean {
  if (!profile || !profile.id || !profile.name || !profile.channelCount) return false;
  if (RESERVED_PROFILE_IDS.has(profile.id)) return false;
  // A built-in is defined by this file. An upload or a show file carrying the
  // same id would otherwise replace it for every fixture patched to it — and a
  // show file saved with the built-ins in it would pin an old copy forever.
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

/**
 * Why a patch has more cells than the engine renders, or null when it fits.
 * `profileOf` resolves a fixture's profile — the live registry by default, or
 * the profiles a show is bringing with it.
 */
function unitCapOverflow<F extends Pick<Fixture, 'profileId'>>(fixtures: Iterable<F>,
  profileOf: (fixture: F) => Pick<Profile, 'cells'> | null | undefined = getProfile): string | null {
  const total = countUnits(fixtures, profileOf);
  if (total <= MAX_UNITS) return null;
  return `The patch would have ${total} lights (cells), more than the ${MAX_UNITS} the engine renders`;
}

export {
  BUILTIN_PROFILE_ID,
  BUILTIN_PROFILE_IDS,
  LEGACY_HUE_PROFILE_IDS,
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
