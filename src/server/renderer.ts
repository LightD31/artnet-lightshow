/**
 * The render core: what the rig puts out for one frame.
 *
 * It reads nothing global. Every frame it is handed a description of the
 * moment — the look, the masters, the patch, any fade or sync test that was
 * asked for (`renderInput` in engine.js builds it from the live state) — and
 * where the music is, and it writes the DMX buffers of a universe store. What
 * it has to remember from one frame to the next is its own: the pattern layer
 * as it last went out, a crossfade in progress, the dice the random patterns
 * last rolled, the smoothed expression channel, the step anchor.
 *
 * That is what lets the same code run in two places. On the main thread it is
 * driven straight from the live state; in the engine's worker thread it is
 * driven from snapshots the main thread posts, and keeps rendering on the last
 * one when the main thread is busy. Either way a frame is the same bytes.
 */

import { fixedColours, colourSlots, resolveGradient } from '../shared/palette-model.ts';
import type { PaletteBody } from '../shared/palette-model.ts';
import { COLOR_PRESETS, STANDARD_STROBE } from './presets.ts';
import { isHueProfile } from '../shared/hue-lamp.ts';
import { outputEmitters } from '../shared/emitter-capability.ts';
import { HardwareClock } from '../shared/hardware-clock.ts';
import { HardwareGuard } from '../shared/hardware-guard.ts';
import { hardwareStrobe } from '../shared/hardware-strobe.ts';
import { hardwareOf } from '../shared/hardware.ts';
import type { HardwareCaps, HardwareSettings } from '../shared/hardware.ts';
import { FRAME_MS } from './frame-clock.ts';
import { PATTERN_FUNCS, paletteOf } from '../shared/patterns.ts';
import { renderLayer } from '../shared/layer.ts';
import { buildRig, rigSignature } from '../shared/rig.ts';
import { cellPlace, channelPlace, stripOf } from '../shared/placement.ts';
// Shared with the browser's rehearsal preview so the two cannot drift.
import { EXPRESSION_REST, blendExpression, blendFixture, cellDrive, HOLD_STROBE } from '../shared/look-math.ts';
import { anchorStep, stepAt, motionAdvance } from '../shared/beat-clock.ts';
import { drawnByTheShow, strobeLevel } from '../shared/strobe-fx.ts';
import { createFlashLimiter, lightLuminance, strobeCap, FLASHES_PER_SECOND } from './flash-limit.ts';
import { identifyLights } from './identify.ts';
import { HD_MASTER_DEFAULTS } from '../shared/effects/types.ts';
import { canonical, effectContentKey, handOverStrobes, hdGuarded, relaunchEffect, renderEffectLayer, renderVoices, voiceAnchor, voiceLaunchKey, voiceLayout } from '../shared/effects/layer.ts';
import { energyEffectSpec } from '../shared/effects/catalogue.ts';
import { endSequence, newSequenceRun, renderSequenceLayer, retable } from '../shared/effects/sequence.ts';
import { kindOf, ridesLevel } from '../shared/effects/registry.ts';
import { EffectStepper } from '../shared/effects/stepper.ts';
import { HdFlashGuard, StrobeLampGuard } from '../shared/effects/flash-guard.ts';
import { strobeFrameOf } from '../shared/effects/strobe.ts';
import { seedFrom } from '../shared/effects/hash.ts';
import type { IdentifyRequest } from './identify.ts';
import type { EnergyLook, UnitLight } from '../shared/look-math.ts';
import type { Layout, Rig } from '../shared/rig.ts';
import type { MusicalTime } from './conductor.ts';
import type { PatternAnchor } from './state.ts';
import type { UniverseStore } from './universes.ts';
import type { AudioFrame } from '../shared/effects/audio-frame.ts';
import type { VoiceFrame, VoiceRecord } from '../shared/effects/layer.ts';
import type { EffectInstance } from '../shared/effects/stepper.ts';
import type { SequenceTable, SequenceTransport } from '../shared/effects/sequence.ts';
import type { AudioMode, EffectCommand, EffectSlot, EffectSpec, FrameBase, HdMaster, Seed } from '../shared/effects/types.ts';
import type { ChannelDefault, ChannelMap, Colour, Expression, Override, PixelMap, Profile, PulseReading, ShowDynamics, StageFixture } from '../types/rig.ts';

export type { VoiceFrame } from '../shared/effects/layer.ts';
// The preview keys its effects the same way; both read it from the shared layer.
export { effectContentKey };

/** A fixture as a frame needs it: its universe and trim resolved. */
export interface RenderFixture extends StageFixture {
  id: number;
  address: number;
  universe: number;
  profileId: string;
  maxBrightness: number;
  override: Override | null;
}

/** A crossfade asked for: from what is on stage at `at`, over `ms`. */
export interface FadeRequest {
  seq: number;
  ms: number;
  at: number;
}

/** The Hue sync test asked for: flash for `seconds` from `at`. */
export interface SyncTestRequest {
  seq: number;
  seconds: number;
  at: number;
}

/** Everything a frame depends on (engine.ts renderInput builds it). */
export interface RenderInput {
  hardware?: HardwareSettings;
  running: boolean;
  pattern: string;
  colorA: number;
  colorB: number;
  colorC: number;
  colorD: number;
  split: number | null;
  pixelMap: PixelMap;
  /** The bars' own picture while the pars run `pattern`, or null. */
  pixelPattern?: string | null;
  pixelSpan?: number | null;
  pixelFrom?: number | null;
  /** The panels' own picture while the bars run `pixelPattern`, or null. */
  panelPattern?: string | null;
  beatDivision: number;
  strobeSpeed: number;
  strobeFunction: string;
  masterDimmer: number;
  masterBlackout: boolean;
  /** Hold the rig to three large-area flashes a second (flash-limit.ts). */
  flashLimit?: boolean;
  /** An energy effect's id, or null. */
  energy: string | null;
  showDynamics: ShowDynamics | null;
  /** The music at pixel rate, while a show with an analysed track runs. */
  pulse?: PulseReading | null;
  patternAnchor: PatternAnchor | null;
  fade: FadeRequest | null;
  syncTest: SyncTestRequest | null;
  /** Fixtures showing themselves on the rig (identify.ts), or null. */
  identify?: IdentifyRequest | null;
  universes: number[];
  fixtures: RenderFixture[];
  /**
   * What the party effects hear this frame (audio-features.ts), the audio
   * mode and Hue Dynamics' master. A hand-built input may leave them out:
   * frame() reads them as no audio, 'tempo' and the master's defaults.
   */
  audio?: AudioFrame | null;
  audioMode?: AudioMode;
  master?: HdMaster;
  /**
   * The base look as an effect, in place of `pattern`'s own picture; null or
   * absent plays the pattern. `effectRevision` changes when the effect is
   * replaced on purpose, so the same content starts again.
   */
  effect?: EffectSpec | null;
  effectRevision?: number;
  /**
   * The voices playing over the base, highest by tier and launch. Absent, the
   * renderer plays `energy` as a voice of its own, as it always played the
   * energy burst; present (even empty), the caller owns every voice.
   */
  voices?: VoiceFrame[];
  /** Colours the effects play instead of their own and the look's, or null. */
  paletteOverride?: Colour[] | null;
  basePalette?: PaletteBody | null;
  overridePalette?: PaletteBody | null;
  safety?: RenderSafety;
  /** How Hue lamps take a flash: 'flash' hard, 'pulse' falling to a floor. Absent is 'pulse', as before the setting. */
  hueStrobe?: 'flash' | 'pulse';
  /**
   * The sequence playing: the revision of the clip table it plays (handed
   * over apart, by setSequence) and where it is. The table plays only while
   * both are given and the revision is the table's own; absent or null, the
   * look plays alone.
   */
  sequenceRevision?: number | null;
  sequenceTransport?: SequenceTransport | null;
}

export interface RenderSafety {
  hdFlashIntervalMs: number;
  acknowledged: boolean;
}

/** What frame() reads for a field a hand-built input leaves out. */
export const RENDER_SAFETY_DEFAULTS: Readonly<RenderSafety> = Object.freeze({ hdFlashIntervalMs: 350, acknowledged: false });

/** A RenderInput with every optional field the effects read filled in, as frame() sees it. */
export type FrameInput = RenderInput & Required<Pick<RenderInput,
  'audio' | 'audioMode' | 'master' | 'effect' | 'voices' | 'paletteOverride' | 'safety' | 'hueStrobe' | 'sequenceRevision' | 'sequenceTransport'>>;

/** The input with its defaults; the caller's object is left as it was. */
export function withInputDefaults(input: RenderInput): FrameInput {
  return {
    ...input,
    audio: input.audio ?? null,
    audioMode: input.audioMode ?? 'tempo',
    master: input.master ?? { ...HD_MASTER_DEFAULTS },
    effect: input.effect ?? null,
    voices: input.voices ?? [],
    paletteOverride: input.paletteOverride ?? null,
    safety: input.safety ?? { ...RENDER_SAFETY_DEFAULTS },
    hueStrobe: input.hueStrobe ?? 'pulse',
    sequenceRevision: input.sequenceRevision ?? null,
    sequenceTransport: input.sequenceTransport ?? null,
  };
}

