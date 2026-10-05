/**
 * The per-frame maths that decides what a fixture is actually emitting.
 *
 * Two things compute this: `src/server/engine.js`, which drives the rig, and
 * `src/shared/preview.js`, which replays a planned timeline in the browser so an
 * operator can rehearse a track before the room is full. They have to agree.
 * When they did not, the rehearsal view showed a cool-white blinder where the
 * rig throws warm, and a UV wash at a bit over half its real level — which is
 * worse than having no rehearsal view, because it is confidently wrong.
 *
 * So the arithmetic lives here once and both import it. Nothing in this file
 * reads server state, `require`s a transport, or touches the DMX buffers: every
 * function is a pure function of its arguments, which is also what lets the
 * browser bundle it.
 */

import { colourMixer } from './color.ts';
import type { Colour, EmitterLevels, Expression, FullColour, ShowDynamics } from '../types/rig.ts';

/** What an energy burst forces on every fixture. */
export interface EnergyLook {
  col: Colour;
  dim: number;
  strobe: number;
}

/** A light as the pattern layer holds it: a colour, a level and a strobe value. */
export interface UnitLight extends Colour {
  dim: number;
  strobe: number;
}

// A UV die reads far dimmer to the eye than the same number on a primary, so it
// is driven harder to sit level with the rest of the mix. Defined here rather
// than in profiles.js because the preview needs it too and must not grow its
// own copy; profiles.js re-exports it for the callers that already ask there.
const UV_BOOST = 1.8;

// Where the expression channel sits when no show is driving it: full level,
// everything else mid. Frozen because it is the value the engine falls back to
// by assignment, and a mutated rest state would be a very confusing bug.
const EXPRESSION_REST: Readonly<Expression> = Object.freeze({
  level: 1, bass: .5, vocal: .5, air: .3, width: .5, motion: .3, decay: .25,
});

/**
 * The look an energy burst forces on every fixture, or null for "not a burst".
 *
 * `colA` is the look's current slot-A colour, and `level` the *smoothed*
 * expression level — `glow` rides it rather than overriding it, so a soft accent
 * still reflects what the music is doing instead of being a flash with a lower
 * number on it.
 */
