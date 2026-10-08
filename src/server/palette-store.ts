import crypto from 'node:crypto';
import { z } from 'zod';

import { deepFreeze } from '../shared/effects/index.ts';
import { resolvePalette, toHex } from '../shared/effects/palette.ts';
import { canonical } from '../shared/effects/layer.ts';
import { newUserId, snapshot } from './effect-library.ts';
import { validate } from './validation.ts';
import { HttpError, messageOf } from '../errors.ts';
import { JsonStore } from './json-store.ts';
import type { BuiltinPalette } from '../shared/effects/ldj-palettes.ts';
import type { Seed } from '../shared/effects/types.ts';
import type { Colour } from '../types/rig.ts';
import { ALL_PALETTES } from './palette-catalogue.ts';
import { paletteFields, checkGradients } from '../shared/palette-model.ts';
import type { PaletteBody } from '../shared/palette-model.ts';

export const MAX_PALETTES = 128;

export interface UserPalette extends PaletteBody { id: string; name: string }

export interface PaletteStoreOptions {
  /** Where a palette put on as the override draws its random colours (128 bits); a test passes a fixed one. */
  seed?: () => Seed;
}

/** 128 fresh bits: each time a palette goes on, its random colours are rolled anew. */
function freshSeed(): Seed {
  const bytes = crypto.randomBytes(16);
  return [bytes.readUInt32LE(0), bytes.readUInt32LE(4), bytes.readUInt32LE(8), bytes.readUInt32LE(12)];
}

export function materializePalette(body: PaletteBody, seed = freshSeed()): PaletteBody {
  return { ...body, colours: resolvePalette({ palette: body.colours }, null, [], seed, 0).map(toHex) };
}

/** One palette by id, and where it comes from. */
export type PaletteLookup = { source: 'builtin'; palette: BuiltinPalette } | { source: 'user'; palette: UserPalette };

const BUILTIN_IDS = new Set(ALL_PALETTES.map((p) => p.id));

const nameSchema = z.string().min(1).max(80);
const createSchema = z.object({ name: nameSchema, ...paletteFields }).strict()
  .superRefine((p, ctx) => checkGradients(p, p.colours.length, ctx));
const updateSchema = z.object({ name: nameSchema, ...paletteFields }).partial().strict();

const fileSchema = z.object({
  palettes: z.array(createSchema.safeExtend({ id: z.string().min(1).max(64) })).max(MAX_PALETTES),
}).strict().superRefine((file, ctx) => {
  const seen = new Set<string>();
  file.palettes.forEach(({ id }, i) => {
    if (BUILTIN_IDS.has(id)) ctx.addIssue({ code: 'custom', path: ['palettes', i, 'id'], message: `${id} is a built-in palette's` });
    else if (seen.has(id)) ctx.addIssue({ code: 'custom', path: ['palettes', i, 'id'], message: `${id} is used twice` });
    seen.add(id);
  });
});

export class PaletteStore extends JsonStore {
  declare _palettes: readonly UserPalette[];
  declare _listeners: (() => void)[];
  declare _seed: () => Seed;

  /** palettes.json. No file is normal; one that does not validate is moved aside whole (JsonStore). */
  constructor(file: string, { seed = freshSeed }: PaletteStoreOptions = {}) {
    super(file, { tag: 'palettes', fallback: 'starting with the built-in palettes only' });
    this._palettes = [];
    this._listeners = [];
    this._seed = seed;
  }

  load(): this {
    const saved = this.readValid(fileSchema);
    if (saved) this._palettes = deepFreeze(saved.palettes);
    return this;
  }

  useDefaults(): void {
    this._palettes = [];
  }

  /** Every saved palette, as copies. */
  list(): UserPalette[] {
    return this._palettes.map(snapshot);
  }

  /** One palette as a copy: a built-in, else a saved one. */
  get(id: string): PaletteLookup | null {
    const builtin = ALL_PALETTES.find((p) => p.id === id);
    if (builtin) return { source: 'builtin', palette: snapshot(builtin) };
    const saved = this._palettes.find((p) => p.id === id);
    return saved ? { source: 'user', palette: snapshot(saved) } : null;
  }

  materializeBody(id: string): PaletteBody | null {
    const entry = this.get(id);
    if (!entry) return null;
    const { colours, gradients, sets, gradient, gradientSet, gradientRole } = entry.palette;
    const fixed = resolvePalette({ palette: [...colours] }, null, [], this._seed(), 0).map(toHex);
    return { colours: fixed, ...(gradients ? { gradients } : {}), ...(sets ? { sets } : {}),
      ...(gradient !== undefined ? { gradient } : {}), ...(gradientSet !== undefined ? { gradientSet } : {}),
      ...(gradientRole !== undefined ? { gradientRole } : {}) };
  }

  materialize(id: string): Colour[] | null {
    const entry = this.get(id);
    return entry ? resolvePalette({ palette: [...entry.palette.colours] }, null, [], this._seed(), 0) : null;
  }

  /** Called after every saved change; never for a refused, failed or empty one. */
  onChange(fn: () => void): void {
    this._listeners.push(fn);
  }

  create(input: unknown): UserPalette {
    const body = validate(createSchema, input, 'palette');
    if (this._palettes.length >= MAX_PALETTES) throw new HttpError(400, `The palette library is full (${MAX_PALETTES} palettes)`);
    let id = newUserId();
    while (BUILTIN_IDS.has(id) || this._palettes.some((p) => p.id === id)) id = newUserId();
    const palette: UserPalette = { id, ...body };
    this._commit([...this._palettes, palette]);
    return snapshot(palette);
  }

  /** Rename a palette, recolour it, or both; null for a built-in or an unknown id. */
  update(id: string, input: unknown): UserPalette | null {
    const current = this._palettes.find((p) => p.id === id);
    if (!current) return null;
    const body = validate(updateSchema, input, 'palette');
    const { id: _id, ...previous } = current;
    const next: UserPalette = { id, ...validate(createSchema, { ...previous, ...body }, 'palette') };
    if (canonical(next) === canonical(current)) return snapshot(current);
    this._commit(this._palettes.map((p) => (p.id === id ? next : p)));
    return snapshot(next);
  }

  /** Delete a saved palette; false for a built-in or an unknown id. */
  remove(id: string): boolean {
    if (!this._palettes.some((p) => p.id === id)) return false;
    this._commit(this._palettes.filter((p) => p.id !== id));
    return true;
  }

  // Written first, then published, as the effect library does.
  _commit(next: readonly UserPalette[]): void {
    try {
      this.writeJson({ palettes: next });
    } catch (err) {
      console.warn(`[palettes] could not save ${this.file}: ${messageOf(err)}`);
      throw new HttpError(500, `Could not save the palettes: ${messageOf(err)}`);
    }
    this._palettes = deepFreeze([...next]);
    for (const fn of this._listeners) {
      try { fn(); } catch (err) { console.warn(`[palettes] listener: ${messageOf(err)}`); }
    }
  }
}
