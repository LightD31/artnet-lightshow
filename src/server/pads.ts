import { z } from 'zod';

import { deepFreeze, presetById } from '../shared/effects/index.ts';
import { canonical } from '../shared/effects/layer.ts';
import { HttpError, messageOf } from '../errors.ts';
import { JsonStore } from './json-store.ts';
import { snapshot } from './effect-library.ts';
import { validate, ValidationError } from './validation.ts';
import { launchOf, targetsOf } from './voices.ts';
import type { PresetLookup, Voice, VoiceManager, VoiceMode, VoiceTargets } from './voices.ts';

/**
 * Pads: Hue Dynamics' two banks of eight. Each pad plays a preset, a pattern
 * (one voice of lanes and clips), the strobe, or drops a pattern into the
 * sequence; held, once or as a loop that a second press stops; on a grid of
 * its own (0 is now) and on the whole rig or some fixtures. The layout lives
 * in config/pads.json; what a pad plays is a voice (voices.ts), one per pad.
 *
 *   hold   plays while its owner renews the lease: a page over the socket,
 *          or a REST caller pressing again within HOLD_TIMEOUT_MS
 *   once   plays its length: `?ms=`, else the preset's, else its loop's
 *   loop   latched until the pad is pressed or toggled again
 */

export const PAD_BANKS = 2;
export const PAD_SLOTS = 8;
export const PAD_COUNT = PAD_BANKS * PAD_SLOTS;
// Hue Dynamics' default: 240 of its 960 ticks to the beat.
export const DEFAULT_QUANTISE = 0.25;
/** The strobe pad's content id; `strobe` is no preset (it stays the upstream pattern's id). */
export const STROBE_ID = 'strobe';
/** The token a REST press uses when it names none, so its bare release finds it. */
export const REST_TOKEN = 'rest';

export type PadContentKind = 'preset' | 'pattern' | 'strobe' | 'sequencePattern';
export interface PadContent { kind: PadContentKind; id: string }
export type PadLaunchMode = 'once' | 'hold' | 'loop';
export interface PadEntry {
  bank: 0 | 1;
  slot: number;
  label: string;
  /** #RRGGBB, the pad's colour on the deck. */
  accent: string;
  content: PadContent | null;
  launch: PadLaunchMode;
  /** Beats of the grid a launch snaps up to while something plays; 0 is now. */
  quantise: number;
  targets: 'shared' | number[];
}

/** What a pattern pad hands the pattern player: the pad's launch, under the pad's key. No length: the pattern's own plays, unless `lengthMs`. */
export interface PadVoiceLaunch {
  targets: VoiceTargets;
  mode: VoiceMode;
  quantise: number;
  /** Start it under this key: a pad plays one voice at a time. */
  key: string;
  source: 'pad';
  label: string;
  owner?: string;
  token?: string;
  lengthMs?: number;
}
/** Plays a pattern as one voice; the sequencer's patterns install it. */
export type PatternVoiceHook = (id: string, launch: PadVoiceLaunch) => Voice;
/** Drops a pattern into the loaded sequence at a beat; the sequencer installs it. */
export type InsertPatternHook = (id: string, atBeat: number) => void;
/** A pad launched (its grid beat) or a held one released (with its end), for the sequencer's punch recording. */
export type PadHitHook = (hit: { bank: number; slot: number; startBeat: number; endBeat?: number; lengthMs?: number }) => void;
/** The manual strobe's hold, which the strobe installs: the strobe pad and voice-hold's `{ preset: 'strobe' }` both go through it. */
export interface StrobeHook {
  hold(owner: string, token: string): Voice;
  release(owner: string, token: string): void;
}

/** One issue with a new assignment, under its path in the entry. */
export interface PadIssue { path: (string | number)[]; message: string }
/** Asked of an entry before it is saved, with the one it replaces: what it names that is not there. */
export type PadAdmission = (entry: PadEntry, before: PadEntry) => PadIssue[];

/** A pad's place in the layout, bank by bank; a 400 naming the bank or the slot that is none. */
export function padIndex(bank: unknown, slot: unknown): number {
  if (bank !== 0 && bank !== 1) throw new HttpError(400, `pad: bank must be 0 or ${PAD_BANKS - 1}`);
  if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot >= PAD_SLOTS) {
    throw new HttpError(400, `pad: slot must be 0 to ${PAD_SLOTS - 1}`);
  }
  return bank * PAD_SLOTS + slot;
}

