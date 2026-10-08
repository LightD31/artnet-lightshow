import { BUILTIN_PROFILE_ID, BUILTIN_PROFILE_IDS, getProfile, listProfiles } from './profiles.ts';
import { settings } from './settings.ts';
import * as universes from './universes.ts';
import { COLOR_PRESETS, PATTERNS, PRESET_ROWS, STROBE_FUNCTIONS, ENERGY_EFFECTS, SYNC_OFFSET_LIMIT_MS } from './presets.ts';
import { ALL_PALETTES } from './palette-catalogue.ts';
import type { PaletteBody } from '../shared/palette-model.ts';
import { PALETTES } from './palettes.ts';
import { conductor } from './conductor.ts';
import { isArmed } from './armed.ts';
import { safety } from './safety.ts';
import { HttpError } from '../errors.ts';
import { footprintOf, universesOf, isInternalUniverse, placeAddressless } from '../shared/placement.ts';
import { FAMILIES } from '../shared/effects/index.ts';
import { toHex } from '../shared/effects/palette.ts';
import { HOLD_STROBE } from '../shared/look-math.ts';
import { VoiceManager } from './voices.ts';
import { EnergyHold } from './energy-hold.ts';
import { Strobe, STROBE_VOICE_ID } from './strobe.ts';
import { MatrixBoard } from './matrix.ts';
import type { Settings } from './settings.ts';
import type { ClockSource, TempoMode } from './conductor.ts';
import type { Colour, Fixture, PixelMap, Profile, ShowDynamics } from '../types/rig.ts';

/** Where a running pattern counts its steps from, in the clock epoch it belongs to (patch.ts). */
export interface PatternAnchor {
  step: number;
  epoch: number;
}

export interface ShowState {
  artnet: Settings['artnet'];
  bpm: number;
  /** Whether the clock follows the music or holds `bpm` (settings `clock.tempoMode`). */
  tempoMode: TempoMode;
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
  /** The latched energy effect's id, or null; read off its voice (latchEnergy), held over or not. */
  energyOverride: string | null;
  /** The energy effect playing over the latch, or null: the energy hold's, a pad's or the API's (energy-hold.ts over()). */
  heldEnergy: string | null;
  palette: string | null;
  /** Colours every effect plays instead of its own and the slots (Light DJ's active palette), or null. */
  paletteOverride: Colour[] | null;
  paletteOverrideId: string | null;
  basePalette: PaletteBody | null;
  overridePalette: PaletteBody | null;
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
  panelPattern: string | null;
  patternAnchor: PatternAnchor | null;
}

/** A fixture as a client sees it: its universe and trim filled in. */
export type ClientFixture = Fixture & { universe: number; maxBrightness: number };

const DEFAULT_ADDRESSES = [1, 13, 25, 37];

const state: ShowState = {
  // The default universe: new fixtures land on it, and fixtures on it follow it (setDefaultUniverse).
  artnet: settings.group('artnet'),
  bpm: 120,
  // The clock's own default, not the stored value: the applier puts that back
  // at start through applyPatch, which tells the clock as well (apply.ts).
  tempoMode: 'auto',
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
  // Only a label for the look the slots came from: null once a slot is written by hand.
  palette: null,
  // Rolled once when set, so a palette's random entries do not re-roll each frame.
  paletteOverride: null,
  paletteOverrideId: null,
  basePalette: null,
  overridePalette: null,
  autoIntensity: 50,
  // A rig calibration, not a look, so it lives in settings (patch.ts persists it).
  autoSyncOffsetMs: settings.group('auto').syncOffsetMs,
  prolinkEnabled: false,
  autoSource: 'auto',
  autoPrefetchDepth: 1,
  fixtures: [],
  // Hue, MIDI and cues refer to fixtures by id, so ids survive deletes and reorders.
  nextFixtureId: 4,
  showDynamics: null,
  // The auto show's split: the group holding a wash while the rest run the pattern.
  split: null,
  // Across the stage, along each bar, or mirrored about the centre.
  pixelMap: 'stage',
  // The bars' own picture while the pars run `pattern` (null: `pattern` everywhere), and its span.
  pixelPattern: null,
  pixelSpan: null,
  // How far through its span the picture starts, so a build-up's fill carries across its scenes.
  pixelFrom: null,
  // The WLED panels' own picture; null and they are bars like any other.
  panelPattern: null,
  patternAnchor: null,
};

