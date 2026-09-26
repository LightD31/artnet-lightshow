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

import { COLOR_PRESETS, STROBE_FUNCTIONS } from './presets.ts';
import { HUE_PROFILE_IDS } from './profiles.ts';
import { FRAME_MS } from './frame-clock.ts';
import { PATTERN_FUNCS } from '../shared/patterns.ts';
import { renderLayer } from '../shared/layer.ts';
import { buildRig, rigSignature } from '../shared/rig.ts';
import { cellPlace, channelPlace, stripOf } from '../shared/placement.ts';
// Shared with the browser's rehearsal preview so the two cannot drift.
import { EXPRESSION_REST, resolveEnergyOverride, blendExpression, emitterValues, blendFixture, cellDrive } from '../shared/look-math.ts';
import { anchorStep, stepAt, motionAdvance } from '../shared/beat-clock.ts';
import { createFlashLimiter, lightLuminance, strobeCap } from './flash-limit.ts';
import { identifyLights } from './identify.ts';
import type { IdentifyRequest } from './identify.ts';
import type { EnergyLook, UnitLight } from '../shared/look-math.ts';
import type { Rig } from '../shared/rig.ts';
import type { MusicalTime } from './conductor.ts';
import type { PatternAnchor } from './state.ts';
import type { UniverseStore } from './universes.ts';
import type { ChannelDefault, ChannelMap, Colour, Expression, Override, PixelMap, Profile, PulseReading, ShowDynamics, StageFixture } from '../types/rig.ts';

/** A fixture as a frame needs it: its universe and trim resolved. */
export interface RenderFixture extends StageFixture {
  id: number;
  address: number;
  universe: number;
  profileId: string;
  maxBrightness: number;
  override: Override | null;
  /** A Hue lamp, so it is never strobed in software. */
  hue: boolean;
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
}

type Dmx = Buffer | Uint8Array;

export interface Renderer {
  frame(input: RenderInput, reading: MusicalTime, now: number, store: FrameStore): Rig<RenderFixture>;
  invalidateRig(): void;
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
// A fixture with a strobe channel flashes itself: the strobe value goes to
// that channel and the lamp's own electronics do the rest. A fixture without
// one — plenty of LED bars and cheap pars — used to sit there steady through
// the strobe pattern and every strobing burst. It is now flashed here instead,
// by leaving it dark on the frames between flashes.
//
// 1 to 20 flashes a second, as the fixtures' own standard strobe runs, and no
// faster than every other frame. Each flash lasts at least one frame (so none
// falls between two), a third of the period at most, and never more than 50 ms:
// a strobe is a flash, not a blink.
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
 * Is a software-strobed fixture lit on the frame at `now`? Periodic, on the
 * clock, so every such fixture flashes together; the random strobe functions
 * flash each fixture on its own, at the same average rate.
 */
function softStrobeLit({ raw, fnId }: StrobeRequest, now: number): boolean {
  const hz = softStrobeHz(raw);
  if (/random|rnd/.test(fnId)) return Math.random() < (hz * FRAME_MS) / 1000;
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
  function renderPattern(input: RenderInput, rigNow: Rig<RenderFixture>, reading: MusicalTime): void {
    if (!input.running) return;
    const pixelPattern = rigNow.hasPixels && input.pixelPattern ? input.pixelPattern : null;
    const panelPattern = rigNow.hasPanels && input.panelPattern && PATTERN_FUNCS[input.panelPattern] ? input.panelPattern : null;
    const known = !!PATTERN_FUNCS[input.pattern];
    const knownPixel = !!pixelPattern && !!PATTERN_FUNCS[pixelPattern];
    const look = {
      pattern: input.pattern,
      colors: [input.colorA, input.colorB, input.colorC, input.colorD].map((i) => COLOR_PRESETS[i]),
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
    // A random pattern re-rolls when its step or its look moves, and holds
    // what it rolled in between; the pars, the bars and the panels keep their
    // own dice. Which lights each part covers is in every key.
    const lookKey = `${step}|${input.colorA},${input.colorB},${input.colorC},${input.colorD}|${input.split}|${fixtureCount}`;
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
      fixtureCount,
      twinkle,
      pixelTwinkle,
      panelTwinkle,
    }, setUnitColor, { skipPattern, skipPixelPattern, skipPanelPattern });
  }

  function syncTestEnergy(now: number): EnergyLook | null {
    if (!syncTest) return null;
    if (now >= syncTest.until) { syncTest = null; return null; }
    const lit = (now - syncTest.start) % 1000 < SYNC_FLASH_MS;
    return { col: { r: 255, g: 255, b: 255, w: 255, a: 0, uv: 0 }, dim: lit ? 255 : 0, strobe: 0 };
  }

  /** The burst currently forced on every fixture, or null. */
  function currentEnergy(input: RenderInput, now: number): EnergyLook | null {
    const test = syncTestEnergy(now);
    if (test) return test;
    return input.energy ? resolveEnergyOverride(input.energy, COLOR_PRESETS[input.colorA], expression.level) : null;
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
      col = { r: layer.r, g: layer.g, b: layer.b, w: layer.w, a: layer.a || 0, uv: layer.uv || 0 };
      dim = layer.dim; strobe = layer.strobe;
    }

    const pinned = fix.override && fix.override.enabled;
    if (!energy && !pinned) dim *= expression.level;
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