/**
 * Which base effect a command is meant for: the pattern id it plays under,
 * its revision, and its content without the palette (a palette edit is the
 * same effect playing on). The engine sends it with each command; the
 * renderer applies the command only to a base that still matches.
 */
export interface BaseIntent { pattern: string; revision: number | null; content: string }

/** A command's outcome: applied to the base's state, or why not. */
export type CommandStatus = 'applied' | 'stale' | 'unavailable' | 'unsupported' | 'invalid' | 'duplicate';
export interface CommandResult { seq: number; status: CommandStatus }

const COMMANDS: readonly EffectCommand[] = ['stop', 'comboBreak', 'toggleDirection', 'fadeToBaseline', 'setPulserBaselineColor'];

/** The base effect an input plays, as a command names it; null for a pattern. */
export function baseIntentOf(input: Pick<RenderInput, 'pattern' | 'effect' | 'effectRevision'>): BaseIntent | null {
  if (!input.effect) return null;
  return { pattern: input.pattern, revision: input.effectRevision ?? null, content: effectContentKey(input.effect) };
}

/** A grid origin's phase on the 44 Hz frame grid, 0..FRAME_MS. */
function gridPhaseOf(originMs: number): number {
  const phase = ((originMs % FRAME_MS) + FRAME_MS) % FRAME_MS;
  // A hair under a whole frame is the frame's start.
  return FRAME_MS - phase < 1e-6 ? 0 : phase;
}

/** A command's argument as its kind takes it: null for none, a colour for the baseline; undefined is refused. */
function commandArg(cmd: string, arg: unknown): Colour | null | undefined {
  if (!(COMMANDS as readonly string[]).includes(cmd)) return undefined;
  if (cmd !== 'setPulserBaselineColor') return arg === undefined || arg === null ? null : undefined;
  if (!arg || typeof arg !== 'object') return undefined;
  const c = arg as Record<string, unknown>;
  const byte = (v: unknown, fallback?: number) => {
    const n = v === undefined ? fallback : v;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 255 ? n : NaN;
  };
  const colour = { r: byte(c.r), g: byte(c.g), b: byte(c.b), w: byte(c.w, 0), a: byte(c.a, 0), uv: byte(c.uv, 0) };
  return Object.values(colour).every((v) => !Number.isNaN(v)) ? colour : undefined;
}

/** The universe buffers a frame writes. */
export type FrameStore = Pick<UniverseStore, 'getBuffer' | 'sync' | 'clearAll'>;

/** What the look puts on one light before the masters. */
interface LightValue {
  col: Colour;
  dim: number;
  strobe: number;
}

/** A strobe asked for: its 1–255 value and the function it runs. */
interface StrobeRequest {
  raw: number;
  fnId: string;
  limitHz?: number;
}

type Dmx = Buffer | Uint8Array;

export interface Renderer {
  /**
   * `gridOriginMs`: where the 44 Hz frame grid this frame belongs to starts,
   * on `now`'s clock. The effects count their frames from it. Without it the
   * renderer's own first frame starts the grid.
   */
  frame(input: RenderInput, reading: MusicalTime, now: number, store: FrameStore, gridOriginMs?: number): Rig<RenderFixture>;
  invalidateRig(): void;
  /** Queue a command for the base effect; it is decided at the next frame, in order. */
  command(seq: number, cmd: string, arg?: unknown, intent?: BaseIntent | null): void;
  /** The commands decided since the last call, in order. */
  takeCommandResults(): CommandResult[];
  /** Decide every queued command as `status` without a frame (a worker with nothing to render). */
  rejectCommands(status: CommandStatus): void;
  /** The highest sequence decided (applied or not) and the highest applied. */
  commandStatus(): { processed: number; applied: number };
  /**
   * The loaded sequence's clip table, or null. Kept until replaced: a frame
   * plays it while its input names this table's revision and a transport.
   * A clip that did not change plays on through a new table.
   */
  setSequence(table: SequenceTable | null): void;
}

// Patterns that roll dice. They re-roll when the step moves or the look
// changes — a twinkle redrawn every frame is noise, not a twinkle.
const RANDOM_PATTERNS = new Set(['twinkle', 'sparkle', 'random-flash']);

// The Hue sync test: every fixture flashes white for a tenth of a second,
// once a second, so the pars and the Hue lamps can be filmed side by side and
// the latency setting turned until the two flashes land together.
const SYNC_FLASH_MS = 100;

const blankUnit = (): UnitLight => ({ r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0 });

// ── Software strobe ──────────────────────────────────────────────────────────
// The standard strobe: a fixture with a strobe channel flashes itself — the
// strobe value goes to that channel and the lamp's own electronics do the
// rest. A fixture without one — plenty of LED bars and cheap pars — used to
// sit there steady through the strobe pattern and every strobing burst. It is
// now flashed here instead, by leaving it dark on the frames between flashes.
//
// 1 to 20 flashes a second, as the fixtures' own standard strobe runs, and no
// faster than every other frame. Each flash lasts at least one frame (so none
// falls between two), a third of the period at most, and never more than 50 ms:
// a strobe is a flash, not a blink.
//
// Every other strobe function (the ramps, the random strobe, the burst) is
// drawn here on every fixture, strobe channel or not: a level on the clock
// that the light's brightness is multiplied by (shared/strobe-fx.ts).
const SOFT_STROBE_MIN_HZ = 1;
const SOFT_STROBE_MAX_HZ = Math.min(20, 1000 / (2 * FRAME_MS));
const SOFT_FLASH_MAX_MS = 50;

/** Flashes a second for a strobe value of 1–255. */
function softStrobeHz(raw: number): number {
  return SOFT_STROBE_MIN_HZ + (Math.min(255, raw) / 255) * (SOFT_STROBE_MAX_HZ - SOFT_STROBE_MIN_HZ);
}

// The fastest strobe the flash limit allows, on the same scale: three a
// second. A fixture's own strobe channel is taken to run the same range
// (1–20 Hz, as most LED pars' standard strobe does), since what it actually
// runs at is the fixture's secret.
const FLASH_LIMIT_STROBE = strobeCap(softStrobeHz);

/**
 * Is a fixture on the standard software strobe lit on the frame at `now`?
 * Periodic, on the clock, so every such fixture flashes together.
 */
function softStrobeLit({ raw }: StrobeRequest, now: number): boolean {
  const hz = softStrobeHz(raw);
  const period = 1000 / hz;
  const flash = Math.min(SOFT_FLASH_MAX_MS, Math.max(FRAME_MS, 0.3 * period));
  return ((now % period) + period) % period < flash;
}

/**
 * Write a dimmer level (0–255, fractional) to its channel — as a 16-bit value
 * across the coarse and fine channels when the profile has a fine one. The
 * fine byte used to be written 0, so a 16-bit fixture fading out stepped
 * through 256 levels when it can do 65,536: the steps are what a slow fade
 * into black looks like on an LED.
 */
function writeDimmer(dmx: Dmx, base: number, ch: ChannelMap, level: number): void {
  if (ch.dimmer === undefined) return;
  const clamped = level > 255 ? 255 : (level > 0 ? level : 0);
  if (ch.dimmerFine === undefined) {
    dmx[base + ch.dimmer] = Math.round(clamped);
    return;
  }
  const v16 = Math.round((clamped / 255) * 65535);
  dmx[base + ch.dimmer] = v16 >> 8;
  dmx[base + ch.dimmerFine] = v16 & 0xff;
}

/**
 * Put a profile's undriven channels at their defaults (profileSchema's
 * `defaults`). Written first, so a channel the show drives — a strobe that is
 * open at rest and flashing now — still ends up at the show's value.
 */
function writeDefaults(dmx: Dmx, base: number, defaults: ChannelDefault[] | undefined): void {
  if (!defaults) return;
  for (let i = 0; i < defaults.length; i++) dmx[base + defaults[i].offset] = defaults[i].value;
}

/** writeDefaults for a strip that runs over several universes. */
function writeStripDefaults(store: FrameStore, fix: RenderFixture, strip: NonNullable<ReturnType<typeof stripOf>>,
  defaults: ChannelDefault[] | undefined): void {
  if (!defaults) return;
  for (const { offset, value } of defaults) {
    const place = channelPlace(strip, fix.address, offset);
    store.getBuffer(fix.universe + place.universe)[place.index] = value;
  }
}

/**
 * @param profileOf         fixture → its profile
 * @param profilesRevision  () → a number that changes whenever a profile does
 * @param now               the clock reading the first frame's dt is taken from
 */
