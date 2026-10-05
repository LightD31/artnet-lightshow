// A sequence's clips on the rig: where the sequence is, which clip plays on
// which fixture, and each clip's laps as activations of their own (state,
// seed, wall origin). The server's renderer and the rehearsal preview both
// play a clip table through this, so they pick the same clips and laps.
// Browser-safe: nothing here reads server state.

// layer.ts is the way in that loads every kind; one instance is rendered as the macro renders its steps.
import { canonical, effectContentKey, effectRoom } from './layer.ts';
import { renderEffect } from './render-instance.ts';
import { seedFrom } from './hash.ts';
import { tempoOf } from '../look-math.ts';
import type { Colour } from '../../types/rig.ts';
import type { Layout, Rig } from '../rig.ts';
import type { EffectLayerSet } from './layer.ts';
import type { EffectInstance, EffectStepper } from './stepper.ts';
import type { EffectSlot, EffectSpec, FrameBase, Seed } from './types.ts';

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
 * Where a playing sequence is, small enough to ride every snapshot: the
 * music's beat its beat 0 fell on, its loop, and a generation a seek moves
 * on (every clip starts again from a new generation).
 */
export interface SequenceTransport { startBeat: number; loop: SequenceLoop | null; generation: number }

/**
 * A moment of the sequence: beats since it started (`elapsed`, never
 * wrapped), its position in the arrangement, how many times the loop has come
 * round (`traversal`), and the music's beat this traversal's position 0 falls on.
 */
export interface SequencePlace { elapsed: number; position: number; traversal: number; origin: number }

// Positions land on a lap or a loop's start within this, so a decimal loop
// (0.3 beats) does not start its laps a frame late on rounding alone.
const EPS = 1e-9;

