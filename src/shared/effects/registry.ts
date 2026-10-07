// Kinds register on import so the worker and browser use the same definitions.
// Specs remain wire data: fixed colours are only parsed when an instance starts.

import { z } from 'zod';
import { admissionPolicySchema } from '../hardware.ts';
import { HEX_COLOUR, gradientFields, checkGradients, paletteBodySchema } from '../palette-model.ts';
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

// Set while a trusted caller validates: only then does an internal kind exist.
let internalAdmitted = false;

const paramsSchema = z.record(z.string(), z.unknown());
const specSchema = z.object({
  admission: admissionPolicySchema.optional(),
  kind: z.string().refine((kind) => KINDS.has(kind) && (internalAdmitted || !KINDS.get(kind)!.internal), 'unknown effect kind'),
  params: paramsSchema.optional(),
  palette: z.array(z.union([
    z.string().regex(HEX_COLOUR, 'expected a full colour hex value'),
    z.object({ random: z.literal(true) }),
  ])).min(1).max(8).nullable().optional(),
  ...gradientFields,
  brightness: z.number().min(0).max(1).optional(),
  rapidFlash: z.boolean().optional(),
  minFlashIntervalMs: z.number().min(0).optional(),
  scope: z.enum(['singleBeat', 'measure']).optional(),
}).superRefine((spec, ctx) => checkGradients(spec, spec.palette?.length ?? 8, ctx));

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

/**
 * A spec as the effects play it. Internal kinds (EffectKindDef.internal) are
 * unknown here unless `internal` is set, and then for its children too.
 */
export function validateSpec(raw: unknown, { internal = false }: { internal?: boolean } = {}): EffectSpec {
  const before = internalAdmitted;
  internalAdmitted = before || internal;
  try {
    return validateAdmitted(raw);
  } finally {
    internalAdmitted = before;
  }
}

function validateAdmitted(raw: unknown): EffectSpec {
  if (isRecord(raw) && isRecord(raw.palette)) {
    const { colours, ...gradient } = paletteBodySchema.parse(raw.palette);
    raw = { ...raw, ...gradient, palette: colours };
  }
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