state.fixtures = Array.from({ length: 4 }, (_, i) => ({
  id: i,
  label: `PAR ${i + 1}`,
  address: DEFAULT_ADDRESSES[i],
  universe: state.artnet.universe,
  profileId: BUILTIN_PROFILE_ID,
  // A trim, not a look: 255 is none, 128 halves every level, whatever drives the fixture.
  maxBrightness: 255,
  override: null,
}));

// Every effect over the base look, pads to API, in one manager on the monotonic clock.
const voiceListeners = new Set<() => void>();

const voices = new VoiceManager({
  now: () => performance.now(),
  // The beat the engine reads next, the grid line and the tempo from one reading.
  reading: () => conductor.peek(),
  acknowledged: () => safety.acknowledged(),
  anyRunning: () => state.running || sequenceRuns(),
  onChange: voicesChanged,
  // No route latches a strobe past the configured cap, whichever launches it.
  strobeLatchMs: () => settings.get('safety.strobeMaxLatchSec') * 1000,
});

const legacyEnergy = new EnergyHold(() => {}, voices);
const strobe = new Strobe(voices, settings, safety);
const matrix = new MatrixBoard({ voices, acknowledged: () => safety.acknowledged() });

function voicesChanged(): void {
  legacyEnergy.sync();
  // A latch kept under a strobe hold comes back when the hold ends.
  strobe.sync();
  // The matrix board's voice stopped from outside takes its cells with it.
  matrix.sync();
  mirrorEnergy();
  reconcileFreeClock();
  for (const fn of [...voiceListeners]) {
    try { fn(); } catch (err) { console.warn(`[voices] listener: ${err instanceof Error ? err.message : String(err)}`); }
  }
}

/** The state's energy fields, from their voices: the latch, and any voice of an energy effect over it. */
function mirrorEnergy(): void {
  state.heldEnergy = legacyEnergy.over();
  state.energyOverride = legacyEnergy.latched();
}

// The palette strobe replaces the manual one; clearing leaves it, as scenes and cues clear constantly.
function latchEnergy(effect: string | null): void {
  legacyEnergy.latch(effect);
  if (effect === HOLD_STROBE) voices.stop(STROBE_VOICE_ID);
  mirrorEnergy();
}

/** Called after the state's fields follow each voice change; returns the unsubscribe. */
function onVoicesChange(fn: () => void): () => void {
  voiceListeners.add(fn);
  return () => { voiceListeners.delete(fn); };
}

// What the free clock was last told. It starts running, as the patterns do.
let freeClockRunning = true;

// Whether the sequencer's transport moves (sequencer.ts runs()); false while none is registered.
let sequenceRuns: () => boolean = () => false;

/**
 * Whether the free tap clock runs: while the patterns run, while any voice
 * is launched (one waiting for its grid line too), and while a sequence
 * plays or is paused, so a pad pressed or a sequence played with the
 * patterns stopped still counts its beats — and starts nothing else.
 */
function freeClockRuns(): boolean {
  return state.running || voices.size > 0 || sequenceRuns();
}

/** Register what says whether the sequence moves; the free clock follows it from now. */
function setSequenceRuns(fn: (() => boolean) | null | undefined): void {
  sequenceRuns = typeof fn === 'function' ? fn : () => false;
  reconcileFreeClock();
}

/** `force` tells the clock even when nothing changed. */
function reconcileFreeClock(force = false): void {
  const want = freeClockRuns();
  if (!force && want === freeClockRunning) return;
  freeClockRunning = want;
  conductor.setRunning(want);
}