  /** The strobe asked for — `{ raw, fnId }` — or null for none. */
  function strobeRequest(input: RenderInput, energy: EnergyLook | null, strobe: number): StrobeRequest | null {
    // Energy overrides force 'standard' strobe so a colour-strobe burst never
    // inherits a slow ramp/break function from the prior segment.
    let raw = energy ? strobe : (input.pattern === 'strobe' ? input.strobeSpeed : strobe);
    if (!(raw > 0)) return null;
    if (input.flashLimit) raw = Math.min(raw, FLASH_LIMIT_STROBE);
    return { raw, fnId: energy ? 'standard' : input.strobeFunction };
  }

  /** The strobe channel's value, or null to leave it closed. */
  function strobeValue(request: StrobeRequest | null): number | null {
    if (!request) return null;
    const fn = STROBE_FUNCTIONS.find((f) => f.id === request.fnId) || STROBE_FUNCTIONS[0];
    return fn.lo + Math.round((request.raw / 255) * (fn.hi - fn.lo));
  }

  /**
   * Handle the strobe for a fixture: its strobe channel when it has one,
   * else the software strobe. False when the fixture is dark this frame.
   * Never for a Hue lamp: a bridge cannot flash.
   */
  function strobe(dmx: Dmx, base: number, fix: RenderFixture, ch: ChannelMap, request: StrobeRequest | null,
    now: number): boolean {
    if (ch.strobe !== undefined) {
      const value = strobeValue(request);
      if (value !== null) dmx[base + ch.strobe] = value;
      return true;
    }
    if (!request || fix.hue || HUE_PROFILE_IDS.has(fix.profileId)) return true;
    return softStrobeLit(request, now);
  }

  /** A fixture that is one light. */
  function writePar(input: RenderInput, store: FrameStore, fix: RenderFixture, { col, dim, strobe: flash }: LightValue,
    energy: EnergyLook | null, now: number): void {
    const dmx = store.getBuffer(fix.universe);
    const base = fix.address - 1;
    const profile = profileOf(fix);
    const ch = profile.channelMap;
    const ms = mastersOf(input, fix);

    writeDefaults(dmx, base, profile.defaults);
    if (!strobe(dmx, base, fix, ch, strobeRequest(input, energy, flash), now)) return;
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
    energy: EnergyLook | null, now: number): void {
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
    if (!strobe(dmx, base, fix, ch, strobeRequest(input, energy, flash), now)) return;
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
   * @param input    renderInput(): the look, masters, patch and requests
   * @param reading  the Conductor's `{ beatPos, bpm, epoch, anchorBeat? }`
   * @param now      this frame's time, on the clock `input`'s request times use
   * @param store    the universe buffers to write
   */
  function frame(input: RenderInput, reading: MusicalTime, now: number, store: FrameStore): Rig<RenderFixture> {
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
    sizeUnitBuffers(rigNow.units.length);
    renderPattern(input, rigNow, reading);

    const energy = currentEnergy(input, now);

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

    // With the buffers already cleared, a blackout is simply empty universes —
    // but for a fixture asked to identify itself.
    if (input.masterBlackout) {
      if (input.flashLimit) limiter.commit(0, now);
      if (ident) {
        for (let i = 0; i < fixtures.length; i++) {
          if (ident.ids.has(fixtures[i].id)) writeIdentified(input, store, fixtures[i], rigNow.cellMaps[i], now - ident.start, now);
        }
      }
      return rigNow;
    }
    // Each light: its source (a burst, a pinned fixture, or the pattern layer
    // partway through any fade), then the music's level on top.
    const all: LightValue[][] = [];
    for (let i = 0; i < fixtures.length; i++) {
      const { start, count } = rigNow.ranges[i];
      const lights: LightValue[] = [];
      for (let u = start; u < start + count; u++) lights.push(lightOf(u, fixtures[i], energy, fadeT, target));
      all.push(lights);
    }
    if (input.flashLimit) limitFlashes(input, all, now);
    else limiter.reset();
    for (let i = 0; i < fixtures.length; i++) {
      const cells = rigNow.cellMaps[i];
      if (ident && ident.ids.has(fixtures[i].id)) writeIdentified(input, store, fixtures[i], cells, now - ident.start, now);
      else if (cells) writeBar(input, store, fixtures[i], cells, all[i], energy, now);
      else writePar(input, store, fixtures[i], all[i][0], energy, now);
    }
    return rigNow;
  }

  /** How bright the rig is as a whole: every fixture's mean light, after the masters. */
  function rigLuminance(input: RenderInput, all: LightValue[][]): number {
    if (!all.length) return 0;
    let sum = 0;
    for (let i = 0; i < all.length; i++) {
      const lights = all[i];
      let fixture = 0;
      for (const { col, dim } of lights) fixture += lightLuminance(col, dim);
      sum += (fixture / Math.max(1, lights.length)) * mastersOf(input, input.fixtures[i]);
    }
    return sum / all.length;
  }

  /**
   * Hold this frame inside the flash limit (flash-limit.ts): scale every
   * light towards the brightness the limiter allows, then tell it what went
   * out.
   */
  function limitFlashes(input: RenderInput, all: LightValue[][], now: number): void {
    const luminance = rigLuminance(input, all);
    const allowed = limiter.target(luminance, now);
    if (luminance > 1e-6 && Math.abs(allowed - luminance) > 1e-4) {
      const scale = allowed / luminance;
      for (const lights of all) for (const light of lights) light.dim = Math.min(255, light.dim * scale);
      limiter.commit(rigLuminance(input, all), now);
    } else {
      limiter.commit(luminance, now);
    }
  }

  return {
    frame,
    /** Forget the cached rig, so the next frame builds it afresh. */
    invalidateRig() { rig = null; },
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
  const v = emitterValues(col, scale);
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
