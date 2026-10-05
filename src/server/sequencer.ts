import crypto from 'node:crypto';
import { z, ZodError } from 'zod';

// The entry point registers every kind, so a clip's effect validates against it.
import { BUILTIN_PALETTES, deepFreeze } from '../shared/effects/index.ts';
import { pacesOwnFlashes, validateSpec } from '../shared/effects/registry.ts';
import { canonical } from '../shared/effects/layer.ts';
import { hash01, pickNotLast, seedFrom } from '../shared/effects/hash.ts';
import { resolvePalette, toHex } from '../shared/effects/palette.ts';
import { barBeats, playingClips, resyncPosition, selectClips } from '../shared/effects/sequence.ts';
import { validate, ValidationError } from './validation.ts';
import { safety } from './safety.ts';
import { HttpError } from '../errors.ts';
import type { RefinementCtx } from 'zod';
import type { MusicalTime } from './conductor.ts';
import type { AudioMode, EffectSpec, Seed } from '../shared/effects/types.ts';
import type { SequenceLane, SequenceLoop, SequenceTable, SequenceTransport, TableClip } from '../shared/effects/sequence.ts';

/**
 * The sequencer: lanes of effect clips on a beat timeline, as Hue Dynamics
 * arranges its Party shows, and Light DJ's playlists of rows as the special
 * case of one lane played row by row. This holds the model and its rules and
 * the sequence loaded for the transport; it resolves that sequence into the
 * clip table the renderer plays (shared/effects/sequence.ts picks which clip
 * plays where). Loading a sequence plays nothing: its transport starts it.
 *
 * Musical time is in quarter-note beats throughout, the conductor's.
 */

export type Lane = SequenceLane;
export type { SequenceTable, SequenceTransport, TableClip };

/** A clip plays one effect: given inline (`effect`) or a library preset by id (`presetId`). */
export interface Clip {
  id: string;
  laneId: string;
  startBeat: number;
  lengthBeats: number;
  /** The effect starts again every this many beats inside the clip. */
  loopBeats: number;
  presetId?: string;
  effect?: EffectSpec;
  /** The lane's fixtures, or fixture ids of its own (on a track, only the track's fixture counts). */
  targets: 'lane' | number[];
  mute: boolean;
}

/** Light DJ's command rows: at a beat, a palette, a tempo, a master level, or a jump to a beat. */
export type Command =
  | { id: string; atBeat: number; type: 'palette'; value: string }
  | { id: string; atBeat: number; type: 'tempo'; value: number }
  | { id: string; atBeat: number; type: 'brightness'; value: number }
  | { id: string; atBeat: number; type: 'goto'; value: number };

/**
 * Light DJ's timed changes of the tempo or the master. `period` counts beats
 * for brightness and seconds for tempo; `target` is where target mode goes.
 */
export interface Automation {
  mode: 'none' | 'target' | 'triangle' | 'sawtooth' | 'sine';
  period: number;
  min: number;
  max: number;
  growing: boolean;
  target?: number;
}

export interface Sequence {
  id: string;
  name: string;
  /** An arrangement plays every lane together; a playlist plays one lane's rows one at a time. */
  mode: 'arrangement' | 'playlist';
  bpm: number | null;
  timeSignature: { beats: number; unit: number };
  musicMode: AudioMode | null;
  loop: { on: boolean; startBeat: number; endBeat: number } | null;
  snap: number;
  lanes: Lane[];
  clips: Clip[];
  commands: Command[];
  automation: { tempo: Automation | null; brightness: Automation | null };
  /**
   * Light DJ's playlist options. `autoplay` moves a playing playlist on to
   * the next row at a row's end (off, the row loops until next), on by
   * default as in the app; it never starts a sequence, which only play does.
   */
  options: { autoplay: boolean; shuffle: boolean; randomPaletteOnLoop: boolean; initialPalette: string | null };
}

/** What the engine takes from the sequencer each frame: the table, and its transport (null while it neither plays, pauses nor stops). */
export interface SequenceFrame { table: SequenceTable | null; transport: SequenceTransport | null }

/**
 * The sequencer as the live state carries it (`sequence`): what is loaded,
 * whether it plays, is paused or stopped (holding its picture, or black), the
 * beat of the sequence it is on and that beat's bar (counted from 1), the
 * loop region, the clip on top of each lane, and why it stopped by itself.
 */
export interface SequenceStatus {
  loaded: { id: string; name: string } | null;
  revision: number;
  mode: Sequence['mode'] | null;
  playing: boolean;
  paused: boolean;
  stopped: 'hold' | 'black' | null;
  beat: number;
  bar: number;
  loop: Sequence['loop'];
  lanes: { id: string; clip: string | null }[];
  error: SequenceError | null;
}

// Hue Dynamics' cap: three shared lanes over the per-fixture tracks. Its cap
// of ten lights is its own bridge's, not this rig's, and is not kept.
export const MAX_SHARED_LANES = 3;

// Every lap is a fresh instance, so the strobe in a clip would restart its
// five-a-second permit each lap, as in a macro's step, and Disco's automatic
// strobe its limit likewise. Null for an effect a clip may hold.
function noOwnFlashes(spec: EffectSpec): { message: string; field: 'kind' | 'params' } | null {
  if (!pacesOwnFlashes(spec)) return null;
  return spec.kind === 'strobe'
    ? { message: 'a clip may not hold the strobe: it plays as a voice of its own', field: 'kind' }
    : { message: 'a clip may not hold an automatic strobe: each lap would start its five-a-second limit again', field: 'params' };
}

const idSchema = z.string().min(1).max(64);
const beatSchema = z.number().min(0);
const fixtureIdSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const BPM = { min: 20, max: 300 } as const;
const BYTE = { min: 0, max: 255 } as const;

