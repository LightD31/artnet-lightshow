// Kinds register on import so the worker and browser use the same definitions.
// Specs remain wire data: fixed colours are only parsed when an instance starts.

import { z } from 'zod';
import type { EffectKindDef, EffectSpec } from './types.ts';

export const KINDS = new Map<string, EffectKindDef>();

export function registerKind<P, S>(def: EffectKindDef<P, S>): void {
  KINDS.set(def.kind, def);
}

export function kindOf(kind: string): EffectKindDef | null {
  return KINDS.get(kind) ?? null;
}

export function requiresAcknowledgement(spec: EffectSpec): boolean {
  const def = kindOf(spec.kind);
  return Boolean(spec.rapidFlash || def?.rapidFlash || def?.rapidFlashWhen?.(spec.params));
}

/** Does a kind ride the expression level on a curve of its own (glow), so a layer's level is not multiplied by it again. */
export function ridesLevel(kind: string | null | undefined): boolean {
  return !!kind && !!kindOf(kind)?.rideLevel;
}

/** Does a spec hold its flash limit in its own state (EffectKindDef.pacesOwnFlashes); false for an unknown kind. */
export function pacesOwnFlashes(spec: EffectSpec): boolean {
  return Boolean(kindOf(spec.kind)?.pacesOwnFlashes?.(spec.params ?? {}));
}

const paramsSchema = z.record(z.string(), z.unknown());
const specSchema = z.object({
  kind: z.string().refine((kind) => KINDS.has(kind), 'unknown effect kind'),
  params: paramsSchema.optional(),
  palette: z.array(z.union([
    z.string().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i, 'expected a hex colour'),
    z.object({ random: z.literal(true) }),
  ])).min(1).max(8).nullable().optional(),
  brightness: z.number().min(0).max(1).optional(),
  rapidFlash: z.boolean().optional(),
  minFlashIntervalMs: z.number().min(0).optional(),
  scope: z.enum(['singleBeat', 'measure']).optional(),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Filling nested defaults lets an inspector change one trigger or spatial field
// without losing its siblings. Arrays and explicit nulls are complete values.
function fillDefaults(defaults: unknown, supplied: unknown): unknown {
  if (supplied === undefined) return defaults;
  if (!isRecord(defaults) || !isRecord(supplied)) return supplied;
  return Object.fromEntries([...new Set([...Object.keys(defaults), ...Object.keys(supplied)])]
    .map((key) => [key, fillDefaults(defaults[key], supplied[key])]));
}

export function validateSpec(raw: unknown): EffectSpec {
  const supplied = specSchema.parse(raw);
  const def = KINDS.get(supplied.kind)!;
  // Only absence inherits a recommendation: false, zero and null remain explicit.
  const present = Object.fromEntries(Object.entries(supplied).filter(([, value]) => value !== undefined));
  const merged = specSchema.parse({ ...def.defaults, ...present, brightness: supplied.brightness ?? def.defaults.brightness ?? 1 });
  const params = paramsSchema.parse(parseParams(def, fillDefaults(def.defaults.params, supplied.params)));
  return { ...merged, params };
}

// A kind's schema sees the params alone; its issues are moved under `params`,
// so an error names `params.cadence` rather than a spec field `cadence`.
function parseParams(def: EffectKindDef, params: unknown): unknown {
  const result = def.schema.safeParse(params);
  if (result.success) return result.data;
  throw new z.ZodError(result.error.issues.map((issue) => ({ ...issue, path: ['params', ...issue.path] })));
}

export function specWithDefaults<P = Record<string, unknown>>(kind: string, params?: Partial<P>): EffectSpec {
  return validateSpec({ kind, params });
}
