// Light DJ's lamp transitions run at 22 Hz. The faster renderer samples their
// latest output; fractional frame time and pending changes belong to the instance.

import { z } from 'zod';
import type { Colour } from '../../types/rig.ts';
import type { Room } from '../room.ts';
import type { AudioFrame } from './audio-frame.ts';
import type { EffectKindDef, Seed } from './types.ts';

export const LDJ_FRAME_MS = 1000 / 22;
export type LdjEnvelope = { kind: 'instant' } | { kind: 'fade'; beats: number; baseline?: number }
  | { kind: 'flare' | 'twoWay' | 'blend'; beats: number }
  | { kind: 'matrix'; fadeIn: number; peak: number; fadeOut: number; baseline?: number; peakColour?: Colour };

const BLACK: Colour = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
const WHITE: Colour = { ...BLACK, r: 255, g: 255, b: 255 };
const f32 = Math.fround;
const level = (n: number) => f32(Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
const tempo = (bpm: number) => Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
const frameCount = (n: number) => Number.isFinite(n) ? Math.max(0, Math.floor(n / 22)) : 0;
// The fastest supported musical row is an eighth of a beat. Smaller wire
// values can turn a normal render gap into an unbounded replay loop.
const MIN_CADENCE = 1 / 8;

interface LampTransition {
  colour: Colour;
  fromColour: Colour;
  toColour: Colour;
  bri: number;
  from: number;
  to: number;
  env: LdjEnvelope;
  tick: number;
  seconds: number | null;
  reverse: boolean;
}
interface PendingLamp { slot: number; delay: number; transition: LampTransition }

function toward(state: LampTransition, target: number, amount: number): void {
  // Float comparisons and updates both round, as the lamp engine does.
  if (target > f32(state.bri + amount)) state.bri = f32(state.bri + amount);
  else if (target < f32(state.bri - amount)) state.bri = f32(state.bri - amount);
  else {
    state.bri = target;
    if (state.reverse) {
      [state.from, state.to] = [state.to, state.from];
      state.reverse = false;
    }
  }
}

function tickLamp(state: LampTransition): void {
  const env = state.env;
  if (env.kind === 'matrix') {
    const rise = frameCount(env.fadeIn), hold = Math.max(1, frameCount(env.peak)), fall = frameCount(env.fadeOut);
    // set/activation already exposed frame zero. Matrix phase is elapsed
    // whole frames, so its peak colour and visible duration share boundaries.
    state.tick++;
    if (state.tick < rise) toward(state, state.to, f32(1 / rise));
    else if (state.tick < rise + hold) state.bri = state.to;
    else {
      if (fall === 0) state.bri = state.from;
      else toward(state, state.from, f32(1 / fall));
    }
    state.colour = state.tick >= rise && state.tick < rise + hold ? env.peakColour ?? state.fromColour : state.fromColour;
    return;
  } else if (env.kind === 'blend') {
    const steps = Math.max(1, Math.floor((state.seconds ?? 0) * 22));
    const t = Math.min(1, (state.tick + 1) / steps);
    const mix = (channel: keyof Colour) => Math.round((state.fromColour[channel] ?? 0) * (1 - t) + (state.toColour[channel] ?? 0) * t);
    state.colour = { r: mix('r'), g: mix('g'), b: mix('b'), w: mix('w'), a: mix('a'), uv: mix('uv') };
  } else if (env.kind !== 'instant') {
    const duration = state.seconds ?? 0;
    toward(state, state.to, duration > 0 ? f32(1 / f32(f32(duration) * 22)) : 1);
  }
  state.tick++;
}

export class LdjLamps {
  private lamps: (LampTransition | null)[];
  private pending: PendingLamp[] = [];
  private remainderMs = 0;

  constructor(n: number) { this.lamps = Array.from({ length: Math.max(0, Math.floor(n)) }, () => null); }

  set(i: number, colour: Colour, bri: number, env: LdjEnvelope, delayFrames = 0): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.lamps.length) return;
    const from = env.kind === 'fade' ? level(bri) : env.kind === 'matrix' ? level(env.baseline ?? 0) : 0;
    const to = env.kind === 'fade' ? level(env.baseline ?? 0) : level(bri);
    const state: LampTransition = {
      colour: { ...colour }, fromColour: { ...colour }, toColour: { ...colour },
      bri: env.kind === 'instant' || env.kind === 'blend' ? to : from,
      from, to, env: env.kind === 'matrix' && env.peakColour ? { ...env, peakColour: { ...env.peakColour } } : { ...env },
      tick: 0, seconds: null, reverse: env.kind === 'twoWay',
    };
    if (env.kind === 'blend') state.colour = state.fromColour = { ...(this.lamps[i]?.colour ?? BLACK) };
    const delay = Number.isFinite(delayFrames) ? Math.max(0, Math.floor(delayFrames)) : 0;
    // Matrix peaks occupy complete lamp frames. A request between boundaries
    // waits for the next one, without resetting the other lamps' accumulator.
    if (delay || (env.kind === 'matrix' && this.remainderMs > 1e-8)) this.pending.push({ slot: i, delay, transition: state });
    else this.install(i, state);
  }

  private install(i: number, state: LampTransition): boolean {
    this.lamps[i] = state;
    // Matrix activation exposes frame zero once, whether it starts at the
    // baseline or immediately at its peak. A queued activation does the same.
    if (state.env.kind === 'matrix') {
      if (frameCount(state.env.fadeIn) === 0) {
        state.bri = state.to;
        state.colour = state.env.peakColour ?? state.fromColour;
      }
      return true;
    }
    return false;
  }

  off(i: number): void {
    if (i < 0 || i >= this.lamps.length) return;
    this.lamps[i] = null;
    this.pending = this.pending.filter((request) => request.slot !== i);
  }

  advance(dtMs: number, bpm: number): number {
    // Capture fresh requests before their delay starts, even on a zero-time
    // call. A later tap changes new notes, never an already scheduled fade.
    const bind = (state: LampTransition | null) => {
      if (state && state.seconds === null) state.seconds = 'beats' in state.env ? state.env.beats * 60 / tempo(bpm) : 0;
    };
    this.lamps.forEach(bind);
    for (const request of this.pending) bind(request.transition);
    this.remainderMs += Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
    const frames = Math.floor((this.remainderMs + 1e-8) / LDJ_FRAME_MS);
    this.remainderMs = Math.max(0, this.remainderMs - frames * LDJ_FRAME_MS);
    for (let frame = 0; frame < frames; frame++) {
      const exposed = new Set<number>();
      const waiting: PendingLamp[] = [];
      for (const request of this.pending) {
        if (request.delay > 0) { request.delay--; waiting.push(request); }
        else if (this.install(request.slot, request.transition)) exposed.add(request.slot);
        else exposed.delete(request.slot);
      }
      this.pending = waiting;
      for (let i = 0; i < this.lamps.length; i++) {
        const state = this.lamps[i];
        if (state && !exposed.has(i)) tickLamp(state);
      }
    }
    return frames;
  }

  read(i: number): { colour: Colour; bri: number } {
    const state = this.lamps[i];
    return state ? { colour: state.colour, bri: state.bri } : { colour: { ...BLACK }, bri: 0 };
  }
}

