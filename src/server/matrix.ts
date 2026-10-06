import { z } from 'zod';
import { canonical } from '../shared/effects/layer.ts';
import { requiresAcknowledgement } from '../shared/effects/registry.ts';
import { ACKNOWLEDGEMENT_REQUIRED } from './safety.ts';
import { HOLD_TIMEOUT_MS } from './voices.ts';
import { validate } from './validation.ts';
import { HttpError } from '../errors.ts';
import type { StartVoice, Voice } from './voices.ts';
import type { EffectSpec } from '../shared/effects/types.ts';

/**
 * Light DJ's matrix board: every held cell's colour, in the order pressed,
 * forms one list, and the board plays it in one mode as one hold voice
 * keyed `matrix`. Any change to the list or the mode starts a fresh
 * instance; the last cell let go ends it. Each cell is a lease renewed by
 * pressing it again; one not renewed lapses alone.
 *
 * Solid swaps every lamp at once, so changes closer than 20 ms coalesce:
 * the latest list is applied once when the 20 ms are up.
 */

export const MATRIX_KEY = 'matrix';
export const MATRIX_MAX_CELLS = 8;
export const MATRIX_LEASE_MS = HOLD_TIMEOUT_MS;
// Released tokens remembered for one lease, so a late renewal cannot re-add a colour.
const MATRIX_TOMBSTONES = 256;
export const SOLID_GUARD_MS = 20;
export const MATRIX_MODES = ['fireworks', 'flashes', 'pulses', 'cycle', 'solid'] as const;
export type MatrixMode = typeof MATRIX_MODES[number];