/**
 * The owner a REST press holds a pad under: one per pad, and never a
 * socket's (socket.io ids have no colon), so a REST press and a socket's
 * never share a lease.
 */
export const restOwner = (bank: number, slot: number): string => `rest:pad:${bank}:${slot}`;

const padKey = (index: number) => `pad:${Math.floor(index / PAD_SLOTS)}:${index % PAD_SLOTS}`;

// ── The layout file ─────────────────────────────────────────────────────────

const fixtureId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const fields = {
  label: z.string().max(80),
  accent: z.string().regex(/^#[0-9a-f]{6}$/i, 'expected a hex colour #RRGGBB').transform((hex) => hex.toUpperCase()),
  content: z.object({ kind: z.enum(['preset', 'pattern', 'strobe', 'sequencePattern']), id: z.string().min(1).max(64) }).strict().nullable(),
  launch: z.enum(['once', 'hold', 'loop']),
  quantise: z.number().finite().min(0),
  // R7: 'shared', never 'all'. Ids once each; an empty list stays empty (it covers nothing).
  targets: z.union([z.literal('shared'), z.array(fixtureId).max(1024).transform((ids) => [...new Set(ids)])]),
};
const place = { bank: z.union([z.literal(0), z.literal(1)]), slot: z.number().int().min(0).max(PAD_SLOTS - 1) };

// The strobe's hook only holds and releases.
function strobeHeld(pad: { content: { kind: string; id: string } | null; launch: string }, ctx: z.RefinementCtx): void {
  if (pad.content?.kind !== 'strobe') return;
  if (pad.content.id !== STROBE_ID) ctx.addIssue({ code: 'custom', path: ['content', 'id'], message: `the strobe's id is "${STROBE_ID}"` });
  if (pad.launch !== 'hold') ctx.addIssue({ code: 'custom', path: ['launch'], message: 'the strobe pad plays while held: "hold"' });
}

const fieldsSchema = z.object(fields).strict().superRefine(strobeHeld);
const entrySchema = z.object({ ...place, ...fields }).strict().superRefine(strobeHeld);
const layoutSchema = z.array(entrySchema).length(PAD_COUNT).superRefine((pads, ctx) => {
  const seen = new Set<number>();
  pads.forEach(({ bank, slot }, i) => {
    const at = bank * PAD_SLOTS + slot;
    if (seen.has(at)) ctx.addIssue({ code: 'custom', path: [i], message: `bank ${bank} slot ${slot} is there twice` });
    seen.add(at);
  });
});
const fileSchema = z.object({ pads: layoutSchema }).strict();

const ordered = (pads: readonly PadEntry[]): PadEntry[] =>
  [...pads].sort((a, b) => (a.bank * PAD_SLOTS + a.slot) - (b.bank * PAD_SLOTS + b.slot));

// A fresh install: the six energy effects and the strobe held, then Hue
// Dynamics and Light DJ looks. None but the two energy strobes (and the
// strobe pad, the strobe's own) waits for the photosensitivity acknowledgement.
const DEFAULTS: [content: PadContent, launch: PadLaunchMode, accent: string][] = [
  [{ kind: 'preset', id: 'energy.whiteStrobe' }, 'hold', '#FFFFFF'],
  [{ kind: 'preset', id: 'energy.colorStrobe' }, 'hold', '#F472B6'],
  [{ kind: 'preset', id: 'energy.blinder' }, 'hold', '#FDE047'],
  [{ kind: 'preset', id: 'energy.uvWash' }, 'hold', '#7C3AED'],
  [{ kind: 'preset', id: 'energy.kill' }, 'hold', '#334155'],
  [{ kind: 'preset', id: 'energy.glow' }, 'hold', '#FB923C'],
  [{ kind: 'strobe', id: STROBE_ID }, 'hold', '#E2E8F0'],
  [{ kind: 'preset', id: 'hd.bassBloom' }, 'once', '#FF006E'],
  [{ kind: 'preset', id: 'hd.auroraDrift' }, 'loop', '#06B6D4'],
  [{ kind: 'preset', id: 'hd.neonDomino' }, 'loop', '#FF2BD6'],
  [{ kind: 'preset', id: 'hd.prismRicochet' }, 'loop', '#A855F7'],
  [{ kind: 'preset', id: 'hd.meteorShower' }, 'once', '#38BDF8'],
  [{ kind: 'preset', id: 'ldj.Swirl' }, 'loop', '#22D3EE'],
  [{ kind: 'preset', id: 'ldj.GrooveWave' }, 'loop', '#22C55E'],
  [{ kind: 'preset', id: 'ldj.NorthernLights' }, 'loop', '#10B981'],
  [{ kind: 'preset', id: 'ldj.Popcorn' }, 'once', '#FACC15'],
];
/** The layout a fresh install starts with, frozen; labels are the presets' names. */
export const DEFAULT_PADS: readonly PadEntry[] = deepFreeze(DEFAULTS.map(([content, launch, accent], i): PadEntry => ({
  bank: Math.floor(i / PAD_SLOTS) as 0 | 1, slot: i % PAD_SLOTS,
  label: content.kind === 'strobe' ? 'Strobe' : presetById(content.id)!.name,
  accent, content, launch, quantise: DEFAULT_QUANTISE, targets: 'shared',
})));

/** A refusal in the form validate() gives one: each issue under its path. */
function refusal(label: string, issues: PadIssue[]): ValidationError {
  return new ValidationError(`${label}: ${issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    issues.map((i) => ({ code: 'custom', path: i.path, message: i.message, input: undefined })) as unknown as z.ZodIssue[]);
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export class PadStore extends JsonStore {
  declare _layout: readonly PadEntry[];
  declare _listeners: (() => void)[];
  declare _admit: PadAdmission | null;

  /** pads.json. No file is the default layout; one that does not validate is moved aside whole (JsonStore). */
  constructor(file: string) {
    super(file, { tag: 'pads', fallback: 'starting with the default pads' });
    this._layout = DEFAULT_PADS;
    this._listeners = [];
    this._admit = null;
  }

  // Shapes only: a preset deleted since, or a fixture gone, leaves the pad
  // assigned (refused at launch), rather than costing the whole layout.
  load(): this {
    const saved = this.readValid(fileSchema);
    if (saved) this._layout = deepFreeze(ordered(saved.pads));
    return this;
  }

  useDefaults(): void {
    this._layout = DEFAULT_PADS;
  }

  /** Every pad, bank 0 then bank 1, as copies. */
  layout(): PadEntry[] {
    return this._layout.map(snapshot);
  }

  /** The layout itself, frozen, for the live state (it rides every broadcast). */
  view(): readonly PadEntry[] {
    return this._layout;
  }

  /** One pad, as a copy. */
  get(bank: number, slot: number): PadEntry {
    return snapshot(this._layout[padIndex(bank, slot)]);
  }

  /** What decides whether an entry names what is there; asked only of what changed. */
  setAdmission(fn: PadAdmission | null): void {
    this._admit = fn;
  }

  /** Called after every saved change; never for a refused, failed or empty one. */
  onChange(fn: () => void): void {
    this._listeners.push(fn);
  }

  /** Assign one pad. Its bank and slot may come along when they are the place's own. */
  set(bank: number, slot: number, input: unknown): PadEntry {
    const index = padIndex(bank, slot);
    let body = input;
    if (isRecord(input) && (Object.hasOwn(input, 'bank') || Object.hasOwn(input, 'slot'))) {
      const { bank: b, slot: s, ...rest } = input;
      if (b !== undefined && b !== bank) throw refusal('pad', [{ path: ['bank'], message: `${String(b)} is not this pad's (${bank})` }]);
      if (s !== undefined && s !== slot) throw refusal('pad', [{ path: ['slot'], message: `${String(s)} is not this pad's (${slot})` }]);
      body = rest;
    }
    const entry: PadEntry = { bank: bank as 0 | 1, slot, ...validate(fieldsSchema, body, 'pad') };
    const issues = this._admit?.(entry, this._layout[index]) ?? [];
    if (issues.length) throw refusal('pad', issues);
    this._commit(this._layout.map((p, i) => (i === index ? entry : p)));
    return snapshot(entry);
  }

  /** Replace the whole layout: sixteen pads, each place once. All or nothing. */
  replace(input: unknown): PadEntry[] {
    const entries = validate(layoutSchema, input, 'pads') as PadEntry[];
    const issues = entries.flatMap((entry, i) => (this._admit?.(entry, this._layout[entry.bank * PAD_SLOTS + entry.slot]) ?? [])
      .map((issue) => ({ ...issue, path: [i, ...issue.path] })));
    if (issues.length) throw refusal('pads', issues);
    this._commit(ordered(entries));
    return this.layout();
  }

  /** Back to the default layout. */
  reset(): PadEntry[] {
    this._commit(DEFAULT_PADS);
    return this.layout();
  }

  // Written first, then published, as the effect library does; a change that
  // changes nothing is neither written nor told.
  _commit(next: readonly PadEntry[]): void {
    if (canonical(next) === canonical(this._layout)) return;
    try {
      this.writeJson({ pads: next });
    } catch (err) {
      console.warn(`[pads] could not save ${this.file}: ${messageOf(err)}`);
      throw new HttpError(500, `Could not save the pads: ${messageOf(err)}`);
    }
    this._layout = deepFreeze([...next]);
    for (const fn of this._listeners) {
      try { fn(); } catch (err) { console.warn(`[pads] listener: ${messageOf(err)}`); }
    }
  }
}

