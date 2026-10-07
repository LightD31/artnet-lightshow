// A sequence's clips on the rig: where the sequence is, which clip plays on
// which fixture, and each clip's laps as activations of their own (state,
// seed, wall origin). The server's renderer and the rehearsal preview both
// play a clip table through this, so they pick the same clips and laps.
// Browser-safe: nothing here reads server state.

// layer.ts is the way in that loads every kind; one instance is rendered as the macro renders its steps.
import { canonical, effectContentKey, effectRoom } from './layer.ts';
import { renderEffect } from './render-instance.ts';
import { pacesOwnFlashes } from './registry.ts';
import { seedFrom } from './hash.ts';
import { tempoOf } from '../look-math.ts';
import type { Colour } from '../../types/rig.ts';
import type { Layout, Rig } from '../rig.ts';
import type { EffectLayerSet } from './layer.ts';
import type { EffectInstance, EffectStepper } from './stepper.ts';
import type { EffectSlot, EffectSpec, FrameBase, Seed } from './types.ts';
import type { Room } from '../room.ts';

/**
 * A lane of clips. Shared lanes stack in list order (the last is on top);
 * a track is one fixture's own and beats every shared lane on it.
 */
export interface SequenceLane { id: string; kind: 'shared' | 'track'; fixtureId?: number; name: string; mute: boolean; solo: boolean }

/** A clip as the renderer plays it: its effect resolved, its fixtures as ids (null: every fixture the lane covers). */
export interface TableClip {
  id: string;
  laneId: string;
  fixtureIds: number[] | null;
  startBeat: number;
  lengthBeats: number;
  loopBeats: number;
  spec: EffectSpec;
  seed: Seed;
  mute: boolean;
}

/** The loaded sequence's content. `revision` moves with the content, never with time. */
export interface SequenceTable { revision: number; lanes: SequenceLane[]; clips: TableClip[] }

/** An arrangement's loop region, half-open: the end is never reached, the start is. */
export interface SequenceLoop { on: boolean; startBeat: number; endBeat: number }

/**
 * Where a sequence is, small enough to ride every snapshot: the music's beat
 * it stood at `startPosition` on (beat 0 when that is left out), the
 * traversal it was on then, the loop in force, and a generation a seek moves
 * on (every clip starts again from a new generation). The sequencer anchors
 * it afresh on a play, a seek, a resume or a jump of the music's clock.
 *
 * Paused (`hold`), the clips on top at the held position stay selected and
 * play their own laps on from the music's `beat`. Stopped (`stop`), the base
 * holds the last frame the sequence showed, or is black.
 */
export interface SequenceTransport {
  startBeat: number;
  loop: SequenceLoop | null;
  generation: number;
  startPosition?: number;
  traversal?: number;
  hold?: SequenceHold | null;
  stop?: SequenceStop | null;
}

export interface SequenceHold { position: number; traversal: number; beat: number }

/** `position` and `traversal` say what to show for a renderer that never saw the sequence play. */
export interface SequenceStop { mode: 'hold' | 'black'; position: number; traversal: number }

const finite = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const count = (v: unknown): number => (Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : 0);

/**
 * A transport handed over by a client or another thread, with only the
 * fields a transport has: a pause or a stop it carries is kept, so the
 * rehearsal holds and freezes as the rig does.
 */
export function transportOf(raw: SequenceTransport): SequenceTransport {
  const out: SequenceTransport = { startBeat: raw.startBeat, loop: raw.loop ?? null, generation: count(raw.generation) };
  if (raw.startPosition !== undefined) out.startPosition = Math.max(0, finite(raw.startPosition, 0));
  if (raw.traversal !== undefined) out.traversal = count(raw.traversal);
  const hold = raw.hold;
  if (hold && typeof hold === 'object') out.hold = { position: Math.max(0, finite(hold.position, 0)), traversal: count(hold.traversal), beat: finite(hold.beat, raw.startBeat) };
  const stop = raw.stop;
  if (stop && typeof stop === 'object') {
    out.stop = { mode: stop.mode === 'black' ? 'black' : 'hold', position: Math.max(0, finite(stop.position, 0)), traversal: count(stop.traversal) };
  }
  return out;
}