export interface StepClock { iter: number; phase: number; stepBeats: number; stepMs: number; changed: boolean }

function clockIteration(steps: number): number {
  const iter = Math.floor(steps);
  if (!Number.isSafeInteger(iter)) throw new RangeError('Light DJ clock iteration must be a finite safe integer');
  return iter;
}

export function stepClock(pos: number, cadenceBeats: number, bpm: number, lastIter: number | null): StepClock {
  if (!Number.isFinite(cadenceBeats) || cadenceBeats < MIN_CADENCE) throw new RangeError('Light DJ cadence must be at least one eighth of a beat');
  const steps = pos / cadenceBeats, iter = clockIteration(steps);
  const stepMs = cadenceBeats * 60000 / tempo(bpm);
  if (!Number.isFinite(stepMs)) throw new RangeError('Light DJ clock period must be finite');
  return { iter, phase: steps - iter, stepBeats: cadenceBeats, stepMs, changed: iter !== lastIter };
}

export function wallClock(nowMs: number, periodMs: number, lastIter: number | null): StepClock {
  if (!Number.isFinite(periodMs) || periodMs <= 0) throw new RangeError('Light DJ wall period must be finite and positive');
  const steps = nowMs / periodMs, iter = clockIteration(steps);
  return { iter, phase: steps - iter, stepBeats: 0, stepMs: periodMs, changed: iter !== lastIter };
}

export function roles(palette: Colour[]): { p: Colour; s: Colour; at(i: number): Colour } {
  const pal = palette.length ? palette : [WHITE];
  const at = (i: number) => pal[((Math.trunc(i) % pal.length) + pal.length) % pal.length];
  return { p: pal[1] ?? pal[0], s: pal[0], at };
}