// ── Playing them ────────────────────────────────────────────────────────────

export interface PadsOptions {
  voices: VoiceManager;
  store: PadStore;
  /** Presets by id or alias, as a launch reads them now (the library's, saved ones included). */
  lookup: () => PresetLookup;
  /** The patch's fixture ids now. */
  fixtureIds: () => readonly number[];
  /** The beat a sequence pattern is dropped in from. */
  beat?: () => number;
  insertPattern?: InsertPatternHook;
  patternVoice?: PatternVoiceHook;
  strobe?: StrobeHook;
}

/** A voice a pad launched, or a strobe hold: what lights a pad, and what a release lets go of. */
interface PadRecord {
  /** The pad, or null for voice-hold's `{ preset: 'strobe' }`. */
  index: number | null;
  id: string;
  launchSeq: number;
  via: 'voice' | 'strobe';
  owner: string | null;
  token: string | null;
}

const HELD_ONLY = 'The strobe pad plays while it is held: press and release it';

export class Pads {
  declare store: PadStore;
  // The hooks later tasks install; until then their pads answer 409.
  declare insertPattern: InsertPatternHook | undefined;
  declare onHit: PadHitHook | undefined;
  declare _holds: Map<string, number>;
  // A latched loop's start, for the end its toggle-off records.
  declare _latched: Map<number, number>;
  declare patternVoice: PatternVoiceHook | undefined;
  declare strobe: StrobeHook | undefined;
  declare _voices: VoiceManager;
  declare _lookup: () => PresetLookup;
  declare _fixtureIds: () => readonly number[];
  declare _beat: () => number;
  declare _records: PadRecord[];