/** A spec validated as any effect is, its issues named under the clip's `effect`. */
const effectSchema = z.unknown().transform((raw, ctx): EffectSpec => {
  try {
    return validateSpec(raw);
  } catch (err) {
    if (!(err instanceof ZodError)) throw err;
    for (const issue of err.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    return z.NEVER;
  }
});

const laneSchema = z.object({
  id: idSchema,
  kind: z.enum(['shared', 'track']),
  fixtureId: fixtureIdSchema.optional(),
  name: z.string().max(80).default(''),
  mute: z.boolean().default(false),
  solo: z.boolean().default(false),
}).strict().superRefine((lane, ctx) => {
  if (lane.kind === 'track' && lane.fixtureId === undefined) ctx.addIssue({ code: 'custom', path: ['fixtureId'], message: 'a track names its fixture' });
  if (lane.kind === 'shared' && lane.fixtureId !== undefined) ctx.addIssue({ code: 'custom', path: ['fixtureId'], message: 'a shared lane names no fixture' });
});

const clipSchema = z.object({
  id: idSchema,
  laneId: idSchema,
  startBeat: beatSchema,
  lengthBeats: z.number().positive(),
  loopBeats: z.number().positive().optional(),
  presetId: idSchema.optional(),
  effect: effectSchema.optional(),
  targets: z.union([z.literal('lane'), z.array(fixtureIdSchema)]).default('lane'),
  mute: z.boolean().default(false),
}).strict().superRefine((clip, ctx) => {
  if ((clip.effect === undefined) === (clip.presetId === undefined)) {
    ctx.addIssue({ code: 'custom', path: [], message: 'a clip plays exactly one of effect or presetId' });
  }
  const own = clip.effect && noOwnFlashes(clip.effect);
  if (own) ctx.addIssue({ code: 'custom', path: ['effect', own.field], message: own.message });
  if (!Number.isFinite(clip.startBeat + clip.lengthBeats)) ctx.addIssue({ code: 'custom', path: [], message: 'ends past the last beat a sequence can count' });
  // Its laps are counted in whole numbers: a loop so short they cannot be is refused before it plays.
  if (clip.lengthBeats / (clip.loopBeats ?? clip.lengthBeats) > Number.MAX_SAFE_INTEGER) {
    ctx.addIssue({ code: 'custom', path: ['loopBeats'], message: 'is too short for its clip: its laps cannot be counted' });
  }
  if (Array.isArray(clip.targets)) {
    const seen = new Set<number>();
    clip.targets.forEach((id, k) => {
      if (seen.has(id)) ctx.addIssue({ code: 'custom', path: ['targets', k], message: `${id} is named twice` });
      seen.add(id);
    });
  }
}).transform((clip): Clip => ({ ...clip, loopBeats: clip.loopBeats ?? clip.lengthBeats }));

const commandSchema = z.discriminatedUnion('type', [
  z.object({ id: idSchema, atBeat: beatSchema, type: z.literal('palette'), value: idSchema }).strict(),
  z.object({ id: idSchema, atBeat: beatSchema, type: z.literal('tempo'), value: z.number().min(BPM.min).max(BPM.max) }).strict(),
  z.object({ id: idSchema, atBeat: beatSchema, type: z.literal('brightness'), value: z.number().int().min(BYTE.min).max(BYTE.max) }).strict(),
  z.object({ id: idSchema, atBeat: beatSchema, type: z.literal('goto'), value: beatSchema }).strict(),
]);

/** One automation, in the units of what it moves: tempo 20–300, the master 0–255. Light DJ's period runs 1 to 512. */
function automationSchema({ min, max }: { min: number; max: number }) {
  const value = z.number().min(min).max(max);
  return z.object({
    mode: z.enum(['none', 'target', 'triangle', 'sawtooth', 'sine']),
    period: z.number().int().min(1).max(512),
    min: value,
    max: value,
    growing: z.boolean().default(true),
    target: value.optional(),
  }).strict().superRefine((a, ctx) => {
    if (a.min > a.max) ctx.addIssue({ code: 'custom', path: ['min'], message: 'is above max' });
    if (a.mode === 'target' && a.target === undefined) ctx.addIssue({ code: 'custom', path: ['target'], message: 'target mode needs a target' });
  }).nullable().default(null);
}

// Hue Dynamics' time signatures: 1 to 32 beats a bar, of a power of two from a whole note to a 32nd.
const timeSignatureSchema = z.object({
  beats: z.number().int().min(1).max(32),
  unit: z.number().int().refine((u) => [1, 2, 4, 8, 16, 32].includes(u), 'a power of two from 1 to 32'),
}).strict();

const loopSchema = z.object({ on: z.boolean(), startBeat: beatSchema, endBeat: beatSchema }).strict().superRefine((loop, ctx) => {
  if (!(loop.endBeat > loop.startBeat)) ctx.addIssue({ code: 'custom', path: ['endBeat'], message: 'ends after it starts' });
});

/** Ids that must be unique within one list. */
function unique(ctx: RefinementCtx, list: readonly { id: string }[], key: string): void {
  const seen = new Set<string>();
  list.forEach(({ id }, i) => {
    if (seen.has(id)) ctx.addIssue({ code: 'custom', path: [key, i, 'id'], message: `${id} is used twice` });
    seen.add(id);
  });
}

/** A sequence, saved or loaded. Fields left out take their defaults; arrangement is the default mode. */
export const sequenceSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(80),
  mode: z.enum(['arrangement', 'playlist']).default('arrangement'),
  bpm: z.number().min(BPM.min).max(BPM.max).nullable().default(null),
  timeSignature: timeSignatureSchema.default({ beats: 4, unit: 4 }),
  musicMode: z.enum(['off', 'tempo', 'reactive']).nullable().default(null),
  loop: loopSchema.nullable().default(null),
  snap: z.number().positive().default(1),
  lanes: z.array(laneSchema).default([]),
  clips: z.array(clipSchema).default([]),
  commands: z.array(commandSchema).default([]),
  automation: z.object({ tempo: automationSchema(BPM), brightness: automationSchema(BYTE) }).strict().default({ tempo: null, brightness: null }),
  options: z.object({
    autoplay: z.boolean().default(true),
    shuffle: z.boolean().default(false),
    randomPaletteOnLoop: z.boolean().default(false),
    initialPalette: idSchema.nullable().default(null),
  }).strict().default({ autoplay: true, shuffle: false, randomPaletteOnLoop: false, initialPalette: null }),
}).strict().superRefine((seq, ctx) => {
  unique(ctx, seq.lanes, 'lanes');
  unique(ctx, seq.clips, 'clips');
  unique(ctx, seq.commands, 'commands');
  if (seq.lanes.filter((l) => l.kind === 'shared').length > MAX_SHARED_LANES) {
    ctx.addIssue({ code: 'custom', path: ['lanes'], message: `at most ${MAX_SHARED_LANES} shared lanes` });
  }
  const tracks = new Set<number>();
  seq.lanes.forEach((lane, i) => {
    if (lane.kind !== 'track' || lane.fixtureId === undefined) return;
    if (tracks.has(lane.fixtureId)) ctx.addIssue({ code: 'custom', path: ['lanes', i, 'fixtureId'], message: `fixture ${lane.fixtureId} has a track already` });
    tracks.add(lane.fixtureId);
  });
  const lanes = new Set(seq.lanes.map((l) => l.id));
  seq.clips.forEach((clip, i) => {
    if (!lanes.has(clip.laneId)) ctx.addIssue({ code: 'custom', path: ['clips', i, 'laneId'], message: `no lane ${clip.laneId}` });
  });
  if (seq.mode === 'playlist') {
    // Light DJ's playlist: one lane of rows, each after the last. A sequence
    // that is not one stays as it is; nothing is dropped to make it fit.
    if (seq.lanes.length !== 1 || seq.lanes[0].kind !== 'shared') {
      ctx.addIssue({ code: 'custom', path: ['mode'], message: 'a playlist plays one shared lane' });
    }
    for (let i = 1; i < seq.clips.length; i++) {
      const before = seq.clips[i - 1];
      if (seq.clips[i].startBeat < before.startBeat + before.lengthBeats) {
        ctx.addIssue({ code: 'custom', path: ['clips', i], message: 'a playlist\'s rows run in order, one after another' });
      }
    }
  }
});

