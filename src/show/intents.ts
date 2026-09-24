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

import type { ShowDynamics } from '../types/rig.ts';

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

export type IntentKind = (typeof INTENT)[keyof typeof INTENT];
export type BurstKind = (typeof BURST)[keyof typeof BURST];

/** Where an intent came from, and how it ranks against others at its instant. */
interface IntentOptions {
  source?: string;
  priority?: number;
}

interface IntentBase {
  timeMs: number;
  source: string;
  priority: number;
}

/** Everything a scene may set. Colours are indices into the colour table. */
export interface ScenePayload {
  pattern?: string;
  colors?: number[];
  beatDivision?: number;
  strobeSpeed?: number;
  strobeFunction?: string;
  bpm?: number;
  running?: boolean;
  /** The first scene of a show, which also clears the expression channel. */
  opening?: boolean;
  role?: string;
  label?: string | null;
  level?: string;
  identity?: number;
  fadeMs?: number;
  split?: number;
  pixelMap?: string;
  /** The bars' own picture on a rig with LED bars, null for one pattern on
   *  the whole rig; its span in beats and where in it the scene starts. */
  pixelPattern?: string | null;
  pixelSpan?: number | null;
  pixelFrom?: number | null;
}

export interface SceneIntent extends IntentBase, ScenePayload {
  kind: typeof INTENT.SCENE;
}

export interface ExpressionIntent extends IntentBase {
  kind: typeof INTENT.EXPRESSION;
  dynamics: ShowDynamics;
}

export interface ColorIntent extends IntentBase {
  kind: typeof INTENT.COLOR;
  colors: number[];
  fadeMs?: number;
}

export interface AccentIntent extends IntentBase {
  kind: typeof INTENT.ACCENT;
  burst: BurstKind;
  durationMs: number;
  confidence: number;
  intensity: number;
}

export interface TempoIntent extends IntentBase {
  kind: typeof INTENT.TEMPO;
  bpm: number;
}

export interface DarkIntent extends IntentBase {
  kind: typeof INTENT.DARK;
  colorIndex: number | null;
}

export type Intent = SceneIntent | ExpressionIntent | ColorIntent | AccentIntent | TempoIntent | DarkIntent;

function scene(timeMs: number, payload: ScenePayload,
  { source = 'section', priority = PRIORITY.SECTION }: IntentOptions = {}): SceneIntent {
  return { timeMs: Math.round(timeMs), kind: INTENT.SCENE, source, priority, ...payload };
}

/**
 * A reading of the continuous channel. `dynamics` carries only the fields that
 * moved, and the engine interpolates towards them at frame rate.
 */
function expression(timeMs: number, dynamics: ShowDynamics,
  { source = 'music', priority = PRIORITY.EXPRESSION }: IntentOptions = {}): ExpressionIntent {
  return { timeMs: Math.round(timeMs), kind: INTENT.EXPRESSION, source, priority, dynamics };
}

function color(timeMs: number, colors: number[],
  { source = 'melody', priority = PRIORITY.MELODY, fadeMs = 0 }: IntentOptions & { fadeMs?: number } = {}): ColorIntent {
  return { timeMs: Math.round(timeMs), kind: INTENT.COLOR, source, priority, colors, ...(fadeMs > 0 ? { fadeMs } : {}) };
}

/**
 * `confidence` is how sure the analyser is the moment is real; `intensity` is
 * how big it is musically, 0.5 when nothing was measured. The contrast pass
 * spends its budget on both.
 */
function accent(timeMs: number, burst: BurstKind, durationMs: number,
  { source = 'bar', priority = PRIORITY.BAR_ACCENT, confidence = 1, intensity = 0.5 }:
  IntentOptions & { confidence?: number; intensity?: number } = {}): AccentIntent {
  return {
    timeMs: Math.round(timeMs), kind: INTENT.ACCENT, source, priority,
    burst, durationMs: Math.round(durationMs), confidence, intensity,
  };
}

function tempo(timeMs: number, bpm: number,
  { source = 'curve', priority = PRIORITY.TEMPO }: IntentOptions = {}): TempoIntent {
  return { timeMs: Math.round(timeMs), kind: INTENT.TEMPO, source, priority, bpm };
}

/**
 * `colorIndex` left unset means "whatever the rig calls off" — the renderer
 * fills it in. Passing one is for the rare case where a particular dark colour
 * is wanted rather than the configured blackout.
 */
function dark(timeMs: number, { source = 'gap', priority = PRIORITY.SILENCE,
  colorIndex = null }: IntentOptions & { colorIndex?: number | null } = {}): DarkIntent {
  return { timeMs: Math.round(timeMs), kind: INTENT.DARK, source, priority, colorIndex };
}

export {
  INTENT,
  BURST,
  PRIORITY,
  scene,
  expression,
  color,
  accent,
  tempo,
  dark,
};
