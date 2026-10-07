import crypto from 'node:crypto';
import { z } from 'zod';

// The entry point registers every kind, so a stored spec validates against it.
import { CATALOGUE, deepFreeze, presetById } from '../shared/effects/index.ts';
import { requiresAcknowledgement, validateSpec } from '../shared/effects/registry.ts';
import { canonical } from '../shared/effects/layer.ts';
import { PATTERN_FUNCS } from '../shared/patterns.ts';
import { PATTERN_IDS } from './presets.ts';
import { validate, ValidationError } from './validation.ts';
import { HttpError, messageOf } from '../errors.ts';
import { JsonStore } from './json-store.ts';
import type { CataloguePreset } from '../shared/effects/index.ts';
import type { EffectSpec } from '../shared/effects/types.ts';

// Validate and persist edits before publishing them so failed writes cannot change active library state.

export const MAX_PRESETS = 256;

export interface UserPreset { id: string; name: string; spec: EffectSpec; createdAt: string; updatedAt: string }

export type LibraryEntry = { source: 'builtin'; preset: CataloguePreset } | { source: 'user'; preset: UserPreset };

export type Admission = (id: string, spec: EffectSpec) => void;

export interface PresetSummary {
  id: string; name: string; kind: string; rapidFlash: boolean; scope: EffectSpec['scope'] | null; updatedAt: string;
}

export interface EffectLibraryOptions {
  now?: () => Date;
}

const PATTERNS = new Set<string>(PATTERN_IDS);
const ROUTE_WORDS = new Set(['command']);

function reserved(id: string): boolean {
  return ROUTE_WORDS.has(id) || PATTERNS.has(id) || Object.hasOwn(PATTERN_FUNCS, id) || presetById(id) !== null;
}

export function newUserId(): string {
  return `user.${crypto.randomBytes(8).toString('hex')}`;
}

export const snapshot = <T>(value: T): T => structuredClone(value);

function specIssues(err: unknown): { text: string; issues: z.ZodIssue[] | null } {
  const issues = (err as { issues?: z.ZodIssue[] }).issues;
  if (!Array.isArray(issues)) return { text: `spec ${messageOf(err)}`, issues: null };
  return { text: issues.map((i) => `${['spec', ...i.path].join('.')} ${i.message}`).join('; '), issues };
}

function specOf(raw: unknown): EffectSpec {
  try {
    return validateSpec(raw);
  } catch (err) {
    const { text, issues } = specIssues(err);
    throw issues ? new ValidationError(`preset: ${text}`, issues) : new HttpError(400, `preset: ${text}`);
  }
}

const nameSchema = z.string().min(1).max(80);
const createSchema = z.object({ name: nameSchema, spec: z.unknown() }).strict();
const updateSchema = z.object({ name: nameSchema.optional(), spec: z.unknown().optional() }).strict();

const storedSpec = z.unknown().transform((raw, ctx): EffectSpec => {
  try {
    return validateSpec(raw);
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: `not a valid effect: ${specIssues(err).text}` });
    return z.NEVER;
  }
});

const fileSchema = z.object({
  presets: z.array(z.object({
    id: z.string().min(1).max(64),
    name: nameSchema,
    spec: storedSpec,
    createdAt: z.string().max(40),
    updatedAt: z.string().max(40),
  }).strict()).max(MAX_PRESETS),
}).strict().superRefine((file, ctx) => {
  const seen = new Set<string>();
  file.presets.forEach(({ id }, i) => {
    if (reserved(id)) ctx.addIssue({ code: 'custom', path: ['presets', i, 'id'], message: `${id} is a built-in name` });
    else if (seen.has(id)) ctx.addIssue({ code: 'custom', path: ['presets', i, 'id'], message: `${id} is used twice` });
    seen.add(id);
  });
});

export class EffectLibrary extends JsonStore {
  declare _presets: readonly UserPreset[];
  declare _byId: Map<string, UserPreset>;
  declare _revision: number;
  declare _listeners: (() => void)[];
  declare _admit: Admission | null;
  declare _now: () => Date;
  declare _summaries: readonly PresetSummary[] | null;