/** A sequence as it is kept, or a 400 saying what is wrong with it. */
export function validateSequence(raw: unknown): Sequence {
  return validate(sequenceSchema, raw, 'sequence') as Sequence;
}

/** What a clip's preset id plays: a validated spec, or null for none (or a pattern, which no clip can play). */
export type EffectResolver = (presetId: string) => EffectSpec | null;

/**
 * The clip table of a sequence: every clip's effect resolved, its fixtures
 * as ids. A shared lane's own targets are every fixture (null); a track's are
 * its fixture; explicit ids stay ids, and on a track only the track's
 * fixture among them counts. A fixture the patch does not have covers
 * nothing. A preset that resolves to no effect is refused.
 */
export function buildTable(seq: Sequence, resolve: EffectResolver, revision: number): SequenceTable {
  const lanes = new Map(seq.lanes.map((l) => [l.id, l]));
  const issues: z.ZodIssue[] = [];
  const clips = seq.clips.map((c, i): TableClip => {
    const spec = c.effect ?? resolve(c.presetId!);
    const own = spec && noOwnFlashes(spec);
    if (!spec) issues.push({ code: 'custom', path: ['clips', i, 'presetId'], message: `no effect ${c.presetId}`, input: c.presetId });
    else if (own) issues.push({ code: 'custom', path: ['clips', i, 'presetId'], message: own.message, input: c.presetId });
    const lane = lanes.get(c.laneId)!;
    let fixtureIds: number[] | null;
    if (lane.kind === 'track') fixtureIds = c.targets === 'lane' ? [lane.fixtureId!] : c.targets.filter((id) => id === lane.fixtureId);
    else fixtureIds = c.targets === 'lane' ? null : [...c.targets];
    return {
      id: c.id, laneId: c.laneId, fixtureIds, startBeat: c.startBeat, lengthBeats: c.lengthBeats, loopBeats: c.loopBeats,
      spec: spec!, seed: seedFrom(`clip:${seq.id}:${c.id}`), mute: c.mute,
    };
  });
  if (issues.length) throw new ValidationError(`sequence: ${issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`, issues);
  return { revision, lanes: seq.lanes.map((l) => ({ ...l })), clips };
}

// ── Automation ──────────────────────────────────────────────────────────────

/**
 * Light DJ's timer: where an automation stands `elapsed` into it (beats for
 * the master, seconds for the tempo), having started from `from`, the value
 * there when it began. Null for none.
 *
 * Target goes from `from` to its target in a straight line over one period,
 * then holds it. The cycles start from `from` (held inside min..max), up when
 * `growing`, down when not: the triangle's period is one leg, there and back
 * takes two; the sawtooth's and the sine's a whole cycle. The sawtooth's
 * wrap point belongs to the start of its next cycle.
 */
export function automationValue(a: Automation, from: number, elapsed: number): number | null {
  const t = Math.max(0, elapsed) / a.period;
  if (a.mode === 'none') return null;
  if (a.mode === 'target') {
    const target = a.target ?? from;
    return t >= 1 ? target : from + (target - from) * t;
  }
  const span = a.max - a.min;
  if (!(span > 0)) return a.min;
  const x = Math.max(0, Math.min(1, (from - a.min) / span));
  let v: number;
  if (a.mode === 'triangle') {
    const p = (((a.growing ? x : 2 - x) + t) % 2 + 2) % 2;
    v = p <= 1 ? p : 2 - p;
  } else if (a.mode === 'sawtooth') {
    v = (((a.growing ? x + t : x - t) % 1) + 1) % 1;
  } else {
    const start = Math.acos(2 * x - 1);
    v = (1 + Math.cos((a.growing ? 2 * Math.PI - start : start) + 2 * Math.PI * t)) / 2;
  }
  return a.min + v * span;
}

/** What the sequence changes on the rig, applied as one patch a frame: the palette override (hex), the tempo, the master. */
export interface SequencePatch { paletteOverride?: string[]; bpm?: number; masterDimmer?: number }

// One automation playing: its settings, the value it started from, and how
// far it has come (beats for the master, counted frame by frame so a tempo
// change keeps its phase; the wall clock for the tempo).
interface AutomationRun { a: Automation; from: number | null; beats: number; seen: number; startMs: number | null; done: boolean }

// ── The transport ───────────────────────────────────────────────────────────

/**
 * The most a frame does: commands run, times round a loop and playlist rows
 * moved on, together. Past it the sequence stops where it got to and says so,
 * rather than catching up without end; play carries on from there.
 */
export const MAX_FRAME_OPERATIONS = 4096;

/** Why a sequence stopped by itself. */
export interface SequenceError { code: 'traversal-limit' | 'goto-cycle'; message: string; beat: number }

type RunMode = 'idle' | 'playing' | 'paused' | 'stopped';

// Where the sequence stands in its own beats: the position, the traversal
// (times its loop came round), and the next command to run (sorted order),
// which tells a command on this very beat already run from one still due.
interface Cursor { pos: number; traversal: number; next: number }

// The music's beat the sequence stood at `startPosition` on, the loop in
// force from there (the playlist row repeating, or the sequence's own), and
// how far the walk has come since, in beats.
interface Anchor { startBeat: number; startPosition: number; traversal: number; loop: SequenceLoop | null; rowLoop: boolean; walked: number }

type Op =
  | { type: 'start'; real: boolean }
  | { type: 'resume' }
  | { type: 'pause' }
  | { type: 'stop'; mode: 'hold' | 'black' }
  | { type: 'seek'; to: (pos: number) => number | null }
  | { type: 'loop' };

/** A sorted command, with its place in the saved list for ties. */
type Sorted = Command & { order: number };

