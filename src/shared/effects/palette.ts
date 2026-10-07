import type { Colour } from '../../types/rig.ts';
import { hash01 } from './hash.ts';
import type { EffectSpec, ParsedPaletteEntry, Seed } from './types.ts';

// Hue entries are degrees; the fixed set keeps random colours distinct.
export const LDJ_RANDOM_HUES = [0, 36, 60, 120, 195, 250, 280, 325];

const colour = (r: number, g: number, b: number, w = 0): Colour => ({ r, g, b, w, a: 0, uv: 0 });
const WHITE = colour(255, 255, 255);

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function parseHex(hex: string): Colour {
  if (typeof hex !== 'string' || !HEX.test(hex)) throw new Error(`not a hex colour: ${String(hex)}`);
  const d = hex.slice(1);
  if (d.length === 3) return colour(...([0, 1, 2].map((i) => parseInt(d[i] + d[i], 16)) as [number, number, number]));
  const byte = (i: number) => parseInt(d.slice(2 * i, 2 * i + 2), 16);
  return colour(byte(0), byte(1), byte(2), d.length === 8 ? byte(3) : 0);
}

// Hex preserves white but has no amber or UV representation.
export function toHex(c: Colour): string {
  const two = (v: number | undefined) => Math.max(0, Math.min(255, Math.round(v ?? 0))).toString(16).padStart(2, '0');
  const w = Math.round(c.w ?? 0) > 0 ? two(c.w) : '';
  return `#${two(c.r)}${two(c.g)}${two(c.b)}${w}`.toUpperCase();
}

// Float32 HSV arithmetic and floor(x + 0.5) preserve the preset colour bytes.
const f32 = Math.fround;
const round = (x: number) => Math.floor(f32(f32(x) + 0.5));

export function hsbToColour(h01: number, s01: number, b01: number): Colour {
  const s = f32(Math.min(1, Math.max(0, s01 || 0)));
  const v = f32(Math.min(1, Math.max(0, b01 || 0)));
  const vb = round(f32(v * 255));
  if (Math.abs(s) <= 1 / 4096) return colour(vb, vb, vb);
  let hx = f32((h01 || 0) * 360);
  // Out-of-range hue is red rather than wrapped, matching the preset colour model.
  if (hx < 0 || hx >= 360) hx = 0;
  const w = f32(hx / 60);
  const f = f32(w - Math.floor(w));
  const p = round(f32(f32(f32(1 - s) * v) * 255));
  const q = round(f32(f32(f32(1 - f32(s * f)) * v) * 255));
  const t = round(f32(f32(f32(1 - f32(s * f32(1 - f))) * v) * 255));
  switch (Math.floor(w)) {
    case 0: return colour(vb, t, p);
    case 1: return colour(q, vb, p);
    case 2: return colour(p, vb, t);
    case 3: return colour(p, q, vb);
    case 4: return colour(t, p, vb);
    default: return colour(vb, p, q);
  }
}

export function samplePalette(pal: readonly Colour[], position: number): Colour {
  const n = pal.length;
  // An empty palette is white in Hue Dynamics too; never an undefined colour mid-frame.
  if (n === 0) return { ...WHITE };
  if (n === 1) return pal[0];
  const pos = Number.isFinite(position) ? position - Math.floor(position) : 0;
  const p = pos * n;
  const i = Math.floor(p) % n;
  const t = p - Math.floor(p);
  const A = pal[i], B = pal[(i + 1) % n];
  const mix = (a: number | undefined, b: number | undefined) => Math.round((a ?? 0) + ((b ?? 0) - (a ?? 0)) * t);
  return { r: mix(A.r, B.r), g: mix(A.g, B.g), b: mix(A.b, B.b), w: mix(A.w, B.w), a: mix(A.a, B.a), uv: mix(A.uv, B.uv) };
}

const isRandom = (e: ParsedPaletteEntry): e is { random: true } => 'random' in e && e.random === true;

export interface PreparedPalette {
  entries: ParsedPaletteEntry[] | null;
  hues: (number | null)[];
  roll: number;
  seed: Seed | null;
  counters: number[];
  pending: number[];
}

// Prepare colours outside the frame loop; rebuild only when the spec changes.
export function preparePalette(spec: Pick<EffectSpec, 'palette'>): PreparedPalette {
  const entries = spec.palette?.map((entry) => typeof entry === 'string' ? parseHex(entry) : { random: true } as const) ?? null;
  return { entries, hues: new Array<number | null>(entries?.length ?? 0).fill(null), roll: -1, seed: null, counters: [], pending: [] };
}

