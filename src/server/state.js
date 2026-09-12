'use strict';

const { BUILTIN_PROFILE_ID, BUILTIN_PROFILE_IDS, getProfile, listProfiles } = require('./profiles');
const { settings } = require('./settings');
const universes = require('./universes');
const {
  COLOR_PRESETS,
  PATTERNS,
  STROBE_FUNCTIONS,
  ENERGY_EFFECTS,
  SYNC_OFFSET_LIMIT_MS,
} = require('./presets');
const { PALETTES } = require('./palettes');

const DEFAULT_ADDRESSES = [1, 13, 25, 37];

const state = {
  // Seeded from the settings store at boot. Live edits go through applyPatch
  // (the Art-Net panel on the main page) and are persisted back by server.js,
  // so the two never drift.
  //
  // `artnet.universe` is the rig's *default* universe: it seeds new fixtures,
  // and fixtures sitting on it follow when it changes (see setDefaultUniverse).
  // A fixture moved somewhere else stays where it was put.
  artnet: settings.group('artnet'),
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
  // The named look the four colour slots came from, or null once any slot has
  // been written by hand. Only a label — the slots are the truth.
  palette: null,
  // Mirrors the auto show's energy slider. The generated show owns the value;
  // this copy is what the MIDI surface reads to light an encoder ring and what
  // a client sees without asking the auto-show module.
  autoIntensity: 50,
  // Milliseconds the light show runs ahead of the reported track position.
  // A rig calibration rather than a look, so it is seeded from settings and
  // written back there whenever it changes — see patch.js.
  autoSyncOffsetMs: settings.group('auto').syncOffsetMs,
  prolinkEnabled: false,
  autoSource: 'auto',
  autoPrefetchDepth: 1,
  fixtures: [],
  showDynamics: null,
  _step: 0,
  _pingDir: 1,
  _hue: 0,
  _fadePhase: 0,
  _hitPhase: 1,
  _twinkle: new Array(4).fill(0),
};

state.fixtures = Array.from({ length: 4 }, (_, i) => ({
  id: i,
  label: `PAR ${i + 1}`,
  address: DEFAULT_ADDRESSES[i],
  universe: state.artnet.universe,
  profileId: BUILTIN_PROFILE_ID,
  // A trim, not a look: scales everything this fixture outputs, whatever is
  // driving it. 255 is "no trim"; 128 is "half as bright at every level".
  maxBrightness: 255,
  override: null,
}));

/** A fixture's brightness trim, tolerating a show saved before there was one. */
function maxBrightnessOf(fixture) {
  return Number.isInteger(fixture.maxBrightness) ? fixture.maxBrightness : 255;
}

/** The universe a fixture lives on, tolerating a show saved before universes. */
function universeOf(fixture) {
  return Number.isInteger(fixture.universe) ? fixture.universe : state.artnet.universe;
}

/**
 * Every universe the engine has to transmit.
 *
 * The default universe is always in the list: a rig with no fixtures patched
 * on it still needs a frame going out, or a node that was streaming a moment
 * ago is left holding its last look.
 */
function activeUniverses() {
  const active = new Set([state.artnet.universe]);
  for (const fix of state.fixtures) active.add(universeOf(fix));
  return [...active].sort((a, b) => a - b);
}

/**
 * How many distinct universes a proposed fixture list would span, counting the
 * default universe (which is always transmitted). Used to hold edits to the
 * output cap before they reach the render loop.
 */
function countUniverses(fixtures) {
  const seen = new Set([state.artnet.universe]);
  for (const fix of fixtures) {
    seen.add(Number.isInteger(fix.universe) ? fix.universe : state.artnet.universe);
  }
  return seen.size;
}

/**
 * Move the rig's default universe.
 *
 * Fixtures on the old default follow it — before universes existed the Art-Net
 * panel's universe field *was* the rig's universe, and an operator changing it
 * still means "put the rig over there". Fixtures deliberately patched onto
 * another universe are left alone.
 */
function setDefaultUniverse(next) {
  const previous = state.artnet.universe;
  if (next === previous) return;
  for (const fix of state.fixtures) {
    if (universeOf(fix) === previous) fix.universe = next;
  }
  state.artnet.universe = next;
}

function getFixtureCount() { return state.fixtures.length; }

/** How many channels of `universe` are worth showing in the monitor. */
function getDmxSnapshotSize(universe) {
  let maxEnd = 0;
  for (const fix of state.fixtures) {
    if (universeOf(fix) !== universe) continue;
    const profile = getProfile(fix);
    const end = fix.address - 1 + profile.channelCount;
    if (end > maxEnd) maxEnd = end;
  }
  return Math.min(universes.UNIVERSE_SIZE, maxEnd);
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
    palettes: PALETTES,
    // Which profiles ship with the server. The UI needs this to know which ones
    // it must not offer to delete — it used to test against the one built-in id
    // it had hardcoded, which stopped being the whole truth once the Hue lamp
    // profiles arrived and left them showing a Remove button the server refuses.
    builtinProfileIds: [...BUILTIN_PROFILE_IDS],
    // So the sync control can size itself from the server's limit rather than
    // carrying a second copy of the number that silently drifts.
    syncOffsetLimitMs: SYNC_OFFSET_LIMIT_MS,
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
    palette: state.palette,
    autoIntensity: state.autoIntensity,
    autoSyncOffsetMs: state.autoSyncOffsetMs,
    autoSource: state.autoSource,
    autoPrefetchDepth: state.autoPrefetchDepth,
    universes: activeUniverses(),
    fixtures: state.fixtures.map((f) => ({
      ...f,
      universe: universeOf(f),
      maxBrightness: maxBrightnessOf(f),
    })),
    profiles: { ...listProfiles() },
    ...extrasProvider(),
  };
}

/**
 * Live DMX values for the high-rate `dmx` channel, keyed by universe.
 *
 * An object rather than the old flat array: with fixtures spread across
 * universes there is no single 512-channel picture to send, and the monitor
 * needs to know which universe a value belongs to.
 */
function getDmxSnapshot() {
  const out = {};
  for (const universe of activeUniverses()) {
    const size = getDmxSnapshotSize(universe);
    out[universe] = Array.from(universes.getBuffer(universe).subarray(0, size));
  }
  return out;
}

// Full snapshot: GET /api/state and the initial push on socket connect. It is
// exactly the three parts the incremental channels carry, reassembled — spelling
// the fields out a second time only created two lists to keep in sync, and they
// had already drifted once.
function getClientState() {
  return {
    ...getLiveState(),
    ...getCatalogs(),
    dmxSnapshot: getDmxSnapshot(),
  };
}

module.exports = {
  state,
  universeOf,
  maxBrightnessOf,
  activeUniverses,
  countUniverses,
  setDefaultUniverse,
  getFixtureCount,
  getDmxSnapshotSize,
  getClientState,
  getLiveState,
  getCatalogs,
  getDmxSnapshot,
  setExtrasProvider,
};
