import { BUILTIN_PROFILE_ID, BUILTIN_PROFILE_IDS, HUE_PROFILE_IDS, getProfile, listProfiles } from './profiles.ts';
import { settings } from './settings.ts';
import * as universes from './universes.ts';
import { COLOR_PRESETS, PATTERNS, STROBE_FUNCTIONS, ENERGY_EFFECTS, SYNC_OFFSET_LIMIT_MS } from './presets.ts';
import { PALETTES } from './palettes.ts';
import { conductor } from './conductor.ts';
import { HttpError } from '../errors.ts';
import { footprintOf, universesOf, isInternalUniverse, placeAddressless } from '../shared/placement.ts';
import type { Settings } from './settings.ts';
import type { Fixture, PixelMap, Profile, ShowDynamics } from '../types/rig.ts';

/** Where a running pattern counts its steps from (see patch.ts). */
export interface PatternAnchor {
  step: number;
  /** The musical clock's epoch the step belongs to. */
  epoch: number;
}

/** The live show: the look, the masters, the patch. */
export interface ShowState {
  artnet: Settings['artnet'];
  bpm: number;
  beatDivision: number;
  running: boolean;
  pattern: string;
  colorA: number;
  colorB: number;
  colorC: number;
  colorD: number;
  masterDimmer: number;
  masterBlackout: boolean;
  /** Three large-area flashes a second at most (settings `safety.flashLimit`). */
  flashLimit: boolean;
  strobeSpeed: number;
  strobeFunction: string;
  /** An energy effect's id, or null. */
  energyOverride: string | null;
  heldEnergy: string | null;
  palette: string | null;
  autoIntensity: number;
  autoSyncOffsetMs: number;
  prolinkEnabled: boolean;
  autoSource: string;
  autoPrefetchDepth: number;
  fixtures: Fixture[];
  nextFixtureId: number;
  showDynamics: ShowDynamics | null;
  split: number | null;
  pixelMap: PixelMap;
  pixelPattern: string | null;
  pixelSpan: number | null;
  pixelFrom: number | null;
  patternAnchor: PatternAnchor | null;
}

/** A fixture as a client sees it: its universe and trim filled in. */
export type ClientFixture = Fixture & { universe: number; maxBrightness: number };

const DEFAULT_ADDRESSES = [1, 13, 25, 37];