/** A fixture's brightness trim, tolerating a show saved before there was one. */
function maxBrightnessOf(fixture: Pick<Fixture, 'maxBrightness'>): number {
  return Number.isInteger(fixture.maxBrightness) ? fixture.maxBrightness as number : 255;
}

/** The universe a fixture lives on, tolerating a show saved before universes. */
function universeOf(fixture: Pick<Fixture, 'universe'>): number {
  return Number.isInteger(fixture.universe) ? fixture.universe as number : state.artnet.universe;
}

// The default universe always goes out, or a node streaming a moment ago holds its last look.
function activeUniverses(): number[] {
  const active = new Set([state.artnet.universe]);
  for (const fix of state.fixtures) for (const u of universesOf(universeOf(fix), getProfile(fix))) active.add(u);
  return [...active].sort((a, b) => a - b);
}

// The internal universes hold fixtures with no DMX address and never go out (shared/placement.ts).
function wireUniverses(): number[] {
  return activeUniverses().filter((u) => !isInternalUniverse(u));
}

// Called on every patch change: cheap, and a no-op when nothing moved.
function placeAddresslessFixtures(fixtures: Fixture[] = state.fixtures,
  profileOf: (fixture: Pick<Fixture, 'profileId'>) => Profile = getProfile): boolean {
  return placeAddressless(fixtures, profileOf);
}

// Holds edits to the output cap before the render loop; profileOf can be an incoming show's profiles.
function countUniverses(fixtures: readonly Pick<Fixture, 'universe' | 'profileId'>[],
  profileOf: (fixture: Pick<Fixture, 'profileId'>) => Profile = getProfile): number {
  const seen = new Set([state.artnet.universe]);
  for (const fix of fixtures) {
    const universe = Number.isInteger(fix.universe) ? fix.universe as number : state.artnet.universe;
    for (const u of universesOf(universe, profileOf(fix))) seen.add(u);
  }
  return seen.size;
}

// Fixtures on the old default follow ("put the rig over there"); ones patched elsewhere stay.
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

/**
 * The musical clock as the live state carries it: what it follows and its
 * tempo (conductor.ts), and for screens that keep their own beat in phase
 * with the rig — the visuals — where the beat is, its epoch, and the wall
 * clock when that was read, `at`. Such a screen carries it on as
 * beatPos + (now − at) / 60000 × bpm. The beat moves on every read; the
 * publisher sends it only when that carrying-on would miss it (protocol.ts).
 */
function clockState(): { source: ClockSource; bpm: number; byHand: boolean; beatPos: number; epoch: number; at: number } {
  const { beatPos, epoch } = conductor.phase();
  const at = Date.now();
  // byHand: a tempo taken by hand holds the music off, so the screens offer Follow.
  return { ...conductor.status(), byHand: conductor.byHand(), beatPos, epoch, at };
}

// Returns the snapshot the UI consumes. Heavyweight fields (autoShow, prolink,
// spotify) are filled in by integrations.js via injectExtras.
let extrasProvider: () => Record<string, unknown> = () => ({});

function setExtrasProvider(fn: () => Record<string, unknown>): void { extrasProvider = fn; }

let sequenceProvider: () => unknown = () => null;

function getSequenceStatus(): unknown {
  return sequenceProvider();
}

function setSequenceProvider(fn: (() => unknown) | null | undefined): void {
  sequenceProvider = typeof fn === 'function' ? fn : () => null;
}

// One id space: `pattern` may name a legacy pattern or a built-in effect preset.
const PATTERN_CATALOG = [...PATTERNS, ...PRESET_ROWS];

// Fixed at boot, so sent once per connection rather than in every broadcast.
function getCatalogs() {
  return {
    colorPresets: COLOR_PRESETS,
    patterns: PATTERN_CATALOG,
    energyEffects: ENERGY_EFFECTS,
    strobeFunctions: STROBE_FUNCTIONS,
    palettes: PALETTES,
    families: FAMILIES,
    builtinPalettes: ALL_PALETTES,
    // Which profiles ship with the server. The UI needs this to know which ones
    // it must not offer to delete rather than hardcoding the ids, which drift.
    builtinProfileIds: [...BUILTIN_PROFILE_IDS],
    // So the sync control can size itself from the server's limit rather than
    // carrying a second copy of the number that silently drifts.
    syncOffsetLimitMs: SYNC_OFFSET_LIMIT_MS,
  };
}