export type LdjChannels = 1 | 2 | 3 | 4 | 5 | 'lights' | 'colours' | 'depth' | 'width';
const ANCHORS: Record<number, [number, number][]> = {
  1: [[0, 0]], 2: [[-1, 0], [1, 0]], 3: [[-1, 0], [0, 1], [1, 0]],
  4: [[-1, 1], [-1, -1], [1, 1], [1, -1]],
  5: [[-1, 1], [-1, -1], [1, 1], [1, -1], [0, 0]],
};

/** LDJ keeps its own corner indices; the legacy looks retain their established geometry. */
export function ldjChannels(room: Room, selector: LdjChannels, paletteCount = 1): number[] {
  const n = room.n;
  if (n === 0) return [];
  if (selector === 'lights') return Array.from({ length: n }, (_, i) => i);
  const count = selector === 'depth' || selector === 'width' ? 2
    : Math.min(n, selector === 'colours' ? Math.max(1, paletteCount) : selector);
  if (selector === 'colours' && count === n) return Array.from({ length: n }, (_, i) => i);
  const capacity = Array.from({ length: count }, (_, i) => Math.floor(n / count) + Number(i < n % count));
  // Palettes may have eight colours, while spatial anchors stop at five.
  // Contiguous balanced groups preserve every colour in this larger case.
  if (count > 5) return capacity.flatMap((size, channel) => Array(size).fill(channel));
  const anchors: [number, number][] = selector === 'depth' ? [[0, -1], [0, 1]] : ANCHORS[count];
  const assigned = Array<number>(n).fill(-1), sizes = Array<number>(count).fill(0);
  let remaining = n;
  while (remaining) {
    for (let channel = 0; channel < count; channel++) {
      if (sizes[channel] >= capacity[channel]) continue;
      let best = Infinity, pick = -1;
      for (let i = 0; i < n; i++) {
        if (assigned[i] !== -1) continue;
        const distance = Math.hypot(room.u[i] - anchors[channel][0], room.v[i] - anchors[channel][1]);
        if (distance < best) { best = distance; pick = i; }
      }
      assigned[pick] = channel;
      sizes[channel]++;
      remaining--;
    }
  }
  return assigned;
}

export interface LdjParams { cadence: number; beats?: number; speed?: number }
interface RowTiming { originMs: number; lastMs: number; lastBeat: number; nextDueMs: number; nextIter: number }
export interface LdjState {
  lamps: LdjLamps; lastIter: number | null; lastPick: number | null; recent: number[]; perm: number[] | null; roll: number;
  scratch: Record<string, unknown>; timing?: RowTiming;
}
export interface LdjCtx {
  room: Room; lamps: LdjLamps; pal: Colour[]; p: Colour; s: Colour; n: number; seed: Seed; state: LdjState;
  channelOf: number[]; ringOrder: number[]; bpm: number; audio: AudioFrame | null; iter: number;
  params: LdjParams; nowMs: number; elapsedMs: number; reroll(): void;
  colour(paletteIndex: number, cacheKey?: number): Colour;
  refresh(cacheKey: number): void;
  frameColour(paletteIndex: number, lamp: number, wholeFrame: number): Colour;
}
export interface LdjRow {
  cadence: number | 'wall:50'; channels?: LdjChannels; rapidFlash?: boolean; beats?: number;
  step(ctx: LdjCtx): void;
  /** A variable wall schedule starts at launch and adds each delay to its last deadline. */
  nextDelayMs?(ctx: LdjCtx): number;
  /** Sample an uncached colour after transitions advance, without changing their state. */
  outputColour?(ctx: LdjCtx, slot: number, lamp: { colour: Colour; bri: number }): Colour;
}

const paramsSchema = z.object({ cadence: z.number().min(MIN_CADENCE), beats: z.number().positive().optional(), speed: z.number().positive().optional() });

