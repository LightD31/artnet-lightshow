import { z } from 'zod';
import { colourMixer } from './color.ts';
import type { Colour } from '../types/rig.ts';

export type PaletteEntry = string | { random: true };
export type ColourSpace = 'rgb' | 'oklch' | 'step';
export type GradientStop = { at: number; slot: number } | { at: number; colour: string };
export interface Gradient { name: string; space: ColourSpace; wrap: boolean; stops: GradientStop[] }
export interface GradientSet { name: string; roles: string[] }
export interface GradientSettings {
  gradients?: Gradient[];
  sets?: GradientSet[];
  gradient?: string | null;
  gradientSet?: string | null;
  gradientRole?: number;
}
export interface PaletteBody extends GradientSettings { colours: PaletteEntry[] }
export interface ResolvedGradient { sample(position: number): Colour }

export const HEX_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8}|[0-9a-f]{10}|[0-9a-f]{12})$/i;
export const DIES = ['r', 'g', 'b', 'w', 'a', 'uv'] as const;

export function parseHex(hex: string): Colour {
  if (typeof hex !== 'string' || !HEX_COLOUR.test(hex)) throw new Error(`not a hex colour: ${String(hex)}`);
  const raw = hex.slice(1), digits = raw.length === 3 ? [...raw].map((d) => d + d).join('') : raw;
  const value = (i: number) => i * 2 < digits.length ? parseInt(digits.slice(i * 2, i * 2 + 2), 16) : 0;
  return { r: value(0), g: value(1), b: value(2), w: value(3), a: value(4), uv: value(5) };
}