export interface SequencerOptions {
  /** A clip's preset by id (the effect library's resolve). */
  resolve: EffectResolver;
  /** A palette by id as the colours it puts on now (hex), or null for none. Built-in palettes when left out. */
  palette?: (id: string) => string[] | null;
  /** Put on what the sequence changes: the main thread's patch, from the sequence (never as a hand on a control). */
  apply?: (patch: SequencePatch) => void;
  /** The master and tempo on the rig now, which an automation starts from. */
  current?: () => { masterDimmer: number; bpm: number };
  /** Set the audio mode a sequence asks for when it starts. */
  musicMode?: (mode: AudioMode) => void;
  /** Throws (409) for an effect that may not play yet: the photosensitivity gate. */
  admit?: (spec: EffectSpec) => void;
  /** The wall clock for the tempo's automation, in milliseconds (monotonic). */
  now?: () => number;
  /** Where shuffle and the random palettes draw from; fresh each session unless given. */
  seed?: Seed;
}

const EPS = 1e-9;

function builtinPalette(id: string): string[] | null {
  const p = BUILTIN_PALETTES.find((b) => b.id === id);
  return p ? resolvePalette({ palette: [...p.colours] }, null, [], seedFrom(`palette:${id}`), 0).map(toHex) : null;
}

export class Sequencer {
  declare _resolve: EffectResolver;
  declare _paletteOf: (id: string) => string[] | null;
  declare _apply: (patch: SequencePatch) => void;
  declare _current: () => { masterDimmer: number; bpm: number };
  declare _musicMode: (mode: AudioMode) => void;
  declare _admit: (spec: EffectSpec) => void;
  declare _now: () => number;
  declare _rng: { seed: Seed; iter: number };
  declare _loaded: Sequence | null;
  declare _key: string | null;
  declare _table: SequenceTable | null;
  declare _revision: number;
  declare _commands: Sorted[];
  // What was asked for, at once (play twice is play once); and what the
  // frames have made of it, which waits for the next frame's beat.
  declare _mode: RunMode;
  // The stop asked for (hold or black), shown before the frame takes it up.
  declare _asked: 'hold' | 'black' | null;
  declare _run: RunMode;
  declare _ops: Op[];
  declare _generation: number;
  declare _anchor: Anchor | null;
  declare _cursor: Cursor;
  declare _hold: SequenceTransport['hold'];
  declare _stop: SequenceTransport['stop'];
  declare _error: SequenceError | null;
  declare _spent: number;
  declare _gotos: Map<string, number>;
  declare _patch: SequencePatch;
  declare _palette: string | null;
  declare _automation: { brightness: AutomationRun | null; tempo: AutomationRun | null };
  declare _last: MusicalTime | null;
  declare _transport: SequenceTransport | null;