function createRenderer({ profileOf, profilesRevision = () => 0, now = performance.now() }: {
  profileOf: (fixture: RenderFixture) => Profile;
  profilesRevision?: () => number;
  now?: number;
}): Renderer {
  // The pattern layer, one entry per light: a par is one, each cell of an LED
  // bar another (see shared/rig.js). On a rig of pars, entry i is fixture i.
  const unitColors = Array.from({ length: 4 }, blankUnit);
  const twinkle = new Array(4).fill(0);
  // The bars' own dice, when they run a picture apart from the pars', and
  // the panels'.
  const pixelTwinkle = new Array(4).fill(0);
  const panelTwinkle = new Array(4).fill(0);

  // ── Crossfades ─────────────────────────────────────────────────────────────
  // The show asks for a fade where the music does — long into a breakdown,
  // none into a drop — and each light blends from what it was last showing to
  // what the new look renders, frame by frame, so a moving pattern keeps
  // moving underneath. Only the pattern layer fades: a burst or a pinned
  // fixture sits on top.
  const shown: UnitLight[] = [];     // the pattern layer as it went out last frame, per light
  let fade: { start: number; ms: number; from: UnitLight[] } | null = null;
  let syncTest: { start: number; until: number } | null = null;
  let identify: { ids: Set<number>; start: number; until: number } | null = null;
  const adopted = { fade: 0, syncTest: 0, identify: 0 };

  // The continuous expression channel, smoothed towards whatever the show last
  // asked for, and how far the expressive patterns have travelled.
  let expression: Expression = { ...EXPRESSION_REST };
  let expressionPhase = 0;
  let lastReading: MusicalTime | null = null;
  let lastNow = now;

  // Where the pattern counts its steps from. The live state carries the anchor
  // a scene set; this is the one in force, which also moves when the music
  // jumps. Only a *new* anchor from the state replaces it.
  let anchor: PatternAnchor | null = null;
  let givenAnchor: PatternAnchor | null = null;
  let lastRandomKey: string | null = null;
  let lastPixelRandomKey: string | null = null;
  let lastPanelRandomKey: string | null = null;

  let rig: Rig<RenderFixture> | null = null;
  let rigKey = '';
  const limiter = createFlashLimiter();

  // ── Effects ────────────────────────────────────────────────────────────────
  // The base effect and the voices keep their state in one stepper, so a
  // preview checkpoint, an expiry and a reset all see the same lifetimes.
  const stepper = new EffectStepper();
  const guard = new HdFlashGuard(RENDER_SAFETY_DEFAULTS.hdFlashIntervalMs);
  // The strobe's permit per lamp, whichever strobe draws it (flash-guard.ts).
  const strobeGuard = new StrobeLampGuard();
  const hardwareGuard = new HardwareGuard();
  const hardwareStrobeGuard = new HardwareGuard();
  const hardwareClock = new HardwareClock();
  let lastSweep = -Infinity;
  // The effects count time from the frame grid's phase, so a frame a few ms
  // early or late is still its own frame (strobe.ts counts in frames).
  let gridPhase: number | null = null;
  let lastEffectNow: number | null = null;
  // Per unit, the kind that drew the base layer; null for a pattern, the wash or black.
  // `baseKinds` says whether any entry may be set, so a rig of patterns pays nothing for it.
  const baseKind: (string | null)[] = [];
  const baseOwner: (string | undefined)[] = [];
  let baseKinds = false;
  // Per unit, the kind on top this frame: what Hue Dynamics' flash limit reads.
  const topKind: (string | null)[] = [];
  let base: {
    key: string; id: string; kind: string; pattern: string; revision: number | null; content: string;
    seed: Seed; startedAtMs: number;
  } | null = null;
  // Each voice id's launch, so a relaunch under the same id starts afresh, and
  // its musical anchor, which moves when the music jumps while its wall times stay.
  const voiceRecords = new Map<string, VoiceRecord>();
  // The strobe voices whose state the stepper holds: one gone hands its permit to the next (layer.ts).
  const strobeTrail = new Set<string>();
  // The energy burst played as a voice for an input that names no voices.
  let compat: { energy: string; voice: VoiceFrame } | null = null;
  // The layouts the effects play on, with each cell's fixture id and Hue flag
  // taken from the patch as it is now (the cached rig keeps the ids it was built with).
  let baseCells: { key: string; layout: Layout; ids: number[] } | null = null;
  let voiceCells: { key: string; layout: Layout; ids: number[] } | null = null;
  let identityKey = '';

  // The sequence's clip table, and what playing it remembers. Per unit, the
  // clip on top this frame (over the look's layer, under overrides and
  // voices) and the kind that drew it; `seqUnits` says whether any is set.
  let sequence: SequenceTable | null = null;
  const seqRun = newSequenceRun();
  const seqLight: (UnitLight | null)[] = [];
  const seqKind: (string | null)[] = [];
  const seqOwner: (string | undefined)[] = [];
  let seqUnits = false;

  // Commands for the base effect: decided at the next frame, in order, once.
  const commandQueue: { seq: number; cmd: string; arg?: unknown; intent: BaseIntent | null }[] = [];
  let commandResults: CommandResult[] = [];
  let processedSeq = 0;
  let appliedSeq = 0;

  /**
   * Every effect starts again: the state and the flash histories. A new grid
   * also forgets the launches and the clock; a new patch, found partway
   * through a frame, keeps this frame's, so its voices start again only once.
   */
  function resetEffects(clock = true): void {
    stepper.reset();
    guard.reset();
    strobeGuard.reset();
    base = null;
    if (!clock) return;
    voiceRecords.clear();
    strobeTrail.clear();
    // A clip's wall origin was on the old clock: its laps start again.
    endSequence(seqRun, stepper);
    lastEffectNow = null;
  }

  /** This frame's time on the effects' clock, which counts from the grid's phase. */
  function effectNow(now: number, gridOriginMs: number | undefined): number {
    let phase = gridPhase;
    if (gridOriginMs !== undefined && Number.isFinite(gridOriginMs)) phase = gridPhaseOf(gridOriginMs);
    else if (phase === null) phase = gridPhaseOf(now);
    if (gridPhase !== null && Math.abs(phase - gridPhase) > 1e-6) {
      // Another grid (the engine restarted): what the effects counted no longer lines up.
      resetEffects();
    }
    gridPhase = phase;
    return now - phase;
  }

  /** Each cell of a layout with its fixture's current id, and its Hue flag as the renderer reads Hue lamps. */
  function effectCells(layout: Layout, rigNow: Rig<RenderFixture>, fixtures: RenderFixture[]): { layout: Layout; ids: number[] } {
    const { list } = layout.units;
    const ids = list.map((u) => fixtures[rigNow.units[u].fixture].id);
    const hue = list.map((u) => hueLamp(fixtures[rigNow.units[u].fixture]));
    const noFlash = hue.some(Boolean) ? hue : null;
    return { layout: { ...layout, units: { ...layout.units, noFlash } }, ids };
  }

  /**
   * The base layout and the voices' layout for this frame. A change of what
   * the patch is (its fixtures, their ids, profiles and places) starts every
   * effect and every lamp's flash history again; the look's split or pixel
   * map only moves the base. Addresses, universes and trims change nothing here.
   */
  function cellsFor(input: FrameInput, rigNow: Rig<RenderFixture>): void {
    const ids = input.fixtures.map((f) => f.id).join(',');
    const identity = `${rigKey}|${ids}`;
    if (identity !== identityKey) {
      if (identityKey) resetEffects(false);
      hardwareClock.clear();
      identityKey = identity;
      baseCells = null;
      voiceCells = null;
    }
    const baseKey = `${input.split}|${input.pixelMap}`;
    if (!baseCells || baseCells.key !== baseKey) baseCells = { key: baseKey, ...effectCells(rigNow.layout(input.split, input.pixelMap), rigNow, input.fixtures) };
    if (!voiceCells) voiceCells = { key: '', ...effectCells(voiceLayout(rigNow), rigNow, input.fixtures) };
  }

  let hardwareKey = '';
  let capabilities: HardwareCaps[] = [];
  let capabilityIndex = new Map<number, number>();
  const inputFixtureIndex = (f: RenderFixture) => capabilityIndex.get(f.id) ?? -1;
  function hardwareFor(input: RenderInput): void {
    if (!input.hardware) { capabilities = []; hardwareKey = ''; hardwareClock.clear(); return; }
    const key = JSON.stringify([profilesRevision(), input.hardware, input.fixtures.map((f) =>
      [f.id, f.profileId, f.productId, f.hardware, f.admission, f.output?.protocol])]);
    if (key !== hardwareKey) {
      hardwareKey = key;
      hardwareClock.clear();
      hardwareGuard.blackout();
      capabilityIndex = new Map(input.fixtures.map((f, i) => [f.id, i]));
      hardwareStrobeGuard.retain(new Set(input.fixtures.map((f) => String(f.id))));
      capabilities = input.fixtures.map((f) => hardwareOf(f, profileOf(f), input.hardware));
    }
  }
  function cellHardware(layout: Layout, rig: Rig): HardwareCaps[] | undefined {
    return capabilities.length ? layout.units.list.map((u) => capabilities[rig.units[u].fixture]) : undefined;
  }

  function frameBaseOf(input: FrameInput, reading: MusicalTime, nowMs: number, dtMs: number, acknowledged: boolean,
    manualStrobeActive: boolean): FrameBase {
    const colours = fixedColours(input.basePalette, [input.colorA, input.colorB, input.colorC, input.colorD].map((i) => COLOR_PRESETS[i]));
    return {
      beatPos: reading.beatPos, bpm: reading.bpm, nowMs, dtMs, anchorBeat: 0,
      lookPalette: input.basePalette?.gradients?.length ? colours : paletteOf({ colors: colours }),
      lookGradient: input.basePalette,
      overrideGradient: input.overridePalette,
      paletteOverride: input.paletteOverride, audio: input.audio, audioMode: input.audioMode, master: input.master,
      seed: [0, 0, 0, 0], acknowledged, hueStrobe: input.hueStrobe, manualStrobeActive, expressionLevel: expression.level,
    };
  }

  /**
   * The base effect's instance for this frame. Its public id and seed come
   * from the look's launch (`base:<pattern>:<anchor step>`); a change of
   * content, revision, layout or launch starts it again, a palette edit does
   * not. The strobe is the exception: its per-lamp permit carries on through
   * a relaunch or an edit, or relaunching a strobe look would outrun its cap.
   */
  function baseInstance(input: FrameInput, anchorStepNow: number, division: number, nowMs: number): EffectInstance {
    const spec = input.effect!;
    const id = `base:${input.pattern}:${anchorStepNow}`;
    const content = effectContentKey(spec);
    const revision = input.effectRevision ?? null;
    // The music jumping re-anchors the look: a new generation even on the step it had.
    const key = canonical([id, revision, content, baseCells!.key, anchor?.epoch ?? null]);
    if (!base || base.key !== key) {
      relaunchEffect(stepper, base, id, spec.kind);
      base = { key, id, kind: spec.kind, pattern: input.pattern, revision, content, seed: seedFrom(id), startedAtMs: nowMs };
    }
    return { id, spec, seed: base.seed, anchorBeat: anchorStepNow / division, startedAtMs: base.startedAtMs, targets: null };
  }

  /** The energy burst as a voice, as /api/energy has always played it: look colour A, every fixture. */
  function compatVoice(input: FrameInput, now: number): VoiceFrame | null {
    const energy = input.energy;
    if (!energy) { compat = null; return null; }
    if (compat && compat.energy === energy) return compat.voice;
    const spec = energyEffectSpec(energy);
    if (!spec) { compat = null; return null; }
    const id = `energy:${energy}`;
    // The hold strobe stays on the global beat grid (anchor 0), as it always flashed.
    compat = { energy, voice: { id, spec, targets: null, tier: energy === HOLD_STROBE ? 'strobe' : 'voice', launchSeq: 0,
      startedAtMs: now, untilMs: null, anchorBeat: 0, seed: seedFrom(id) } };
    return compat.voice;
  }

  /**
   * The voices playing now, on the effects' clock, each with the musical
   * anchor it plays from. A voice not started yet, or ended, plays nothing
   * (and suppresses nothing). The music jumping (a new epoch) moves a voice's
   * anchor to the start of the beat it is now in; its launch, deadline, seed
   * and wall-clock state stay, and its kind takes the jump as it takes a
   * position that went back.
   */
  function playingVoices(given: RenderInput, input: FrameInput, reading: MusicalTime, now: number, phase: number):
    { voices: VoiceFrame[]; admitted: Set<VoiceFrame> } {
    const admitted = new Set<VoiceFrame>();
    const legacy = given.voices === undefined;
    // A voices field, even an empty one, means the caller owns every voice:
    // the renderer plays the energy burst itself only for an input without one.
    if (!legacy) compat = null;
    const synthesized = legacy ? compatVoice(input, now) : null;
    const source = legacy ? (synthesized ? [synthesized] : []) : input.voices;
    const seen = new Set<string>();
    const voices: VoiceFrame[] = [];
    // After a jump in the music, the beat a voice re-anchors on: its scene's when the auto show says which, else where the music is.
    const beatNow = reading.anchorBeat !== undefined && Number.isFinite(reading.anchorBeat) ? reading.anchorBeat : reading.beatPos;
    for (const v of source) {
      if (!v || typeof v.id !== 'string' || !v.spec || typeof v.spec.kind !== 'string') continue;
      if (!(Number.isFinite(v.startedAtMs) && now >= v.startedAtMs)) continue;
      // Half-open: gone at its deadline. A deadline left out is none.
      if (v.untilMs != null && !(now < v.untilMs)) continue;
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      // The hold strobe keeps the global beat grid it has always flashed on,
      // played by the renderer itself or as the energy endpoints' voice.
      const holdsGrid = (legacy && v === compat?.voice) || v.holdsGrid === true;
      const anchorBeat = voiceAnchor(voiceRecords, stepper, v, voiceLaunchKey(v), reading.epoch, beatNow, holdsGrid);
      const played: VoiceFrame = { ...v, startedAtMs: v.startedAtMs - phase, untilMs: v.untilMs == null ? null : v.untilMs - phase, anchorBeat };
      // Only the renderer's own burst, for an input that says nothing of safety, keeps the old admission.
      if (legacy && given.safety === undefined && v === compat?.voice) admitted.add(played);
      voices.push(played);
    }
    for (const id of voiceRecords.keys()) if (!seen.has(id)) voiceRecords.delete(id);
    handOverStrobes(stepper, strobeTrail, voices);
    return { voices, admitted };
  }

  /** Is a voice on at least one fixture of the patch: null covers them all, an unknown id none. */
  function coversPatch(v: VoiceFrame, ids: readonly number[]): boolean {
    return v.targets === null || v.targets.some((id) => ids.includes(id));
  }

  const NO_COMMANDS = { due: [], decide() {} };

  /**
   * Decide this frame's commands: refused ones at once, the base's own when
   * the base effect renders (after its initialization, before its sample).
   */
  function takeCommands(input: FrameInput): { due: { seq: number; cmd: EffectCommand; arg?: Colour }[]; decide: (applied: boolean) => void } {
    if (!commandQueue.length) return NO_COMMANDS;
    const queued = commandQueue.splice(0);
    const due: { seq: number; cmd: EffectCommand; arg?: Colour }[] = [];
    // Each command's outcome, in the order they came; the ones due are decided by the frame.
    const decided: (CommandResult | null)[] = [];
    const def = input.effect ? kindOf(input.effect.kind) : null;
    const now = baseIntentOf(input);
    const taken = new Set<number>();
    for (const c of queued) {
      const refuse = (status: CommandStatus) => { decided.push({ seq: c.seq, status }); };
      if (c.seq <= processedSeq || taken.has(c.seq)) { refuse('duplicate'); continue; }
      taken.add(c.seq);
      const arg = commandArg(c.cmd, c.arg);
      if (arg === undefined) { refuse('invalid'); continue; }
      if (!now || !def) { refuse('unsupported'); continue; }
      if (c.intent && (c.intent.pattern !== now.pattern || c.intent.revision !== now.revision || c.intent.content !== now.content)) {
        refuse('stale'); continue;
      }
      if (!def.command) { refuse('unsupported'); continue; }
      due.push({ seq: c.seq, cmd: c.cmd as EffectCommand, arg: arg === null ? undefined : arg });
      decided.push(null);
    }
    return {
      due,
      decide(applied) {
        let next = 0;
        const results = decided.map((d) => d ?? { seq: due[next++].seq, status: applied ? 'applied' as const : 'unavailable' as const });
        for (const d of results) {
          if (d.status === 'duplicate') continue;
          processedSeq = Math.max(processedSeq, d.seq);
          if (d.status === 'applied') appliedSeq = Math.max(appliedSeq, d.seq);
        }
        commandResults.push(...results);
      },
    };
  }

  /** The rig as lights, rebuilt only when what it depends on changes. */
  function rigFor(fixtures: RenderFixture[]): Rig<RenderFixture> {
    const key = rigSignature(fixtures, profilesRevision());
    if (!rig || key !== rigKey) {
      rig = buildRig(fixtures, profileOf);
      rigKey = key;
    }
    return rig;
  }

  /** Size the per-light buffers to the rig. Cheap when nothing changed. */
  function sizeUnitBuffers(count: number): void {
    while (unitColors.length < count) unitColors.push(blankUnit());
    if (unitColors.length > count) unitColors.length = count;
    while (twinkle.length < count) twinkle.push(0);
    twinkle.length = count;
    while (pixelTwinkle.length < count) pixelTwinkle.push(0);
    pixelTwinkle.length = count;
    while (panelTwinkle.length < count) panelTwinkle.push(0);
    panelTwinkle.length = count;
    while (baseKind.length < count) baseKind.push(null);
    baseKind.length = count;
    while (seqLight.length < count) seqLight.push(null);
    seqLight.length = count;
    while (seqKind.length < count) seqKind.push(null);
    seqKind.length = count;
  }

  function setUnitColor(u: number, color: Colour, dim: number, strobe: number): void {
    unitColors[u] = {
      r: color.r,
      g: color.g,
      b: color.b,
      w: color.w || 0,
      a: color.a || 0,
      uv: color.uv || 0,
      dim,
      strobe,
    };
  }

  /** A fade or a sync test asked for since the last frame starts now. */
  function adoptRequests(input: RenderInput): void {
    const f = input.fade;
    if (f && f.seq !== adopted.fade) {
      adopted.fade = f.seq;
      fade = f.ms > 0 ? { start: f.at, ms: f.ms, from: shown.map((c) => ({ ...c })) } : null;
    }
    const s = input.syncTest;
    if (s && s.seq !== adopted.syncTest) {
      adopted.syncTest = s.seq;
      syncTest = { start: s.at, until: s.at + s.seconds * 1000 };
    }
    const id = input.identify;
    if (id && id.seq !== adopted.identify) {
      adopted.identify = id.seq;
      identify = id.ids.length && id.ms > 0 ? { ids: new Set(id.ids), start: id.at, until: id.at + id.ms } : null;
    }
  }

  /** The fixtures identifying themselves this frame, or null. */
  function identifying(now: number): { ids: Set<number>; start: number } | null {
    if (identify && now >= identify.until) identify = null;
    return identify;
  }

  /**
   * A fixture showing itself (identify.ts): its own picture, over the look
   * and through the master and a blackout, at its trim. No strobe, no burst,
   * no flash limit — the picture is slower than any of them would allow.
   */
  function writeIdentified(input: RenderInput, store: FrameStore, fix: RenderFixture, cells: ChannelMap[] | null,
    elapsed: number, now: number): void {
    const plain: RenderInput = { ...input, masterDimmer: 255, pattern: '', flashLimit: false };
    const lights = identifyLights(cells ? cells.length : 1, elapsed).map(({ col, dim }) => ({ col, dim, strobe: 0 }));
    if (cells) writeBar(plain, store, fix, cells, lights, null, now);
    else writePar(plain, store, fix, lights[0], null, now);
  }

  /**
   * The step the pattern is on, counted from its anchor on the step grid.
   *
   * The anchor is set when a scene changes the pattern or the division (see
   * patch.js). When the music itself jumps — a seek, a new track, another
   * source taking over the clock — the old anchor belongs to a beat position
   * that no longer exists, so the pattern re-anchors: on its scene's beat when
   * the auto show says which that is, else where the music now is.
   */
  function patternStep(input: RenderInput, reading: MusicalTime): { step: number; anchor: number; division: number } {
    const division = Math.max(1, input.beatDivision || 1);
    const given = input.patternAnchor;
    if (given && (!givenAnchor || given.step !== givenAnchor.step || given.epoch !== givenAnchor.epoch)) {
      anchor = { step: given.step, epoch: given.epoch };
    }
    givenAnchor = given ? { step: given.step, epoch: given.epoch } : null;
    if (!anchor || anchor.epoch !== reading.epoch) {
      // After a seek in the auto show, from the beat its scene was scheduled
      // on, so the chase is on the step that playing through would have reached.
      const from = reading.anchorBeat !== undefined && Number.isFinite(reading.anchorBeat)
        ? reading.anchorBeat : reading.beatPos;
      anchor = { step: anchorStep(from, division), epoch: reading.epoch };
    }
    return { step: stepAt(reading.beatPos, anchor.step, division), anchor: anchor.step, division };
  }

  /**
   * Write the pattern layer for this frame, from the musical clock, through
   * the layer the rehearsal preview draws with too (shared/layer.js).
   *
   * The step is a function of where the music is, not a counter a timer
   * advances, so it cannot drift off the beat and lands on the same step
   * however the moment was reached. Deterministic patterns render every
   * frame, so a colour or a split shows the moment it is set rather than on
   * the next beat. Stopped, the layer holds what it last showed.
   */
  function renderPattern(input: FrameInput, rigNow: Rig<RenderFixture>, reading: MusicalTime): void {
    if (!input.running) return;
    // A pattern is no effect: Hue Dynamics' flash limit does not cover it.
    if (baseKinds) { baseKind.fill(null); baseKinds = false; }
    const pixelPattern = rigNow.hasPixels && input.pixelPattern ? input.pixelPattern : null;
    const panelPattern = rigNow.hasPanels && input.panelPattern && PATTERN_FUNCS[input.panelPattern] ? input.panelPattern : null;
    const known = !!PATTERN_FUNCS[input.pattern];
    const knownPixel = !!pixelPattern && !!PATTERN_FUNCS[pixelPattern];
    const colours = input.paletteOverride ?? fixedColours(input.basePalette, [input.colorA, input.colorB, input.colorC, input.colorD].map((i) => COLOR_PRESETS[i]));
    const look = {
      pattern: input.pattern,
      colors: colourSlots(colours),
      gradient: resolveGradient(input.paletteOverride ? input.overridePalette : input.basePalette, colours),
      split: input.split,
      pixelMap: input.pixelMap,
      pixelPattern,
      pixelSpan: input.pixelSpan ?? null,
      pixelFrom: input.pixelFrom ?? null,
      panelPattern,
    };
    if (!known && !knownPixel && !panelPattern) {
      // Nothing to draw, but a split look's wash still holds.
      renderLayer(rigNow, look, null, setUnitColor, { skipPattern: true, skipPixelPattern: true, skipPanelPattern: true });
      return;
    }

    const fixtureCount = input.fixtures.length;
    const { step, anchor: from, division } = patternStep(input, reading);
    const lookKey = `${step}|${input.colorA},${input.colorB},${input.colorC},${input.colorD}|${input.split}|${fixtureCount}|${JSON.stringify([input.basePalette, input.overridePalette, input.paletteOverride])}`;
    const pixels = `|${rigNow.hasPixels ? rigNow.units.length : ''}|${input.pixelMap}|${panelPattern}`;
    let skipPattern = !known;
    if (known && RANDOM_PATTERNS.has(input.pattern)) {
      const key = `${input.pattern}|${lookKey}${pixels}|${pixelPattern}`;
      skipPattern = key === lastRandomKey;
      lastRandomKey = key;
    }
    let skipPixelPattern = !knownPixel;
    if (knownPixel && RANDOM_PATTERNS.has(pixelPattern)) {
      const key = `${pixelPattern}|${lookKey}${pixels}|${input.pattern}`;
      skipPixelPattern = key === lastPixelRandomKey;
      lastPixelRandomKey = key;
    }
    let skipPanelPattern = !panelPattern;
    if (panelPattern && RANDOM_PATTERNS.has(panelPattern)) {
      const key = `${lookKey}${pixels}|${input.pattern}|${pixelPattern}`;
      skipPanelPattern = key === lastPanelRandomKey;
      lastPanelRandomKey = key;
    }

    renderLayer(rigNow, look, {
      beatPos: reading.beatPos,
      step,
      anchor: from,
      division,
      phase: expressionPhase,
      expression,
      dynamicsOn: !!input.showDynamics,
      pulse: input.pulse ?? null,
      bpm: reading.bpm,
      hueStrobe: input.hueStrobe,
      hardware: capabilities, hardwareClock,
      fixtureCount,
      twinkle,
      pixelTwinkle,
      panelTwinkle,
    }, setUnitColor, { skipPattern, skipPixelPattern, skipPanelPattern });
  }

  /**
   * The base effect in place of the pattern, over the look's split cells,
   * with the split look's wash holding colour B on its own lamps as it does
   * under a pattern. Stopped, the layer holds what it last showed and the
   * effect keeps its state; a command still reaches that state.
   */
  function renderBaseEffect(input: FrameInput, rigNow: Rig<RenderFixture>, reading: MusicalTime, fb: FrameBase,
    commands: ReturnType<typeof takeCommands>): void {
    const cells = baseCells!;
    const def = kindOf(input.effect!.kind);
    if (!input.running) {
      let applied = false;
      if (base) {
        stepper.keep(base.id, fb.nowMs);
        const intent = baseIntentOf(input);
        const same = !!intent && base.pattern === intent.pattern && base.revision === intent.revision && base.content === intent.content;
        const held = same && commands.due.length ? stepper.values(base.id) : [];
        if (held.length && def?.command) {
          for (const value of held) for (const c of commands.due) def.command(value, c.cmd, c.arg);
          applied = true;
        }
      }
      commands.decide(applied);
      return;
    }
    const { anchor: from, division } = patternStep(input, reading);
    const instance = baseInstance(input, from, division, fb.nowMs);
    let prepared = false;
    const prepare = (state: unknown) => {
      prepared = true;
      for (const c of commands.due) def!.command!(state, c.cmd, c.arg);
    };
    baseKinds = true;
    renderEffectLayer(rigNow, cells.layout, { ...fb, fixtureIds: cells.ids, hardware: cellHardware(cells.layout, rigNow) }, instance, stepper, (u, colour, dim, strobe, kind, owner) => {
      setUnitColor(u, colour, dim, strobe);
      baseKind[u] = kind;
      baseOwner[u] = owner;
    }, commands.due.length ? prepare : undefined);
    commands.decide(prepared);
    const colourB = colourSlots(input.paletteOverride ?? fixedColours(input.basePalette, [input.colorA, input.colorB, input.colorC, input.colorD].map((i) => COLOR_PRESETS[i])))[1];
    for (const i of cells.layout.wash) {
      const { start, count } = rigNow.ranges[i];
      for (let u = start; u < start + count; u++) {
        setUnitColor(u, colourB, 255, 0);
        baseKind[u] = null;
      }
    }
  }

  /** Does this frame play the sequence: a table, a transport, and the input naming that table. */
  function sequencePlays(input: FrameInput): boolean {
    return !!sequence && !!input.sequenceTransport && input.sequenceRevision === sequence.revision;
  }

  /**
   * The sequence's clips over the look, on the voices' cells (every fixture,
   * the whole stage): on each fixture a clip covers, the clip on top is its
   * base, black where that clip leaves it dark; elsewhere the look shows.
   * Kept apart from the look's layer, so a stopped or random look underneath
   * still holds its own picture for when the clip ends.
   */
  function renderSequence(input: FrameInput, rigNow: Rig<RenderFixture>, fb: FrameBase | null): void {
    if (seqUnits) { seqLight.fill(null); seqKind.fill(null); seqOwner.fill(undefined); seqUnits = false; }
    if (!fb || !sequencePlays(input)) {
      if (seqRun.activations.size || seqRun.last || seqRun.shown) endSequence(seqRun, stepper);
      return;
    }
    const cells = voiceCells!;
    seqUnits = renderSequenceLayer(rigNow, cells.layout, { ...fb, fixtureIds: cells.ids, hardware: cellHardware(cells.layout, rigNow) }, sequence!, input.sequenceTransport!, seqRun, stepper,
      (u, colour, dim, strobe, kind, owner) => {
        seqLight[u] = { r: colour.r, g: colour.g, b: colour.b, w: colour.w || 0, a: colour.a || 0, uv: colour.uv || 0, dim, strobe };
        seqKind[u] = kind;
        seqOwner[u] = owner;
      });
  }

  function syncTestEnergy(now: number): EnergyLook | null {
    if (!syncTest) return null;
    if (now >= syncTest.until) { syncTest = null; return null; }
    const lit = (now - syncTest.start) % 1000 < SYNC_FLASH_MS;
    return { col: { r: 255, g: 255, b: 255, w: 255, a: 0, uv: 0 }, dim: lit ? 255 : 0, strobe: 0 };
  }

  /** A Hue lamp: a bridge cannot flash. */
  function hueLamp(fix: RenderFixture): boolean {
    return isHueProfile(profileOf(fix));
  }

  /**
   * What one light shows this frame before the masters: a burst over
   * everything, a pinned fixture over the look, else the pattern layer
   * (partway through a fade if one is running). The music scales the pattern
   * underneath manual effects and fixture overrides; silence puts out what the
   * music drives, and a pinned fixture is not driven by the music — it holds
   * through the quiet the same as it holds through the level above.
   */
  function lightOf(u: number, fix: RenderFixture, energy: EnergyLook | null, fadeT: number,
    target: ShowDynamics | null): LightValue {
    // Kept whatever sits on top of it this frame, so a fade that starts under
    // a burst starts from the look and not from the burst.
    const layer = fade && fade.from[u] ? blendFixture(fade.from[u], unitColors[u], fadeT) : unitColors[u];
    shown[u] = layer;
    // A clip of the sequence stands in for the look on its fixture; a fade of the look goes on under it.
    const clip = seqUnits ? seqLight[u] : null;
    const below = clip ?? layer;

    let col: Colour; let dim: number; let strobe: number;
    if (energy) {
      col = energy.col; dim = energy.dim; strobe = energy.strobe;
    } else if (fix.override && (fix.override.enabled || fix.override.blackout)) {
      const ov = fix.override;
      if (ov.blackout) {
        col = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 }; dim = 0; strobe = 0;
      } else {
        col = { r: ov.r, g: ov.g, b: ov.b, w: ov.w, a: ov.a || 0, uv: ov.uv || 0 };
        dim = ov.dim !== undefined ? ov.dim : 255;
        strobe = ov.strobe !== undefined ? ov.strobe : 0;
      }
    } else {
      col = { r: below.r, g: below.g, b: below.b, w: below.w, a: below.a || 0, uv: below.uv || 0 };
      dim = below.dim; strobe = below.strobe;
    }

    const pinned = fix.override && fix.override.enabled;
    // Glow rides the level on its own curve, as the base or a clip as it does as a voice: not multiplied again.
    if (!energy && !pinned && !ridesLevel(clip ? seqKind[u] : baseKind[u])) dim *= expression.level;
    if (target?.level === 0 && !energy && !pinned) dim = 0;
    return { col, dim, strobe };
  }

  // Two scalers sit above whatever is driving a fixture, and both apply to
  // every source of light including an energy override. The grand master is
  // the operator's one hand on the whole rig; the per-fixture trim is for the
  // lamp hanging a metre from someone's face.
  //
  // Both multiply rather than clamp. A trim that clipped — min(level, trim) —
  // would leave a fixture already below the line untouched and only bite at
  // the top, so the bottom of the throw would go dead and two fixtures on
  // different trims would converge as they dimmed. Multiplying keeps the whole
  // range proportional: half the trim is half the output at every level.
  function mastersOf(input: RenderInput, fix: RenderFixture): number {
    return (input.masterDimmer / 255) * (fix.maxBrightness / 255);
  }

  /**
   * The strobe asked for — `{ raw, fnId }` — or null for none. `clip`: a
   * clip of the sequence is the fixture's base, so the look's strobe is not
   * its to run.
   */
  function strobeRequest(input: RenderInput, energy: EnergyLook | null, strobe: number, clip = false): StrobeRequest | null {
    // Energy overrides force 'standard' strobe so a colour-strobe burst never
    // inherits a slow ramp/break function from the prior segment; a clip likewise.
    const own = !!energy || clip;
    let raw = own ? strobe : (input.pattern === 'strobe' ? input.strobeSpeed : strobe);
    if (!(raw > 0)) return null;
    if (input.flashLimit && !capabilities.length) raw = Math.min(raw, FLASH_LIMIT_STROBE);
    return { raw, fnId: own || input.flashLimit ? 'standard' : input.strobeFunction,
      limitHz: input.flashLimit ? FLASHES_PER_SECOND : undefined };
  }

  /** The strobe channel's value for the standard strobe, or null to leave it at rest. */
  function strobeValue(request: StrobeRequest | null): number | null {
    if (!request) return null;
    return STANDARD_STROBE.lo + Math.round((request.raw / 255) * (STANDARD_STROBE.hi - STANDARD_STROBE.lo));
  }

  /**
   * Handle the standard strobe for a fixture: its strobe channel when it has
   * one, else the software strobe, through the fixture's hardware limits when
   * it has them. The level its lights are let through at this frame, 0 when
   * it is dark.
   * Any other function was drawn on its lights already (drawStrobes), and
   * leaves the strobe channel at rest. Never for a Hue lamp: a bridge cannot
   * flash.
   */
    function strobe(dmx: Dmx, base: number, fix: RenderFixture, ch: ChannelMap, request: StrobeRequest | null,
    now: number): number {
    if (request && drawnByTheShow(request.fnId)) return 1;
    const caps = capabilities[inputFixtureIndex(fix)];
    if (caps) {
      const planned = hardwareStrobe(request?.raw ?? 0, caps, now, request?.limitHz);
      if (planned.raw !== null && ch.strobe !== undefined) {
        dmx[base + ch.strobe] = strobeValue({ raw: planned.raw,
          fnId: planned.raw === request?.raw ? request.fnId : 'standard' })!;
      }
      return hardwareStrobeGuard.apply(String(fix.id), planned.level, now,
        { ...caps, maxFlashHz: Math.min(caps.maxFlashHz, request?.limitHz ?? Infinity), minTransitionMs: 0 });
    }
    if (ch.strobe !== undefined) {
      const value = strobeValue(request);
      if (value !== null) dmx[base + ch.strobe] = value;
      return 1;
    }
    if (!request || hueLamp(fix)) return 1;
    return softStrobeLit(request, now) ? 1 : 0;
  }

  /**
   * Draw the strobe functions the show draws itself (shared/strobe-fx.ts) on
   * every light asked for one: its brightness times the function's level at
   * this point in the music, each light — a par, a cell of a bar — rolling
   * its own dice for the random ones. Not on a Hue lamp, which cannot follow.
   */
  function drawStrobes(input: RenderInput, rigNow: Rig<RenderFixture>, all: LightValue[][], energies: (EnergyLook | null)[],
    reading: MusicalTime): void {
    for (let i = 0; i < all.length; i++) {
      const lights = all[i];
      let hue: boolean | null = null;
      for (let k = 0; k < lights.length; k++) {
        const request = strobeRequest(input, energies[i], lights[k].strobe);
        if (!request || !drawnByTheShow(request.fnId)) continue;
        if (hue === null) hue = isHueProfile(profileOf(input.fixtures[i]));
        if (hue) break;
        lights[k].dim *= strobeLevel(request.fnId, request.raw, reading.beatPos, reading.bpm, rigNow.ranges[i].start + k);
      }
    }
  }

  /** A fixture that is one light. */
  function writePar(input: RenderInput, store: FrameStore, fix: RenderFixture, { col, dim, strobe: flash }: LightValue,
    energy: EnergyLook | null, now: number, clip = false): void {
    const dmx = store.getBuffer(fix.universe);
    const base = fix.address - 1;
    const profile = profileOf(fix);
    const ch = profile.channelMap;
    const ms = mastersOf(input, fix);

    writeDefaults(dmx, base, profile.defaults);
    if (!strobe(dmx, base, fix, ch, strobeRequest(input, energy, flash, clip), now)) return;
    writeDimmer(dmx, base, ch, dim * ms);
    writeEmitters(dmx, base, ch, col, ms * (dim / 255));
  }

  /**
   * An LED bar: the channels the bar shares, then every cell's own. Each cell
   * comes out as a par with the same channels would at its level (see
   * cellDrive in look-math.js), so a look the same on every cell drives a bar
   * exactly as it drives a par, and kill or silence closes the bar's dimmer.
   */
  function writeBar(input: RenderInput, store: FrameStore, fix: RenderFixture, cells: ChannelMap[], lights: LightValue[],
    energy: EnergyLook | null, now: number, clip = false): void {
    const dmx = store.getBuffer(fix.universe);
    const base = fix.address - 1;
    const profile = profileOf(fix);
    const ch = profile.channelMap;
    const ms = mastersOf(input, fix);
    // A strip longer than a universe runs on into the next ones, whole cells
    // to a universe (shared/placement.ts); anything else is all on its own.
    const strip = stripOf(profile);

    if (strip) writeStripDefaults(store, fix, strip, profile.defaults);
    else writeDefaults(dmx, base, profile.defaults);
    let top = 0;
    let flash = 0;
    for (const light of lights) {
      if (light.dim > top) top = light.dim;
      if (light.strobe > flash) flash = light.strobe;
    }
    if (!strobe(dmx, base, fix, ch, strobeRequest(input, energy, flash, clip), now)) return;
    const fixtureDimmer = ch.dimmer !== undefined;
    writeDimmer(dmx, base, ch, top * ms);

    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c];
      const { col, dim } = lights[c];
      const { cellDim, scale } = cellDrive(dim, top, ms, fixtureDimmer, cell.dimmer !== undefined);
      let out = dmx;
      let at = base;
      if (strip) {
        const place = cellPlace(strip, fix.address, c);
        if (place.universe) out = store.getBuffer(fix.universe + place.universe);
        at = place.shift;
      }
      if (cell.dimmer !== undefined) out[at + cell.dimmer] = cellDim;
      writeEmitters(out, at, cell, col, scale);
    }
  }

  /**
   * Render one frame into `store` (the universes module's API).
   *
   * @param given    renderInput(): the look, masters, patch and requests
   * @param reading  the Conductor's `{ beatPos, bpm, epoch, anchorBeat? }`
   * @param now      this frame's time, on the clock `given`'s request times use
   * @param store    the universe buffers to write
   * @param gridOriginMs  where the frame grid starts on `now`'s clock (see Renderer.frame)
   */
  function frame(given: RenderInput, reading: MusicalTime, now: number, store: FrameStore, gridOriginMs?: number): Rig<RenderFixture> {
    // Fields a hand-built input leaves out get their defaults here, once, so
    // everything below reads one complete input.
    const input = withInputDefaults(given);
    const dt = Math.max(0, Math.min(0.25, (now - lastNow) / 1000));
    lastNow = now;
    adoptRequests(input);

    const target = input.showDynamics;
    expression = blendExpression(expression, target, dt);

    // How fast the expressive patterns travel across the rig: motion decides
    // how many beats one crossing takes, eight when the track is barely moving
    // and two when it is driving. Counted in beats of the musical clock, so the
    // sweep follows the track's own tempo — and a jump in the music does not
    // fling it.
    const dBeats = lastReading && lastReading.epoch === reading.epoch
      ? Math.min(4, Math.max(0, reading.beatPos - lastReading.beatPos)) : 0;
    lastReading = reading;
    expressionPhase = (expressionPhase + motionAdvance(dBeats, expression.motion)) % 1;

    const rigNow = rigFor(input.fixtures);
    hardwareFor(input);
    sizeUnitBuffers(rigNow.units.length);

    // The effects' clock, and the real time since their last frame (not the
    // expression's clamped seconds: a Light DJ fade replays the whole gap).
    const effNow = effectNow(now, gridOriginMs);
    const effDt = lastEffectNow === null ? 0 : Math.max(0, effNow - lastEffectNow);
    lastEffectNow = effNow;
    if (effNow - lastSweep >= 1000 || effNow < lastSweep) {
      stepper.sweep(effNow);
      lastSweep = effNow;
    }
    const interval = input.safety.hdFlashIntervalMs;
    guard.setInterval(Number.isFinite(interval) && interval >= 0 ? interval : RENDER_SAFETY_DEFAULTS.hdFlashIntervalMs);

    const { voices, admitted } = playingVoices(given, input, reading, now, gridPhase!);
    const effects = !!input.effect || voices.length > 0 || sequencePlays(input);
    let fb: FrameBase | null = null;
    if (effects) {
      cellsFor(input, rigNow);
      // Disco's automatic strobe stands down for any manual strobe playing, whichever voice is on top.
      const manualStrobeActive = voices.some((v) => v.spec.kind === 'strobe' && coversPatch(v, voiceCells!.ids));
      fb = frameBaseOf(input, reading, effNow, effDt, input.safety.acknowledged, manualStrobeActive);
    }
    const commands = takeCommands(input);

    if (input.effect) renderBaseEffect(input, rigNow, reading, fb!, commands);
    else {
      commands.decide(false);
      renderPattern(input, rigNow, reading);
    }
    renderSequence(input, rigNow, fb);

    // The voices' cells, by unit: the voice on top of each, or null for the base.
    let voiceTop: (EffectSlot | null)[] | null = null;
    if (voices.length && fb) {
      const cells = voiceCells!;
      const winners = renderVoices(rigNow, cells.layout, { ...fb, fixtureIds: cells.ids, hardware: cellHardware(cells.layout, rigNow) }, voices, stepper, { admit: admitted });
      voiceTop = new Array<EffectSlot | null>(rigNow.units.length).fill(null);
      const { list } = cells.layout.units;
      for (let k = 0; k < list.length; k++) voiceTop[list[k]] = winners[k];
    }

    // Allocate a buffer for every universe the patch now spans and retire the
    // ones it left. Done every frame rather than on patch edits: a fixture
    // moved between universes takes effect immediately, and no caller has to
    // remember.
    store.sync(input.universes);

    // Clear every universe each frame, then let each fixture write its own
    // channels back. Zeroing per-fixture ranges instead used to leave any
    // channel no *current* fixture covers latched at its last value forever:
    // delete a fixture, re-address one, load a smaller show, or map a profile
    // offset past its channelCount, and the orphaned channels kept streaming
    // with no way to clear them — master blackout only walked the current
    // fixtures, so it could not turn those lights off either. A 512-byte
    // memset per universe per frame is far cheaper than the bug.
    store.clearAll();

    let fadeT = 1;
    if (fade) {
      fadeT = (now - fade.start) / fade.ms;
      if (fadeT >= 1) fade = null;
    }

    const { fixtures } = input;
    const ident = identifying(now);
    // The Hue sync test, forced on every fixture above the voices.
    const sync = syncTestEnergy(now);

    // With the buffers already cleared, a blackout is simply empty universes —
    // but for a fixture asked to identify itself.
    if (input.masterBlackout) {
      hardwareGuard.blackout();
      hardwareStrobeGuard.blackout();
      if (input.flashLimit) limiter.commit(0, now);
      // Dark is no rise: a lamp coming back bright afterwards is a new one.
      if (guard.brightCount) for (let u = 0; u < rigNow.units.length; u++) guard.clear(u);
      if (strobeGuard.liveCount) for (let u = 0; u < rigNow.units.length; u++) strobeGuard.clear(u);
      if (ident) {
        for (let i = 0; i < fixtures.length; i++) {
          if (ident.ids.has(fixtures[i].id)) writeIdentified(input, store, fixtures[i], rigNow.cellMaps[i], now - ident.start, now);
        }
      }
      return rigNow;
    }
    // Each light: its source (a burst or a voice, a pinned fixture, or the
    // pattern layer partway through any fade), then the music's level on top.
    // A voice stands where the energy burst always stood: over a pinned
    // fixture and a fixture's blackout alike, at its own level.
    const all: LightValue[][] = [];
    const owned: (EnergyLook | null)[] = [];
    // Fixtures whose base is a clip of the sequence (a bar when any of its cells is), as a voice owns one.
    const clipped: boolean[] = [];
    // Which kind is on top of each unit matters only while an effect plays.
    const watch = !!voiceTop || baseKinds || seqUnits;
    let guarded = false;
    let strobed = false;
    for (let i = 0; i < fixtures.length; i++) {
      const fix = fixtures[i];
      const { start, count } = rigNow.ranges[i];
      const overridden = !!fix.override && (fix.override.enabled || fix.override.blackout);
      const lights: LightValue[] = [];
      let first: EnergyLook | null = sync;
      let clip = false;
      for (let u = start; u < start + count; u++) {
        if (seqUnits && seqLight[u] && !overridden) clip = true;
        const voice = sync || !voiceTop ? null : voiceTop[u];
        const top = sync ?? (voice ? { col: voice.colour, dim: 255 * voice.level, strobe: voice.strobe ?? 0 } : null);
        if (top && !first) first = top;
        lights.push(lightOf(u, fix, top, fadeT, target));
        if (!watch) continue;
        const kind = top ? (voice ? voice.kind ?? null : null) : overridden ? null : seqUnits && seqLight[u] ? seqKind[u] : baseKind[u];
        topKind[u] = kind;
        if (hdGuarded(kind)) guarded = true;
        if (kind === 'strobe') strobed = true;
      }
      owned.push(first);
      clipped.push(clip);
      all.push(lights);
    }
    if (capabilities.length) {
      const ids = new Set<string>();
      for (let i = 0; i < fixtures.length; i++) for (let c = 0; c < all[i].length; c++) {
        const id = `${fixtures[i].id}:${c}`; ids.add(id);
        const light = all[i][c];
        const u = rigNow.ranges[i].start + c, fix = fixtures[i], voice = voiceTop?.[u];
        const override = fix.override && (fix.override.enabled || fix.override.blackout);
        const clip = seqUnits && seqLight[u];
        const kind = watch ? topKind[u] : null;
        const owner = sync ? 'sync' : voice?.owner ?? (override ? 'override' : clip ? seqOwner[u] ?? 'sequence:black'
          : input.effect ? baseOwner[u] ?? 'base:excluded' : `legacy:${input.pattern}`);
        const cut = kind === 'energy.kill' || !voice && !sync && (!!fix.override?.blackout
          || target?.level === 0 && !fix.override?.enabled || !!clip && input.sequenceTransport?.stop?.mode === 'black');
        const guardedLight = hardwareGuard.light(id, light.col, light.dim, effNow, capabilities[i], owner, cut);
        light.col = guardedLight.colour; light.dim = guardedLight.dim;
      }
      hardwareGuard.retain(ids);
    }
    drawStrobes(input, rigNow, all, owned, reading);
    if (guarded) limitHdRises(input, rigNow, all, effNow);
    else if (guard.brightCount) for (let u = 0; u < rigNow.units.length; u++) guard.clear(u);
    // Only while a strobe is on top of a lamp, or one it drew is still counted as lit.
    if (strobed) limitStrobeRises(rigNow, all, effNow);
    else if (strobeGuard.liveCount) for (let u = 0; u < rigNow.units.length; u++) strobeGuard.clear(u);
    if (input.flashLimit) limitFlashes(input, all, now);
    else limiter.reset();
    for (let i = 0; i < fixtures.length; i++) {
      const cells = rigNow.cellMaps[i];
      if (ident && ident.ids.has(fixtures[i].id)) writeIdentified(input, store, fixtures[i], cells, now - ident.start, now);
      else if (cells) writeBar(input, store, fixtures[i], cells, all[i], owned[i], now, clipped[i]);
      else writePar(input, store, fixtures[i], all[i][0], owned[i], now, clipped[i]);
    }
    return rigNow;
  }

  /**
   * Hue Dynamics' per-lamp limit on its own kinds: a second bright rise of a
   * lamp inside the interval is dark. It reads what the lamp would put out,
   * after the masters and its trim, so a lamp a low master keeps under the
   * threshold spends no rise; any other source on a lamp ends its held rise.
   */
  function limitHdRises(input: FrameInput, rigNow: Rig<RenderFixture>, all: LightValue[][], nowMs: number): void {
    for (let i = 0; i < input.fixtures.length; i++) {
      const { start } = rigNow.ranges[i];
      const masters = mastersOf(input, input.fixtures[i]);
      const lights = all[i];
      for (let c = 0; c < lights.length; c++) {
        const u = start + c;
        if (!hdGuarded(topKind[u])) { guard.clear(u); continue; }
        const light = lights[c];
        if (guard.apply(u, (light.dim / 255) * masters, nowMs) === 0) light.dim = 0;
      }
    }
  }

  /**
   * The strobe's permit on each lamp, across every strobe that draws it: one
   * ending over another, or a strobe look showing again from under a strobe
   * voice, cannot raise a lamp sooner than one strobe alone could. It reads
   * the level the strobe asks for, before the masters: a fader moved is not
   * a flash.
   */
  function limitStrobeRises(rigNow: Rig<RenderFixture>, all: LightValue[][], nowMs: number): void {
    const frameIndex = strobeFrameOf(nowMs);
    for (let i = 0; i < all.length; i++) {
      const { start } = rigNow.ranges[i];
      const lights = all[i];
      for (let c = 0; c < lights.length; c++) {
        const u = start + c;
        if (topKind[u] !== 'strobe') { strobeGuard.clear(u); continue; }
        const light = lights[c];
        const level = light.dim / 255;
        const allowed = strobeGuard.apply(u, level, frameIndex);
        if (allowed < level) light.dim = 255 * allowed;
      }
    }
  }

  function rigLuminance(input: RenderInput, all: LightValue[][], gain = 1): number {
    if (!all.length) return 0;
    const dimmer = (ch: ChannelMap, level: number) => ch.dimmer === undefined ? 255
      : ch.dimmerFine === undefined ? Math.round(level) : Math.round(level / 255 * 65535) >> 8;
    let sum = 0;
    for (let i = 0; i < all.length; i++) {
      const fix = input.fixtures[i], profile = profileOf(fix), ms = mastersOf(input, fix);
      const lights = all[i], cells = rig?.cellMaps[i] ?? profile.cells?.map((c) => c.channelMap);
      const levels = lights.map((light) => Math.min(255, light.dim * gain));
      const top = Math.max(...levels), fixtureDimmer = profile.channelMap.dimmer !== undefined;
      let fixture = 0;
      for (let c = 0; c < lights.length; c++) {
        const map = cells?.[c] ?? profile.channelMap, dim = levels[c];
        const drive = cells ? cellDrive(dim, top, ms, fixtureDimmer, map.dimmer !== undefined) : null;
        const master = dimmer(profile.channelMap, (cells ? top : dim) * ms);
        const cell = drive ? dimmer(map, drive.cellDim) : 255;
        fixture += lightLuminance(outputEmitters(lights[c].col, drive?.scale ?? ms * dim / 255, map), master * cell / 255);
      }
      sum += fixture / Math.max(1, lights.length);
    }
    return sum / all.length;
  }

  /**
   * Hold this frame inside the flash limit (flash-limit.ts): scale every
   * light towards the brightness the limiter allows, then tell it what went
   * out.
   */
  function limitFlashes(input: RenderInput, all: LightValue[][], now: number): void {
    // Fit emitters and dimmers before measuring: RGB fallback changes real brightness.
    const luminance = rigLuminance(input, all), allowed = limiter.target(luminance, now);
    if (luminance > 1e-6 && Math.abs(allowed - luminance) > 1e-4) {
      let lo = 0, hi = 1;
      if (allowed > luminance) {
        let previous = luminance;
        for (let k = 0; k < 16; k++) {
          hi *= 2;
          const brighter = rigLuminance(input, all, hi);
          if (brighter >= allowed || brighter - previous < 1e-6) break;
          previous = brighter;
        }
      }
      let gain = 1, error = Math.abs(allowed - luminance);
      for (let k = 0; k < 14; k++) {
        const mid = (lo + hi) / 2, actual = rigLuminance(input, all, mid);
        if (Math.abs(actual - allowed) < error) { gain = mid; error = Math.abs(actual - allowed); }
        if (error < .001) break;
        if (actual < allowed) lo = mid; else hi = mid;
      }
      for (const lights of all) for (const light of lights) light.dim = Math.min(255, light.dim * gain);
    }
    limiter.commit(rigLuminance(input, all), now);
  }

  return {
    frame,
    /** Forget the cached rig, so the next frame builds it afresh. */
    invalidateRig() { rig = null; },
    command(seq, cmd, arg, intent = null) {
      commandQueue.push({ seq, cmd, arg, intent });
    },
    takeCommandResults() {
      const out = commandResults;
      commandResults = [];
      return out;
    },
    rejectCommands(status) {
      for (const c of commandQueue.splice(0)) {
        const duplicate = c.seq <= processedSeq;
        if (!duplicate) processedSeq = Math.max(processedSeq, c.seq);
        commandResults.push({ seq: c.seq, status: duplicate ? 'duplicate' : status });
      }
    },
    commandStatus() { return { processed: processedSeq, applied: appliedSeq }; },
    setSequence(table) {
      // From another thread or a test: anything that is not a table is none.
      const ok = !!table && typeof table === 'object' && Number.isFinite(table.revision) && Array.isArray(table.lanes) && Array.isArray(table.clips);
      sequence = ok ? table : null;
      retable(seqRun, sequence, stepper);
    },
  };
}

