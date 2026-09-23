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

import { colourMixer } from './color.js';

// A UV die reads far dimmer to the eye than the same number on a primary, so it
// is driven harder to sit level with the rest of the mix. Defined here rather
// than in profiles.js because the preview needs it too and must not grow its
// own copy; profiles.js re-exports it for the callers that already ask there.
const UV_BOOST = 1.8;

// Where the expression channel sits when no show is driving it: full level,
// everything else mid. Frozen because it is the value the engine falls back to
// by assignment, and a mutated rest state would be a very confusing bug.
const EXPRESSION_REST = Object.freeze({
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
function resolveEnergyOverride(id, colA, level = 1) {
  const a = colA || { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
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

/** `fade`'s sine, 25..255. `phase` is 0..1 across its eight beats (beat-clock.js). */
function fadeBrightness(phase) {
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
function hitBrightness(phase) {
  const p = Math.max(0, Math.min(1, phase));
  return Math.round(35 + Math.pow(1 - p, 1.8) * 220);
}

/**
 * One step of the expression channel towards what the show last asked for.
 *
 * Returns a new object; `current` is not mutated, so a caller that keeps a
 * running value assigns the result. Silence closes immediately even for
 * long-decay music — a room that is supposed to be dark cannot fade there.
 */
function blendExpression(current, target, dt) {
  if (!target) return { ...EXPRESSION_REST };
  const next = { ...current };
  const blend = 1 - Math.exp(-dt / (.12 + (target.decay || 0) * .45));
  for (const key of Object.keys(next)) {
    if (target[key] != null) next[key] += (target[key] - next[key]) * blend;
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
function emitterValues(col, scale) {
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
function cellDrive(dim, top, ms, fixtureDimmer, cellDimmer) {
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
function blendFixture(from, to, t) {
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
const blendMemo = new Map();

function blendColour(from, to, t) {
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
  fadeBrightness,
  hitBrightness,
  blendExpression,
  emitterValues,
  cellDrive,
};
