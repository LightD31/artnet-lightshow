import { colourMixer } from './color.ts';
import type { Colour, EmitterLevels, Expression, FullColour, ShowDynamics } from '../types/rig.ts';

export interface EnergyLook {
  col: Colour;
  dim: number;
  strobe: number;
}

export interface UnitLight extends Colour {
  dim: number;
  strobe: number;
}

// Boost UV because equal channel values look dimmer than the primary emitters.
const UV_BOOST = 1.8;

// Freeze the fallback expression because callers reuse it by reference.
const EXPRESSION_REST: Readonly<Expression> = Object.freeze({
  level: 1, bass: .5, vocal: .5, air: .3, width: .5, motion: .3, decay: .25,
});

function resolveEnergyOverride(id: string | null | undefined, colA: Colour | null | undefined, level = 1): EnergyLook | null {
  const a: Colour = colA || { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
  switch (id) {
    // Cold: no amber, so it reads as a hard white flash rather than a warm one.
    case 'white-strobe': return { col: { r: 255, g: 255, b: 255, w: 255, a: 0, uv: 0 }, dim: 255, strobe: 255 };
    case 'glow': return { col: a, dim: Math.round(150 + 105 * level), strobe: 0 };
    case 'color-strobe': return {
      col: { r: a.r, g: a.g, b: a.b, w: a.w || 0, a: a.a || 0, uv: a.uv || 0 },
      dim: 255, strobe: 255,
    };
    // Exclude UV from blinder because it adds no perceived brightness to visible white.
    case 'blinder': return { col: { r: 255, g: 255, b: 255, w: 255, a: 255, uv: 0 }, dim: 255, strobe: 0 };
    case 'uv-wash': return { col: { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 255 }, dim: 255, strobe: 0 };
    // Close the dimmer as well as the emitters so kill also blacks out dimmer-only fixtures.
    case 'kill': return { col: { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 }, dim: 0, strobe: 0 };
    default: return null;
  }
}


const HOLD_STROBE = 'palette-strobe';
const HOLD_STROBE_MAX_HZ = 5;
const HOLD_FLASH_MS = 100;
const HOLD_BLACK_MS = 100;
const HUE_PULSE_MS = 200;
const HUE_PULSE_FLOOR = 40;

export interface HoldFlash {
  index: number;
  sinceMs: number;
  periodMs: number;
}

function tempoOf(bpm: number | null | undefined): number {
  return typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
}

function holdStrobeDivision(bpm: number | null | undefined, maxHz: number = HOLD_STROBE_MAX_HZ): number {
  const tempo = tempoOf(bpm);
  const cap = Number.isFinite(maxHz) && maxHz > 0 ? Math.min(maxHz, HOLD_STROBE_MAX_HZ) : HOLD_STROBE_MAX_HZ;
  const rate = (perBeat: number) => (tempo / 60) * perBeat;
  let perBeat = 1;
  while (rate(perBeat * 2) <= cap) perBeat *= 2;
  while (perBeat > 1 / 16 && rate(perBeat) > cap) perBeat /= 2;
  return perBeat;
}

function holdStrobeFlash(beatPos: number, bpm: number | null | undefined, maxHz: number = HOLD_STROBE_MAX_HZ): HoldFlash {
  const tempo = tempoOf(bpm);
  const perBeat = holdStrobeDivision(tempo, maxHz);
  const periodMs = 60000 / tempo / perBeat;
  const pos = beatPos * perBeat;
  const index = Math.floor(pos);
  return { index, sinceMs: (pos - index) * periodMs, periodMs };
}

function holdStrobeLook(palette: readonly Colour[], flash: HoldFlash, hue: boolean): EnergyLook | null {
  const n = Math.max(1, palette.length);
  const col = palette[((flash.index % n) + n) % n] || { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
  if (hue) return { col, dim: huePulseLevel(flash.sinceMs), strobe: 0 };
  if (flash.sinceMs < HOLD_FLASH_MS) return { col, dim: 255, strobe: 0 };
  if (flash.sinceMs < HOLD_FLASH_MS + HOLD_BLACK_MS) return { col: { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 }, dim: 0, strobe: 0 };
  return null;
}

function huePulseLevel(sinceMs: number, floor = HUE_PULSE_FLOOR): number {
  const fall = Math.max(0, Math.min(1, sinceMs / HUE_PULSE_MS));
  return Math.round(255 - (255 - floor) * fall);
}

function fadeBrightness(phase: number): number {
  return Math.round(((Math.sin(phase * Math.PI * 2 - Math.PI / 2) + 1) / 2) * 230 + 25);
}

// Clamp hit phase so a decay holds its floor instead of retriggering after one beat.
function hitBrightness(phase: number): number {
  const p = Math.max(0, Math.min(1, phase));
  return Math.round(35 + Math.pow(1 - p, 1.8) * 220);
}

const GRID_UNDER_GROOVE = 0.5;

function grooveBrightness(clock: number, groove: number): number {
  const underneath = 35 + (clock - 35) * GRID_UNDER_GROOVE;
  return Math.round(Math.max(underneath, 35 + 220 * Math.max(0, Math.min(1, groove))));
}

// Silence closes immediately so a long decay cannot delay blackout.
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

// Round and boost emitters here so rig output and rehearsal use the same bytes.
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

// Split squared brightness between fixture and cell dimmers so bars match pars at equal levels.
function cellDrive(dim: number, top: number, ms: number, fixtureDimmer: boolean, cellDimmer: boolean): { cellDim: number; scale: number } {
  const scale = ms * dim / 255;
  if (!fixtureDimmer) return { cellDim: Math.round(dim * ms), scale };
  if (top <= 0) return { cellDim: 0, scale: 0 };
  return {
    cellDim: Math.round((255 * dim) / top),
    scale: cellDimmer || dim === top ? scale : (scale * dim) / top,
  };
}

// Use destination strobe immediately because interpolating hardware rates has no useful meaning.
function blendFixture(from: UnitLight, to: UnitLight, t: number): UnitLight {
  if (t >= 1) return to;
  const col = blendColour(from, to, t);
  return { ...col, dim: Math.round(from.dim + (to.dim - from.dim) * t), strobe: to.strobe };
}

// Cache identical blends within a frame to avoid repeating the expensive colour-space conversion.
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
  tempoOf,
  fadeBrightness,
  hitBrightness,
  grooveBrightness,
  blendExpression,
  emitterValues,
  cellDrive,
};
