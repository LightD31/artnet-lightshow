import { canonical, effectContentKey, effectRoom } from './layer.ts';
import { effectAdmission } from './hardware.ts';
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

// Track lanes outrank shared lanes; later shared lanes win so layering is deterministic.
export interface SequenceLane { id: string; kind: 'shared' | 'track'; fixtureId?: number; name: string; mute: boolean; solo: boolean }

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

export interface SequenceTable { revision: number; lanes: SequenceLane[]; clips: TableClip[] }

export interface SequenceLoop { on: boolean; startBeat: number; endBeat: number }

// Generation changes on seek so every clip starts a fresh activation.
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

export interface SequenceStop { mode: 'hold' | 'black'; position: number; traversal: number }

const finite = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const count = (v: unknown): number => (Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : 0);

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

export interface SequencePlace { elapsed: number; position: number; traversal: number; origin: number }

// Decimal loops need rounding slack so their laps do not start one frame late.
const EPS = 1e-9;
// Tolerate conductor jitter so a sequence anchored just ahead does not disappear for one frame.
const JITTER_BEATS = 0.25;

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
  let wraps = Math.floor((end - loop.startBeat) / span + EPS);
  if (!Number.isSafeInteger(wraps) || !Number.isSafeInteger(base + wraps)) return null;
  wraps = Math.max(1, wraps);
  const position = Math.max(loop.startBeat, end - wraps * span);
  return { elapsed, position, traversal: base + wraps, origin: beatPos - position };
}

export function clipLap(clip: Pick<TableClip, 'startBeat' | 'lengthBeats' | 'loopBeats'>, position: number): { lap: number; lapStart: number } | null {
  if (!(position >= clip.startBeat && position < clip.startBeat + clip.lengthBeats)) return null;
  const rel = position - clip.startBeat;
  const last = Math.ceil(clip.lengthBeats / clip.loopBeats - EPS) - 1;
  const lap = Math.min(last, Math.floor(rel / clip.loopBeats + EPS));
  if (!Number.isSafeInteger(lap) || lap < 0) return null;
  // Never after the position itself: a lap does not start in the future.
  return { lap, lapStart: Math.min(position, clip.startBeat + lap * clip.loopBeats) };
}

export function activationId(clipId: string, generation: number, traversal: number, lap: number): string {
  return `clip:${clipId}:${generation}.${traversal}.${lap}`;
}

// Lap seeds exclude table revision and fixture so edits do not change unchanged activations.
export function lapSeed(seed: Seed, traversal: number, lap: number): Seed {
  return seedFrom(`clip:${seed.join(':')}:${traversal}:${lap}`);
}

// Reject self-paced flash effects because fresh clip laps would reset their safety limits.
function playable(c: TableClip | null | undefined): c is TableClip {
  return !!c && typeof c.id === 'string' && typeof c.laneId === 'string' && !!c.spec && typeof c.spec.kind === 'string' && !pacesOwnFlashes(c.spec)
    && Number.isFinite(c.startBeat) && c.lengthBeats > 0 && c.loopBeats > 0 && Number.isFinite(c.startBeat + c.lengthBeats)
    && Array.isArray(c.seed) && (c.fixtureIds === null || Array.isArray(c.fixtureIds));
}

export interface ActiveClip { index: number; lap: number; lapStart: number }

function covers(lane: SequenceLane, clip: TableClip, fixtureId: number | string): boolean {
  if (lane.kind === 'track' && fixtureId !== lane.fixtureId) return false;
  return clip.fixtureIds === null || clip.fixtureIds.includes(fixtureId as number);
}