/**
 * Route one resolved colour onto the channels a map names. One resolution of
 * colour × scale for every emitter, shared with the rehearsal preview.
 *
 * A lamp with separate warm and cool white dies (a Hue bulb) rather than one
 * white emitter and an amber one gets them from the two components that
 * already carry exactly that meaning: the neutral white content, and the warm
 * content. "Cool White" (white at full) and "Warm White" (white and amber
 * together) then land on such a lamp as the whites they are named after.
 */
function writeEmitters(dmx: Dmx, base: number, ch: ChannelMap, col: Colour, scale: number): void {
  const v = outputEmitters(col, scale, ch);
  if (ch.red !== undefined)       dmx[base + ch.red]       = v.r;
  if (ch.green !== undefined)     dmx[base + ch.green]     = v.g;
  if (ch.blue !== undefined)      dmx[base + ch.blue]      = v.b;
  if (ch.white !== undefined)     dmx[base + ch.white]     = v.w;
  if (ch.amber !== undefined)     dmx[base + ch.amber]     = v.a;
  if (ch.coolWhite !== undefined) dmx[base + ch.coolWhite] = v.w;
  if (ch.warmWhite !== undefined) dmx[base + ch.warmWhite] = v.a;
  if (ch.uv !== undefined)        dmx[base + ch.uv]        = v.uv;
}

export {
  createRenderer,
  SYNC_FLASH_MS,
  softStrobeHz,
  softStrobeLit,
  writeDimmer,
  SOFT_STROBE_MAX_HZ,
};