const colourSchema = z.string().regex(/^#[0-9a-f]{6}$/i, 'is not a #rrggbb colour');
const tokenSchema = z.string().min(1).max(64);
export const matrixPressSchema = z.object({ colour: colourSchema, token: tokenSchema.optional() }).strict();
export const matrixReleaseSchema = z.object({ colour: colourSchema.optional(), token: tokenSchema.optional() }).strict()
  .refine((b) => b.colour !== undefined || b.token !== undefined, 'give a colour or a token');
export const matrixModeSchema = z.object({ mode: z.enum(MATRIX_MODES) }).strict();

export interface MatrixStatus { mode: MatrixMode; colours: string[]; voice: string | null }

interface Cell { token: string; colour: string; until: number }
type MatrixVoices = { start(v: StartVoice): Voice; stop(id: string): boolean; get(id: string): Voice | null };
interface MatrixOptions {
  voices: MatrixVoices;
  acknowledged: () => boolean;
  now?: () => number;
  onChange?: () => void;
}

export class MatrixBoard {
  declare _voices: MatrixVoices;
  declare _acknowledged: () => boolean;
  declare _now: () => number;
  declare _onChange: () => void;
  _cells: Cell[] = [];
  _released = new Map<string, number>();
  /** Cells whose voice was stopped from outside: their presses are ignored until let go, or silent for a lease. */
  _revoked = new Map<string, number>();
  /** The board is changing its own voice: not a stop from outside. */
  _busy = false;
  _mode: MatrixMode = 'pulses';
  _voiceId: string | null = null;
  _appliedKey: string | null = null;
  _appliedMode: MatrixMode | null = null;
  _acceptedAt = -Infinity;
  _solidWait: ReturnType<typeof setTimeout> | null = null;
  _leaseWait: ReturnType<typeof setTimeout> | null = null;

  constructor({ voices, acknowledged, now = () => performance.now(), onChange = () => {} }: MatrixOptions) {
    this._voices = voices;
    this._acknowledged = acknowledged;
    this._now = now;
    this._onChange = onChange;
  }

  /** Hold a cell, or renew it; the same token with another colour moves it. */
  press(token: string, colour: string): MatrixStatus {
    const hex = validate(colourSchema, colour, 'matrix').toUpperCase();
    const until = this._now() + MATRIX_LEASE_MS;
    const at = this._cells.findIndex((c) => c.token === token);
    this._pruneReleased();
    if (at < 0 && this._released.has(token)) return this.status();
    // Stopped from outside (stop-all, a disarm): the finger still down does not start it again.
    if (this._revoked.has(token)) {
      this._revoked.set(token, until);
      return this.status();
    }
    if (at < 0 && this._cells.length >= MATRIX_MAX_CELLS) {
      throw new HttpError(400, `matrix: at most ${MATRIX_MAX_CELLS} cells at once`);
    }
    const next = this._cells.map((c) => ({ ...c }));
    if (at < 0) next.push({ token, colour: hex, until });
    else next[at] = { token, colour: hex, until };
    return this._commit(next, this._mode);
  }

  release(token: string): MatrixStatus {
    this._pruneReleased();
    this._released.delete(token);
    this._released.set(token, this._now() + MATRIX_LEASE_MS);
    if (this._released.size > MATRIX_TOMBSTONES) this._released.delete(this._released.keys().next().value as string);
    this._revoked.delete(token);
    return this._commit(this._cells.filter((c) => c.token !== token), this._mode, false);
  }

  setMode(mode: unknown): MatrixStatus {
    const { mode: next } = validate(matrixModeSchema, { mode }, 'matrix');
    return this._commit(this._cells, next);
  }

  /** Let every cell go at once (a disarm, a blackout). */
  clear(): MatrixStatus {
    return this._commit([], this._mode, false);
  }

  /**
   * After any change to the voices: the board's voice stopped by something
   * else (stop-all, a disarm) takes the cells with it, and the fingers still
   * down are ignored until they lift.
   */
  sync(): void {
    if (this._busy || !this._voiceId || this._voices.get(this._voiceId)) return;
    const until = this._now() + MATRIX_LEASE_MS;
    for (const { token } of this._cells) this._revoked.set(token, until);
    this._voiceId = null;
    this._appliedKey = null;
    this._appliedMode = null;
    this._commit([], this._mode, false);
  }

  _pruneReleased(): void {
    const now = this._now();
    for (const [token, until] of this._released) {
      if (until > now) break;
      this._released.delete(token);
    }
    for (const [token, until] of this._revoked) if (until <= now) this._revoked.delete(token);
  }

  status(): MatrixStatus {
    return { mode: this._mode, colours: this._cells.map((c) => c.colour), voice: this._voiceId && this._voices.get(this._voiceId) ? this._voiceId : null };
  }

  // A rapid mode before the acknowledgement is refused before anything
  // changes. Letting go is never refused (`admit` false: a release, a lapsed
  // lease, a clear): whatever happened to the acknowledgement since, a cell
  // must be able to end.
  _commit(cells: Cell[], mode: MatrixMode, admit = true): MatrixStatus {
    if (admit && cells.length && !this._acknowledged() && requiresAcknowledgement(this._spec(cells, mode))) {
      throw new HttpError(409, ACKNOWLEDGEMENT_REQUIRED);
    }
    this._cells = cells;
    this._mode = mode;
    this._busy = true;
    try { this._apply(); } finally { this._busy = false; }
    this._schedule();
    this._onChange();
    return this.status();
  }

  _spec(cells: Cell[], mode: MatrixMode): EffectSpec {
    const colours = cells.map((c) => c.colour);
    return { kind: 'ldj.matrixBoard', palette: colours, params: { colours, mode } };
  }

  _apply(): void {
    if (!this._cells.length) {
      this._cancelSolid();
      if (this._voiceId) this._voices.stop(this._voiceId);
      this._voiceId = null;
      this._appliedKey = null;
      this._appliedMode = null;
      return;
    }
    const spec = this._spec(this._cells, this._mode);
    // The acknowledgement taken back with cells still held: nothing rapid plays on; the cells end with their fingers.
    if (!this._acknowledged() && requiresAcknowledgement(spec)) {
      this._cancelSolid();
      if (this._voiceId) this._voices.stop(this._voiceId);
      this._voiceId = null;
      this._appliedKey = null;
      this._appliedMode = null;
      return;
    }
    const key = canonical(spec.params);
    if (key === this._appliedKey && this._voiceId && this._voices.get(this._voiceId)) return;
    const now = this._now();
    if (this._mode === 'solid' && this._appliedMode === 'solid' && now - this._acceptedAt < SOLID_GUARD_MS) {
      this._solidWait ??= setTimeout(() => {
        this._solidWait = null;
        this._busy = true;
        try { this._apply(); } finally { this._busy = false; }
        this._onChange();
      }, this._acceptedAt + SOLID_GUARD_MS - now);
      return;
    }
    this._cancelSolid();
    // Started without an id: each instance gets a new one, the key replaces the last.
    const voice = this._voices.start({
      spec, targets: 'shared', tier: 'voice', source: 'matrix', mode: 'latched', key: MATRIX_KEY, label: 'Matrix',
    });
    this._voiceId = voice.id;
    this._appliedKey = key;
    this._appliedMode = this._mode;
    this._acceptedAt = now;
  }

  _cancelSolid(): void {
    if (this._solidWait) clearTimeout(this._solidWait);
    this._solidWait = null;
  }

  // One timer, at the earliest lease; lapsed cells go, the rest play on.
  _schedule(): void {
    if (this._leaseWait) clearTimeout(this._leaseWait);
    this._leaseWait = null;
    if (!this._cells.length) return;
    const first = Math.min(...this._cells.map((c) => c.until));
    this._leaseWait = setTimeout(() => {
      this._leaseWait = null;
      const now = this._now();
      this._commit(this._cells.filter((c) => c.until > now), this._mode, false);
    }, Math.max(0, first - this._now()));
  }
}
