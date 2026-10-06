// The entry point registers every kind, so a voice's spec validates against it.
import { deepFreeze, presetById } from '../shared/effects/index.ts';
import { requiresAcknowledgement, validateSpec } from '../shared/effects/registry.ts';
import { BUNDLE_KIND, isMintedBundle } from '../shared/effects/bundle.ts';
import { seedFrom } from '../shared/effects/hash.ts';
import { scopedLoopLength } from '../shared/effects/hd.ts';
import { canonical, hdGuarded } from '../shared/effects/layer.ts';
import { HttpError, messageOf } from '../errors.ts';
import { ACKNOWLEDGEMENT_REQUIRED } from './safety.ts';
import type { VoiceFrame } from '../shared/effects/layer.ts';
import type { EffectSpec, HdParams, Seed } from '../shared/effects/types.ts';

/**
 * Voices: effects launched over the base look, each on its fixtures, for as
 * long as its mode says. A pad held down, an energy effect, the strobe, a
 * REST call: one manager owns every launch, its timers and its leases, and
 * hands the renderer the voices playing now (layer.ts lays them over the
 * base by tier and launch).
 *
 *   hold     lives while its owner renews it: a press, then a renewal at
 *            least every HOLD_TIMEOUT_MS, then a release. A tablet whose
 *            Wi-Fi drops stops renewing, and the voice dies on its own
 *   once     ends by itself, after its length in milliseconds or beats
 *   latched  stays until it is stopped, or until its maximum latch
 *
 * Every time is in milliseconds on the manager's clock: a quantised start is
 * converted at launch at the tempo in force, and so is a length in beats.
 * Neither moves afterwards, whatever the tempo or the music's epoch does;
 * the renderer re-anchors a voice's beat when the music jumps.
 */

// A browser must keep a momentary effect alive. Losing the release packet,
// closing the tab, or a broken connection can therefore never latch the effect.
export const HOLD_TIMEOUT_MS = 1200;

// Node's timers take a 32-bit delay; a longer wait is chained in such steps.
const MAX_TIMER_MS = 2 ** 31 - 1;

export type VoiceMode = 'hold' | 'once' | 'latched';
export type VoiceTier = 'strobe' | 'voice';
export type VoiceSource = 'pad' | 'energy' | 'strobe' | 'api' | 'sequence' | 'matrix';
/** Fixture ids, or every fixture (`'shared'`, the wire's word for it). */
export type VoiceTargets = 'shared' | readonly number[];

/** A launch, as the server's own callers ask for one. */
export interface StartVoice {
  spec: EffectSpec;
  targets: VoiceTargets;
  mode: VoiceMode;
  tier: VoiceTier;
  source: VoiceSource;
  label?: string;
  /** A once voice's length from its start: beats (at the launch tempo) or milliseconds, not both. */
  lengthBeats?: number;
  lengthMs?: number;
  /** A hold's lease: who renews it and with what. */
  owner?: string;
  token?: unknown;
  /** Beats of the grid a launch snaps up to while something plays; 0 is now. */
  quantise?: number;
  /** A latched voice ends this long after its start. */
  maxLatchMs?: number;
  /** One voice per key: starting the same key again replaces it. */
  key?: string;
  /** Its id, for the ids the renderer and the preview know (`energy:<id>`, `strobe`); a launch with an id replaces that voice. */
  id?: string;
  /** The beat it plays from; the launch's beat when left out. */
  anchorBeat?: number;
  /** Plays from beat 0 on the global beat grid and stays there when the music jumps, as the energy burst always did. */
  holdsGrid?: boolean;
  /**
   * When the photosensitivity gate is asked: at launch (a 409), or only at
   * render time, where the renderer holds it dark — the energy endpoints'
   * way, which answer as they always have.
   */
  admission?: 'launch' | 'render';
  /** Launched hidden (setHidden): kept and timed, never rendered. */
  hidden?: boolean;
}

/** A launched voice. */
export interface Voice {
  id: string;
  spec: EffectSpec;
  /** Fixture ids, or null for every fixture. */
  targets: number[] | null;
  mode: VoiceMode;
  tier: VoiceTier;
  source: VoiceSource;
  label: string;
  launchSeq: number;
  startedAtMs: number;
  /** Its end; null for a hold (its lease ends it) and for a latch with no maximum. */
  untilMs: number | null;
  anchorBeat: number;
  seed: Seed;
  owner: string | null;
  key: string | null;
  hidden: boolean;
  holdsGrid: boolean;
}

