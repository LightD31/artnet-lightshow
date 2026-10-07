import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { codeOf, messageOf } from '../errors.ts';

export interface JsonStoreOptions {
  /** How the store signs its log lines: `[cues] …`. */
  tag: string;
  /** What the store does without its file, for the log: 'starting with no cues'. */
  fallback: string;
  /** The file's permissions, for one that holds secrets (0o600). */
  mode?: number;
}

/**
 * A JSON file the server keeps in its config directory — settings.json,
 * show.json, cues.json, midi-map.json — and the rules every one of them
 * follows:
 *
 *   - no file is normal (nothing has been saved yet): the store keeps its
 *     defaults;
 *   - a file that cannot be read is reported, and the defaults stand;
 *   - a file that is not JSON, or not what the store accepts, is moved aside
 *     (`<file>.invalid-<ms>`) rather than deleted, so a hand-edit that went
 *     wrong can be recovered — and the show still starts, on the defaults;
 *   - a write goes to a temporary file renamed over the old one, so a crash
 *     mid-write never leaves half a file.
 *
 * A store extends it, reads with readValid() (or readJson() when it checks the
 * contents itself), puts its defaults back in useDefaults(), and writes with
 * writeJson() or write().
 */
export class JsonStore {
  declare file: string;
  declare _tag: string;
  declare _fallback: string;
  declare _mode: number | undefined;

  constructor(file: string, { tag, fallback, mode }: JsonStoreOptions) {
    this.file = file;
    this._tag = tag;
    this._fallback = fallback;
    this._mode = mode;
  }

  /** Back to the defaults, for a file that was moved aside. The store's own. */
  useDefaults(): void { /* nothing by default */ }

  /**
   * The file, parsed; undefined when there is nothing to load: no file, one
   * that cannot be read, or one that is not JSON (moved aside).
   */
  readJson(): unknown {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (codeOf(err) !== 'ENOENT') console.warn(`[${this._tag}] cannot read ${this.file}: ${messageOf(err)} — ${this._fallback}`);
      return undefined;
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      this.quarantine(`invalid JSON (${messageOf(err)})`);
      return undefined;
    }
  }

  /**
   * The file checked against `schema` — after `prepare`, for a store that
   * mends an older file first — or undefined when there is nothing valid to
   * load. A file the schema rejects is moved aside, with what was wrong.
   */
  readValid<S extends z.ZodType>(schema: S, prepare: (parsed: unknown) => unknown = (parsed) => parsed): z.output<S> | undefined {
    const parsed = this.readJson();
    if (parsed === undefined) return undefined;
    const result = schema.safeParse(prepare(parsed));
    if (!result.success) {
      this.quarantine(result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '));
      return undefined;
    }
    return result.data;
  }

  /** Move the file aside, say why and where, and put the defaults back. */
  quarantine(reason: string): void {
    const backup = `${this.file}.invalid-${Date.now()}`;
    try {
      fs.renameSync(this.file, backup);
      console.warn(`[${this._tag}] ${this.file}: ${reason}`);
      console.warn(`[${this._tag}] moved it to ${backup} — ${this._fallback}`);
    } catch (err) {
      console.warn(`[${this._tag}] ${this.file}: ${reason} (could not move it aside: ${messageOf(err)}) — ${this._fallback}`);
    }
    this.useDefaults();
  }

  /** Write `body` as the file's contents, atomically. Throws when it cannot. */
  write(body: string): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, body, this._mode === undefined ? undefined : { mode: this._mode });
    fs.renameSync(tmp, this.file);
    // A file that existed before keeps its old mode through a rename on some
    // systems; the temporary one's is what it should have.
    if (this._mode !== undefined) {
      try { fs.chmodSync(this.file, this._mode); } catch (_) { /* best effort on Windows */ }
    }
  }

  /** Write `value` as indented JSON, atomically. Throws when it cannot. */
  writeJson(value: unknown): void {
    this.write(`${JSON.stringify(value, null, 2)}\n`);
  }
}