  constructor({ voices, store, lookup, fixtureIds, beat, insertPattern, patternVoice, strobe }: PadsOptions) {
    this.store = store;
    this.insertPattern = insertPattern;
    this.patternVoice = patternVoice;
    this.strobe = strobe;
    this._voices = voices;
    this._lookup = lookup;
    this._fixtureIds = fixtureIds;
    this._beat = beat ?? (() => 0);
    this._records = [];
    this._holds = new Map();
    this._latched = new Map();
    store.setAdmission((entry, before) => this._admit(entry, before));
  }

  /** One pad, as a copy. */
  entry(bank: number, slot: number): PadEntry {
    return this.store.get(bank, slot);
  }

  /**
   * A press, as the pad's launch says: a hold leased to `owner` and
   * `token` (the same press again renews it), a once, a loop toggled, the
   * strobe held, a pattern dropped into the sequence. Null when nothing
   * plays: an empty pad, a loop stopped, a pattern dropped in.
   */
  press(bank: number, slot: number, owner: string, token: string): Voice | null {
    const index = padIndex(bank, slot);
    const entry = this.store.get(bank, slot);
    const content = entry.content;
    if (!content) return null;
    if (content.kind === 'sequencePattern') return this._insert(entry);
    if (content.kind === 'strobe') return this._holdStrobe(index, owner, token, this._targets(entry));
    if (entry.launch === 'loop') return this._hit(bank, slot, entry, this._toggle(index, entry));
    if (entry.launch === 'once') return this._hit(bank, slot, entry, this._launch(index, entry, 'once'));
    const voice = this._hit(bank, slot, entry, this._launch(index, entry, 'hold', { owner, token }));
    if (voice && this.onHit) this._holds.set(`${index}|${owner}|${token}`, this._gridBeat(entry));
    return voice;
  }