/**
 * A moment of the sequence: beats since its transport was anchored
 * (`elapsed`, never wrapped), its position in the arrangement, how many times
 * the loop has come round (`traversal`), and the music's beat this
 * traversal's position 0 falls on.
 */
export interface SequencePlace { elapsed: number; position: number; traversal: number; origin: number }

// Positions land on a lap or a loop's start within this, so a decimal loop
// (0.3 beats) does not start its laps a frame late on rounding alone.
const EPS = 1e-9;
// The music's clock may step back this far without a new epoch (the
// conductor's own tolerance): a sequence anchored a hair ahead of such a
// reading stays at its anchor rather than vanishing for a frame.
const JITTER_BEATS = 0.25;

/**
 * Where the sequence is at the music's `beatPos`; null before it starts. A
 * loop wraps the position when it runs into the loop's end (excluded) from
 * before it; a sequence anchored past the end plays on.
 */
export function sequencePlace(transport: SequenceTransport, beatPos: number): SequencePlace | null {
  const since = beatPos - transport.startBeat;
  if (!Number.isFinite(since) || since < -JITTER_BEATS) return null;
  const elapsed = Math.max(0, since);
  const from = transport.startPosition ?? 0;
  const base = transport.traversal ?? 0;
  const end = from + elapsed;
  const loop = transport.loop;
  const span = loop ? loop.endBeat - loop.startBeat : NaN;
  if (!loop || !loop.on || !(span > 0) || !Number.isFinite(span) || !(from < loop.endBeat - EPS) || end < loop.endBeat - EPS) {
    return { elapsed, position: end, traversal: base, origin: beatPos - end };
  }
  // Past the end: each time round is a traversal of its own.
  let wraps = Math.floor((end - loop.startBeat) / span + EPS);
  if (!Number.isSafeInteger(wraps) || !Number.isSafeInteger(base + wraps)) return null;
  wraps = Math.max(1, wraps);
  const position = Math.max(loop.startBeat, end - wraps * span);
  return { elapsed, position, traversal: base + wraps, origin: beatPos - position };
}

/** A clip's lap at a position, and where that lap started; null where the clip does not cover it. */
export function clipLap(clip: Pick<TableClip, 'startBeat' | 'lengthBeats' | 'loopBeats'>, position: number): { lap: number; lapStart: number } | null {
  if (!(position >= clip.startBeat && position < clip.startBeat + clip.lengthBeats)) return null;
  const rel = position - clip.startBeat;
  // The last lap is the last that starts inside the clip, however close to its end the position is.
  const last = Math.ceil(clip.lengthBeats / clip.loopBeats - EPS) - 1;
  const lap = Math.min(last, Math.floor(rel / clip.loopBeats + EPS));
  if (!Number.isSafeInteger(lap) || lap < 0) return null;
  // Never after the position itself: a lap does not start in the future.
  return { lap, lapStart: Math.min(position, clip.startBeat + lap * clip.loopBeats) };
}

/** A clip's activation: its id, unique to its lap in this traversal of this generation. */
export function activationId(clipId: string, generation: number, traversal: number, lap: number): string {
  return `clip:${clipId}:${generation}.${traversal}.${lap}`;
}

/** A lap's seed: the clip's own and where the lap falls, never the table's revision or a fixture. */
export function lapSeed(seed: Seed, traversal: number, lap: number): Seed {
  return seedFrom(`clip:${seed.join(':')}:${traversal}:${lap}`);
}

/**
 * Can a clip be played at all: the renderer trusts a table no further than
 * this. An effect that keeps its own flash limit (the strobe, Disco's
 * automatic strobe) never plays: each lap is a fresh instance and would start
 * that limit afresh. The sequencer refuses one; a table holding one anyway
 * never selects it.
 */
function playable(c: TableClip | null | undefined): c is TableClip {
  return !!c && typeof c.id === 'string' && typeof c.laneId === 'string' && !!c.spec && typeof c.spec.kind === 'string' && !pacesOwnFlashes(c.spec)
    && Number.isFinite(c.startBeat) && c.lengthBeats > 0 && c.loopBeats > 0 && Number.isFinite(c.startBeat + c.lengthBeats)
    && Array.isArray(c.seed) && (c.fixtureIds === null || Array.isArray(c.fixtureIds));
}

