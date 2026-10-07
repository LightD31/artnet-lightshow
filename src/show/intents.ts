import type { ShowDynamics } from '../types/rig.ts';

const INTENT = Object.freeze({
  SCENE: 'SCENE',
  EXPRESSION: 'EXPRESSION',
  COLOR: 'COLOR',
  ACCENT: 'ACCENT',
  TEMPO: 'TEMPO',
  DARK: 'DARK',
});

// Dark and soft bursts preserve accent choices for tracks that cannot support bright flashes.
const BURST = Object.freeze({
  BLINDER: 'blinder',
  WHITE_STROBE: 'white-strobe',
  COLOR_STROBE: 'color-strobe',
  UV_WASH: 'uv-wash',
  KILL: 'kill',
  GLOW: 'glow',
});

const PRIORITY = Object.freeze({
  SILENCE_HARD: 110,
  DROP: 100,
  BUILDUP: 80,
  EXPRESSION: 70,
  SECTION: 60,
  TEMPO: 55,
  SILENCE: 50,
  ROTATION: 40,
  MELODY: 30,
  // A measured fill outranks the following downbeat because the scene change already marks that boundary.
  FILL_ACCENT: 25,
  BAR_ACCENT: 20,
  BEAT_ACCENT: 10,
});

export type IntentKind = (typeof INTENT)[keyof typeof INTENT];
export type BurstKind = (typeof BURST)[keyof typeof BURST];

interface IntentOptions {
  source?: string;
  priority?: number;
}

interface IntentBase {
  timeMs: number;
  source: string;
  priority: number;
}

export interface ScenePayload {
  pattern?: string;
  colors?: number[];
  beatDivision?: number;
  strobeSpeed?: number;
  strobeFunction?: string;
  bpm?: number;
  running?: boolean;
  opening?: boolean;
  role?: string;
  label?: string | null;
  level?: string;
  identity?: number;
  fadeMs?: number;
  split?: number;
  pixelMap?: string;
  pixelPattern?: string | null;
  pixelSpan?: number | null;
  pixelFrom?: number | null;
  panelPattern?: string | null;
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

function expression(timeMs: number, dynamics: ShowDynamics,
  { source = 'music', priority = PRIORITY.EXPRESSION }: IntentOptions = {}): ExpressionIntent {
  return { timeMs: Math.round(timeMs), kind: INTENT.EXPRESSION, source, priority, dynamics };
}

function color(timeMs: number, colors: number[],
  { source = 'melody', priority = PRIORITY.MELODY, fadeMs = 0 }: IntentOptions & { fadeMs?: number } = {}): ColorIntent {
  return { timeMs: Math.round(timeMs), kind: INTENT.COLOR, source, priority, colors, ...(fadeMs > 0 ? { fadeMs } : {}) };
}

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