  constructor({ resolve, palette = builtinPalette, apply = () => {}, current = () => ({ masterDimmer: 255, bpm: 120 }),
    musicMode = () => {}, admit = (spec) => safety.requireAcknowledged(spec), now = () => performance.now(), seed }: SequencerOptions) {
    this._resolve = resolve;
    this._paletteOf = palette;
    this._apply = apply;
    this._current = current;
    this._musicMode = musicMode;
    this._admit = admit;
    this._now = now;
    this._rng = { seed: seed ? [...seed] as Seed : freshSeed(), iter: 0 };
    this._loaded = null;
    this._key = null;
    this._table = null;
    this._revision = 0;
    this._commands = [];
    this._release();
    this._last = null;
    this._spent = 0;
    this._gotos = new Map();
    this._patch = {};
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  /**
   * Load a sequence for the transport: validated, every preset and palette
   * resolved, then its table published under a new revision. Refused (400),
   * the sequence loaded before stays. The same sequence resolving to the same
   * effects again is no change; a preset edited in the library since is.
   * Loading plays nothing, arms nothing and launches no voice.
   *
   * An edit of the sequence playing (the same id) plays on from where it is,
   * its unchanged clips undisturbed; one holding an effect the room has not
   * acknowledged is refused (409) while it plays. Another sequence stops the
   * one playing and lets its held picture go.
   */
  load(raw: unknown): Sequence {
    const seq = validateSequence(raw);
    const table = buildTable(seq, this._resolve, this._revision + 1);
    this._checkPalettes(seq);
    const key = canonical([seq, table.clips.map((c) => c.spec)]);
    if (key === this._key) return structuredClone(this._loaded!);
    const same = this._loaded?.id === seq.id;
    if (same && (this._mode === 'playing' || this._mode === 'paused')) for (const c of table.clips) this._admit(c.spec);
    const before = this._loaded;
    this._revision++;
    this._loaded = deepFreeze(seq);
    this._key = key;
    this._table = deepFreeze({ ...table, revision: this._revision });
    this._commands = sortCommands(seq.commands);
    if (!same) this._release();
    else this._edited(before!);
    return structuredClone(this._loaded!);
  }

  /** Nothing loaded: the table goes, under a new revision, and the transport with it. */
  unload(): void {
    if (!this._loaded) return;
    this._loaded = null;
    this._key = null;
    this._table = null;
    this._commands = [];
    this._revision++;
    this._release();
  }

  /** The loaded sequence as a copy, or null. */
  current(): Sequence | null {
    return this._loaded ? structuredClone(this._loaded) : null;
  }

  /** The loaded sequence's clip table, frozen; the same object until the sequence changes. */
  table(): SequenceTable | null {
    return this._table;
  }

  /** Moves with every change of the loaded sequence, never with time. */
  revision(): number {
    return this._revision;
  }

  // Every palette a command or the start names is known, as every preset is.
  _checkPalettes(seq: Sequence): void {
    const issues: z.ZodIssue[] = [];
    seq.commands.forEach((c, i) => {
      if (c.type === 'palette' && !this._paletteOf(c.value)) issues.push({ code: 'custom', path: ['commands', i, 'value'], message: `no palette ${c.value}`, input: c.value });
    });
    const first = seq.options.initialPalette;
    if (first !== null && !this._paletteOf(first)) issues.push({ code: 'custom', path: ['options', 'initialPalette'], message: `no palette ${first}`, input: first });
    if (issues.length) throw new ValidationError(`sequence: ${issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`, issues);
  }

  // Back to nothing playing: no transport, no held picture, no automation.
  _release(): void {
    this._mode = 'idle';
    this._asked = null;
    this._run = 'idle';
    this._ops = [];
    this._generation = 0;
    this._anchor = null;
    this._cursor = { pos: 0, traversal: 0, next: 0 };
    this._hold = null;
    this._stop = null;
    this._error = null;
    this._palette = null;
    this._automation = { brightness: null, tempo: null };
    this._transport = null;
  }

  // The sequence playing was edited: its commands may sit elsewhere now, a
  // playlist row may repeat or not, an automation may be new.
  _edited(before: Sequence): void {
    // What is behind the position has run; what is ahead may have moved.
    this._cursor.next = this._firstFrom(this._cursor.pos, this._run !== 'playing');
    if (this._anchor) this._ops.push({ type: 'loop' });
    const seq = this._loaded!;
    for (const which of ['brightness', 'tempo'] as const) {
      if (canonical(seq.automation[which]) !== canonical(before.automation[which]) && this._automation[which]) {
        this._automation[which] = newAutomation(seq.automation[which]);
      }
    }
  }

  // ── The transport's controls ──────────────────────────────────────────────
  // Each takes effect at the next frame, on that frame's beat (Light DJ's
  // player waits for its next tick too); play, pause and stop are answered at
  // once, so a second press finds the first already taken.

  /**
   * Play: from the top (or where a seek put it) after a stop, on from the
   * held beat after a pause, nothing more while playing. Refused (409) while
   * a clip needs the photosensitivity acknowledgement. A real start puts on
   * the sequence's tempo, audio mode and first palette and starts its
   * automation; resuming does none of that.
   */
  play(): void {
    const table = this._requireLoaded();
    for (const c of table.clips) this._admit(c.spec);
    if (this._mode === 'playing') return;
    if (this._mode === 'paused') {
      this._mode = 'playing';
      this._ops.push({ type: 'resume' });
      return;
    }
    // After a stop the transport counted out by its traversal limit, play carries
    // on where it stopped; a stop asked for since (it starts from the top) is a real start again.
    const real = !this._error || this._ops.some((op) => op.type === 'stop');
    if (real) this._startSettings();
    this._mode = 'playing';
    this._asked = null;
    this._ops.push({ type: 'start', real });
  }

  /** Pause: the clips on top stay, playing their own laps on; the transport, its commands and its selection wait. */
  pause(): void {
    this._requireLoaded();
    if (this._mode !== 'playing') return;
    this._mode = 'paused';
    this._ops.push({ type: 'pause' });
  }

  /**
   * Stop: the sequence's picture holds under the voices and the masters, or
   * (`blackout`) its base is black on every fixture. The automation ends;
   * the next play starts from the top, even after a stop the sequence made
   * itself. A new load lets the picture go.
   */
  stop({ blackout = false }: { blackout?: boolean } = {}): void {
    this._requireLoaded();
    const mode = blackout ? 'black' : 'hold';
    if (this._mode === 'idle' && !blackout) return;
    // Stopped by its own error, a stop by hand still lets go of where it stopped.
    if (this._mode === 'stopped' && !this._error && (this._asked === mode || !blackout)) return;
    this._mode = 'stopped';
    this._asked = mode;
    this._ops.push({ type: 'stop', mode });
    if (this._run !== 'playing' && this._run !== 'paused') this._applyQueued(null);
  }

  /** To a beat of the sequence: every clip starts again there; the commands on that beat run, none before it. */
  seek(beat: number): void {
    this._requireLoaded();
    if (typeof beat !== 'number' || !Number.isFinite(beat) || beat < 0) throw new HttpError(400, 'seek: a beat from 0 on');
    this._move(() => beat);
  }

  /** The next row of a playlist (round to the first after the last), or an arrangement's next clip start. */
  next(): void {
    this._requireLoaded();
    this._move((pos) => this._neighbour(pos, 1));
  }

  /** The row before (round to the last), or the clip start before the one the arrangement is in (else its top). */
  prev(): void {
    this._requireLoaded();
    this._move((pos) => this._neighbour(pos, -1));
  }

  /** Another row (or clip start) at random, never the one playing; with nothing else, nothing moves. */
  shuffle(): void {
    this._requireLoaded();
    this._move((pos) => this._shuffled(pos));
  }

  /** To a clip's start (404 for one the sequence has not got). */
  jump(clipId: string): void {
    const seq = this._requireLoaded() && this._loaded!;
    const target = seq.clips.find((c) => c.id === clipId);
    if (!target) throw new HttpError(404, 'No such clip in the loaded sequence');
    this._move(() => target.startBeat);
  }

  /** Hue Dynamics' resync: the nearest beat of the time signature, or the bar's start, is now. */
  resync(boundary: 'beat' | 'bar'): void {
    this._requireLoaded();
    if (boundary !== 'beat' && boundary !== 'bar') throw new HttpError(400, 'resync: beat or bar');
    const ts = this._loaded!.timeSignature;
    this._move((pos) => resyncPosition(pos, ts, boundary));
  }

  /** The loop region, kept on the loaded sequence (not the shelf); the position carries on under it. */
  setLoop(raw: unknown): SequenceLoop | null {
    this._requireLoaded();
    const loop = validate(loopSchema.nullable(), raw ?? null, 'loop') as SequenceLoop | null;
    const seq = { ...this._loaded!, loop };
    this._loaded = deepFreeze(seq);
    this._key = canonical([seq, this._table!.clips.map((c) => c.spec)]);
    if (this._anchor || this._ops.length) this._ops.push({ type: 'loop' });
    return loop;
  }

  /** The tempo by hand, from the sequence's controls: its automation ends, as for any hand on the tempo. */
  setTempo(bpm: number): void {
    if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm < BPM.min || bpm > BPM.max) throw new HttpError(400, `tempo: ${BPM.min} to ${BPM.max} BPM`);
    this._automation.tempo = null;
    this._apply({ bpm });
  }

  /** A hand on the master or the tempo: the automation of that one ends; the sequence's own samples never come here. */
  handEdit({ masterDimmer = false, bpm = false }: { masterDimmer?: boolean; bpm?: boolean }): void {
    if (masterDimmer) this._automation.brightness = null;
    if (bpm) this._automation.tempo = null;
  }

  _requireLoaded(): SequenceTable {
    if (!this._table) throw new HttpError(409, 'No sequence loaded');
    return this._table;
  }

  // A move of the position: at the next frame while the transport runs,
  // now while it stands (where the next play starts).
  _move(to: (pos: number) => number | null): void {
    this._ops.push({ type: 'seek', to });
    if (this._run !== 'playing' && this._run !== 'paused') this._applyQueued(null);
  }

  // What a real start puts on: the sequence's tempo, audio mode and first palette.
  _startSettings(): void {
    const seq = this._loaded!;
    if (seq.options.initialPalette !== null) {
      const colours = this._paletteOf(seq.options.initialPalette);
      if (colours) {
        this._palette = seq.options.initialPalette;
        this._apply({ paletteOverride: colours });
      }
    }
    if (seq.bpm !== null) this._apply({ bpm: seq.bpm });
    if (seq.musicMode !== null) this._musicMode(seq.musicMode);
  }

  // ── Rows and boundaries ───────────────────────────────────────────────────