// The catalogues go once on connect and dmxSnapshot on its own channel, so neither is here.
function getLiveState() {
  return {
    // Copies, not references: these leave the module.
    artnet: { ...state.artnet },
    bpm: state.bpm,
    // What the pattern clock is locked to right now — the auto show's grid, a
    // CDJ, the playing track, or the operator's own tempo — the tempo it is
    // keeping, and where its beat is. See clockState().
    clock: clockState(),
    // Whether that is the music's tempo or the operator's held one.
    tempoMode: state.tempoMode,
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
    panelPattern: state.panelPattern,
    energyOverride: state.heldEnergy ?? state.energyOverride,
    // The hidden latch under a hold too.
    voices: voices.list(),
    palette: state.palette,
    // Hex on the wire, as a palette is written everywhere else.
    paletteOverride: state.paletteOverride ? state.paletteOverride.map(toHex) : null,
    paletteOverrideId: state.paletteOverrideId,
    basePalette: state.basePalette,
    overridePalette: state.overridePalette,
    safety: safety.status(),
    strobe: strobe.status(),
    matrix: matrix.status(),
    autoIntensity: state.autoIntensity,
    autoSyncOffsetMs: state.autoSyncOffsetMs,
    autoSource: state.autoSource,
    autoPrefetchDepth: state.autoPrefetchDepth,
    universes: wireUniverses(),
    // Companion lights its arm button by this.
    armed: isArmed(),
    fixtures: state.fixtures.map((f) => ({
      ...f,
      universe: universeOf(f),
      maxBrightness: maxBrightnessOf(f),
      position: f.position ? { ...f.position } : null,
    })),
    profiles: { ...listProfiles() },
    // How a Hue lamp takes a flash (renderer.ts), and the flash limits each
    // kind of output and each product can follow (shared/hardware.ts).
    hueStrobe: settings.group('hue').strobe ?? 'flash',
    hardware: settings.group('hardware'),
    sequence: sequenceProvider(),
    // The bridges a Hue lamp's output can name, for the patch table and the
    // inspector to show the lamp's bridge by its label. Never the keys.
    hueBridges: settings.group('hue').bridges.map(({ id, label, host, enabled }) => ({ id, label, host, enabled })),
    ...extrasProvider(),
  };
}

// Keyed by universe, internal ones too: the swatches and stage show a Hue lamp's colour from them.
function getDmxSnapshot(): Record<number, number[]> {
  const out: Record<number, number[]> = {};
  for (const universe of activeUniverses()) {
    const size = getDmxSnapshotSize(universe);
    out[universe] = Array.from(universes.getBuffer(universe).subarray(0, size));
  }
  return out;
}

// Views onto the engine's buffers, for the binary DMX feed (shared/dmx-frame.ts).
function getDmxUniverses(): [number, Uint8Array][] {
  return activeUniverses().map((universe) => [universe, universes.getBuffer(universe).subarray(0, getDmxSnapshotSize(universe))]);
}

// The three incremental parts reassembled, so there is no second field list to drift.
function getClientState() {
  return {
    ...getLiveState(),
    ...getCatalogs(),
    dmxSnapshot: getDmxSnapshot(),
  };
}

export {
  state,
  voices,
  legacyEnergy,
  strobe,
  matrix,
  latchEnergy,
  onVoicesChange,
  freeClockRuns,
  reconcileFreeClock,
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
  clockState,
  getCatalogs,
  getDmxSnapshot,
  getDmxUniverses,
  setExtrasProvider,
  setSequenceProvider,
  setSequenceRuns,
  getSequenceStatus,
};