/** A clip playing now: its index in the table, its lap and where the lap started. */
export interface ActiveClip { index: number; lap: number; lapStart: number }

/** Does a clip on its lane cover a fixture: a track only its own, explicit ids only those. */
function covers(lane: SequenceLane, clip: TableClip, fixtureId: number | string): boolean {
  if (lane.kind === 'track' && fixtureId !== lane.fixtureId) return false;
  return clip.fixtureIds === null || clip.fixtureIds.includes(fixtureId as number);
}

/**
 * Which clip is on top of each slot at a position, as Hue Dynamics picks
 * the timeline clip of a light: of the clips playing there (half-open, not
 * muted, on a lane that plays), a track's beats every shared lane's, a later
 * shared lane beats an earlier one, a later start wins within a lane, and
 * the later in the list wins a tie. Any solo narrows the sequence to the
 * soloed lanes, counted before mute, so a muted solo lane silences the rest
 * and plays nothing itself. Slots are named by their fixture's id.
 */
export function selectClips(table: SequenceTable, position: number, slotFixtureIds: readonly (number | string)[]):
  { winners: number[]; active: ActiveClip[] } {
  const winners = new Array<number>(slotFixtureIds.length).fill(-1);
  const active: ActiveClip[] = [];
  if (!Number.isFinite(position)) return { winners, active };
  const lanes = new Map<string, { lane: SequenceLane; index: number }>();
  table.lanes.forEach((lane, index) => { if (lane && !lanes.has(lane.id)) lanes.set(lane.id, { lane, index }); });
  const anySolo = table.lanes.some((l) => l?.solo);
  // Each distinct fixture's winner, then every slot of it.
  const best = new Map<number | string, { index: number; rank: [number, number, number] }>();
  const ids = [...new Set(slotFixtureIds)];
  table.clips.forEach((clip, index) => {
    if (!playable(clip) || clip.mute) return;
    const on = lanes.get(clip.laneId);
    if (!on || on.lane.mute || (anySolo && !on.lane.solo)) return;
    const lap = clipLap(clip, position);
    if (!lap) return;
    active.push({ index, ...lap });
    const rank: [number, number, number] = [on.lane.kind === 'track' ? 1 : 0, on.index, clip.startBeat];
    for (const id of ids) {
      if (!covers(on.lane, clip, id)) continue;
      const held = best.get(id);
      // Later in the list wins a tie: clips are met in list order.
      if (!held || compareRank(rank, held.rank) >= 0) best.set(id, { index, rank });
    }
  });
  slotFixtureIds.forEach((id, k) => { winners[k] = best.get(id)?.index ?? -1; });
  return { winners, active };
}