  // A playlist's rows, in order; an arrangement's distinct clip starts.
  _rows(): Clip[] {
    return this._loaded?.mode === 'playlist' ? this._loaded.clips : [];
  }

  _rowAt(pos: number): number {
    return this._rows().findIndex((r) => pos >= r.startBeat - EPS && pos < r.startBeat + r.lengthBeats - EPS);
  }

  _starts(): number[] {
    return [...new Set(this._loaded!.clips.map((c) => c.startBeat))].sort((a, b) => a - b);
  }

  _neighbour(pos: number, step: 1 | -1): number | null {
    const rows = this._rows();
    if (this._loaded!.mode === 'playlist') {
      if (!rows.length) return null;
      const at = this._rowAt(pos);
      let i: number;
      if (at >= 0) i = (at + step + rows.length) % rows.length;
      else if (step > 0) i = Math.max(0, rows.findIndex((r) => r.startBeat > pos));
      else i = rows.reduce((found, r, k) => (r.startBeat < pos ? k : found), rows.length - 1);
      return rows[i].startBeat;
    }
    const starts = this._starts();
    if (step > 0) return starts.find((b) => b > pos + EPS) ?? null;
    const current = [...starts].reverse().find((b) => b <= pos + EPS);
    if (current === undefined) return 0;
    return [...starts].reverse().find((b) => b < current - EPS) ?? 0;
  }

  _shuffled(pos: number, row = this._rowAt(pos)): number | null {
    let options: number[];
    if (this._loaded!.mode === 'playlist') {
      const at = row;
      options = this._rows().filter((r, k) => k !== at && !r.mute).map((r) => r.startBeat);
    } else {
      const starts = this._starts();
      const current = [...starts].reverse().find((b) => b <= pos + EPS);
      options = starts.filter((b) => b !== current);
    }
    if (!options.length) return null;
    return options[Math.floor(hash01(this._rng.seed, SHUFFLE_KEY, this._rng.iter++) * options.length) % options.length];
  }

  // The loop in force at a position: with autoplay off a playlist's row
  // repeats, else the sequence's own loop region.
  _loopAt(pos: number): { loop: SequenceLoop | null; rowLoop: boolean } {
    const seq = this._loaded!;
    if (seq.mode === 'playlist' && !seq.options.autoplay) {
      const at = this._rowAt(pos);
      if (at >= 0) {
        const row = seq.clips[at];
        return { loop: { on: true, startBeat: row.startBeat, endBeat: row.startBeat + row.lengthBeats }, rowLoop: true };
      }
    }
    return { loop: seq.loop, rowLoop: false };
  }