  /**
   * Let go of the hold this pad launched for `owner` and `token`, whatever
   * the pad holds now: the press owns its release. A once and a loop play
   * on; another owner's or token's hold is not this one's. Whether one went.
   */
  release(bank: number, slot: number, owner: string, token: string): boolean {
    const index = padIndex(bank, slot);
    const record = this._alive().find((r) => r.index === index && r.owner === owner && r.token === token);
    if (!record) return false;
    this._stop(record);
    const key = `${index}|${owner}|${token}`;
    const startBeat = this._holds.get(key);
    this._holds.delete(key);
    if (startBeat !== undefined) this.onHit?.({ bank, slot, startBeat, endBeat: this._beat() });
    return true;
  }

  /** Play the pad once, whatever its launch: `ms` long, else its preset's or its pattern's length. */
  once(bank: number, slot: number, ms?: number): Voice | null {
    const index = padIndex(bank, slot);
    const entry = this.store.get(bank, slot);
    const content = entry.content;
    if (!content) return null;
    if (content.kind === 'sequencePattern') return this._insert(entry);
    if (content.kind === 'strobe') throw new HttpError(409, HELD_ONLY);
    return this._hit(bank, slot, entry, this._launch(index, entry, 'once', null, ms), ms);
  }

  /** Stop what the pad plays, or start it as a loop, whatever its launch. Null when it stopped. */
  toggle(bank: number, slot: number): Voice | null {
    const index = padIndex(bank, slot);
    const entry = this.store.get(bank, slot);
    if (entry.content?.kind === 'strobe') throw new HttpError(409, HELD_ONLY);
    return this._hit(bank, slot, entry, this._toggle(index, entry));
  }

  /** Stop every voice a pad launched, the strobe pad's hold included; the others play on. How many. */
  stopAll(): number {
    let n = 0;
    for (const record of this._alive()) {
      if (record.index !== null && record.via === 'strobe') {
        this._stop(record);
        n++;
      }
    }
    return n + this._voices.stopWhere((v) => v.source === 'pad');
  }

  /**
   * voice-hold's `{ preset: 'strobe' }`: the strobe held, through the same
   * hook as the strobe pad. Until the strobe is installed, what voice-hold
   * always made of it: a preset by that id, and there is none (a 400).
   */
  holdStrobe(owner: string, token: string, targets?: unknown): Voice {
    return this._holdStrobe(null, owner, token, targets);
  }

  /** Let go of `owner`'s hold under `token`, a pad's or not, by the way it was pressed. */
  releaseHold(owner: string, token: string): void {
    const record = this._alive().find((r) => r.owner === owner && r.token === token);
    if (record) this._stop(record);
    else this._voices.release(owner, token);
  }

  /** The voice each pad plays, bank 0 then bank 1, or null for a dark one. */
  lit(): (string | null)[] {
    const out: (string | null)[] = Array(PAD_COUNT).fill(null);
    // In launch order: the latest on a pad lights it.
    for (const record of this._alive()) if (record.index !== null) out[record.index] = record.id;
    return out;
  }

  /** The live state's `pads`: the layout, and which pads are lit. */
  view(): { layout: readonly PadEntry[]; lit: (string | null)[] } {
    return { layout: this.store.view(), lit: this.lit() };
  }

  _toggle(index: number, entry: PadEntry): Voice | null {
    // Stopping first, before anything a launch would ask (the acknowledgement among it).
    const current = this._alive().filter((r) => r.index === index).at(-1);
    if (current) {
      this._stop(current);
      const startBeat = this._latched.get(index);
      this._latched.delete(index);
      if (startBeat !== undefined) this.onHit?.({ bank: Math.floor(index / PAD_SLOTS), slot: index % PAD_SLOTS, startBeat, endBeat: this._beat() });
      return null;
    }
    if (!entry.content) return null;
    if (entry.content.kind === 'sequencePattern') return this._insert(entry);
    const voice = this._launch(index, entry, 'latched');
    if (this.onHit) this._latched.set(index, this._gridBeat(entry));
    return voice;
  }

  _launch(index: number, entry: PadEntry, mode: VoiceMode, lease: { owner: string; token: string } | null = null, ms?: number): Voice {
    const content = entry.content!;
    const launch: PadVoiceLaunch = {
      targets: this._targets(entry), mode, quantise: entry.quantise, key: padKey(index), source: 'pad', label: entry.label || content.id,
      ...(lease ?? {}), ...(ms !== undefined ? { lengthMs: ms } : {}),
    };
    let voice: Voice;
    if (content.kind === 'pattern') {
      if (!this.patternVoice) throw new HttpError(409, 'No pattern player on this server yet');
      voice = this.patternVoice(content.id, launch);
    } else {
      // A copy of the preset as it is now: a later edit leaves this launch as it was.
      const found = launchOf({ preset: content.id }, this._lookup());
      voice = this._voices.start({
        ...launch, spec: found.spec, tier: 'voice', label: entry.label || found.label,
        // A once with no length plays its preset's, then its kind's (voices.ts lengthBeatsOf).
        ...(mode === 'once' && ms === undefined ? { lengthBeats: found.lengthBeats } : {}),
      });
    }
    this._remember(index, voice, 'voice', lease);
    return voice;
  }