function resolveEnergyOverride(id: string | null | undefined, colA: Colour | null | undefined, level = 1): EnergyLook | null {
  const a: Colour = colA || { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
  switch (id) {
    // Cold: no amber, so it reads as a hard white flash rather than a warm one.
    case 'white-strobe': return { col: { r: 255, g: 255, b: 255, w: 255, a: 0, uv: 0 }, dim: 255, strobe: 255 };
    // The quiet end of the vocabulary. A lift rather than a flash, and the only
    // accent soft enough for a ballad.
    case 'glow': return { col: a, dim: Math.round(150 + 105 * level), strobe: 0 };
    case 'color-strobe': return {
      col: { r: a.r, g: a.g, b: a.b, w: a.w || 0, a: a.a || 0, uv: a.uv || 0 },
      dim: 255, strobe: 255,
    };
    // Every emitter that makes visible light, amber included — this is the
    // brightest the rig goes. UV is left out: it adds no perceived brightness to
    // a white wall, and UV_BOOST would push that channel harder for nothing.
    case 'blinder': return { col: { r: 255, g: 255, b: 255, w: 255, a: 255, uv: 0 }, dim: 255, strobe: 0 };
    case 'uv-wash': return { col: { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 255 }, dim: 255, strobe: 0 };
    // Momentary darkness. dim 0 as well as a black colour so the fixture's
    // dimmer channel closes too, rather than leaving it open on black.
    case 'kill': return { col: { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 }, dim: 0, strobe: 0 };
    default: return null;
  }
}

// ── The hold strobe ─────────────────────────────────────────────────────────
// The energy effect `palette-strobe`, after the hold-to-strobe pad of the Hue
// party apps: while it is held, flashes in the look's colours over whatever
// the rig is playing. Not a strobe channel's blur but a run of hard flashes
// the running look can be seen between, on the beat grid — the finest
// division of the beat that stays under five flashes a second — each a colour
// of the look at full for 100 ms, then black as long again (Hue Dynamics'
// manual strobe timing), then the running look shows through until the
// next. The flash limit still holds the rig as a whole to its three a
// second. A Hue lamp is never flashed: it takes each flash as the colour at
// full falling to a floor over 200 ms and held there until the next, as the
// apps fade a hit lamp back.

/** The hold strobe's id among the energy effects (server/presets.ts). */
const HOLD_STROBE = 'palette-strobe';
/** No lamp flashes faster than this, however fast the music. */
const HOLD_STROBE_MAX_HZ = 5;
const HOLD_FLASH_MS = 100;
const HOLD_BLACK_MS = 100;
/** A Hue lamp takes a flash as the colour at full, falling to the floor over this long… */
const HUE_PULSE_MS = 200;
/** …and holds this, of 255, until its next flash: the fade brightness of the party apps. */
const HUE_PULSE_FLOOR = 40;

/** Where the hold strobe is: which flash, how far into it, and how long each is. */
export interface HoldFlash {
  index: number;
  sinceMs: number;
  periodMs: number;
}

/**
 * Flashes per beat: the finest power-of-two division of the beat that flashes
 * no faster than `maxHz`, itself never above HOLD_STROBE_MAX_HZ. Without a
 * tempo, 120 BPM.
 */
function holdStrobeDivision(bpm: number | null | undefined, maxHz: number = HOLD_STROBE_MAX_HZ): number {
  const tempo = bpm && bpm > 0 ? bpm : 120;
  const cap = Number.isFinite(maxHz) && maxHz > 0 ? Math.min(maxHz, HOLD_STROBE_MAX_HZ) : HOLD_STROBE_MAX_HZ;
  const rate = (perBeat: number) => (tempo / 60) * perBeat;
  let perBeat = 1;
  while (rate(perBeat * 2) <= cap) perBeat *= 2;
  while (perBeat > 1 / 16 && rate(perBeat) > cap) perBeat /= 2;
  return perBeat;
}

/**
 * The hold strobe's flash at a beat position, on holdStrobeDivision's grid so
 * every flash lands on it. The strobe kind passes its configured rate; the
 * hold strobe keeps five a second.
 */
function holdStrobeFlash(beatPos: number, bpm: number | null | undefined, maxHz: number = HOLD_STROBE_MAX_HZ): HoldFlash {
  const tempo = bpm && bpm > 0 ? bpm : 120;
  const perBeat = holdStrobeDivision(tempo, maxHz);
  const periodMs = 60000 / tempo / perBeat;
  const pos = beatPos * perBeat;
  const index = Math.floor(pos);
  return { index, sinceMs: (pos - index) * periodMs, periodMs };
}

/**
 * What the hold strobe puts on one light, or null between flashes, when the
 * running look shows through. `palette` is the look's distinct colours
 * (patterns.ts paletteOf), taken in turn, one per flash.
 */
function holdStrobeLook(palette: readonly Colour[], flash: HoldFlash, hue: boolean): EnergyLook | null {
  const n = Math.max(1, palette.length);
  const col = palette[((flash.index % n) + n) % n] || { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
  if (hue) return { col, dim: huePulseLevel(flash.sinceMs), strobe: 0 };
  if (flash.sinceMs < HOLD_FLASH_MS) return { col, dim: 255, strobe: 0 };
  if (flash.sinceMs < HOLD_FLASH_MS + HOLD_BLACK_MS) return { col: { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 }, dim: 0, strobe: 0 };
  return null;
}

/** A Hue lamp's level `sinceMs` after a flash: full, falling to `floor` over HUE_PULSE_MS and held. */
function huePulseLevel(sinceMs: number, floor = HUE_PULSE_FLOOR): number {
  const fall = Math.max(0, Math.min(1, sinceMs / HUE_PULSE_MS));
  return Math.round(255 - (255 - floor) * fall);
}

/** `fade`'s sine, 25..255. `phase` is 0..1 across its eight beats (beat-clock.js). */
function fadeBrightness(phase: number): number {
  return Math.round(((Math.sin(phase * Math.PI * 2 - Math.PI / 2) + 1) / 2) * 230 + 25);
}

/**
 * `hit`'s decay, 255 down to 35 over one step (beat-clock.js `hitPhase`).
 *
 * `phase` is clamped rather than wrapped, and that is the point: past the end of
 * the beat the lamp *holds* at 35 until the beat clock resets it. Letting it
 * wrap turns a decay into a sawtooth that re-triggers on its own, which is what
 * the preview used to do and the rig never did.
 */
function hitBrightness(phase: number): number {
  const p = Math.max(0, Math.min(1, phase));
  return Math.round(35 + Math.pow(1 - p, 1.8) * 220);
}

// How much of the step's own decay stays under the drums when `hit` follows
// them: enough that the division still reads, well short of a hit.
const GRID_UNDER_GROOVE = 0.5;

/**
 * `hit` following the drums (show/pulse.ts `groove`): the step's decay
 * (`hitBrightness`) still pulses underneath at half its height, and a drum as
 * it was hit takes the lamps to full and falls back the way the drum does. On
 * four to the floor the kick and the step land together, and what changes is
 * that each hit is as hard as the kick was; on a breakbeat, a half-time groove
 * or a live drummer the rig flashes where the drums do, and the grid alone
 * never would.
 */
function grooveBrightness(clock: number, groove: number): number {
  const underneath = 35 + (clock - 35) * GRID_UNDER_GROOVE;
  return Math.round(Math.max(underneath, 35 + 220 * Math.max(0, Math.min(1, groove))));
}

/**
 * One step of the expression channel towards what the show last asked for.
 *
 * Returns a new object; `current` is not mutated, so a caller that keeps a
 * running value assigns the result. Silence closes immediately even for
 * long-decay music — a room that is supposed to be dark cannot fade there.
 */
function blendExpression(current: Expression, target: ShowDynamics | null | undefined, dt: number): Expression {
  if (!target) return { ...EXPRESSION_REST };
  const next: Expression = { ...current };
  const blend = 1 - Math.exp(-dt / (.12 + (target.decay || 0) * .45));
  for (const key of Object.keys(next) as (keyof Expression)[]) {
    const goal = target[key];
    if (goal != null) next[key] += (goal - next[key]) * blend;
  }
  if (target.level === 0) next.level = 0;
  return next;
}

/**
 * A colour and a 0..1 scale, resolved to the value each emitter is driven at.
 *
 * This is the last step before the numbers become DMX, so it owns the rounding
 * and the UV boost. Both callers take the whole object: the engine writes the
 * members its profile's channel map names, and the preview mixes them to screen.
 */
function emitterValues(col: Colour, scale: number): EmitterLevels {
  return {
    r: Math.round((col.r || 0) * scale),
    g: Math.round((col.g || 0) * scale),
    b: Math.round((col.b || 0) * scale),
    w: Math.round((col.w || 0) * scale),
    a: Math.round((col.a || 0) * scale),
    uv: Math.min(255, Math.round((col.uv || 0) * scale * UV_BOOST)),
  };
}

/**
 * How one cell of an LED bar is driven, so that it looks exactly like a par
 * with the same channels would at the same level.
 *
 * A par gets its level twice: once on its dimmer channel, once in its colour
 * values (both `dim × master`), so light goes with the square of the level. A
 * bar's cells share at most one fixture dimmer, which can only be as high as
 * the brightest cell (`top`); each cell makes up the rest itself — on its own
 * dimmer when it has one, else in its colour. A look the same on every cell
 * therefore drives a bar with exactly a par's bytes, and a cell at a lower
 * level looks like a par at that level.
 *
 * @param dim            the cell's level, 0..255, after the music and silence
 * @param top            the brightest cell's level in the same fixture
 * @param ms             grand master × the fixture's trim, 0..1
 * @param fixtureDimmer  does the fixture have a dimmer channel of its own
 * @param cellDimmer     does this cell have a dimmer channel of its own
 * @returns { cellDim, scale } — the cell dimmer's value, and the colour scale
 *          for emitterValues. The fixture dimmer itself is round(top × ms).
 */
function cellDrive(dim: number, top: number, ms: number, fixtureDimmer: boolean, cellDimmer: boolean): { cellDim: number; scale: number } {
  const scale = ms * dim / 255;
  if (!fixtureDimmer) return { cellDim: Math.round(dim * ms), scale };
  if (top <= 0) return { cellDim: 0, scale: 0 };
  return {
    cellDim: Math.round((255 * dim) / top),
    scale: cellDimmer || dim === top ? scale : (scale * dim) / top,
  };
}

/**
 * One fixture partway through a crossfade from the look it was showing to the
 * one it is heading for, t in 0..1.
 *
 * Colour travels round the wheel like `ribbon`'s blend, so a fade between two
 * opposite colours does not pass through grey; the level moves linearly, and
 * the strobe channel is the destination's from the first frame — a strobe
 * rate has no in-between worth showing.
 */
function blendFixture(from: UnitLight, to: UnitLight, t: number): UnitLight {
  if (t >= 1) return to;
  const col = blendColour(from, to, t);
  return { ...col, dim: Math.round(from.dim + (to.dim - from.dim) * t), strobe: to.strobe };
}

// Within one frame of a fade every light is at the same point of it, and most
// of them are fading between the same two colours — a bar of sixteen cells in
// one colour is sixteen identical blends. The colour-space walk is the costly
// part of a frame, so the result is kept for the rest of the frame. Exact: the
// key is everything the blend reads.
let blendMemoT = NaN;
const blendMemo = new Map<string, FullColour>();

function blendColour(from: Colour, to: Colour, t: number): FullColour {
  if (t !== blendMemoT || blendMemo.size > 4096) {
    blendMemo.clear();
    blendMemoT = t;
  }
  const key = `${from.r},${from.g},${from.b},${from.w},${from.a},${from.uv}|${to.r},${to.g},${to.b},${to.w},${to.a},${to.uv}`;
  let col = blendMemo.get(key);
  if (!col) {
    col = colourMixer(from, to)(t);
    blendMemo.set(key, col);
  }
  return col;
}

export {
  UV_BOOST,
  blendFixture,
  EXPRESSION_REST,
  resolveEnergyOverride,
  HOLD_STROBE,
  HOLD_STROBE_MAX_HZ,
  HOLD_FLASH_MS,
  HOLD_BLACK_MS,
  HUE_PULSE_MS,
  HUE_PULSE_FLOOR,
  holdStrobeDivision,
  holdStrobeFlash,
  holdStrobeLook,
  huePulseLevel,
  fadeBrightness,
  hitBrightness,
  grooveBrightness,
  blendExpression,
  emitterValues,
  cellDrive,
};
