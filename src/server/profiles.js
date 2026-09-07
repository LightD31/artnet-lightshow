'use strict';

const BUILTIN_PROFILE_ID = 'cameo-root-par-6-12ch';

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
});

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
  if (id === BUILTIN_PROFILE_ID) return false;
  delete fixtureProfiles[id];
  return true;
}

function listProfiles() {
  return fixtureProfiles;
}

function clearNonBuiltinProfiles() {
  Object.keys(fixtureProfiles).forEach((id) => {
    if (id !== BUILTIN_PROFILE_ID) delete fixtureProfiles[id];
  });
}

module.exports = {
  BUILTIN_PROFILE_ID,
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
