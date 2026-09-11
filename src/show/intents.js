'use strict';

/**
 * Lighting intents — what the show wants to happen, in rig-neutral terms.
 *
 *     musical events  ->  LIGHTING INTENT  ->  DMX / Art-Net
 *
 * An intent says "hold this look", "hit a colour strobe for 300 ms", "move the
 * beat clock to 140". It says nothing about DMX channels, patch fields or
 * fixture personalities — that translation is `render.js`, and keeping it
 * separate is what lets the director be tested by reading its decisions rather
 * than by decoding a stream of channel values.
 *
 * `priority` breaks ties when two intents want the same instant. It also drives
 * the contrast pass: when the show is over budget, the lowest-priority accents
 * are the ones that go.
 */

const INTENT = Object.freeze({
  /** Establish a whole look: pattern, colours, beat division, strobe channel. */
  SCENE: 'SCENE',
  /**
   * Move the continuous expression channel — how loud, how low, how wide, how
   * fast the rig is breathing right now.
   *
   * The distinction from SCENE is what keeps a show from twitching. A scene is
   * a *decision* and resets the pattern's phase; an expression is a *reading*
   * and is emitted twice a second all track long. Putting them on the same
   * intent would mean the rig restarted its chase every half second in order
   * to follow a swell.
   */
  EXPRESSION: 'EXPRESSION',
  /** Move colours only, leaving the pattern and everything else alone. */
  COLOR: 'COLOR',
  /** A short burst on top of the current look. */
  ACCENT: 'ACCENT',
  /** Move the beat clock. */
  TEMPO: 'TEMPO',
  /** Go dark — the gap before a drop, or a genuine silence in the track. */
  DARK: 'DARK',
});

/**
 * Burst kinds, loudest first. The renderer maps these to energy overrides.
 *
 * The quiet end of this list is not padding. Everything above `UV_WASH` is a
 * *flash*, so before the soft gestures existed a track with a gentle or
 * unpercussive character had no accent it could use and therefore got none.
 *
 * Two of them mark a moment by taking light away rather than adding it, which
 * is the gesture a rig of static pars is best at and the one that cannot be
 * confused with the pattern running underneath. `KILL` is a hole on the beat.
 * `UV_WASH` drops everything to blacklight, which reads as a change of state
 * rather than as a hit.
 *
 * There used to be a `color-punch` here — a solid stab in the look's own
 * colour. It never found a form that worked: in the look's colour it was
 * indistinguishable from the pattern stuttering, and lifted with white it was
 * indistinguishable from the blinder. `KILL` does the job it was meant to do.
 */
const BURST = Object.freeze({
  BLINDER: 'blinder',
  WHITE_STROBE: 'white-strobe',
  COLOR_STROBE: 'color-strobe',
  UV_WASH: 'uv-wash',
  KILL: 'kill',
  GLOW: 'glow',
});

const PRIORITY = Object.freeze({
  // A genuine silence outranks even a drop: the two can land within a
  // millisecond of each other at a stutter edit, and the silence is the one
  // the audience will notice going wrong.
  SILENCE_HARD: 110,
  DROP: 100,
  BUILDUP: 80,
  EXPRESSION: 70,
  SECTION: 60,
  TEMPO: 55,
  SILENCE: 50,
  ROTATION: 40,
  MELODY: 30,
  BAR_ACCENT: 20,
  BEAT_ACCENT: 10,
});

function scene(timeMs, payload, { source = 'section', priority = PRIORITY.SECTION } = {}) {
  return { timeMs: Math.round(timeMs), kind: INTENT.SCENE, source, priority, ...payload };
}

/**
 * A reading of the continuous channel. `dynamics` carries only the fields that
 * moved, and the engine interpolates towards them at frame rate.
 */
function expression(timeMs, dynamics, { source = 'music', priority = PRIORITY.EXPRESSION } = {}) {
  return { timeMs: Math.round(timeMs), kind: INTENT.EXPRESSION, source, priority, dynamics };
}

function color(timeMs, colors, { source = 'melody', priority = PRIORITY.MELODY } = {}) {
  return { timeMs: Math.round(timeMs), kind: INTENT.COLOR, source, priority, colors };
}

function accent(timeMs, burst, durationMs,
  { source = 'bar', priority = PRIORITY.BAR_ACCENT, confidence = 1 } = {}) {
  return {
    timeMs: Math.round(timeMs), kind: INTENT.ACCENT, source, priority,
    burst, durationMs: Math.round(durationMs), confidence,
  };
}

function tempo(timeMs, bpm, { source = 'curve', priority = PRIORITY.TEMPO } = {}) {
  return { timeMs: Math.round(timeMs), kind: INTENT.TEMPO, source, priority, bpm };
}

/**
 * `colorIndex` left unset means "whatever the rig calls off" — the renderer
 * fills it in. Passing one is for the rare case where a particular dark colour
 * is wanted rather than the configured blackout.
 */
function dark(timeMs, { source = 'gap', priority = PRIORITY.SILENCE,
  colorIndex = null } = {}) {
  return { timeMs: Math.round(timeMs), kind: INTENT.DARK, source, priority, colorIndex };
}

module.exports = { INTENT, BURST, PRIORITY, scene, expression, color, accent, tempo, dark };