  constructor(file: string, { now = () => new Date() }: EffectLibraryOptions = {}) {
    super(file, { tag: 'effects', fallback: 'starting with the built-in presets only' });
    this._revision = 0;
    this._listeners = [];
    this._admit = null;
    this._now = now;
    this._install([]);
  }

  load(): this {
    const saved = this.readValid(fileSchema);
    if (saved) this._install(saved.presets);
    return this;
  }

  useDefaults(): void {
    this._install([]);
  }

  _install(presets: readonly UserPreset[]): void {
    this._presets = deepFreeze([...presets]);
    this._byId = new Map(presets.map((p) => [p.id, p]));
    this._summaries = null;
  }

  resolve(id: string): EffectSpec | null {
    const row = presetById(id);
    if (row) return row.legacy ? null : row.spec;
    return this._byId.get(id)?.spec ?? null;
  }

  isKnownPattern(id: string): boolean {
    return PATTERNS.has(id) || presetById(id) !== null || this._byId.has(id);
  }

  list(): { builtin: CataloguePreset[]; user: UserPreset[] } {
    return { builtin: CATALOGUE.map(snapshot), user: this._presets.map(snapshot) };
  }

  get(id: string): LibraryEntry | null {
    const row = presetById(id);
    if (row) return { source: 'builtin', preset: snapshot(row) };
    const preset = this._byId.get(id);
    return preset ? { source: 'user', preset: snapshot(preset) } : null;
  }

  summaries(): readonly PresetSummary[] {
    this._summaries ??= deepFreeze(this._presets.map(({ id, name, spec, updatedAt }) => ({
      id, name, kind: spec.kind, rapidFlash: requiresAcknowledgement(spec), scope: spec.scope ?? null, updatedAt,
    })));
    return this._summaries;
  }

  revision(): number {
    return this._revision;
  }

  onChange(fn: () => void): void {
    this._listeners.push(fn);
  }

  setAdmission(fn: Admission | null): void {
    this._admit = fn;
  }

  create(input: unknown): UserPreset {
    const { name, spec: raw } = validate(createSchema, input, 'preset');
    const spec = specOf(raw);
    if (this._presets.length >= MAX_PRESETS) throw new HttpError(400, `The effect library is full (${MAX_PRESETS} presets)`);
    let id = newUserId();
    while (this._byId.has(id) || reserved(id)) id = newUserId();
    this._admit?.(id, spec);
    const at = this._now().toISOString();
    const preset: UserPreset = { id, name, spec, createdAt: at, updatedAt: at };
    this._commit([...this._presets, preset]);
    return snapshot(preset);
  }

  update(id: string, input: unknown): UserPreset | null {
    const current = this._byId.get(id);
    if (!current) return null;
    const body = validate(updateSchema, input, 'preset');
    const spec = body.spec === undefined ? current.spec : specOf(body.spec);
    const name = body.name ?? current.name;
    const respec = canonical(spec) !== canonical(current.spec);
    if (!respec && name === current.name) return snapshot(current);
    if (respec) this._admit?.(id, spec);
    const next: UserPreset = { ...current, name, spec: respec ? spec : current.spec, updatedAt: this._now().toISOString() };
    this._commit(this._presets.map((p) => (p.id === id ? next : p)));
    return snapshot(next);
  }

  remove(id: string): boolean {
    if (!this._byId.has(id)) return false;
    this._commit(this._presets.filter((p) => p.id !== id));
    return true;
  }

  // Persist before publishing so runtime state cannot diverge from the saved library.
  _commit(next: readonly UserPreset[]): void {
    try {
      this.writeJson({ presets: next });
    } catch (err) {
      console.warn(`[effects] could not save ${this.file}: ${messageOf(err)}`);
      throw new HttpError(500, `Could not save the effect library: ${messageOf(err)}`);
    }
    this._install(next);
    this._revision++;
    for (const fn of this._listeners) {
      try { fn(); } catch (err) { console.warn(`[effects] listener: ${messageOf(err)}`); }
    }
  }
}