/** A voice as the live state and GET /api/voices carry it: times on the wall clock, targets in the wire's form. */
export interface VoiceSummary {
  id: string;
  source: VoiceSource;
  label: string;
  mode: VoiceMode;
  tier: VoiceTier;
  kind: string;
  targets: 'shared' | number[];
  launchSeq: number;
  /** Epoch milliseconds: when it starts (perhaps still ahead, on a grid line) and ends; null runs until stopped or released. */
  startedAt: number;
  until: number | null;
  hidden: boolean;
}

export interface VoiceManagerOptions {
  /** The manager's clock, monotonic milliseconds. */
  now: () => number;
  /** The musical clock at a launch; `reading`, when given, is read once for both. */
  beatPos?: () => number;
  bpm?: () => number;
  reading?: () => { beatPos: number; bpm: number };
  /** Told after every launch and every end; never for a renewal. */
  onChange: () => void;
  /** The photosensitivity acknowledgement. */
  acknowledged: () => boolean;
  /** Whether anything but the voices plays (the base look, a sequence): a quantised launch then waits for its grid line. */
  anyRunning?: () => boolean;
  /** The wall clock the summaries' times are given on. */
  wallNow?: () => number;
  /** The cap on a latched strobe-kind voice that names none (safety.strobeMaxLatchSec), whoever latches it; undefined is none. */
  strobeLatchMs?: () => number | undefined;
}

interface Wait { cancel(): void }

interface VoiceRecord {
  voice: Voice;
  token: unknown;
  /** What makes a press of the same hold the same launch. */
  launch: string;
  /** A hold's lease end, and its generation, so a timer armed for an older lease does nothing. */
  leaseUntil: number | null;
  lease: number;
  leaseWait: Wait | null;
  endWait: Wait | null;
  /** The wall clock less the manager's, at launch. */
  wall: number;
}

/** Wait `ms`, in steps a Node timer takes, without reading any clock: what was armed fires. Unref'd. */
function wait(ms: number, fire: () => void): Wait {
  let handle: ReturnType<typeof setTimeout> | null = null;
  const step = (left: number) => {
    const chunk = Math.min(Math.max(0, left), MAX_TIMER_MS);
    handle = setTimeout(() => {
      handle = null;
      if (left > MAX_TIMER_MS) step(left - MAX_TIMER_MS);
      else fire();
    }, chunk);
    handle.unref?.();
  };
  step(ms);
  return { cancel() { if (handle) clearTimeout(handle); handle = null; } };
}

const bad = (message: string) => new HttpError(400, message);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** What makes a press of the same hold the same launch: everything a launch is, the lease aside. */
const launchKey = (spec: EffectSpec, targets: number[] | null, tier: VoiceTier, source: VoiceSource, label: string, key: string | null,
  id: string | null, holdsGrid: boolean): string => canonical({ spec, targets, tier, source, label, key, id, holdsGrid });

/**
 * A spec as the effects play it, or a 400 saying what is wrong with it. A
 * frozen copy: validation passes some values through as given, and the
 * voice must not change with the caller's object, nor freeze it.
 */
