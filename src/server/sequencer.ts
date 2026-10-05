import { z, ZodError } from 'zod';

// The entry point registers every kind, so a clip's effect validates against it.
import { deepFreeze } from '../shared/effects/index.ts';
import { pacesOwnFlashes, validateSpec } from '../shared/effects/registry.ts';
import { canonical } from '../shared/effects/layer.ts';
import { seedFrom } from '../shared/effects/hash.ts';
import { validate, ValidationError } from './validation.ts';
import type { RefinementCtx } from 'zod';
import type { MusicalTime } from './conductor.ts';
import type { AudioMode, EffectSpec } from '../shared/effects/types.ts';
import type { SequenceLane, SequenceTable, SequenceTransport, TableClip } from '../shared/effects/sequence.ts';

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
  options: { autoplay: boolean; shuffle: boolean; randomPaletteOnLoop: boolean; initialPalette: string | null };
}

/** What the engine takes from the sequencer each frame: the table, and where it plays (null: it does not). */
export interface SequenceFrame { table: SequenceTable | null; transport: SequenceTransport | null }

/** The sequencer as the live state carries it. */
export interface SequenceStatus {
  loaded: { id: string; name: string } | null;
  revision: number;
  mode: Sequence['mode'] | null;
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

export interface SequencerOptions {
  /** A clip's preset by id (the effect library's resolve). */
  resolve: EffectResolver;
}

export class Sequencer {
  declare _resolve: EffectResolver;
  declare _loaded: Sequence | null;
  declare _key: string | null;
  declare _table: SequenceTable | null;
  declare _revision: number;

  constructor({ resolve }: SequencerOptions) {
    this._resolve = resolve;
    this._loaded = null;
    this._key = null;
    this._table = null;
    this._revision = 0;
  }

  /**
   * Load a sequence for the transport: validated, every preset resolved,
   * then its table published under a new revision. Refused (400), the
   * sequence loaded before stays. The same sequence resolving to the same
   * effects again is no change; a preset edited in the library since is.
   * Loading plays nothing, arms nothing and launches no voice.
   */
  load(raw: unknown): Sequence {
    const seq = validateSequence(raw);
    const table = buildTable(seq, this._resolve, this._revision + 1);
    const key = canonical([seq, table.clips.map((c) => c.spec)]);
    if (key !== this._key) {
      this._revision++;
      this._loaded = deepFreeze(seq);
      this._key = key;
      this._table = deepFreeze(table);
    }
    return structuredClone(this._loaded!);
  }

  /** Nothing loaded: the table goes, under a new revision. */
  unload(): void {
    if (!this._loaded) return;
    this._loaded = null;
    this._key = null;
    this._table = null;
    this._revision++;
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

  status(): SequenceStatus {
    const seq = this._loaded;
    return { loaded: seq ? { id: seq.id, name: seq.name } : null, revision: this._revision, mode: seq ? seq.mode : null };
  }

  /**
   * What the engine renders this frame: the table and, while the sequence
   * plays, its transport. Nothing plays until the transport starts it.
   */
  frame(_reading: MusicalTime): SequenceFrame {
    return { table: this._table, transport: null };
  }
}