function compareRank(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** A clip activation playing now: which clip, its lap and id, and where that lap began. */
export interface PlayingActivation {
  index: number;
  lap: number;
  id: string;
  seed: Seed;
  /** The music's beat the lap began on, never after the beat now. */
  anchorBeat: number;
  /** The `elapsed` the lap began at (see SequencePlace), for placing its start between two frames. */
  lapElapsed: number;
}

/** What plays at a moment: the winners per slot, every activation covering, and what identifies the anchoring. */
export interface PlacedSequence {
  winners: number[];
  activations: PlayingActivation[];
  elapsed: number;
  /** Changes whenever `elapsed` is counted from a new anchor, so no lap start is placed across it. */
  anchor: string;
  /** The position the clips were selected at, and its traversal. */
  position: number;
  traversal: number;
}

/**
 * The clips playing at the music's `beatPos` and their activations, as the
 * rig and the preview play them and the detectors pick from them. Playing,
 * the transport's position selects them; paused, the held position does and
 * each selected clip runs on through laps of its own, its length no longer
 * ending it. Null while the transport is stopped or before it starts.
 */
export function placeSequence(table: SequenceTable, transport: SequenceTransport, beatPos: number,
  slotFixtureIds: readonly (number | string)[]): PlacedSequence | null {
  if (transport.stop) return null;
  const generation = transport.generation;
  const hold = transport.hold;
  if (hold) {
    if (!Number.isFinite(hold.position) || !Number.isFinite(hold.beat) || !Number.isSafeInteger(hold.traversal)) return null;
    const since = Number.isFinite(beatPos) ? Math.max(0, beatPos - hold.beat) : 0;
    const { winners, active } = selectClips(table, hold.position, slotFixtureIds);
    const activations = active.flatMap((a): PlayingActivation[] => {
      const clip = table.clips[a.index];
      // Beats into the clip, the clip's laps counted on past its end.
      const local = (hold.position - clip.startBeat) + since;
      const lap = Math.max(a.lap, Math.floor(local / clip.loopBeats + EPS));
      if (!Number.isSafeInteger(lap)) return [];
      const into = Math.max(0, local - lap * clip.loopBeats);
      return [{ index: a.index, lap, id: activationId(clip.id, generation, hold.traversal, lap), seed: lapSeed(clip.seed, hold.traversal, lap),
        anchorBeat: beatPos - into, lapElapsed: since - into }];
    });
    return { winners, activations, elapsed: since, anchor: `hold:${generation}:${hold.beat}:${hold.position}:${hold.traversal}`,
      position: hold.position, traversal: hold.traversal };
  }
  const place = sequencePlace(transport, beatPos);
  if (!place) return null;
  const { winners, active } = selectClips(table, place.position, slotFixtureIds);
  const activations = active.map((a): PlayingActivation => {
    const clip = table.clips[a.index];
    return { index: a.index, lap: a.lap, id: activationId(clip.id, generation, place.traversal, a.lap), seed: lapSeed(clip.seed, place.traversal, a.lap),
      anchorBeat: Math.min(beatPos, place.origin + a.lapStart), lapElapsed: place.elapsed - (place.position - a.lapStart) };
  });
  const anchor = `play:${generation}:${transport.startBeat}:${transport.startPosition ?? 0}:${transport.traversal ?? 0}`;
  return { winners, activations, elapsed: place.elapsed, anchor, position: place.position, traversal: place.traversal };
}

/** A clip activation playing, with the beat its lap is anchored on and the position it was placed at, for a container clip's own step. */
export interface PlayingClip { id: string; spec: EffectSpec; anchorBeat: number; beatPos: number }

/**
 * The clip activations on top of at least one of `fixtureIds` at the music's
 * `beatPos`, highest first in selectClips' order: the sequence's base as the
 * audio detectors pick their owner from it. Nothing is rendered, no state
 * touched, no dice rolled. A stopped sequence plays no effect: its base is a
 * held picture or black.
 */
export function playingClips(table: SequenceTable, transport: SequenceTransport, beatPos: number, fixtureIds: readonly (number | string)[]):
  PlayingClip[] {
  const placed = placeSequence(table, transport, beatPos, fixtureIds);
  if (!placed) return [];
  const won = new Set(placed.winners.filter((i) => i >= 0));
  const laneIndex = new Map(table.lanes.map((l, i) => [l?.id, i]));
  const rank = (index: number) => {
    const clip = table.clips[index];
    const lane = table.lanes[laneIndex.get(clip.laneId)!];
    return [lane.kind === 'track' ? 1 : 0, laneIndex.get(clip.laneId)!, clip.startBeat, index];
  };
  return placed.activations.filter((a) => won.has(a.index))
    .sort((a, b) => compareRank(rank(b.index), rank(a.index)))
    .map((a) => ({ id: a.id, spec: table.clips[a.index].spec, anchorBeat: a.anchorBeat, beatPos }));
}

// ── Musical boundaries ──────────────────────────────────────────────────────

/** A time signature's beat in quarter-note beats: a 6/8 beat is half of one. */
export const signatureBeat = (ts: { unit: number }): number => 4 / ts.unit;

/** A bar in quarter-note beats: a 6/8 bar is three. */
export const barBeats = (ts: { beats: number; unit: number }): number => ts.beats * signatureBeat(ts);

/**
 * Where a sequence ends when no loop brings it round, in its beats: a
 * playlist after its last row or command, an arrangement at the bar line
 * after its last clip or command (0 with nothing in it).
 */
export function sequenceEnd(seq: {
  mode?: string; timeSignature?: { beats: number; unit: number } | null;
  clips?: readonly { startBeat: number; lengthBeats: number }[]; commands?: readonly { atBeat: number }[];
}): number {
  let last = 0;
  for (const c of seq.clips ?? []) last = Math.max(last, c.startBeat + c.lengthBeats);
  for (const k of seq.commands ?? []) last = Math.max(last, k.atBeat);
  if (seq.mode === 'playlist') return last;
  const bar = barBeats(seq.timeSignature ?? { beats: 4, unit: 4 });
  return Math.ceil(last / bar - EPS) * bar;
}

/**
 * Where a resync puts the sequence, after Hue Dynamics: to the nearest beat
 * of the time signature (ties away from zero), or back to the start of the
 * bar it is in.
 */
export function resyncPosition(position: number, ts: { beats: number; unit: number }, boundary: 'beat' | 'bar'): number {
  const p = Math.max(0, position);
  if (boundary === 'beat') {
    const beat = signatureBeat(ts);
    return Math.floor(p / beat + 0.5) * beat;
  }
  const bar = barBeats(ts);
  return Math.floor(p / bar + EPS) * bar;
}

// ── Playing a table ─────────────────────────────────────────────────────────

/** One clip activation as it plays: its clip, its seed and when it began on the wall clock. */
export interface ClipActivation { clip: string; seed: Seed; startedAtMs: number }

/**
 * The picture a stopped sequence holds: per cell of the layout, the colour
 * and level the sequence last put there (`covered` 0 where it put nothing).
 */
export interface HeldPicture { n: number; light: Float64Array; kinds: (string | null)[]; covered: Uint8Array }

/**
 * What playing a table remembers from frame to frame: each clip's content as
 * last seen, the activations playing, the last moment the sequence played
 * (so a lap's start can be placed between two frames), and the last picture
 * it showed, which a stop holds.
 */
export interface SequenceRun {
  keys: Map<string, string>;
  activations: Map<string, ClipActivation>;
  last: { elapsed: number; ms: number; anchor: string } | null;
  shown: HeldPicture | null;
}

export const newSequenceRun = (): SequenceRun => ({ keys: new Map(), activations: new Map(), last: null, shown: null });

/** A run's own copy, for a preview checkpoint. */
export function copySequenceRun(run: SequenceRun): SequenceRun {
  const shown = run.shown && { n: run.shown.n, light: run.shown.light.slice(), kinds: [...run.shown.kinds], covered: run.shown.covered.slice() };
  return {
    keys: new Map(run.keys),
    activations: new Map([...run.activations].map(([id, a]) => [id, { ...a, seed: [...a.seed] as Seed }])),
    last: run.last && { ...run.last },
    shown,
  };
}

/**
 * What makes a clip play the same: its kind and settings (not its colours or
 * brightness), where its laps fall, what it covers and its seed. Its length
 * and lane only decide where and over what it shows.
 */
function clipKey(table: SequenceTable, c: TableClip): string {
  const lane = table.lanes.find((l) => l?.id === c.laneId);
  return canonical([effectContentKey(c.spec), c.startBeat, c.loopBeats, c.fixtureIds, c.seed, lane?.kind === 'track' ? lane.fixtureId ?? null : null]);
}

/** End one activation: its state goes, so nothing of it is met again under its id. */
function endActivation(run: SequenceRun, stepper: EffectStepper, id: string): void {
  stepper.forget(id);
  run.activations.delete(id);
}

function endActivations(run: SequenceRun, stepper: EffectStepper): void {
  for (const id of [...run.activations.keys()]) endActivation(run, stepper, id);
}

/**
 * A new table: a clip whose content changed, or that is gone, starts again;
 * every other clip plays on, its state and wall origin kept.
 */
export function retable(run: SequenceRun, table: SequenceTable | null, stepper: EffectStepper): void {
  const keys = new Map<string, string>();
  for (const c of table?.clips ?? []) if (playable(c) && !keys.has(c.id)) keys.set(c.id, clipKey(table!, c));
  for (const [id, a] of run.activations) if (keys.get(a.clip) !== run.keys.get(a.clip)) endActivation(run, stepper, id);
  run.keys = keys;
}

/** Every activation ends and a held picture is let go: the sequence stopped playing. */
export function endSequence(run: SequenceRun, stepper: EffectStepper): void {
  endActivations(run, stepper);
  run.last = null;
  run.shown = null;
}

/**
 * When a lap began on the wall clock, the rule the macro's steps follow:
 * between the last frame and this one when the sequence was seen crossing
 * its start, now when it starts now, else counted back at the tempo now
 * (history the frames never showed cannot be recovered).
 */
function lapWallStart(last: SequenceRun['last'], elapsed: number, nowMs: number, lapElapsed: number, bpm: number): number {
  if (lapElapsed >= elapsed) return nowMs;
  if (last && last.elapsed < lapElapsed && elapsed > last.elapsed) {
    return last.ms + (nowMs - last.ms) * (lapElapsed - last.elapsed) / (elapsed - last.elapsed);
  }
  return nowMs - (elapsed - lapElapsed) * 60000 / tempoOf(bpm);
}

const BLACK: Colour = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
// Per cell of a held picture: r, g, b, w, a, uv, dim. No strobe: a held
// picture is a still, and a strobe channel left open would flash on for good.
const HELD_STRIDE = 7;

/** The run's picture for `n` cells, every cell uncovered. */
function freshPicture(run: SequenceRun, n: number): HeldPicture {
  if (!run.shown || run.shown.n !== n) run.shown = { n, light: new Float64Array(n * HELD_STRIDE), kinds: new Array(n).fill(null), covered: new Uint8Array(n) };
  else run.shown.covered.fill(0);
  return run.shown;
}

/**
 * The table's clips on a layout's cells, where the transport says the
 * sequence is: each winning clip activation rendered once, over the whole
 * room with its own fixtures as its mask, then laid on the cells it wins.
 * A winner that leaves a cell transparent (or is gated, or unknown) owns it
 * black; a cell no clip covers is not touched. `frame.fixtureIds` names each
 * cell's fixture. Returns whether any cell was covered.
 *
 * Stopped, the sequence plays nothing: it lays the picture it last showed
 * on the same cells again, strobe channels closed (rendered once at the
 * stop's position for a run that never showed one), or black on every cell.
 */
export function renderSequenceLayer(rig: Rig, layout: Layout, frame: FrameBase, table: SequenceTable, transport: SequenceTransport,
  run: SequenceRun, stepper: EffectStepper, set: EffectLayerSet): boolean {
  const { list } = layout.units;
  const ids = frame.fixtureIds ?? [];
  if (!list.length || ids.length !== list.length) { endSequence(run, stepper); return false; }
  const stop = transport.stop;
  if (stop) {
    endActivations(run, stepper);
    run.last = null;
    if (stop.mode === 'black') {
      for (let k = 0; k < list.length; k++) set(list[k], BLACK, 0, 0, null);
      return true;
    }
    if (!run.shown || run.shown.n !== list.length) {
      // Nothing seen to hold: the stop's own moment, once, and that is the picture from now on.
      const held: SequenceTransport = { ...transport, stop: null, hold: { position: stop.position, traversal: stop.traversal, beat: frame.beatPos } };
      renderSequenceLayer(rig, layout, frame, table, held, run, stepper, () => {});
      endActivations(run, stepper);
      run.last = null;
    }
    // A beat the moment cannot be placed on (not a number) left no picture: nothing covered until one can.
    return run.shown ? replay(run.shown, list, set) : false;
  }
  const picture = freshPicture(run, list.length);
  const keep = (k: number, colour: Colour, dim: number, strobe: number, kind: string | null) => {
    const o = k * HELD_STRIDE;
    const l = picture.light;
    l[o] = colour.r; l[o + 1] = colour.g; l[o + 2] = colour.b; l[o + 3] = colour.w || 0; l[o + 4] = colour.a || 0; l[o + 5] = colour.uv || 0;
    l[o + 6] = dim;
    picture.kinds[k] = kind;
    picture.covered[k] = 1;
    set(list[k], colour, dim, strobe, kind);
  };
  const placed = renderPlaced(frame, table, transport, run, stepper, effectRoom(layout), ids, (k, slot, kind) => {
    if (slot) keep(k, slot.colour, 255 * slot.level, slot.strobe ?? 0, slot.kind ?? kind);
    else keep(k, BLACK, 0, 0, null);
  });
  if (placed === null) { endSequence(run, stepper); return false; }
  return placed;
}

/**
 * The playing part of a table at the music's beat, shared by the sequence
 * layer and a pattern bundle voice: activations kept or started, each winning
 * clip rendered once over `room` with its fixtures as its mask, and `lay`
 * called per won cell with the slot (null where the winner is transparent).
 * Null when the transport places nothing; else whether any cell was won.
 */
export function renderPlaced(frame: FrameBase, table: SequenceTable, transport: SequenceTransport, run: SequenceRun, stepper: EffectStepper,
  room: Room, ids: readonly (number | string)[], lay: (k: number, slot: EffectSlot | null, kind: string) => void): boolean | null {
  const placed = placeSequence(table, transport, frame.beatPos, ids);
  if (!placed) return null;
  // A new anchor is no crossing: nothing between the frames either side of it is placed.
  if (run.last && run.last.anchor !== placed.anchor) run.last = null;

  const playing = new Map<number, { id: string; activation: ClipActivation; anchorBeat: number }>();
  for (const a of placed.activations) {
    const clip = table.clips[a.index];
    let activation = run.activations.get(a.id);
    if (!activation) {
      stepper.forget(a.id);
      activation = { clip: clip.id, seed: a.seed, startedAtMs: lapWallStart(run.last, placed.elapsed, frame.nowMs, a.lapElapsed, frame.bpm) };
      run.activations.set(a.id, activation);
    }
    playing.set(a.index, { id: a.id, activation, anchorBeat: a.anchorBeat });
  }
  // An activation not playing now is over: its lap ended, its clip stopped covering, or the loop came round.
  const live = new Set([...playing.values()].map((p) => p.id));
  for (const id of [...run.activations.keys()]) if (!live.has(id)) endActivation(run, stepper, id);
  run.last = { elapsed: placed.elapsed, ms: frame.nowMs, anchor: placed.anchor };

  const won = new Map<number, number[]>();
  placed.winners.forEach((index, k) => {
    if (index < 0) return;
    const cells = won.get(index);
    if (cells) cells.push(k); else won.set(index, [k]);
  });
  if (!won.size) return false;
  for (const [index, cells] of won) {
    const clip = table.clips[index];
    const lane = table.lanes.find((l) => l?.id === clip.laneId)!;
    const { id, activation, anchorBeat } = playing.get(index)!;
    // The clip's own fixtures are its mask; it renders over the whole room once, whichever cells it wins.
    const all = lane.kind !== 'track' && clip.fixtureIds === null;
    const targets = all ? null : ids.flatMap((fid, k) => (covers(lane, clip, fid) ? [k] : []));
    const instance: EffectInstance = { id, spec: clip.spec, seed: activation.seed, anchorBeat, startedAtMs: activation.startedAtMs, targets };
    const out = new Array<EffectSlot>(room.n);
    renderEffect(instance, frame, room, stepper, out);
    for (const k of cells) {
      const slot = out[k] as EffectSlot | undefined;
      lay(k, slot && slot.strength > 0 ? slot : null, clip.spec.kind);
    }
  }
  return true;
}

/** Lay a held picture on its cells again; whether it covers any. */
function replay(picture: HeldPicture, list: readonly number[], set: EffectLayerSet): boolean {
  let any = false;
  for (let k = 0; k < picture.n; k++) {
    if (!picture.covered[k]) continue;
    const o = k * HELD_STRIDE;
    const l = picture.light;
    set(list[k], { r: l[o], g: l[o + 1], b: l[o + 2], w: l[o + 3], a: l[o + 4], uv: l[o + 5] }, l[o + 6], 0, picture.kinds[k]);
    any = true;
  }
  return any;
}