// Choose track, later shared lane, later start, then later saved clip to resolve overlap.
export function selectClips(table: SequenceTable, position: number, slotFixtureIds: readonly (number | string)[], admit?: (clip: TableClip, id: number | string, position: number) => boolean):
  { winners: number[]; active: ActiveClip[] } {
  const winners = new Array<number>(slotFixtureIds.length).fill(-1);
  const active: ActiveClip[] = [];
  if (!Number.isFinite(position)) return { winners, active };
  const lanes = new Map<string, { lane: SequenceLane; index: number }>();
  table.lanes.forEach((lane, index) => { if (lane && !lanes.has(lane.id)) lanes.set(lane.id, { lane, index }); });
  const anySolo = table.lanes.some((l) => l?.solo);
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
      if (!covers(on.lane, clip, id) || admit && !admit(clip, id, position)) continue;
      const held = best.get(id);
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

export interface PlayingActivation {
  index: number;
  lap: number;
  id: string;
  seed: Seed;
  anchorBeat: number;
  lapElapsed: number;
}

export interface PlacedSequence {
  winners: number[];
  activations: PlayingActivation[];
  elapsed: number;
  anchor: string;
  position: number;
  traversal: number;
}

// Pause keeps selecting the held position while selected clips continue their own laps.
export function placeSequence(table: SequenceTable, transport: SequenceTransport, beatPos: number,
  slotFixtureIds: readonly (number | string)[], admit?: (clip: TableClip, id: number | string, position: number) => boolean): PlacedSequence | null {
  if (transport.stop) return null;
  const generation = transport.generation;
  const hold = transport.hold;
  if (hold) {
    if (!Number.isFinite(hold.position) || !Number.isFinite(hold.beat) || !Number.isSafeInteger(hold.traversal)) return null;
    const since = Number.isFinite(beatPos) ? Math.max(0, beatPos - hold.beat) : 0;
    const { winners, active } = selectClips(table, hold.position, slotFixtureIds, admit);
    const activations = active.flatMap((a): PlayingActivation[] => {
      const clip = table.clips[a.index];
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
  const { winners, active } = selectClips(table, place.position, slotFixtureIds, admit);
  const activations = active.map((a): PlayingActivation => {
    const clip = table.clips[a.index];
    return { index: a.index, lap: a.lap, id: activationId(clip.id, generation, place.traversal, a.lap), seed: lapSeed(clip.seed, place.traversal, a.lap),
      anchorBeat: Math.min(beatPos, place.origin + a.lapStart), lapElapsed: place.elapsed - (place.position - a.lapStart) };
  });
  const anchor = `play:${generation}:${transport.startBeat}:${transport.startPosition ?? 0}:${transport.traversal ?? 0}`;
  return { winners, activations, elapsed: place.elapsed, anchor, position: place.position, traversal: place.traversal };
}

export interface PlayingClip { id: string; spec: EffectSpec; anchorBeat: number; beatPos: number }

// Stopped sequences hold a picture, so they provide no live detector owner.
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


export const signatureBeat = (ts: { unit: number }): number => 4 / ts.unit;

export const barBeats = (ts: { beats: number; unit: number }): number => ts.beats * signatureBeat(ts);

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

export function resyncPosition(position: number, ts: { beats: number; unit: number }, boundary: 'beat' | 'bar'): number {
  const p = Math.max(0, position);
  if (boundary === 'beat') {
    const beat = signatureBeat(ts);
    return Math.floor(p / beat + 0.5) * beat;
  }
  const bar = barBeats(ts);
  return Math.floor(p / bar + EPS) * bar;
}


export interface ClipActivation { clip: string; seed: Seed; startedAtMs: number }

export interface HeldPicture { n: number; light: Float64Array; kinds: (string | null)[]; covered: Uint8Array }

export interface SequenceRun {
  keys: Map<string, string>;
  activations: Map<string, ClipActivation>;
  last: { elapsed: number; ms: number; anchor: string } | null;
  shown: HeldPicture | null;
}

export const newSequenceRun = (): SequenceRun => ({ keys: new Map(), activations: new Map(), last: null, shown: null });

export function copySequenceRun(run: SequenceRun): SequenceRun {
  const shown = run.shown && { n: run.shown.n, light: run.shown.light.slice(), kinds: [...run.shown.kinds], covered: run.shown.covered.slice() };
  return {
    keys: new Map(run.keys),
    activations: new Map([...run.activations].map(([id, a]) => [id, { ...a, seed: [...a.seed] as Seed }])),
    last: run.last && { ...run.last },
    shown,
  };
}

// Exclude palette, brightness, length and lane so edits that preserve playback keep instance state.
function clipKey(table: SequenceTable, c: TableClip): string {
  const lane = table.lanes.find((l) => l?.id === c.laneId);
  return canonical([effectContentKey(c.spec), c.startBeat, c.loopBeats, c.fixtureIds, c.seed, lane?.kind === 'track' ? lane.fixtureId ?? null : null]);
}

function endActivation(run: SequenceRun, stepper: EffectStepper, id: string): void {
  stepper.forget(id);
  run.activations.delete(id);
}

function endActivations(run: SequenceRun, stepper: EffectStepper): void {
  for (const id of [...run.activations.keys()]) endActivation(run, stepper, id);
}

// Retain unchanged activations across table revisions so unrelated edits do not restart them.
export function retable(run: SequenceRun, table: SequenceTable | null, stepper: EffectStepper): void {
  const keys = new Map<string, string>();
  for (const c of table?.clips ?? []) if (playable(c) && !keys.has(c.id)) keys.set(c.id, clipKey(table!, c));
  for (const [id, a] of run.activations) if (keys.get(a.clip) !== run.keys.get(a.clip)) endActivation(run, stepper, id);
  run.keys = keys;
}

export function endSequence(run: SequenceRun, stepper: EffectStepper): void {
  endActivations(run, stepper);
  run.last = null;
  run.shown = null;
}

// Cold activations back-project at current tempo because earlier tempo history is unavailable.
function lapWallStart(last: SequenceRun['last'], elapsed: number, nowMs: number, lapElapsed: number, bpm: number): number {
  if (lapElapsed >= elapsed) return nowMs;
  if (last && last.elapsed < lapElapsed && elapsed > last.elapsed) {
    return last.ms + (nowMs - last.ms) * (lapElapsed - last.elapsed) / (elapsed - last.elapsed);
  }
  return nowMs - (elapsed - lapElapsed) * 60000 / tempoOf(bpm);
}

const BLACK: Colour = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
// Held frames omit strobe bytes so stopping a sequence cannot leave hardware flashing.
const HELD_STRIDE = 7;

function freshPicture(run: SequenceRun, n: number): HeldPicture {
  if (!run.shown || run.shown.n !== n) run.shown = { n, light: new Float64Array(n * HELD_STRIDE), kinds: new Array(n).fill(null), covered: new Uint8Array(n) };
  else run.shown.covered.fill(0);
  return run.shown;
}

// A selected transparent clip owns black; uncovered cells keep the base look.
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
      const held: SequenceTransport = { ...transport, stop: null, hold: { position: stop.position, traversal: stop.traversal, beat: frame.beatPos } };
      renderSequenceLayer(rig, layout, frame, table, held, run, stepper, () => {});
      endActivations(run, stepper);
      run.last = null;
    }
    // A beat the moment cannot be placed on (not a number) left no picture: nothing covered until one can.
    return run.shown ? replay(run.shown, list, set) : false;
  }
  const picture = freshPicture(run, list.length);
  const keep = (k: number, colour: Colour, dim: number, strobe: number, kind: string | null, owner?: string) => {
    const o = k * HELD_STRIDE;
    const l = picture.light;
    l[o] = colour.r; l[o + 1] = colour.g; l[o + 2] = colour.b; l[o + 3] = colour.w || 0; l[o + 4] = colour.a || 0; l[o + 5] = colour.uv || 0;
    l[o + 6] = dim;
    picture.kinds[k] = kind;
    picture.covered[k] = 1;
    set(list[k], colour, dim, strobe, kind, owner);
  };
  const placed = renderPlaced(frame, table, transport, run, stepper, effectRoom(layout), ids, (k, slot, kind) => {
    if (slot) keep(k, slot.colour, 255 * slot.level, slot.strobe ?? 0, slot.kind ?? kind, slot.owner);
    else keep(k, BLACK, 0, 0, null);
  });
  if (placed === null) { endSequence(run, stepper); return false; }
  return placed;
}

// Render each winning activation once over the whole room before masking its won cells.
export function renderPlaced(frame: FrameBase, table: SequenceTable, transport: SequenceTransport, run: SequenceRun, stepper: EffectStepper,
  room: Room, ids: readonly (number | string)[], lay: (k: number, slot: EffectSlot | null, kind: string) => void): boolean | null {
  const caps = new Map(ids.map((id, k) => [id, frame.hardware?.[k]]));
  const placed = placeSequence(table, transport, frame.beatPos, ids, (clip, id, position) => {
    const capability = caps.get(id);
    const held = transport.hold;
    const playingPosition = position + (held ? Math.max(0, frame.beatPos - held.beat) : 0);
    const lapStart = held ? clip.startBeat + Math.floor((playingPosition - clip.startBeat) / clip.loopBeats + EPS) * clip.loopBeats
      : clipLap(clip, position)?.lapStart ?? clip.startBeat;
    return !capability || effectAdmission(clip.spec, { ...frame, beatPos: playingPosition, anchorBeat: lapStart, fixtureIds: [id] }, capability).mode !== 'exclude';
  });
  if (!placed) return null;
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
