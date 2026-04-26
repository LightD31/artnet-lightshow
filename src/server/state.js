'use strict';

const { BUILTIN_PROFILE_ID, getProfile, listProfiles } = require('./profiles');
const {
  COLOR_PRESETS,
  PATTERNS,
  STROBE_FUNCTIONS,
  ENERGY_EFFECTS,
} = require('./presets');

const DEFAULT_ADDRESSES = [1, 13, 25, 37];

const state = {
  artnet: {
    host: process.env.ARTNET_HOST || '2.255.255.255',
    port: Number.parseInt(process.env.ARTNET_PORT, 10) || 6454,
    universe: Number.parseInt(process.env.ARTNET_UNIVERSE, 10) || 0,
  },
  bpm: 120,
  beatDivision: 1,
  running: true,
  pattern: 'chase',
  colorA: 0,
  colorB: 6,
  colorC: 4,
  colorD: 8,
  masterDimmer: 255,
  masterBlackout: false,
  strobeSpeed: 0,
  strobeFunction: 'standard',
  energyOverride: null,
  prolinkEnabled: false,
  autoSource: 'auto',
  fixtures: Array.from({ length: 4 }, (_, i) => ({
    id: i,
    label: `PAR ${i + 1}`,
    address: DEFAULT_ADDRESSES[i],
    profileId: BUILTIN_PROFILE_ID,
    override: null,
  })),
  _step: 0,
  _pingDir: 1,
  _hue: 0,
  _fadePhase: 0,
  _hitPhase: 1,
  _twinkle: new Array(4).fill(0),
};

const dmx = Buffer.alloc(512, 0);

function getFixtureCount() { return state.fixtures.length; }

function getDmxSnapshotSize() {
  let maxEnd = 0;
  for (const fix of state.fixtures) {
    const profile = getProfile(fix);
    const end = fix.address - 1 + profile.channelCount;
    if (end > maxEnd) maxEnd = end;
  }
  return Math.min(512, maxEnd);
}

// Returns the snapshot the UI consumes. Heavyweight fields (autoShow, prolink,
// spotify) are filled in by integrations.js via injectExtras.
let extrasProvider = () => ({});

function setExtrasProvider(fn) { extrasProvider = fn; }

function getClientState() {
  return {
    artnet: state.artnet,
    bpm: state.bpm,
    beatDivision: state.beatDivision,
    running: state.running,
    pattern: state.pattern,
    colorA: state.colorA,
    colorB: state.colorB,
    colorC: state.colorC,
    colorD: state.colorD,
    masterDimmer: state.masterDimmer,
    masterBlackout: state.masterBlackout,
    strobeSpeed: state.strobeSpeed,
    strobeFunction: state.strobeFunction,
    energyOverride: state.energyOverride,
    autoSource: state.autoSource,
    fixtures: state.fixtures,
    profiles: listProfiles(),
    colorPresets: COLOR_PRESETS,
    patterns: PATTERNS,
    energyEffects: ENERGY_EFFECTS,
    strobeFunctions: STROBE_FUNCTIONS,
    dmxSnapshot: Array.from(dmx.slice(0, getDmxSnapshotSize())),
    ...extrasProvider(),
  };
}

module.exports = {
  state,
  dmx,
  getFixtureCount,
  getDmxSnapshotSize,
  getClientState,
  setExtrasProvider,
};