export function makeLdjKind(name: string, row: LdjRow): EffectKindDef<LdjParams, LdjState> {
  return {
    kind: `ldj.${name}`, app: 'ldj', schema: paramsSchema,
    defaults: { params: { cadence: typeof row.cadence === 'number' ? row.cadence : 1, beats: row.beats ?? 32 } },
    rapidFlash: row.rapidFlash, stateful: true, rollOf: (state) => state.roll,
    init: (_params, room) => ({ lamps: new LdjLamps(room.n), lastIter: null, lastPick: null, recent: [], perm: null, roll: 0, scratch: {} }),
    render(params, state, room, frame, out) {
      if (!Number.isFinite(frame.nowMs)) throw new RangeError('Light DJ clock time must be finite');
      if (state.lastIter !== null) clockIteration(state.lastIter);
      const first = !state.timing;
      const originMs = frame.startedAtMs ?? state.timing?.originMs ?? frame.nowMs;
      const clock = row.cadence === 'wall:50'
        ? wallClock(frame.nowMs - originMs, 50, state.lastIter)
        : stepClock(frame.beatPos - frame.anchorBeat, params.cadence, frame.bpm, state.lastIter);
      if (!state.timing) {
        const lastMs = row.nextDelayMs ? originMs : frame.nowMs - clock.phase * clock.stepMs;
        state.timing = { originMs, lastMs, lastBeat: frame.beatPos, nextDueMs: originMs, nextIter: 0 };
      }
      const timing = state.timing;
      let cursorMs = timing.lastMs;
      const advanceTo = (nowMs: number) => {
        state.lamps.advance(Math.max(0, nowMs - cursorMs), frame.bpm);
        cursorMs = nowMs;
      };
      const pal = frame.palette.length ? frame.palette : [WHITE];
      const { p, s } = roles(pal);
      const ctx: LdjCtx = {
        room, lamps: state.lamps, pal, p, s, n: room.n, seed: frame.seed, state,
        channelOf: ldjChannels(room, row.channels ?? 4, pal.length),
        ringOrder: Array.from({ length: room.n }, (_, i) => i).sort((a, b) => room.ring[a] - room.ring[b]),
        bpm: frame.bpm, audio: frame.audio, iter: clock.iter, params, nowMs: frame.nowMs, elapsedMs: frame.nowMs - originMs,
        reroll: () => { state.roll++; },
        colour: (index, key) => frame.paletteAccess?.colour(index, key) ?? roles(pal).at(index),
        refresh: (key) => { frame.paletteAccess?.refresh(key); },
        frameColour: (index, lamp, tick) => frame.paletteAccess?.frameColour(index, lamp, tick) ?? roles(pal).at(index),
      };
      const emit = (iter: number, nowMs: number) => {
        clockIteration(iter);
        advanceTo(nowMs);
        ctx.iter = iter; ctx.nowMs = nowMs; ctx.elapsedMs = nowMs - originMs;
        row.step(ctx);
        // Bind all newly queued durations to this event's tempo, including
        // delayed notes; none may inherit a later render's tempo instead.
        state.lamps.advance(0, frame.bpm);
        state.lastIter = iter;
      };
      if (row.nextDelayMs) {
        while (timing.nextDueMs <= frame.nowMs) {
          emit(timing.nextIter, timing.nextDueMs);
          const delay = row.nextDelayMs(ctx);
          if (!Number.isFinite(delay) || delay <= 0) throw new RangeError('Light DJ row delay must be finite and positive');
          const next = timing.nextDueMs + delay;
          if (!Number.isFinite(next) || next <= timing.nextDueMs) throw new RangeError('Light DJ row deadline must advance');
          timing.nextDueMs = next;
          timing.nextIter++;
        }
      } else if (first) emit(clock.iter, cursorMs);
      else if (clock.iter > (state.lastIter ?? clock.iter)) {
        // Beat boundaries interpolate the conductor's consecutive samples;
        // a tap does not move an existing lamp fade or its integer iteration.
        for (let iter = state.lastIter! + 1; iter <= clock.iter; iter++) {
          const fraction = (frame.anchorBeat + iter * params.cadence - timing.lastBeat) / (frame.beatPos - timing.lastBeat);
          const due = row.cadence === 'wall:50' ? originMs + iter * 50
            : timing.lastMs + Math.max(0, Math.min(1, fraction)) * (frame.nowMs - timing.lastMs);
          emit(iter, Math.max(cursorMs, Math.min(frame.nowMs, due)));
        }
      } else if (clock.changed) emit(clock.iter, frame.nowMs);
      advanceTo(frame.nowMs);
      timing.lastMs = frame.nowMs;
      timing.lastBeat = frame.beatPos;
      ctx.nowMs = frame.nowMs; ctx.elapsedMs = frame.nowMs - originMs;
      for (let i = 0; i < room.n; i++) {
        const lamp = state.lamps.read(i);
        out[i] = { colour: row.outputColour?.(ctx, i, lamp) ?? lamp.colour, level: lamp.bri, strength: 1 };
      }
    },
  };
}