// Rerolls exclude cached hues in slots 0–3 and each slot's prior hue to keep changes distinct.
export function resolvePalette(spec: Pick<EffectSpec, 'palette'>, override: Colour[] | null, lookSlots: readonly Colour[], seed: Seed, roll: number, prepared?: PreparedPalette): Colour[] {
  if (override && override.length) return [...override];
  const state = prepared ?? preparePalette(spec);
  const own = state.entries;
  if (!own || !own.length) return [...lookSlots];
  const randomIndices = own.flatMap((entry, index) => isRandom(entry) ? [index] : []);
  if (randomIndices.length) {
    const target = Number.isSafeInteger(roll) && roll >= 0 ? roll : 0;
    if (!state.seed || state.seed.some((word, index) => word !== seed[index]) || target < state.roll) {
      state.hues.fill(null);
      state.counters = [];
      state.pending = [];
      state.roll = -1;
      state.seed = [...seed];
    }
    // Skipped rolls must update the cache in order too, so a seek matches forward playback.
    for (let next = state.roll + 1; next <= target; next++) {
      for (const index of randomIndices) {
        const excluded = new Set(state.hues.slice(0, 4));
        excluded.add(state.hues[index]);
        const candidates = LDJ_RANDOM_HUES.map((_, hue) => hue).filter((hue) => !excluded.has(hue));
        state.hues[index] = candidates[Math.floor(hash01(seed, 11 + index, next) * candidates.length)];
        state.counters[index] = Math.max(state.counters[index] ?? 0, next + 1);
      }
      state.roll = next;
    }
  }
  return own.map((entry, index) => isRandom(entry) ? hsbToColour(LDJ_RANDOM_HUES[state.hues[index]!] / 360, 1, 1) : entry);
}

export interface PaletteAccess {
  palette: Colour[];
  colour(paletteIndex: number, cacheKey?: number): Colour;
  refresh(cacheKey: number): void;
  frameColour(paletteIndex: number, lamp: number, wholeFrame: number): Colour;
}

export interface PaletteBinding { index: number; key: number }
const PALETTE_BINDING = Symbol('paletteBinding');

export function paletteBinding(colour: Colour): PaletteBinding | undefined {
  const binding = (colour as Colour & { [PALETTE_BINDING]?: PaletteBinding })[PALETTE_BINDING];
  return binding && { ...binding };
}

export function createPaletteAccess(spec: EffectSpec, override: Colour[] | null, look: readonly Colour[], seed: Seed,
  roll: number, state: PreparedPalette): PaletteAccess {
  // Advance hidden colours too so removing an override preserves pending refresh order.
  resolvePalette(spec, null, look, seed, roll, state);
  const checkKey = (key: number) => {
    if (!Number.isSafeInteger(key) || key < 0) throw new RangeError('Palette cache key must be a nonnegative safe integer');
  };
  const refresh = (key: number) => {
    const excluded = new Set(state.hues.slice(0, 4));
    excluded.add(state.hues[key]);
    const candidates = LDJ_RANDOM_HUES.map((_, hue) => hue).filter((hue) => !excluded.has(hue));
    const counter = state.counters[key] ?? 0;
    state.hues[key] = candidates[Math.floor(hash01(seed, 11 + key, counter) * candidates.length)];
    state.counters[key] = counter + 1;
  };
  // Consume each refresh once so repeated keys work without growing checkpoint history.
  for (const key of state.pending.splice(0)) refresh(key);
  const entries: readonly ParsedPaletteEntry[] = override?.length ? override
    : state.entries?.length ? state.entries : look.length ? look : [WHITE];
  const wrap = (index: number) => ((Math.trunc(index) % entries.length) + entries.length) % entries.length;
  const colourAt = (index: number, cacheKey?: number): Colour => {
    const wrapped = wrap(index);
    const entry = entries[wrapped], key = cacheKey ?? wrapped;
    checkKey(key);
    if (isRandom(entry) && state.hues[key] == null) refresh(key);
    const colour = isRandom(entry) ? hsbToColour(LDJ_RANDOM_HUES[state.hues[key]!] / 360, 1, 1) : { ...entry };
    // Copy bindings explicitly; a spread intentionally captures only colour channels.
    return Object.defineProperty(colour, PALETTE_BINDING, { value: { index, key } });
  };
  return {
    palette: entries.map((_, index) => colourAt(index)), colour: colourAt,
    refresh(key) { checkKey(key); state.pending.push(key); },
    frameColour(index, lamp, wholeFrame) {
      checkKey(lamp); checkKey(wholeFrame);
      const entry = entries[wrap(index)];
      if (!isRandom(entry)) return entry;
      const hue = Math.floor(hash01(seed, 71 + lamp, wholeFrame) * LDJ_RANDOM_HUES.length);
      return hsbToColour(LDJ_RANDOM_HUES[hue] / 360, 1, 1);
    },
  };
}
