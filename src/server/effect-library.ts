import crypto from 'node:crypto';
import { z } from 'zod';

// The entry point registers every kind, so a stored spec validates against it.
import { CATALOGUE, deepFreeze, presetById } from '../shared/effects/index.ts';
import { validateSpec } from '../shared/effects/registry.ts';
import { canonical } from '../shared/effects/layer.ts';
import { PATTERN_FUNCS } from '../shared/patterns.ts';
import { PATTERN_IDS } from './presets.ts';
import { validate, ValidationError } from './validation.ts';
import { HttpError, messageOf } from '../errors.ts';
import { JsonStore } from './json-store.ts';
import type { CataloguePreset } from '../shared/effects/index.ts';
import type { EffectSpec } from '../shared/effects/types.ts';

/**
 * The effects a look can play: the built-in catalogue, frozen, and the
 * presets saved on this server beside it, in config/effects.json.
 *
 * A built-in is never edited; saving a changed copy is how it is made one's
 * own. Every change is validated and written before anything else sees it,
 * so a refused or failed edit leaves the library, the file and the revision
 * as they were.
 */

// A library for a night's set, not a database. The cap keeps a stuck client
// from growing the file (and every list) without bound.
export const MAX_PRESETS = 256;

export interface UserPreset { id: string; name: string; spec: EffectSpec; createdAt: string; updatedAt: string }

/** One preset by id, and where it comes from. */
export type LibraryEntry = { source: 'builtin'; preset: CataloguePreset } | { source: 'user'; preset: UserPreset };

/** Asked before a preset takes a new spec; a throw refuses the change. */
export type Admission = (id: string, spec: EffectSpec) => void;

export interface EffectLibraryOptions {
  /** The clock the records are stamped by. */
  now?: () => Date;
}

const PATTERNS = new Set<string>(PATTERN_IDS);
// Words the routes use where an id would go (/api/effects/command).
const ROUTE_WORDS = new Set(['command']);

/** An id a saved preset may not take: a built-in's, an alias, a pattern's, a route's. */
function reserved(id: string): boolean {
  return ROUTE_WORDS.has(id) || PATTERNS.has(id) || Object.hasOwn(PATTERN_FUNCS, id) || presetById(id) !== null;
}

/** The id of a new record: a namespace no built-in uses, and 64 random bits. */
export function newUserId(): string {
  return `user.${crypto.randomBytes(8).toString('hex')}`;
}

/** The caller's own copy of a record: changing it changes nothing here. */
export const snapshot = <T>(value: T): T => structuredClone(value);

/** What is wrong with a spec, each issue under its path in the record (`spec.params.cadence …`). */
function specIssues(err: unknown): { text: string; issues: z.ZodIssue[] | null } {
  const issues = (err as { issues?: z.ZodIssue[] }).issues;
  if (!Array.isArray(issues)) return { text: `spec ${messageOf(err)}`, issues: null };
  return { text: issues.map((i) => `${['spec', ...i.path].join('.')} ${i.message}`).join('; '), issues };
}

/** A spec as the effects play it, or a 400 saying what is wrong with it. */
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

// A stored spec is validated as the file loads, inside the schema: a spec
// that no longer validates fails the file, which is then moved aside whole.
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

  /**
   * effects.json. No file is normal (nothing saved yet); one that does not
   * validate is moved aside whole (JsonStore), and the show starts with the
   * built-ins alone.
   */
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

  // Held frozen: the engine keeps the spec it is handed, and a caller that
  // could change it would change the show without a save.
  _install(presets: readonly UserPreset[]): void {
    this._presets = deepFreeze([...presets]);
    this._byId = new Map(presets.map((p) => [p.id, p]));
  }

  /**
   * The effect a pattern id plays: a built-in by id or alias, else a saved
   * preset, else null. A legacy row is null too: its pattern function keeps
   * drawing it. The same frozen object every time until the preset changes.
   */
  resolve(id: string): EffectSpec | null {
    const row = presetById(id);
    if (row) return row.legacy ? null : row.spec;
    return this._byId.get(id)?.spec ?? null;
  }

  /** Whether an id names anything: a pattern, a built-in or a saved preset. */
  isKnownPattern(id: string): boolean {
    return PATTERNS.has(id) || presetById(id) !== null || this._byId.has(id);
  }

  /** Every preset, built-in and saved, as copies. */
  list(): { builtin: CataloguePreset[]; user: UserPreset[] } {
    return { builtin: CATALOGUE.map(snapshot), user: this._presets.map(snapshot) };
  }

  /** One preset as a copy, a built-in under its canonical id with its length and aliases. */
  get(id: string): LibraryEntry | null {
    const row = presetById(id);
    if (row) return { source: 'builtin', preset: snapshot(row) };
    const preset = this._byId.get(id);
    return preset ? { source: 'user', preset: snapshot(preset) } : null;
  }

  /** Counts every saved change, a rename included. */
  revision(): number {
    return this._revision;
  }

  /** Called after every saved change; never for a refused, failed or empty one. */
  onChange(fn: () => void): void {
    this._listeners.push(fn);
  }

  /** What decides whether a preset may take a new spec (the preset on stage plays it at once). */
  setAdmission(fn: Admission | null): void {
    this._admit = fn;
  }

  /** Save a new preset. The id and the times are the server's. */
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

  /**
   * Rename a saved preset, give it a new spec, or both. Null for a built-in
   * or an unknown id. An edit that changes nothing (the same spec with its
   * keys in another order included) is not saved, stamped or announced.
   */
  update(id: string, input: unknown): UserPreset | null {
    const current = this._byId.get(id);
    if (!current) return null;
    const body = validate(updateSchema, input, 'preset');
    const spec = body.spec === undefined ? current.spec : specOf(body.spec);
    const name = body.name ?? current.name;
    const respec = canonical(spec) !== canonical(current.spec);
    if (!respec && name === current.name) return snapshot(current);
    if (respec) this._admit?.(id, spec);
    // A rename keeps the very spec object: nothing downstream sees a new effect.
    const next: UserPreset = { ...current, name, spec: respec ? spec : current.spec, updatedAt: this._now().toISOString() };
    this._commit(this._presets.map((p) => (p.id === id ? next : p)));
    return snapshot(next);
  }

  /** Delete a saved preset; false for a built-in or an unknown id. */
  remove(id: string): boolean {
    if (!this._byId.has(id)) return false;
    this._commit(this._presets.filter((p) => p.id !== id));
    return true;
  }

  // Written first, then published: a write that fails leaves the process
  // agreeing with the file, rather than holding a preset a restart loses.
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