const state: ShowState = {
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
  flashLimit: settings.group('safety').flashLimit,
  strobeSpeed: 0,
  strobeFunction: 'standard',
  energyOverride: null,
  heldEnergy: null,
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
  // Fixture ids are references used by Hue, MIDI and cues. They never change
  // when a fixture is deleted or reordered in the patch array.
  nextFixtureId: 4,
  showDynamics: null,
  // A split look from the auto show: which fixture group holds a wash while
  // the rest run the pattern. Null is the whole rig on the pattern.
  split: null,
  // How a pattern is laid over the rig: across the stage, along each bar, or
  // mirrored about the centre (a chase runs from the middle out to both ends
  // at once, bars or pars). Along each bar means nothing on a rig of pars.
  pixelMap: 'stage',
  // The picture the LED bars draw while the pars run `pattern` — the auto
  // show gives the pars the colour and the bars the movement — and how many
  // beats it takes to play once when it plays once (a build-up's fill). Null
  // runs `pattern` on the whole rig, and the span is then `pattern`'s: a rig
  // of pars fills over a build-up too.
  pixelPattern: null,
  pixelSpan: null,
  // How far through its span that picture already is when the scene starts:
  // a build-up's fill carries on across the scenes inside the build.
  pixelFrom: null,
  // Where the running pattern counts its steps from, on the step grid of the
  // musical clock, and which of the clock's epochs that grid belongs to. Set
  // when a scene changes the pattern or the division (patch.js); the engine
  // re-anchors when the music jumps. See src/shared/beat-clock.js.
  patternAnchor: null,
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
function maxBrightnessOf(fixture: Pick<Fixture, 'maxBrightness'>): number {
  return Number.isInteger(fixture.maxBrightness) ? fixture.maxBrightness as number : 255;
}

/** The universe a fixture lives on, tolerating a show saved before universes. */
function universeOf(fixture: Pick<Fixture, 'universe'>): number {
  return Number.isInteger(fixture.universe) ? fixture.universe as number : state.artnet.universe;
}

/**
 * Every universe the engine has to transmit.
 *
 * The default universe is always in the list: a rig with no fixtures patched
 * on it still needs a frame going out, or a node that was streaming a moment
 * ago is left holding its last look.
 */
function activeUniverses(): number[] {
  const active = new Set([state.artnet.universe]);
  for (const fix of state.fixtures) for (const u of universesOf(universeOf(fix), getProfile(fix))) active.add(u);
  return [...active].sort((a, b) => a - b);
}

/**
 * The universes that go out on the wire: every active one but the server's
 * own, which hold the fixtures with no DMX address (shared/placement.ts).
 */
function wireUniverses(): number[] {
  return activeUniverses().filter((u) => !isInternalUniverse(u));
}

/**
 * Put the fixtures with no DMX address (Hue lamps) on the internal universes.
 * Called whenever the patch changes; cheap, and a no-op when nothing moved.
 */
function placeAddresslessFixtures(fixtures: Fixture[] = state.fixtures,
  profileOf: (fixture: Pick<Fixture, 'profileId'>) => Profile = getProfile): boolean {
  return placeAddressless(fixtures, profileOf);
}

/**
 * How many distinct universes a proposed fixture list would span, counting the
 * default universe (which is always transmitted) and every universe a long
 * strip runs on into. Used to hold edits to the output cap before they reach
 * the render loop. `profileOf` resolves a fixture's profile — the live
 * registry by default, or the profiles a show is bringing with it.
 */
function countUniverses(fixtures: readonly Pick<Fixture, 'universe' | 'profileId'>[],
  profileOf: (fixture: Pick<Fixture, 'profileId'>) => Profile = getProfile): number {
  const seen = new Set([state.artnet.universe]);
  for (const fix of fixtures) {
    const universe = Number.isInteger(fix.universe) ? fix.universe as number : state.artnet.universe;
    for (const u of universesOf(universe, profileOf(fix))) seen.add(u);
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
function setDefaultUniverse(next: number): void {
  const previous = state.artnet.universe;
  if (next === previous) return;
  for (const fix of state.fixtures) {
    if (universeOf(fix) === previous) fix.universe = next;
  }
  state.artnet.universe = next;
}

function getFixtureCount(): number { return state.fixtures.length; }

function getFixture(id: number): Fixture | null {
  return state.fixtures.find((fixture) => fixture.id === id) || null;
}

function allocateFixtureId(): number {
  const highest = state.fixtures.reduce((max, fixture) => Math.max(max, fixture.id), -1);
  const id = Math.max(state.nextFixtureId, highest + 1);
  if (!Number.isSafeInteger(id) || id >= Number.MAX_SAFE_INTEGER) {
    throw new HttpError(400, 'No more fixture ids available');
  }
  state.nextFixtureId = id + 1;
  return id;
}

/** How many channels of `universe` are worth showing in the monitor. */
function getDmxSnapshotSize(universe: number): number {
  let maxEnd = 0;
  for (const fix of state.fixtures) {
    for (const part of footprintOf(universeOf(fix), fix.address, getProfile(fix))) {
      if (part.universe === universe && part.last > maxEnd) maxEnd = part.last;
    }
  }
  return Math.min(universes.UNIVERSE_SIZE, maxEnd);
}

// Returns the snapshot the UI consumes. Heavyweight fields (autoShow, prolink,
// spotify) are filled in by integrations.js via injectExtras.
let extrasProvider: () => Record<string, unknown> = () => ({});

function setExtrasProvider(fn: () => Record<string, unknown>): void { extrasProvider = fn; }

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
    // The profiles that stand for a Hue lamp: a fixture on one has no DMX
    // address by default, so the patch does not ask for one.
    hueProfileIds: [...HUE_PROFILE_IDS],
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
    // What the pattern clock is locked to right now — the auto show's grid, a
    // CDJ, the playing track, or the operator's own tempo — and the tempo it
    // is keeping. See conductor.js.
    clock: conductor.status(),
    beatDivision: state.beatDivision,
    running: state.running,
    pattern: state.pattern,
    colorA: state.colorA,
    colorB: state.colorB,
    colorC: state.colorC,
    colorD: state.colorD,
    masterDimmer: state.masterDimmer,
    masterBlackout: state.masterBlackout,
    flashLimit: state.flashLimit,
    strobeSpeed: state.strobeSpeed,
    strobeFunction: state.strobeFunction,
    pixelMap: state.pixelMap,
    pixelPattern: state.pixelPattern,
    energyOverride: state.heldEnergy ?? state.energyOverride,
    palette: state.palette,
    autoIntensity: state.autoIntensity,
    autoSyncOffsetMs: state.autoSyncOffsetMs,
    autoSource: state.autoSource,
    autoPrefetchDepth: state.autoPrefetchDepth,
    universes: wireUniverses(),
    fixtures: state.fixtures.map((f) => ({
      ...f,
      universe: universeOf(f),
      maxBrightness: maxBrightnessOf(f),
      position: f.position ? { ...f.position } : null,
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
 * needs to know which universe a value belongs to. The server's own universes
 * are in it too: the swatches and the stage show a Hue lamp's colour from
 * them, though they are never sent.
 */
function getDmxSnapshot(): Record<number, number[]> {
  const out: Record<number, number[]> = {};
  for (const universe of activeUniverses()) {
    const size = getDmxSnapshotSize(universe);
    out[universe] = Array.from(universes.getBuffer(universe).subarray(0, size));
  }
  return out;
}

/**
 * The same values as bytes, for the binary DMX feed (shared/dmx-frame.ts):
 * each active universe as a view onto the engine's buffer, up to its last
 * patched channel.
 */
function getDmxUniverses(): [number, Uint8Array][] {
  return activeUniverses().map((universe) => [universe, universes.getBuffer(universe).subarray(0, getDmxSnapshotSize(universe))]);
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

export {
  state,
  universeOf,
  maxBrightnessOf,
  activeUniverses,
  wireUniverses,
  placeAddresslessFixtures,
  countUniverses,
  setDefaultUniverse,
  getFixtureCount,
  getFixture,
  allocateFixtureId,
  getDmxSnapshotSize,
  getClientState,
  getLiveState,
  getCatalogs,
  getDmxSnapshot,
  getDmxUniverses,
  setExtrasProvider,
};