/** Where the sequence is at the music's `beatPos`; null before it starts. */
export function sequencePlace(transport: SequenceTransport, beatPos: number): SequencePlace | null {
  const elapsed = beatPos - transport.startBeat;
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const loop = transport.loop;
  const span = loop ? loop.endBeat - loop.startBeat : NaN;
  if (!loop || !loop.on || !(span > 0) || !Number.isFinite(span) || elapsed < loop.endBeat - EPS) {
    return { elapsed, position: elapsed, traversal: 0, origin: transport.startBeat };
  }
  // Past the end: each time round is a traversal of its own.
  let traversal = Math.floor((elapsed - loop.startBeat) / span + EPS);
  if (!Number.isSafeInteger(traversal)) return null;
  traversal = Math.max(1, traversal);
  const position = Math.max(loop.startBeat, elapsed - traversal * span);
  return { elapsed, position, traversal, origin: transport.startBeat + traversal * span };
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
 * The strobe kind, which no clip may play: each lap is a fresh instance, and
 * would start its five-a-second permit afresh. The sequencer refuses it; a
 * table that holds one anyway never selects it.
 */
export const STROBE_KIND = 'strobe';

/** Can a clip be played at all: the renderer trusts a table no further than this. */
function playable(c: TableClip | null | undefined): c is TableClip {
  return !!c && typeof c.id === 'string' && typeof c.laneId === 'string' && !!c.spec && typeof c.spec.kind === 'string' && c.spec.kind !== STROBE_KIND
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

/**
 * The clip activations on top of at least one of `fixtureIds` at the music's
 * `beatPos`, highest first in selectClips' order: the sequence's base as the
 * audio detectors pick their owner from it. Nothing is rendered, no state
 * touched, no dice rolled.
 */
export function playingClips(table: SequenceTable, transport: SequenceTransport, beatPos: number, fixtureIds: readonly number[]):
  { id: string; spec: EffectSpec }[] {
  const place = sequencePlace(transport, beatPos);
  if (!place) return [];
  const { winners, active } = selectClips(table, place.position, fixtureIds);
  const won = new Set(winners.filter((i) => i >= 0));
  const laneIndex = new Map(table.lanes.map((l, i) => [l?.id, i]));
  const rank = (index: number) => {
    const clip = table.clips[index];
    const lane = table.lanes[laneIndex.get(clip.laneId)!];
    return [lane.kind === 'track' ? 1 : 0, laneIndex.get(clip.laneId)!, clip.startBeat, index];
  };
  return active.filter((a) => won.has(a.index))
    .sort((a, b) => compareRank(rank(b.index), rank(a.index)))
    .map((a) => ({ id: activationId(table.clips[a.index].id, transport.generation, place.traversal, a.lap), spec: table.clips[a.index].spec }));
}

// ── Playing a table ─────────────────────────────────────────────────────────

/** One clip activation as it plays: its clip, its seed and when it began on the wall clock. */
export interface ClipActivation { clip: string; seed: Seed; startedAtMs: number }

/**
 * What playing a table remembers from frame to frame: each clip's content as
 * last seen, the activations playing, and the last moment the sequence played,
 * so a lap's start can be placed between two frames.
 */
export interface SequenceRun {
  keys: Map<string, string>;
  activations: Map<string, ClipActivation>;
  last: { elapsed: number; ms: number; generation: number } | null;
}

export const newSequenceRun = (): SequenceRun => ({ keys: new Map(), activations: new Map(), last: null });

/** A run's own copy, for a preview checkpoint. */
export function copySequenceRun(run: SequenceRun): SequenceRun {
  return {
    keys: new Map(run.keys),
    activations: new Map([...run.activations].map(([id, a]) => [id, { ...a, seed: [...a.seed] as Seed }])),
    last: run.last && { ...run.last },
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

/** Every activation ends: the sequence stopped playing. */
export function endSequence(run: SequenceRun, stepper: EffectStepper): void {
  for (const id of [...run.activations.keys()]) endActivation(run, stepper, id);
  run.last = null;
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

/**
 * The table's clips on a layout's cells, where the transport says the
 * sequence is: each winning clip activation rendered once, over the whole
 * room with its own fixtures as its mask, then laid on the cells it wins.
 * A winner that leaves a cell transparent (or is gated, or unknown) owns it
 * black; a cell no clip covers is not touched. `frame.fixtureIds` names each
 * cell's fixture. Returns whether any cell was covered.
 */
export function renderSequenceLayer(rig: Rig, layout: Layout, frame: FrameBase, table: SequenceTable, transport: SequenceTransport,
  run: SequenceRun, stepper: EffectStepper, set: EffectLayerSet): boolean {
  const { list } = layout.units;
  const ids = frame.fixtureIds ?? [];
  const place = sequencePlace(transport, frame.beatPos);
  if (!place || !list.length || ids.length !== list.length) { endSequence(run, stepper); return false; }
  // A seek is no crossing: nothing between the frames either side of it is placed.
  if (run.last && run.last.generation !== transport.generation) run.last = null;
  const { winners, active } = selectClips(table, place.position, ids);

  const playing = new Map<number, { id: string; activation: ClipActivation; anchorBeat: number }>();
  for (const a of active) {
    const clip = table.clips[a.index];
    const id = activationId(clip.id, transport.generation, place.traversal, a.lap);
    let activation = run.activations.get(id);
    if (!activation) {
      stepper.forget(id);
      const lapElapsed = place.elapsed - (place.position - a.lapStart);
      activation = { clip: clip.id, seed: lapSeed(clip.seed, place.traversal, a.lap),
        startedAtMs: lapWallStart(run.last, place.elapsed, frame.nowMs, lapElapsed, frame.bpm) };
      run.activations.set(id, activation);
    }
    // The music's beat the lap began on, never after the beat now.
    playing.set(a.index, { id, activation, anchorBeat: Math.min(frame.beatPos, place.origin + a.lapStart) });
  }
  // An activation not playing now is over: its lap ended, its clip stopped covering, or the loop came round.
  const live = new Set([...playing.values()].map((p) => p.id));
  for (const id of [...run.activations.keys()]) if (!live.has(id)) endActivation(run, stepper, id);
  run.last = { elapsed: place.elapsed, ms: frame.nowMs, generation: transport.generation };

  const won = new Map<number, number[]>();
  winners.forEach((index, k) => {
    if (index < 0) return;
    const cells = won.get(index);
    if (cells) cells.push(k); else won.set(index, [k]);
  });
  if (!won.size) return false;
  const room = effectRoom(layout);
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
      if (slot && slot.strength > 0) set(list[k], slot.colour, 255 * slot.level, slot.strobe ?? 0, slot.kind ?? clip.spec.kind);
      else set(list[k], BLACK, 0, 0, null);
    }
  }
  return true;
}
