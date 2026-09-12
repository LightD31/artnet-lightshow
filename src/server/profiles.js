'use strict';

// The profile a new fixture gets, and the fallback for a profile id nothing
// knows about. One of several built-ins — see BUILTIN_PROFILE_IDS.
const BUILTIN_PROFILE_ID = 'cameo-root-par-6-12ch';

// Philips Hue lamps have no DMX address of their own: a Hue channel follows a
// rig fixture and shows its colour (see hue.js), so a Hue-only lamp still needs
// a fixture in the patch to follow. These exist so that fixture does not have
// to be a twelve-channel par standing in for a light bulb — the patch then
// reads as what the rig actually is, and the monitor shows four channels moving
// instead of twelve with eight of them permanently dark.
const HUE_COLOR_PROFILE_ID = 'generic-hue-lamp-7ch';
const HUE_WHITE_AMBIANCE_PROFILE_ID = 'generic-hue-white-ambiance-3ch';
const HUE_WHITE_PROFILE_ID = 'generic-hue-white-lamp-1ch';

// One DMX universe. A fixture patched past it has its writes silently dropped
// by the 512-byte buffer, leaving it half-controllable with no error, so every
// path that sets an address checks against this.
const UNIVERSE_SIZE = 512;

// A show is a handful of fixtures. The cap exists so a stuck client or a
// scripted loop cannot grow the patch (and with it every state broadcast)
// without bound.
const MAX_FIXTURES = 64;

/** Last channel a fixture at `address` with `channelCount` channels occupies. */
function endChannel(address, channelCount) {
  return address + channelCount - 1;
}

/** Does a fixture patched here fit inside the universe? */
function fitsInUniverse(address, channelCount) {
  return address >= 1 && endChannel(address, channelCount) <= UNIVERSE_SIZE;
}

// UV LEDs are physically dimmer than RGBW — boost their DMX value so they
// remain visually competitive at lower dimmer settings.
const UV_BOOST = 1.8;

// Ids that would collide with object-machinery keys. Rejected at registration
// as defence in depth alongside the null-prototype registry below.
const RESERVED_PROFILE_IDS = new Set(['__proto__', 'constructor', 'prototype']);

// Null-prototype map: profile ids come straight from user input (GDTF upload,
// POST /api/profiles), and on a plain object literal an id of "__proto__" would
// reassign this object's prototype instead of adding a key.
const fixtureProfiles = Object.assign(Object.create(null), {
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

  // White and Color Ambiance bulbs, light strips and Play bars — the lamps most
  // people mean by "a Hue light". The hardware is RGBWW: red, green and blue
  // dies plus a warm white and a cool white one, which is how the same bulb can
  // do saturated colour *and* tunable white from 2000K to 6500K.
  //
  // Modelling only RGB would throw away real show content rather than merely
  // being imprecise. The colour presets carry most of their white in the white
  // and amber components — "Cool White" is r0 g30 b80 with white at full — so a
  // profile with no white channels rendered it as a dim dark blue. The white
  // dies have to be in the patch for that content to survive.
  //
  // What the bridge receives is still RGB: the Entertainment stream has no
  // white channel, so these fold into the colour that goes out (see
  // hueChannelColors) and the lamp's own firmware decides which dies to light.
  // The profile describes the lamp; the transport is a separate question.
  //
  // Two channels here are not emitters the lamp has, and the difference between
  // them is the whole rule:
  //
  //   UV is carried because it produces something. A Hue lamp cannot emit UV,
  //   but the deep violet a UV wash looks like is a real approximation of it.
  //   Without the channel the show's UV content has nowhere to land, and every
  //   Hue lamp goes black for the length of a UV look while the pars glow —
  //   which reads as a dead lamp, not as an effect.
  //
  //   Strobe is left out because it produces nothing. The bridge interpolates
  //   between the frames it is sent, so a strobe value is discarded on arrival.
  //   A channel that cannot do anything is worse than no channel: it reads as a
  //   feature that is broken rather than one the hardware does not have.
  //
  // There is no separate amber channel either, and none is needed: the show's
  // warm content already drives the warm white die (see engine.js).
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

  // White Ambiance bulbs: tunable white, no colour dies at all. Balancing the
  // two whites is the whole of what they do, so they get both channels and no
  // primaries.
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

  // Plain Hue White bulbs: one fixed warm white die that dims, and nothing
  // else. One channel is the honest description, and the Hue output already
  // treats a fixture with no colour channels as neutral white at its dimmer
  // level — so this needs no special case anywhere, it simply says what the
  // lamp is.
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

// Every profile that ships with the server. None of them may be deleted, and
// loading a show must not wipe them: a show file carries only the profiles it
// brought with it, so anything built in has to survive the swap or a fixture
// referencing one would land on the fallback instead.
const BUILTIN_PROFILE_IDS = new Set([
  BUILTIN_PROFILE_ID,
  HUE_COLOR_PROFILE_ID,
  HUE_WHITE_AMBIANCE_PROFILE_ID,
  HUE_WHITE_PROFILE_ID,
]);

/** Does this profile ship with the server, rather than being imported? */
function isBuiltinProfile(id) {
  return BUILTIN_PROFILE_IDS.has(id);
}

function getProfile(fixture) {
  return fixtureProfiles[fixture.profileId] || fixtureProfiles[BUILTIN_PROFILE_ID];
}

function registerProfile(profile) {
  if (!profile || !profile.id || !profile.name || !profile.channelCount) return false;
  if (RESERVED_PROFILE_IDS.has(profile.id)) return false;
  fixtureProfiles[profile.id] = profile;
  return true;
}

function unregisterProfile(id) {
  if (isBuiltinProfile(id)) return false;
  delete fixtureProfiles[id];
  return true;
}

function listProfiles() {
  return fixtureProfiles;
}

function clearNonBuiltinProfiles() {
  Object.keys(fixtureProfiles).forEach((id) => {
    if (!isBuiltinProfile(id)) delete fixtureProfiles[id];
  });
}

module.exports = {
  BUILTIN_PROFILE_ID,
  BUILTIN_PROFILE_IDS,
  HUE_COLOR_PROFILE_ID,
  HUE_WHITE_AMBIANCE_PROFILE_ID,
  HUE_WHITE_PROFILE_ID,
  isBuiltinProfile,
  UNIVERSE_SIZE,
  MAX_FIXTURES,
  endChannel,
  fitsInUniverse,
  UV_BOOST,
  RESERVED_PROFILE_IDS,
  getProfile,
  registerProfile,
  unregisterProfile,
  listProfiles,
  clearNonBuiltinProfiles,
};
