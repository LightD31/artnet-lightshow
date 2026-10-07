import { z } from 'zod';

import { deepFreeze } from '../shared/effects/index.ts';
import { canonical } from '../shared/effects/layer.ts';
import { patternSchema, sequenceSchema, validatePattern, validateSequence } from './sequencer.ts';
import { HttpError, messageOf } from '../errors.ts';
import { JsonStore } from './json-store.ts';
import type { Sequence, SequencePattern } from './sequencer.ts';

/**
 * The sequences saved on this server, in config/sequences.json: the shelf
 * a sequence is loaded from, apart from the one loaded in the transport
 * (sequencer.ts), which is edited without touching the shelf until saved.
 *
 * Hue Dynamics' patterns sit beside the sequences. The file says which
 * version of itself it is; patterns are an optional part of version 1,
 * written only when there are any, so a file from before them reads as
 * having none. A file of a version this server does not know is moved
 * aside rather than half read.
 */

// A night's worth of sets, as the design caps it; an update at the cap is
// still a save, only a new sequence is refused.
export const MAX_SEQUENCES = 64;
const VERSION = 1;

const fileSchema = z.object({
  version: z.literal(VERSION),
  sequences: z.array(sequenceSchema).max(MAX_SEQUENCES),
  // Capped as the sequences are.
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

  /** sequences.json. No file is normal; one that does not validate is moved aside whole (JsonStore). */
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

  /** Every saved sequence, as copies, in the order they were first saved. */
  list(): Sequence[] {
    return this._sequences.map((s) => structuredClone(s));
  }

  /** Each saved sequence's id and name, in shelf order: what the live state lists. */
  summaries(): { id: string; name: string }[] {
    return this._sequences.map(({ id, name }) => ({ id, name }));
  }

  /** One saved sequence as a copy, or null. */
  get(id: string): Sequence | null {
    const seq = this._sequences.find((s) => s.id === id);
    return seq ? structuredClone(seq) : null;
  }

  /** Called after every saved change; never for a refused, failed or empty one. */
  onChange(fn: () => void): void {
    this._listeners.push(fn);
  }

  /**
   * Save a sequence under its id, new or over the one there. Validated
   * whole (400 with what is wrong); the same sequence again is not written.
   */
  save(raw: unknown): Sequence {
    const seq = validateSequence(raw);
    const at = this._sequences.findIndex((s) => s.id === seq.id);
    if (at >= 0 && canonical(this._sequences[at]) === canonical(seq)) return structuredClone(this._sequences[at]);
    if (at < 0 && this._sequences.length >= MAX_SEQUENCES) throw new HttpError(400, `The sequence shelf is full (${MAX_SEQUENCES} sequences)`);
    this._commit(at >= 0 ? this._sequences.map((s, i) => (i === at ? seq : s)) : [...this._sequences, seq]);
    return structuredClone(seq);
  }

  /** Delete a saved sequence; false for an unknown id. */
  remove(id: string): boolean {
    if (!this._sequences.some((s) => s.id === id)) return false;
    this._commit(this._sequences.filter((s) => s.id !== id));
    return true;
  }

  /** Each saved pattern's id, name and length, in shelf order: what the live state lists. */
  patternSummaries(): { id: string; name: string; lengthBeats: number }[] {
    return this._patterns.map(({ id, name, lengthBeats }) => ({ id, name, lengthBeats }));
  }

  /** Every saved pattern, as copies. */
  listPatterns(): SequencePattern[] {
    return this._patterns.map((p) => structuredClone(p));
  }

  /** One saved pattern as a copy, or null. */
  getPattern(id: string): SequencePattern | null {
    const pattern = this._patterns.find((p) => p.id === id);
    return pattern ? structuredClone(pattern) : null;
  }

  /** Save a pattern under its id, new or over the one there, as save() does a sequence. */
  savePattern(raw: unknown): SequencePattern {
    const pattern = validatePattern(raw);
    const at = this._patterns.findIndex((p) => p.id === pattern.id);
    if (at >= 0 && canonical(this._patterns[at]) === canonical(pattern)) return structuredClone(this._patterns[at]);
    if (at < 0 && this._patterns.length >= MAX_SEQUENCES) throw new HttpError(400, `The pattern shelf is full (${MAX_SEQUENCES} patterns)`);
    this._commit(this._sequences, at >= 0 ? this._patterns.map((p, i) => (i === at ? pattern : p)) : [...this._patterns, pattern]);
    return structuredClone(pattern);
  }

  /** Delete a saved pattern; false for an unknown id. */
  removePattern(id: string): boolean {
    if (!this._patterns.some((p) => p.id === id)) return false;
    this._commit(this._sequences, this._patterns.filter((p) => p.id !== id));
    return true;
  }

  // Written first, then published: a write that fails leaves the shelf as the file has it.
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