  /** The first command at `pos` or after (`inclusive`), or after it. */
  _firstFrom(pos: number, inclusive: boolean): number {
    const cmds = this._commands;
    let lo = 0, hi = cmds.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (inclusive ? cmds[mid].atBeat < pos : cmds[mid].atBeat <= pos) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // ── Frames ────────────────────────────────────────────────────────────────

  /**
   * What the engine renders this frame: the table and, while the sequence
   * plays, is paused or stopped, its transport. The main thread alone runs
   * this, once a frame: the commands the sequence passed since the last
   * frame, the controls asked for since, the automation's samples.
   */
  frame(reading: MusicalTime): SequenceFrame {
    this._spent = 0;
    this._gotos = new Map();
    this._patch = {};
    if (!this._table) {
      this._last = reading;
      return { table: null, transport: null };
    }
    const last = this._last;
    const jumped = !!last && reading.epoch !== last.epoch;
    if (jumped) this._rebaseJump(reading, last!);
    if (this._run === 'playing' && this._anchor) this._walk(reading.beatPos - this._anchor.startBeat);
    this._applyQueued(reading);
    this._sampleAutomation(reading, jumped ? null : last);
    this._flush();
    this._last = reading;
    this._transport = this._transportNow(reading);
    return { table: this._table, transport: this._transport };
  }

  // The music's clock jumped (a seek in the track, a new song): the sequence
  // stays where it was and counts on from the new beat.
  _rebaseJump(reading: MusicalTime, last: MusicalTime): void {
    if (this._anchor) {
      this._anchor = { ...this._anchor, startBeat: reading.beatPos, startPosition: this._cursor.pos, traversal: this._cursor.traversal, walked: 0 };
    }
    if (this._hold) this._hold = { ...this._hold, beat: reading.beatPos - Math.max(0, last.beatPos - this._hold.beat) };
  }

  _anchorAt(beat: number, pos: number, traversal: number): void {
    const { loop, rowLoop } = this._loopAt(pos);
    this._anchor = { startBeat: beat, startPosition: pos, traversal, loop, rowLoop, walked: 0 };
  }

  // The controls asked for since the last frame, in order, on this frame's
  // beat. Without a beat (the transport stands) they go as far as the first
  // that needs one, which waits for the next frame with all after it.
  _applyQueued(reading: MusicalTime | null): void {
    while (this._ops.length) {
      const op = this._ops[0];
      const running = this._run === 'playing' || this._run === 'paused';
      if (!reading && (op.type === 'start' || op.type === 'resume' || op.type === 'pause' || running)) return;
      this._ops.shift();
      this._applyOp(op, reading);
    }
  }

  _applyOp(op: Op, reading: MusicalTime | null): void {
    switch (op.type) {
      case 'start': {
        if (op.real) {
          this._generation++;
          this._cursor = { pos: this._cursor.pos, traversal: 0, next: this._firstFrom(this._cursor.pos, true) };
          this._automation = { brightness: newAutomation(this._loaded!.automation.brightness), tempo: newAutomation(this._loaded!.automation.tempo) };
        }
        this._error = null;
        this._stop = null;
        this._hold = null;
        this._run = 'playing';
        this._anchorAt(reading!.beatPos, this._cursor.pos, this._cursor.traversal);
        this._walk(0);
        return;
      }
      case 'resume': {
        if (this._run !== 'paused') return;
        const hold = this._hold!;
        this._hold = null;
        this._run = 'playing';
        this._anchorAt(reading!.beatPos, hold.position, hold.traversal);
        this._walk(0);
        return;
      }
      case 'pause': {
        if (this._run !== 'playing') return;
        this._run = 'paused';
        this._hold = { position: this._cursor.pos, traversal: this._cursor.traversal, beat: reading!.beatPos };
        this._anchor = null;
        return;
      }
      case 'stop': {
        // A hold with nothing played to hold, or over black, leaves it as it was.
        if (op.mode === 'hold' && (this._run === 'idle' || (this._run === 'stopped' && this._stop?.mode === 'black'))) return;
        const paused = this._run === 'paused';
        this._stop = { mode: op.mode, position: paused ? this._hold!.position : this._cursor.pos, traversal: paused ? this._hold!.traversal : this._cursor.traversal };
        this._run = 'stopped';
        this._hold = null;
        this._anchor = null;
        this._error = null;
        this._automation = { brightness: null, tempo: null };
        this._cursor = { pos: 0, traversal: 0, next: 0 };
        return;
      }
      case 'seek': {
        const from = this._run === 'paused' ? this._hold!.position : this._cursor.pos;
        const to = op.to(from);
        if (to === null) return;
        this._error = null;
        // Its own beat's commands are still to run: now while playing, on resuming while paused.
        this._cursor = { pos: to, traversal: 0, next: this._firstFrom(to, true) };
        if (this._run === 'playing') {
          this._generation++;
          this._anchorAt(reading!.beatPos, to, 0);
          this._walk(0);
        } else if (this._run === 'paused') {
          this._generation++;
          this._hold = { position: to, traversal: 0, beat: reading!.beatPos };
        }
        return;
      }
      case 'loop': {
        if (this._run === 'playing' && this._anchor) this._anchorAt(reading!.beatPos, this._cursor.pos, this._cursor.traversal);
        return;
      }
    }
  }

  // ── The walk ──────────────────────────────────────────────────────────────

  /** One more operation of the frame's budget; false, and the sequence stops, when it is spent. */
  _spend(): boolean {
    if (this._spent >= MAX_FRAME_OPERATIONS) {
      this._halt('traversal-limit', `more than ${MAX_FRAME_OPERATIONS} commands, loop wraps and row changes fell due in one frame`);
      return false;
    }
    this._spent++;
    return true;
  }

  // Stopped by the sequence itself: the picture holds where it got to, and
  // the cursor stays on the next thing undone, for play to carry on from.
  _halt(code: SequenceError['code'], message: string): void {
    const c = this._cursor;
    this._error = { code, message, beat: c.pos };
    this._stop = { mode: 'hold', position: c.pos, traversal: c.traversal };
    this._run = 'stopped';
    this._mode = 'stopped';
    this._asked = 'hold';
    this._anchor = null;
    this._hold = null;
    this._automation = { brightness: null, tempo: null };
  }

  /**
   * Walk the sequence from where it is to `beats` past the anchor's beat:
   * the commands on the way run once each, in beat and list order (a loop's
   * end is never reached, its start is); a goto jumps and carries on from
   * its destination; a playlist moves its rows on. Returns false when the
   * walk stopped the sequence.
   */
  _walk(beats: number): boolean {
    const seq = this._loaded!;
    const rows = this._rows();
    const playlist = seq.mode === 'playlist';
    let target = beats;
    for (;;) {
      const a = this._anchor!;
      const c = this._cursor;
      const travel = Math.max(0, target - a.walked);
      const loop = a.loop;
      const wraps = !!loop && loop.on && loop.endBeat - loop.startBeat > 0 && c.pos < loop.endBeat - EPS;
      let end = c.pos + travel;
      // What the way meets first: the loop's end, a row's end or start, else nothing.
      let event: 'wrap' | 'shuffle' | 'enter' | 'advance' | null = null;
      let leaving = -1;
      if (wraps && end >= loop.endBeat - EPS) { end = loop.endBeat; event = 'wrap'; }
      if (playlist && !a.rowLoop) {
        const row = this._rowAt(c.pos);
        if (row >= 0) {
          const rowEnd = rows[row].startBeat + rows[row].lengthBeats;
          if (rowEnd <= end + EPS && (event === null || rowEnd < end - EPS || seq.options.shuffle)) {
            end = rowEnd;
            event = seq.options.shuffle ? 'shuffle' : 'advance';
            leaving = row;
          }
        } else if (!seq.options.autoplay) {
          const nextRow = rows.find((r) => r.startBeat > c.pos);
          if (nextRow && nextRow.startBeat <= end + EPS && (event === null || nextRow.startBeat < end - EPS)) { end = nextRow.startBeat; event = 'enter'; }
        }
      }
      // The commands up to there: past an end that is never reached (a wrap,
      // a shuffled row's end) only those before it.
      const exclusive = event === 'wrap' || event === 'shuffle';
      const cmds = this._commands;
      while (c.next < cmds.length && (exclusive ? cmds[c.next].atBeat < end - EPS : cmds[c.next].atBeat <= end + EPS)) {
        const cmd = cmds[c.next];
        if (cmd.atBeat < c.pos - EPS) { c.next++; continue; }
        const at = a.walked + (cmd.atBeat - c.pos);
        const left = target - at;
        // Back at a goto already taken with no beat gone by: a loop with no way out.
        if (cmd.type === 'goto' && this._gotos.get(cmd.id) === left) {
          c.pos = cmd.atBeat;
          this._halt('goto-cycle', `the goto ${cmd.id} at beat ${cmd.atBeat} comes back to itself with no beat in between`);
          return false;
        }
        // Stopped on its beat, it is the next thing to do.
        const was = c.pos;
        c.pos = cmd.atBeat;
        if (!this._spend()) return false;
        c.pos = was;
        if (cmd.type === 'goto') {
          this._gotos.set(cmd.id, left);
          this._generation++;
          this._cursor = { pos: cmd.value, traversal: 0, next: this._firstFrom(cmd.value, true) };
          this._anchorAt(a.startBeat + at, cmd.value, 0);
          target = left;
          break;
        }
        c.next++;
        this._command(cmd);
      }
      if (this._anchor !== a) continue;
      // Stopped short of a wrap or a row's end, the walk meets it again from here.
      if (event !== null && !this._spend()) return false;
      a.walked += end - c.pos;
      c.pos = end;
      if (event === null) {
        // A clock that stepped back a hair moves nothing back: the walk waits for it.
        a.walked = Math.max(a.walked, target);
        return true;
      }
      if (event === 'wrap') {
        c.pos = loop!.startBeat;
        c.traversal++;
        c.next = this._firstFrom(c.pos, true);
        if (!a.rowLoop && seq.options.randomPaletteOnLoop) this._randomPalette();
      } else if (event === 'shuffle') {
        // With no other row to go to, the row plays again.
        const to = this._shuffled(c.pos, leaving) ?? rows[leaving].startBeat;
        const at = a.walked;
        this._generation++;
        this._cursor = { pos: to, traversal: 0, next: this._firstFrom(to, true) };
        this._anchorAt(a.startBeat + at, to, 0);
        target -= at;
      } else if (event === 'enter') {
        const at = a.walked;
        this._anchorAt(a.startBeat + at, c.pos, c.traversal);
        target -= at;
      }
    }
  }

  // A command row: a palette, a tempo or a master level goes into this
  // frame's patch, and replaces the automation of the same.
  _command(cmd: Sorted): void {
    if (cmd.type === 'palette') {
      const colours = this._paletteOf(cmd.value);
      if (!colours) return;
      this._palette = cmd.value;
      this._patch.paletteOverride = colours;
    } else if (cmd.type === 'tempo') {
      this._automation.tempo = null;
      this._patch.bpm = cmd.value;
    } else if (cmd.type === 'brightness') {
      this._automation.brightness = null;
      this._patch.masterDimmer = cmd.value;
    }
  }

  // Light DJ's random palette on loop: another built-in palette, never the one on.
  _randomPalette(): void {
    const ids = BUILTIN_PALETTES.map((p) => p.id);
    const now = this._palette === null ? null : ids.indexOf(this._palette);
    const id = ids[pickNotLast(this._rng.seed, this._rng.iter++, ids.length, now, PALETTE_KEY)];
    const colours = this._paletteOf(id);
    if (!colours) return;
    this._palette = id;
    this._patch.paletteOverride = colours;
  }

  // ── Automation and what goes on ───────────────────────────────────────────

  _sampleAutomation(reading: MusicalTime, last: MusicalTime | null): void {
    if (this._run !== 'playing' && this._run !== 'paused') return;
    const live = this._current();
    const b = this._automation.brightness;
    if (b && !b.done) {
      // Beats the music has moved on past the furthest counted: a clock that
      // steps back a hair and on again is not counted twice, nor a jump.
      if (b.from === null || !last) {
        b.from ??= live.masterDimmer;
        b.seen = reading.beatPos;
      } else {
        b.beats += Math.max(0, reading.beatPos - b.seen);
        b.seen = Math.max(b.seen, reading.beatPos);
      }
      const v = automationValue(b.a, b.from, b.beats);
      if (v !== null) {
        const out = Math.max(0, Math.min(255, Math.round(v)));
        if (this._patch.masterDimmer === undefined) this._patch.masterDimmer = out;
        if (b.a.mode === 'target' && b.beats >= b.a.period) b.done = true;
      }
    }
    const t = this._automation.tempo;
    if (t && !t.done) {
      const now = this._now();
      if (t.from === null) { t.from = live.bpm; t.startMs = now; }
      const seconds = (now - t.startMs!) / 1000;
      const v = automationValue(t.a, t.from, seconds);
      if (v !== null) {
        const out = Math.round(Math.max(BPM.min, Math.min(BPM.max, v)) * 100) / 100;
        if (this._patch.bpm === undefined) this._patch.bpm = out;
        if (t.a.mode === 'target' && seconds >= t.a.period) t.done = true;
      }
    }
  }

  // One patch for the frame, of what changed.
  _flush(): void {
    const patch = { ...this._patch };
    const live = this._current();
    if (patch.masterDimmer === live.masterDimmer) delete patch.masterDimmer;
    if (patch.bpm === live.bpm) delete patch.bpm;
    if (Object.keys(patch).length) this._apply(patch);
  }

  _transportNow(reading: MusicalTime): SequenceTransport | null {
    const generation = this._generation;
    if (this._run === 'playing' && this._anchor) {
      const a = this._anchor;
      return { startBeat: a.startBeat, startPosition: a.startPosition, traversal: a.traversal, loop: a.loop, generation };
    }
    if (this._run === 'paused' && this._hold) return { startBeat: this._hold.beat, loop: null, generation, hold: { ...this._hold } };
    if (this._run === 'stopped' && this._stop) return { startBeat: reading.beatPos, loop: null, generation, stop: { ...this._stop } };
    return null;
  }

  // ── What the rest of the server reads ─────────────────────────────────────

  /**
   * The clips playing on top of `fixtureIds` at the last frame, highest
   * first, for the audio detectors: pure, from the transport that frame
   * handed out.
   */
  playing(fixtureIds: readonly number[]): { id: string; spec: EffectSpec }[] {
    if (!this._table || !this._transport || !this._last) return [];
    return playingClips(this._table, this._transport, this._last.beatPos, fixtureIds);
  }

  /** Where the transport stands: the beat of the sequence, its bar (from 1), the loop, and the clip on top of each lane. */
  status(): SequenceStatus {
    const seq = this._loaded;
    const where = this._run === 'paused' && this._hold ? this._hold.position
      : this._run === 'stopped' && this._stop ? this._stop.position : this._cursor.pos;
    const beat = Math.round(where * 1e6) / 1e6;
    const bar = seq ? Math.floor(beat / barBeats(seq.timeSignature) + EPS) + 1 : 1;
    const shows = this._run === 'playing' || this._run === 'paused';
    const tops = shows && seq ? this._laneTops(where) : new Map<string, string>();
    return {
      loaded: seq ? { id: seq.id, name: seq.name } : null,
      revision: this._revision,
      mode: seq ? seq.mode : null,
      playing: this._mode === 'playing',
      paused: this._mode === 'paused',
      stopped: this._mode === 'stopped' ? this._asked : null,
      beat,
      bar,
      loop: seq?.loop ? { ...seq.loop } : null,
      lanes: seq ? seq.lanes.map((l) => ({ id: l.id, clip: tops.get(l.id) ?? null })) : [],
      error: this._error ? { ...this._error } : null,
    };
  }

  // Per lane, the clip on top of it at a position (a later start, then later in the list).
  _laneTops(position: number): Map<string, string> {
    const table = this._table!;
    const { active } = selectClips(table, position, []);
    const tops = new Map<string, { id: string; start: number; index: number }>();
    for (const a of active) {
      const c = table.clips[a.index];
      const held = tops.get(c.laneId);
      if (!held || c.startBeat > held.start || (c.startBeat === held.start && a.index > held.index)) tops.set(c.laneId, { id: c.id, start: c.startBeat, index: a.index });
    }
    return new Map([...tops].map(([lane, t]) => [lane, t.id]));
  }
}

// Independent random streams of the session seed.
const SHUFFLE_KEY = 31;
const PALETTE_KEY = 37;

function freshSeed(): Seed {
  const bytes = crypto.randomBytes(16);
  return [bytes.readUInt32LE(0), bytes.readUInt32LE(4), bytes.readUInt32LE(8), bytes.readUInt32LE(12)];
}

function newAutomation(a: Automation | null): AutomationRun | null {
  return a && a.mode !== 'none' ? { a, from: null, beats: 0, seen: 0, startMs: null, done: false } : null;
}

function sortCommands(commands: readonly Command[]): Sorted[] {
  return commands.map((c, order) => ({ ...c, order })).sort((a, b) => a.atBeat - b.atBeat || a.order - b.order);
}
