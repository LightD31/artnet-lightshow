import { z } from 'zod';
import { STROBE_PARAMS_SCHEMA } from '../shared/effects/strobe.ts';
import { canonical } from '../shared/effects/layer.ts';
import { hexColour, validate } from './validation.ts';
import { ACKNOWLEDGEMENT_REQUIRED } from './safety.ts';
import { HttpError } from '../errors.ts';
import type { Settings, SettingsStore } from './settings.ts';
import type { SafetyStatus } from './safety.ts';
import type { Voice, VoiceManager, VoiceMode, VoiceSummary, VoiceTargets } from './voices.ts';
import type { EffectSpec } from '../shared/effects/types.ts';

/**
 * The manual strobe: Hue Dynamics' hold strobe as one voice in the strobe
 * tier, held, latched under the cap (safety.strobeMaxLatchSec) or burst. A
 * hold over a latch keeps the latch hidden underneath until the hold is let
 * go; a stop ends both. Nothing starts before the acknowledgement.
 */

/** The voice's id, which the renderer and the preview know (voices.ts). */
export const STROBE_VOICE_ID = 'strobe';
/** One voice per key: a new launch replaces the last. */
const STROBE_KEY = 'strobe';
/** A burst's length: at least a flash, at most what a latch would be for. */
export const BURST_MIN_MS = 100;
export const BURST_MAX_MS = 30000;

export type StrobeSettings = Settings['strobe'];

/** What GET /api/strobe answers, and the live state's `strobe`. */
export interface StrobeStatus {
  /** The voice playing as the strobe, or null; times are epoch milliseconds. */
  active: { id: string; mode: VoiceMode; startedAt: number; until: number | null } | null;
  mode: VoiceMode | null;
  settings: StrobeSettings;
}

type StrobeVoices = Pick<VoiceManager, 'start' | 'release' | 'stopWhere' | 'list' | 'get' | 'update' | 'endBy' | 'onStop'>;
export interface StrobeHoldLaunch { targets?: VoiceTargets; quantise?: number }
type StrobeSettingsStore = Pick<SettingsStore, 'group' | 'update' | 'onChange'>;
interface StrobeSafety { acknowledged(): boolean; status(): Pick<SafetyStatus, 'strobeMaxLatchSec'> }

// An edit: any of the settings, each as the settings hold it; nothing else.
const updateSchema = STROBE_PARAMS_SCHEMA.partial().extend({ palette: z.array(hexColour).min(1).max(6).optional() }).strict();

export class Strobe {
  declare _voices: StrobeVoices;
  declare _settings: StrobeSettingsStore;
  declare _safety: StrobeSafety;
  /** The latch a hold plays over: its start and end, for when the hold goes. */
  declare _under: { startedAtMs: number; untilMs: number | null } | null;

  constructor(voices: StrobeVoices, settings: StrobeSettingsStore, safety: StrobeSafety) {
    this._voices = voices;
    this._settings = settings;
    this._safety = safety;
    this._under = null;
    // A stop ends the latch under the hold too, so nothing relaunches it.
    voices.onStop((stopped) => {
      if (stopped.some((v) => v.id === STROBE_VOICE_ID)) this._under = null;
    });
    // A cue's settings or PUT /api/settings reach a running strobe too, and a cap lowered cuts one.
    settings.onChange((changed) => {
      if (changed.some((key) => key.startsWith('strobe.'))) this._follow();
      if (changed.includes('safety.strobeMaxLatchSec')) this._recap();
    });
  }

  /** Latch the strobe until off, or until the cap. Already latched, it plays on as it is. */
  on(mode: 'latched' = 'latched'): Voice {
    this._admit();
    const current = this._voices.get(STROBE_VOICE_ID);
    if (current && current.mode === mode) return current;
    this._under = null;
    return this._launch({ mode, maxLatchMs: this._capMs() });
  }

  /** End every strobe-kind voice: this one, the energy endpoints', hidden under a hold or not, an API's or a pad's. */
  off(): void {
    this._under = null;
    this._voices.stopWhere((v) => v.spec.kind === 'strobe');
  }

  /** End the latch alone (the energy endpoints' off): a hold stays the hand's, a burst runs out. */
  unlatch(): void {
    this._under = null;
    this._voices.stopWhere((v) => v.id === STROBE_VOICE_ID && v.mode === 'latched');
  }

