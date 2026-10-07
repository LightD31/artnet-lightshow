import { z } from 'zod';

import { deepFreeze } from '../shared/effects/index.ts';
import { canonical } from '../shared/effects/layer.ts';
import { patternSchema, sequenceSchema, validatePattern, validateSequence } from './sequencer.ts';
import { HttpError, messageOf } from '../errors.ts';
import { JsonStore } from './json-store.ts';
import type { Sequence, SequencePattern } from './sequencer.ts';

export const MAX_SEQUENCES = 64;
const VERSION = 1;

const fileSchema = z.object({
  version: z.literal(VERSION),
  sequences: z.array(sequenceSchema).max(MAX_SEQUENCES),
  patterns: z.array(patternSchema).max(MAX_SEQUENCES).optional(),
}).strict().superRefine((file, ctx) => {
  for (const key of ['sequences', 'patterns'] as const) {
    const seen = new Set<string>();
    (file[key] ?? []).forEach(({ id }, i) => {
      if (seen.has(id)) ctx.addIssue({ code: 'custom', path: [key, i, 'id'], message: `${id} is used twice` });
      seen.add(id);
    });
  }
});

export class SequenceStore extends JsonStore {
  declare _sequences: readonly Sequence[];
  declare _patterns: readonly SequencePattern[];
  declare _listeners: (() => void)[];

  constructor(file: string) {
    super(file, { tag: 'sequences', fallback: 'starting with no saved sequences' });
    this._sequences = [];
    this._patterns = [];
    this._listeners = [];
  }

  load(): this {
    const saved = this.readValid(fileSchema);
    if (saved) {
      this._sequences = deepFreeze(saved.sequences as Sequence[]);
      this._patterns = deepFreeze((saved.patterns ?? []) as SequencePattern[]);
    }
    return this;
  }

  useDefaults(): void {
    this._sequences = [];
    this._patterns = [];
  }

  list(): Sequence[] {
    return this._sequences.map((s) => structuredClone(s));
  }

  summaries(): { id: string; name: string }[] {
    return this._sequences.map(({ id, name }) => ({ id, name }));
  }

  get(id: string): Sequence | null {
    const seq = this._sequences.find((s) => s.id === id);
    return seq ? structuredClone(seq) : null;
  }

  onChange(fn: () => void): void {
    this._listeners.push(fn);
  }

  save(raw: unknown): Sequence {
    const seq = validateSequence(raw);
    const at = this._sequences.findIndex((s) => s.id === seq.id);
    if (at >= 0 && canonical(this._sequences[at]) === canonical(seq)) return structuredClone(this._sequences[at]);
    if (at < 0 && this._sequences.length >= MAX_SEQUENCES) throw new HttpError(400, `The sequence shelf is full (${MAX_SEQUENCES} sequences)`);
    this._commit(at >= 0 ? this._sequences.map((s, i) => (i === at ? seq : s)) : [...this._sequences, seq]);
    return structuredClone(seq);
  }

  remove(id: string): boolean {
    if (!this._sequences.some((s) => s.id === id)) return false;
    this._commit(this._sequences.filter((s) => s.id !== id));
    return true;
  }

  patternSummaries(): { id: string; name: string; lengthBeats: number }[] {
    return this._patterns.map(({ id, name, lengthBeats }) => ({ id, name, lengthBeats }));
  }

  listPatterns(): SequencePattern[] {
    return this._patterns.map((p) => structuredClone(p));
  }

  getPattern(id: string): SequencePattern | null {
    const pattern = this._patterns.find((p) => p.id === id);
    return pattern ? structuredClone(pattern) : null;
  }

  savePattern(raw: unknown): SequencePattern {
    const pattern = validatePattern(raw);
    const at = this._patterns.findIndex((p) => p.id === pattern.id);
    if (at >= 0 && canonical(this._patterns[at]) === canonical(pattern)) return structuredClone(this._patterns[at]);
    if (at < 0 && this._patterns.length >= MAX_SEQUENCES) throw new HttpError(400, `The pattern shelf is full (${MAX_SEQUENCES} patterns)`);
    this._commit(this._sequences, at >= 0 ? this._patterns.map((p, i) => (i === at ? pattern : p)) : [...this._patterns, pattern]);
    return structuredClone(pattern);
  }

  removePattern(id: string): boolean {
    if (!this._patterns.some((p) => p.id === id)) return false;
    this._commit(this._sequences, this._patterns.filter((p) => p.id !== id));
    return true;
  }

  _commit(next: readonly Sequence[], patterns: readonly SequencePattern[] = this._patterns): void {
    try {
      this.writeJson({ version: VERSION, sequences: next, ...(patterns.length ? { patterns } : {}) });
    } catch (err) {
      console.warn(`[sequences] could not save ${this.file}: ${messageOf(err)}`);
      throw new HttpError(500, `Could not save the sequences: ${messageOf(err)}`);
    }
    this._sequences = deepFreeze([...next]);
    this._patterns = deepFreeze([...patterns]);
    for (const fn of this._listeners) {
      try { fn(); } catch (err) { console.warn(`[sequences] listener: ${messageOf(err)}`); }
    }
  }
}
