'use strict';

const BUILTIN_PROFILE_ID = 'cameo-root-par-6-12ch';

// UV LEDs are physically dimmer than RGBW — boost their DMX value so they
// remain visually competitive at lower dimmer settings.
const UV_BOOST = 1.8;

const fixtureProfiles = {
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
};

function getProfile(fixture) {
  return fixtureProfiles[fixture.profileId] || fixtureProfiles[BUILTIN_PROFILE_ID];
}

function registerProfile(profile) {
  if (!profile || !profile.id || !profile.name || !profile.channelCount) return false;
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
  UV_BOOST,
  getProfile,
  registerProfile,
  unregisterProfile,
  listProfiles,
  clearNonBuiltinProfiles,
};