  /** Flash for `ms` and stop. */
  burst(ms: number): Voice {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < BURST_MIN_MS || ms > BURST_MAX_MS) {
      throw new HttpError(400, `strobe: a burst is ${BURST_MIN_MS} to ${BURST_MAX_MS} ms`);
    }
    this._admit();
    this._under = null;
    return this._launch({ mode: 'once', lengthMs: ms });
  }

  /** Hold it under a lease; the same press renews it. Over a latch it starts at once, so the strobe never goes dark. */
  hold(owner: string, token: string, { targets = 'shared', quantise = 0 }: StrobeHoldLaunch = {}): Voice {
    this._admit();
    const current = this._voices.get(STROBE_VOICE_ID);
    const latch = current && current.mode === 'latched' ? { startedAtMs: current.startedAtMs, untilMs: current.untilMs } : null;
    const voice = this._launch({ mode: 'hold', owner, token, targets, quantise: latch ? 0 : quantise });
    if (latch) this._under = latch;
    return voice;
  }

  /** After any change to the voices: once no strobe plays, a latch kept under a hold comes back, to its own deadline. */
  sync(): void {
    const under = this._under;
    if (!under || this._voices.get(STROBE_VOICE_ID)) return;
    this._under = null;
    if (!this._safety.acknowledged()) return;
    const cap = this._capMs();
    const until = Math.min(under.untilMs ?? Infinity, cap === undefined ? Infinity : under.startedAtMs + cap);
    const voice = this._launch({ mode: 'latched', maxLatchMs: cap });
    if (Number.isFinite(until)) this._voices.endBy(voice.id, until);
  }

  release(owner: string, token: string): void {
    this._voices.release(owner, token);
  }

  status(): StrobeStatus {
    const active = this._active();
    return {
      active: active ? { id: active.id, mode: active.mode, startedAt: active.startedAt, until: active.until } : null,
      mode: active ? active.mode : null,
      settings: this._settings.group('strobe'),
    };
  }

  /** Validate and save new settings (a 400 names what is wrong); a running strobe takes them in place. */
  update(params: unknown): StrobeSettings {
    const edit = validate(updateSchema, params, 'strobe');
    this._settings.update({ strobe: { ...this._settings.group('strobe'), ...edit } });
    this._follow();
    return this._settings.group('strobe');
  }

  _admit(): void {
    if (!this._safety.acknowledged()) throw new HttpError(409, ACKNOWLEDGEMENT_REQUIRED);
  }

  _capMs(): number | undefined {
    const sec = this._safety.status().strobeMaxLatchSec;
    return Number.isFinite(sec) && sec > 0 ? sec * 1000 : undefined;
  }

  /** The strobe kind with the settings: their palette as the effect's, the rest as its parameters. */
  _spec(): EffectSpec {
    const { palette, ...params } = this._settings.group('strobe');
    return { kind: 'strobe', palette, params };
  }

  _launch(launch: { mode: VoiceMode; maxLatchMs?: number; lengthMs?: number; owner?: string; token?: string; targets?: VoiceTargets; quantise?: number }): Voice {
    const voice = this._voices.start({
      spec: this._spec(), targets: 'shared', tier: 'strobe', source: 'strobe', label: 'Strobe', id: STROBE_VOICE_ID, key: STROBE_KEY, ...launch,
    });
    // The energy endpoints' latched palette strobe is this strobe in its beat
    // clock: one launched replaces the other. Only once the launch went through.
    this._voices.stopWhere((v) => v.spec.kind === 'strobe' && v.source === 'energy' && v.mode === 'latched');
    return voice;
  }

  /** The strobe playing: this voice, else the energy endpoints' palette strobe (the strobe in its beat clock), not one hidden under a hold. */
  _active(): VoiceSummary | null {
    const list = this._voices.list();
    return list.find((v) => v.id === STROBE_VOICE_ID)
      ?? list.find((v) => v.kind === 'strobe' && v.source === 'energy' && v.tier === 'strobe' && !v.hidden) ?? null;
  }

  /** The running voice takes the settings as they are now, in place. */
  _follow(): void {
    const current = this._voices.get(STROBE_VOICE_ID);
    if (!current) return;
    const spec = this._spec();
    const same = canonical([spec.palette, spec.params]) === canonical([current.spec.palette, current.spec.params]);
    if (!same) this._voices.update(STROBE_VOICE_ID, spec);
  }

  /** The cap as it is now, on every latched strobe-kind voice: a lower one clips, a higher one extends nothing. */
  _recap(): void {
    const cap = this._capMs();
    if (cap === undefined) return;
    for (const { id, kind, mode } of this._voices.list()) {
      if (kind !== 'strobe' || mode !== 'latched') continue;
      const voice = this._voices.get(id);
      if (voice) this._voices.endBy(id, voice.startedAtMs + cap);
    }
    if (this._under) this._under.untilMs = Math.min(this._under.untilMs ?? Infinity, this._under.startedAtMs + cap);
  }
}