  _holdStrobe(index: number | null, owner: string, token: string, targets: unknown): Voice {
    if (this.strobe) {
      const voice = this.strobe.hold(owner, token);
      this._remember(index, voice, 'strobe', { owner, token });
      return voice;
    }
    // voice-hold's own way with `{ preset: 'strobe' }`, as it was before the strobe.
    const found = launchOf({ preset: STROBE_ID }, this._lookup());
    const voice = this._voices.start({
      spec: found.spec, targets: targetsOf(targets, this._fixtureIds()), mode: 'hold', tier: 'voice', source: 'api', label: found.label, owner, token,
    });
    this._remember(index, voice, 'voice', { owner, token });
    return voice;
  }

  /** Drop the pad's pattern into the sequence at its next grid line (now, for a grid of 0). */
  _insert(entry: PadEntry): null {
    if (!this.insertPattern) throw new HttpError(409, 'No sequence to drop a pattern into on this server yet');
    this.insertPattern(entry.content!.id, this._gridBeat(entry));
    return null;
  }

  /** The pad's next grid line from now (now, for a grid of 0). */
  _gridBeat(entry: PadEntry): number {
    const beat = this._beat();
    const q = entry.quantise;
    return q > 0 && Number.isFinite(beat) ? Math.ceil(beat / q - 1e-9) * q : beat;
  }

  /** Tell the recording of a launch; a loop toggled off launched nothing. */
  _hit(bank: number, slot: number, entry: PadEntry, voice: Voice | null, ms?: number): Voice | null {
    if (voice && this.onHit) this.onHit({ bank, slot, startBeat: this._gridBeat(entry), ...(ms !== undefined ? { lengthMs: ms } : {}) });
    return voice;
  }

  /** The pad's fixtures that are still patched: a fixture removed since is gone, never another's id. */
  _targets(entry: PadEntry): VoiceTargets {
    if (entry.targets === 'shared') return 'shared';
    const known = new Set(this._fixtureIds());
    return entry.targets.filter((id) => known.has(id));
  }

  _stop(record: PadRecord): void {
    this._records = this._records.filter((r) => r !== record);
    if (record.via === 'strobe' && this.strobe && record.owner !== null && record.token !== null) this.strobe.release(record.owner, record.token);
    else if (record.owner !== null && record.token !== null) this._voices.release(record.owner, record.token);
    else this._voices.stop(record.id);
  }

  _remember(index: number | null, voice: Voice, via: PadRecord['via'], lease: { owner: string; token: string } | null): void {
    // A renewal hands back the same launch: one record for it.
    this._records = this._alive().filter((r) => !(r.id === voice.id && r.launchSeq === voice.launchSeq));
    this._records.push({ index, id: voice.id, launchSeq: voice.launchSeq, via, owner: lease?.owner ?? null, token: lease?.token ?? null });
  }

  /**
   * The records whose launch still plays. One ended (a stop, a disarm, a
   * lease run out, its page gone, a launch on the same pad) is forgotten:
   * nothing hidden is left for a release or a toggle to find.
   */
  _alive(): PadRecord[] {
    this._records = this._records.filter((r) => this._voices.get(r.id)?.launchSeq === r.launchSeq);
    return this._records;
  }

  /** What a new assignment names must be there now: its preset, its fixtures. Only what changed is asked. */
  _admit(entry: PadEntry, before: PadEntry): PadIssue[] {
    const issues: PadIssue[] = [];
    const { content, targets } = entry;
    if (content?.kind === 'preset' && canonical(content) !== canonical(before.content) && !this._lookup()(content.id)) {
      issues.push({ path: ['content', 'id'], message: `No such preset: ${content.id}` });
    }
    if (Array.isArray(targets) && canonical(targets) !== canonical(before.targets)) {
      const known = new Set(this._fixtureIds());
      for (const id of targets) if (!known.has(id)) issues.push({ path: ['targets'], message: `no fixture ${id}` });
    }
    return issues;
  }
}