export function voiceSpec(raw: unknown): EffectSpec {
  try {
    return deepFreeze(structuredClone(validateSpec(raw, { internal: isMintedBundle(raw) })));
  } catch (err) {
    const issues = (err as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
    const text = Array.isArray(issues)
      ? issues.map((i) => `${['effect', ...i.path.map(String)].join('.')} ${i.message}`).join('; ')
      : `effect: ${messageOf(err)}`;
    throw bad(text);
  }
}

/**
 * The beats a once launch plays when it names no length: the preset's own
 * length, then Hue Dynamics' scoped loop for its ten Party kinds, a Light DJ
 * kind's `beats`, a macro's loop, and last one beat for a single-beat scope
 * and a bar for any other. `spec` is validated, so every field read here is
 * one its kind owns.
 */
export function lengthBeatsOf(spec: EffectSpec, presetLengthBeats?: number | null): number {
  if (positive(presetLengthBeats)) return presetLengthBeats;
  const params = (spec.params ?? {}) as Record<string, unknown>;
  if (hdGuarded(spec.kind)) {
    const loop = scopedLoopLength(spec, params as unknown as HdParams);
    if (positive(loop)) return loop;
  }
  if (spec.kind.startsWith('ldj.') && positive(params.beats)) return params.beats;
  if (spec.kind === 'macro' && positive(params.loopBeats)) return params.loopBeats;
  if (spec.kind === BUNDLE_KIND && positive(params.lengthBeats)) return params.lengthBeats;
  return spec.scope === 'singleBeat' ? 1 : 4;
}

/** A preset by id or alias: its spec, its length and its name; null for none (or a legacy row, which has no spec). */
export type PresetLookup = (id: string) => { spec: EffectSpec; lengthBeats?: number; name?: string } | null;

/** The built-in presets alone, for a server with no library registered. */
export const builtinPresets: PresetLookup = (id) => {
  const row = presetById(id);
  return row && !row.legacy ? { spec: row.spec, lengthBeats: row.lengthBeats, name: row.name } : null;
};

/**
 * What a request launches: `effect`, a spec, or `preset`, an id — one of the
 * two. A preset no library knows is a 400, like a spec that does not validate.
 */
export function launchOf({ effect, preset }: { effect?: unknown; preset?: unknown }, lookup: PresetLookup):
  { spec: EffectSpec; lengthBeats: number | undefined; label: string } {
  if ((effect === undefined) === (preset === undefined)) throw bad('voice: give either effect or preset');
  if (preset !== undefined) {
    if (typeof preset !== 'string' || !preset.length) throw bad('voice: preset must be an id');
    const found = lookup(preset);
    if (!found) throw bad(`No such preset: ${preset}`);
    return { spec: voiceSpec(found.spec), lengthBeats: found.lengthBeats, label: found.name ?? preset };
  }
  const spec = voiceSpec(effect);
  return { spec, lengthBeats: undefined, label: spec.kind };
}

/**
 * Wire targets as a launch takes them: `'shared'`, or fixture ids of the
 * patch, once each. An empty list stays empty (it covers nothing); an id the
 * patch does not have is a 400 rather than a voice that silently shows nowhere.
 */
export function targetsOf(raw: unknown, fixtureIds: readonly number[]): VoiceTargets {
  const targets = fixtureIdsOf(raw);
  if (!targets) return 'shared';
  const known = new Set(fixtureIds);
  for (const id of targets) if (!known.has(id)) throw bad(`voice: no fixture ${id}`);
  return targets;
}

/** `'shared'` as null, else the ids once each, in the order given. */
function fixtureIdsOf(raw: unknown): number[] | null {
  if (raw === undefined || raw === 'shared') return null;
  if (!Array.isArray(raw) || !raw.every((id) => Number.isSafeInteger(id) && id >= 0)) {
    throw bad('voice: targets must be "shared" or fixture ids');
  }
  return [...new Set(raw as number[])];
}

export class VoiceManager {
  declare _now: () => number;
  declare _read: () => { beatPos: number; bpm: number };
  declare _onChange: () => void;
  declare _acknowledged: () => boolean;
  declare _anyRunning: () => boolean;
  declare _wallNow: () => number;
  declare _strobeLatchMs: () => number | undefined;
  declare _records: Map<string, VoiceRecord>;
  declare _seq: number;

  constructor({ now, beatPos, bpm, reading, onChange, acknowledged, anyRunning, wallNow, strobeLatchMs }: VoiceManagerOptions) {
    this._now = now;
    this._read = reading ?? (() => ({ beatPos: beatPos ? beatPos() : 0, bpm: bpm ? bpm() : 120 }));
    this._onChange = onChange;
    this._acknowledged = acknowledged;
    this._anyRunning = anyRunning ?? (() => false);
    this._wallNow = wallNow ?? (() => Date.now());
    this._strobeLatchMs = strobeLatchMs ?? (() => undefined);
    this._records = new Map();
    this._seq = 0;
  }

  /** How many voices there are, the ones still waiting for their grid line and the hidden ones included. */
  get size(): number {
    return this._records.size;
  }

  /**
   * Launch a voice. Everything is checked before anything changes: a spec
   * that does not validate, bad targets or timing are a 400, an effect that
   * waits for the photosensitivity acknowledgement a 409, and the voice it
   * would replace plays on. A hold pressed again with the same owner and
   * token and the same launch is renewed, not launched again.
   */
  start(v: StartVoice): Voice {
    const spec = voiceSpec(v.spec);
    if (v.admission !== 'render' && requiresAcknowledgement(spec) && !this._acknowledged()) {
      throw new HttpError(409, ACKNOWLEDGEMENT_REQUIRED);
    }
    const ids = fixtureIdsOf(v.targets);
    const targets = ids ? Object.freeze(ids) as number[] : null;
    if (!['hold', 'once', 'latched'].includes(v.mode)) throw bad('voice: mode must be hold, once or latched');
    if (v.tier !== 'strobe' && v.tier !== 'voice') throw bad('voice: tier must be strobe or voice');
    const quantise = v.quantise ?? 0;
    if (!(Number.isFinite(quantise) && quantise >= 0)) throw bad('voice: quantise must be a number of beats, 0 or more');
    if (v.lengthBeats !== undefined && v.lengthMs !== undefined) throw bad('voice: a length in beats or in ms, not both');
    for (const [name, value] of [['lengthBeats', v.lengthBeats], ['lengthMs', v.lengthMs], ['maxLatchMs', v.maxLatchMs]] as const) {
      if (value !== undefined && !positive(value)) throw bad(`voice: ${name} must be a positive number`);
    }
    if (v.mode !== 'once' && (v.lengthBeats !== undefined || v.lengthMs !== undefined)) throw bad('voice: only a once voice has a length');
    if (v.mode !== 'latched' && v.maxLatchMs !== undefined) throw bad('voice: only a latched voice has a maximum latch');
    const owner = v.owner ?? null;
    if (v.mode === 'hold' && (typeof owner !== 'string' || !owner.length || v.token === undefined)) {
      throw bad('voice: a hold needs its owner and token');
    }
    if (v.anchorBeat !== undefined && !Number.isFinite(v.anchorBeat)) throw bad('voice: anchorBeat must be a number');
    // A strobe latched with no cap of its own takes the configured one, whoever latches it.
    let maxLatchMs = v.maxLatchMs;
    if (v.mode === 'latched' && maxLatchMs === undefined && spec.kind === 'strobe') {
      const cap = this._strobeLatchMs();
      if (positive(cap)) maxLatchMs = cap;
    }
    const label = v.label ?? spec.kind;
    const launch = launchKey(spec, targets, v.tier, v.source, label, v.key ?? null, v.id ?? null, !!v.holdsGrid);

    const now = this._now();
    const held = v.mode === 'hold' ? this._holdOf(owner!, v.token) : null;
    // The same press again renews it; a lease already run out is no longer there to renew.
    if (held && held.launch === launch && held.leaseUntil !== null && now < held.leaseUntil) {
      this._renewRecord(held, now);
      return this._view(held);
    }

    // One reading of the clock for the grid line and the length both.
    const { beatPos, bpm: rawBpm } = this._read();
    // The conductor clamps its tempo; this only keeps a stand-in clock from dividing by nothing.
    const bpm = Number.isFinite(rawBpm) && rawBpm > 0 ? rawBpm : 120;
    let startedAtMs = now;
    let anchorBeat = Number.isFinite(beatPos) ? beatPos : 0;
    // Primed (nothing playing), a launch starts at once, as Hue Dynamics' pads do.
    // A voice already past its end is not playing, whether or not its timer has run.
    const primed = !this._liveAt(now) && !this._anyRunning();
    if (!primed && quantise > 0 && Number.isFinite(beatPos)) {
      // Up to the next grid line; a launch exactly on one starts there.
      const grid = Math.ceil(beatPos / quantise - 1e-9) * quantise;
      startedAtMs = now + ((grid - beatPos) * 60000) / bpm;
      anchorBeat = grid;
    }
    if (v.holdsGrid) anchorBeat = 0;
    else if (v.anchorBeat !== undefined) anchorBeat = v.anchorBeat;

    let untilMs: number | null = null;
    if (v.mode === 'once') {
      const ms = v.lengthMs ?? ((v.lengthBeats ?? lengthBeatsOf(spec)) * 60000) / bpm;
      untilMs = startedAtMs + ms;
    } else if (v.mode === 'latched' && maxLatchMs !== undefined) {
      untilMs = startedAtMs + maxLatchMs;
    }
    if (!Number.isFinite(startedAtMs) || (untilMs !== null && !Number.isFinite(untilMs))) throw bad('voice: too long to time');

    // Replaced: the same key, the same hold lease, the same id.
    for (const r of [...this._records.values()]) {
      const same = (v.key !== undefined && r.voice.key === v.key) || (v.id !== undefined && r.voice.id === v.id)
        || (v.mode === 'hold' && r.voice.mode === 'hold' && r.voice.owner === owner && r.token === v.token);
      if (same) this._end(r);
    }

    const launchSeq = ++this._seq;
    const id = v.id ?? `voice:${launchSeq}`;
    const record: VoiceRecord = {
      voice: {
        id, spec, targets, mode: v.mode, tier: v.tier, source: v.source, label, launchSeq,
        startedAtMs, untilMs, anchorBeat, seed: seedFrom(id), owner, key: v.key ?? null, hidden: !!v.hidden, holdsGrid: !!v.holdsGrid,
      },
      token: v.token, launch, leaseUntil: null, lease: 0, leaseWait: null, endWait: null, wall: this._wallNow() - now,
    };
    this._records.set(id, record);
    if (untilMs !== null) record.endWait = wait(untilMs - now, () => { if (this._end(record)) this._changed(); });
    if (v.mode === 'hold') this._renewRecord(record, now);
    this._changed();
    return this._view(record);
  }

  /** Keep a hold alive for another HOLD_TIMEOUT_MS. Only its owner and token renew it; a lease run out is gone. */
  renew(owner: string, token: unknown): void {
    const record = this._holdOf(owner, token);
    if (!record) return;
    const now = this._now();
    if (record.leaseUntil !== null && now >= record.leaseUntil) {
      if (this._end(record)) this._changed();
      return;
    }
    this._renewRecord(record, now);
  }

  /** Let a hold go. Another owner's or token's release does nothing. */
  release(owner: string, token: unknown): void {
    const record = this._holdOf(owner, token);
    if (record && this._end(record)) this._changed();
  }

  /** The owner went (a socket closed): every voice it launched goes with it. */
  disconnect(owner: string): void {
    this.stopWhere((v) => v.owner === owner);
  }

  /** Stop one voice; false when there is none by that id. */
  stop(id: string): boolean {
    const record = this._records.get(id);
    if (!record || !this._end(record)) return false;
    this._changed();
    return true;
  }

  /** Stop every voice, the ones still waiting for their start and the hidden ones too. */
  stopAll(): number {
    return this.stopWhere(() => true);
  }

  /** Stop the voices `pred` picks; how many. */
  stopWhere(pred: (v: Voice) => boolean): number {
    let n = 0;
    for (const record of [...this._records.values()]) if (pred(this._view(record)) && this._end(record)) n++;
    if (n) this._changed();
    return n;
  }

  /**
   * Hide a voice, or show it again: hidden, it keeps its launch, its timers
   * and its lease and renders nothing. The energy endpoints' latch hides
   * under their hold this way. Tells no one: the caller is in a change already.
   */
  setHidden(id: string, hidden: boolean): void {
    const record = this._records.get(id);
    if (record) record.voice.hidden = hidden;
  }

  /**
   * A new spec of the same kind for a running voice (the strobe's settings
   * edited live). Launch, start, seed, lease and end stay, so the renderer
   * keeps its state and the strobe its permit. Null for no such voice.
   */
  update(id: string, raw: unknown): Voice | null {
    const record = this._records.get(id);
    if (!record) return null;
    const spec = voiceSpec(raw);
    const v = record.voice;
    if (spec.kind !== v.spec.kind) throw bad('voice: an update keeps the kind');
    v.spec = spec;
    record.launch = launchKey(spec, v.targets, v.tier, v.source, v.label, v.key, v.id, v.holdsGrid);
    this._changed();
    return this._view(record);
  }

  /** End a voice by `untilMs` at the latest (a cap lowered): never later than it was, and now if that is past. */
  endBy(id: string, untilMs: number): void {
    const record = this._records.get(id);
    if (!record || !Number.isFinite(untilMs)) return;
    const v = record.voice;
    if (v.untilMs !== null && v.untilMs <= untilMs) return;
    v.untilMs = untilMs;
    record.endWait?.cancel();
    const now = this._now();
    if (!(now < untilMs)) {
      if (this._end(record)) this._changed();
      return;
    }
    record.endWait = wait(untilMs - now, () => { if (this._end(record)) this._changed(); });
    this._changed();
  }

  /** One voice, as a copy; null for none. */
  get(id: string): Voice | null {
    const record = this._records.get(id);
    return record ? this._view(record) : null;
  }

  /** The voice launched under a key, as a copy; null for none. */
  keyed(key: string): Voice | null {
    for (const record of this._records.values()) if (record.voice.key === key) return this._view(record);
    return null;
  }

  /** Every voice, in launch order, for the live state and GET /api/voices. Changes nothing. */
  list(): VoiceSummary[] {
    return [...this._records.values()].map(({ voice: v, wall }) => ({
      id: v.id, source: v.source, label: v.label, mode: v.mode, tier: v.tier, kind: v.spec.kind,
      targets: v.targets ? [...v.targets] : 'shared', launchSeq: v.launchSeq,
      startedAt: Math.round(v.startedAtMs + wall), until: v.untilMs === null ? null : Math.round(v.untilMs + wall), hidden: v.hidden,
    }));
  }

  /**
   * The voices playing at `nowMs`, as the renderer takes them. A voice not
   * started yet is left out (unless it starts within `aheadMs`: the renderer
   * holds it until its start), and so is a hidden one. A voice past its end
   * or its lease is ended here, whether or not its timer has fired: the
   * frame is the second check that a dropped hold dies on time. A hold's
   * frame ends at its lease, so a renderer working on without news stops it too.
   */
  frames(nowMs: number, aheadMs = 0): VoiceFrame[] {
    const out: VoiceFrame[] = [];
    let ended = false;
    for (const record of [...this._records.values()]) {
      const v = record.voice;
      const end = this._endOf(record);
      if (!(nowMs < end)) {
        ended = this._end(record) || ended;
        continue;
      }
      if (v.hidden || v.startedAtMs > nowMs + aheadMs) continue;
      out.push({ id: v.id, spec: v.spec, targets: v.targets, tier: v.tier, launchSeq: v.launchSeq, startedAtMs: v.startedAtMs,
        untilMs: Number.isFinite(end) ? end : null, anchorBeat: v.anchorBeat, seed: [...v.seed] as Seed, ...(v.holdsGrid ? { holdsGrid: true } : {}) });
    }
    if (ended) this._changed();
    return out;
  }

  /** Whether any voice is still on at `now`: waiting for its start, hidden or playing, short of its end and its lease. */
  _liveAt(now: number): boolean {
    for (const record of this._records.values()) if (now < this._endOf(record)) return true;
    return false;
  }

  /** Where a voice ends: its own end or its lease's, whichever comes first; Infinity for neither. */
  _endOf(record: VoiceRecord): number {
    return Math.min(record.voice.untilMs ?? Infinity, record.leaseUntil ?? Infinity);
  }

  _holdOf(owner: string, token: unknown): VoiceRecord | null {
    for (const record of this._records.values()) {
      if (record.voice.mode === 'hold' && record.voice.owner === owner && record.token === token) return record;
    }
    return null;
  }

  _renewRecord(record: VoiceRecord, now: number): void {
    record.leaseWait?.cancel();
    record.leaseUntil = now + HOLD_TIMEOUT_MS;
    const lease = ++record.lease;
    // The lease this timer was armed for, not the clock: a renewal since has a timer of its own.
    record.leaseWait = wait(HOLD_TIMEOUT_MS, () => {
      if (record.lease === lease && this._end(record)) this._changed();
    });
  }

  /** Remove a record and its timers; false when it was gone already (a stale timer, a replacement). */
  _end(record: VoiceRecord): boolean {
    if (this._records.get(record.voice.id) !== record) return false;
    this._records.delete(record.voice.id);
    record.endWait?.cancel();
    record.leaseWait?.cancel();
    record.endWait = record.leaseWait = null;
    return true;
  }

  _changed(): void {
    try {
      this._onChange();
    } catch (err) {
      console.warn(`[voices] change listener: ${messageOf(err)}`);
    }
  }

  _view(record: VoiceRecord): Voice {
    const v = record.voice;
    return { ...v, targets: v.targets ? [...v.targets] : null, seed: [...v.seed] as Seed };
  }
}