export function toHex(colour: Colour): string {
  const bytes = DIES.map((die) => Math.max(0, Math.min(255, Math.round(colour[die] ?? 0))));
  const length = bytes[5] ? 6 : bytes[4] ? 5 : bytes[3] ? 4 : 3;
  return '#' + bytes.slice(0, length).map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export const hexColourSchema = z.string().regex(HEX_COLOUR, 'expected an RGB, RGBW, RGBWA or RGBWAUV hex colour');
export const paletteEntrySchema = z.union([hexColourSchema.transform((v) => toHex(parseHex(v))), z.object({ random: z.literal(true) }).strict(),
  z.literal('random').transform(() => ({ random: true as const }))]);
export const paletteColoursSchema = z.array(paletteEntrySchema).min(1).max(8);
const name = z.string().trim().min(1).max(40);
const stop = z.union([
  z.object({ at: z.number().min(0).max(1), slot: z.number().int().min(0).max(7) }).strict(),
  z.object({ at: z.number().min(0).max(1), colour: hexColourSchema.transform((v) => toHex(parseHex(v))) }).strict(),
]);
export const gradientSchema = z.object({ name, space: z.enum(['rgb', 'oklch', 'step']), wrap: z.boolean(), stops: z.array(stop).min(2).max(16) }).strict()
  .refine((g) => g.stops.every((s, i) => i === 0 || s.at > g.stops[i - 1].at), 'gradient stops must be in increasing order');
export const gradientFields = {
  gradients: z.array(gradientSchema).max(8).optional(),
  sets: z.array(z.object({ name, roles: z.array(name).min(1).max(4) }).strict()).max(8).optional(),
  gradient: name.nullable().optional(),
  gradientSet: name.nullable().optional(),
  gradientRole: z.number().int().min(0).max(3).optional(),
};

export function checkGradients(palette: GradientSettings, count: number, ctx: z.RefinementCtx): void {
  const gradients = palette.gradients ?? [], sets = palette.sets ?? [];
  const names = new Set(gradients.map((g) => g.name)), setNames = new Set(sets.map((s) => s.name));
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  if (names.size !== gradients.length) issue(['gradients'], 'gradient names must be unique');
  if (setNames.size !== sets.length) issue(['sets'], 'gradient set names must be unique');
  gradients.forEach((g, i) => g.stops.forEach((s, j) => {
    if ('slot' in s && s.slot >= count) issue(['gradients', i, 'stops', j, 'slot'], 'slot is outside this palette');
  }));
  sets.forEach((s, i) => s.roles.forEach((role, j) => {
    if (!names.has(role)) issue(['sets', i, 'roles', j], 'no such gradient');
  }));
  if (palette.gradient && !names.has(palette.gradient)) issue(['gradient'], 'no such gradient');
  if (palette.gradientSet && !setNames.has(palette.gradientSet)) issue(['gradientSet'], 'no such gradient set');
}

export const paletteFields = { colours: paletteColoursSchema, ...gradientFields };
export const paletteBodySchema = z.object(paletteFields).strict()
  .superRefine((p, ctx) => checkGradients(p, p.colours.length, ctx));

const cache = new Map<string, ResolvedGradient>();
const colourCache = new Map<string, Colour[]>();

/** Stage palettes are materialized before publication; effect random slots resolve at launch. */
export function fixedColours(body: PaletteBody | null | undefined, fallback: readonly Colour[]): Colour[] {
  if (!body) return [...fallback];
  const key = JSON.stringify(body.colours);
  let colours = colourCache.get(key);
  if (!colours) {
    const entries = new Map<string, Colour>();
    colours = body.colours.map((entry, i) => {
      if (typeof entry !== 'string') return fallback[i % fallback.length] ?? parseHex('#000');
      const key = toHex(parseHex(entry));
      if (!entries.has(key)) entries.set(key, parseHex(key));
      return entries.get(key)!;
    });
    if (colourCache.size >= 64) colourCache.delete(colourCache.keys().next().value!);
    colourCache.set(key, colours);
  }
  return colours;
}

export function resolveGradient(settings: GradientSettings | null | undefined, colours: readonly Colour[]): ResolvedGradient | null {
  const gradients = settings?.gradients;
  if (!gradients?.length || !colours.length) return null;
  const set = settings?.sets?.find((s) => s.name === settings.gradientSet);
  const chosen = set ? set.roles[(settings?.gradientRole ?? 0) % set.roles.length] : settings?.gradient;
  const gradient = gradients.find((g) => g.name === chosen) ?? gradients[0];
  const key = JSON.stringify([gradient, colours.map(toHex)]);
  const found = cache.get(key);
  if (found) return found;
  const stops = gradient.stops.map((s) => ({ at: s.at, colour: 'slot' in s ? colours[s.slot % colours.length] : parseHex(s.colour) }));
  const pairs = stops.map((s, i) => ({ from: s, to: stops[(i + 1) % stops.length],
    mix: gradient.space === 'oklch' ? colourMixer(s.colour, stops[(i + 1) % stops.length].colour) : null }));
  const sample = (position: number): Colour => {
    let p = Number.isFinite(position) ? position : 0;
    p = gradient.wrap ? p - Math.floor(p) : Math.max(0, Math.min(1, p));
    const first = stops[0], last = stops[stops.length - 1];
    if (!gradient.wrap && p <= first.at) return first.colour;
    if (!gradient.wrap && p >= last.at) return last.colour;
    let index = stops.findIndex((s) => s.at > p) - 1;
    if (index < 0) index = stops.length - 1;
    const pair = pairs[index], wrap = index === pairs.length - 1;
    const start = pair.from.at, end = pair.to.at + (wrap ? 1 : 0);
    if (wrap && p < start) p += 1;
    const t = end > start ? Math.max(0, Math.min(1, (p - start) / (end - start))) : 0;
    if (gradient.space === 'step') return pair.from.colour;
    if (pair.mix) return pair.mix(t);
    const mix = (die: typeof DIES[number]) => Math.round((pair.from.colour[die] ?? 0) + ((pair.to.colour[die] ?? 0) - (pair.from.colour[die] ?? 0)) * t);
    return { r: mix('r'), g: mix('g'), b: mix('b'), w: mix('w'), a: mix('a'), uv: mix('uv') };
  };
  // Perceptual conversion is expensive; the authored gradient shares a bounded LUT.
  const table = gradient.space === 'oklch' ? Array.from({ length: 1025 }, (_, i) => sample(i / 1024)) : null;
  const resolved = { sample: table ? (position: number) => {
    const p = Number.isFinite(position) ? position : 0;
    return table[Math.round((gradient.wrap ? p - Math.floor(p) : Math.max(0, Math.min(1, p))) * 1024)];
  } : sample };
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(key, resolved);
  return resolved;
}

export function colourSlots(colours: readonly Colour[]): Colour[] {
  return Array.from({ length: Math.max(4, colours.length) }, (_, i) => colours[i % colours.length]);
}
