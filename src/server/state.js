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
  autoPrefetchDepth: 1,
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

// The static half of the snapshot: fixed at boot and identical on every
// broadcast. It was 63% of a 7 KB payload going out 10 times a second, so it is
// now sent once per connection instead.
function getCatalogs() {
  return {
    colorPresets: COLOR_PRESETS,
    patterns: PATTERNS,
    energyEffects: ENERGY_EFFECTS,
    strobeFunctions: STROBE_FUNCTIONS,
  };
}

/**
 * The part of the snapshot that actually changes: control state, fixtures,
 * profiles and the integration status blocks. Excludes the static catalogues
 * (sent once on connect) and `dmxSnapshot` (its own high-rate channel).
 */
function getLiveState() {
  return {
    // Copies, not references: these leave the module and are only safe today
    // because everything is JSON-serialised on the way out.
    artnet: { ...state.artnet },
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
    autoPrefetchDepth: state.autoPrefetchDepth,
    fixtures: state.fixtures.map((f) => ({ ...f })),
    profiles: { ...listProfiles() },
    ...extrasProvider(),
  };
}

/** Just the live DMX values, for the high-rate `dmx` channel. */
function getDmxSnapshot() {
  return Array.from(dmx.slice(0, getDmxSnapshotSize()));
}

// Full snapshot: GET /api/state and the initial push on socket connect. Kept
// whole so REST consumers and first-connect behaviour are unchanged.
function getClientState() {
  return {
    artnet: { ...state.artnet },
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
    autoPrefetchDepth: state.autoPrefetchDepth,
    fixtures: state.fixtures.map((f) => ({ ...f })),
    profiles: { ...listProfiles() },
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
  getLiveState,
  getCatalogs,
  getDmxSnapshot,
  setExtrasProvider,
};
