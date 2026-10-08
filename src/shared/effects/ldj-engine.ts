// Light DJ's lamp transitions run at 22 Hz. The faster renderer samples their
// latest output; fractional frame time and pending changes belong to the instance.

import { z } from 'zod';
import { huePulseLevel, tempoOf } from '../look-math.ts';
import type { Colour } from '../../types/rig.ts';
import type { Room } from '../room.ts';
import type { AudioFrame } from './audio-frame.ts';
import type { EffectKindDef, Seed } from './types.ts';
import { paletteBinding } from './palette.ts';
import type { PaletteAccess, PaletteBinding } from './palette.ts';

export const LDJ_FRAME_MS = 1000 / 22;
export type LdjEnvelope = { kind: 'instant' } | { kind: 'fade'; beats: number; baseline?: number }
  | { kind: 'flare' | 'twoWay' | 'blend'; beats: number }
  | { kind: 'matrix'; fadeIn: number; peak: number; fadeOut: number; baseline?: number; peakColour?: Colour };

const BLACK: Colour = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
const WHITE: Colour = { ...BLACK, r: 255, g: 255, b: 255 };
const f32 = Math.fround;
const level = (n: number) => f32(Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
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
  binding?: PaletteBinding;
  peakBinding?: PaletteBinding;
  /** A hard flash a Hue lamp may take as a pulse, or a rest that cuts one (see FlashHint). */
  mark?: LampMark;
}
interface PendingLamp { slot: number; delay: number; transition: LampTransition }

/**
 * What a row says about a lamp it sets, for Hue lamps in pulse mode: 'flash'
 * is one of its hard flashes (on at full, cut to off), 'rest' its explicit
 * rest level, which cuts a held flash short. Nothing else is marked: a fade,
 * a blend or a background is drawn as authored on every lamp.
 */
export type LampMark = 'flash' | 'rest';

/**
 * A lamp's last hard flash, kept for a Hue lamp to take as the strobe's pulse
 * (full falling to 40/255 over 200 ms). Plain data on the lamps' own clock,
 * so a clone or a replay keeps it. An off step leaves it, so the tail plays
 * on; any unmarked set on the lamp clears it.
 */
interface FlashHint {
  /** When the flash became visible: its set, or the 22 Hz boundary a matrix request waited for. */
  at: number;
  peak: number;
  /** The flash's colour as last drawn while lit; it holds through the tail. */
  colour: Colour;
  /** The lamp's own rest under the flash; the pulse never falls below it. */
  floor: number;
  /** A held matrix peak keeps its plateau to here and softens only the cut; null pulses from `at`. */
  holdUntil: number | null;
  /** An explicit rest that cut the plateau first: the release starts there, once. */
  cutAt: number | null;
}

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
  // The lamps' own clock, ms since the first advance: what flash hints are timed on.
  private clockMs = 0;
  private hints: (FlashHint | null)[];

  constructor(n: number) {
    this.lamps = Array.from({ length: Math.max(0, Math.floor(n)) }, () => null);
    this.hints = this.lamps.map(() => null);
  }

  set(i: number, colour: Colour, bri: number, env: LdjEnvelope, delayFrames = 0, mark?: LampMark): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.lamps.length) return;
    const from = env.kind === 'fade' ? level(bri) : env.kind === 'matrix' ? level(env.baseline ?? 0) : 0;
    const to = env.kind === 'fade' ? level(env.baseline ?? 0) : level(bri);
    const state: LampTransition = {
      colour: { ...colour }, fromColour: { ...colour }, toColour: { ...colour },
      bri: env.kind === 'instant' || env.kind === 'blend' ? to : from,
      from, to, env: env.kind === 'matrix' && env.peakColour ? { ...env, peakColour: { ...env.peakColour } } : { ...env },
      tick: 0, seconds: null, reverse: env.kind === 'twoWay',
      binding: env.kind === 'blend' ? undefined : paletteBinding(colour),
      peakBinding: env.kind === 'matrix' && env.peakColour ? paletteBinding(env.peakColour) : undefined,
      ...(mark ? { mark } : {}),
    };
    if (env.kind === 'blend') state.colour = state.fromColour = { ...(this.lamps[i]?.colour ?? BLACK) };
    const delay = Number.isFinite(delayFrames) ? Math.max(0, Math.floor(delayFrames)) : 0;
    // Matrix peaks occupy complete lamp frames. A request between boundaries
    // waits for the next one, without resetting the other lamps' accumulator.
    if (delay || (env.kind === 'matrix' && this.remainderMs > 1e-8)) this.pending.push({ slot: i, delay, transition: state });
    else this.install(i, state, this.clockMs);
  }

  /** The hint a lamp's new transition leaves: a flash's own, a rest's cut, or none. */
  private hint(i: number, state: LampTransition, atMs: number): void {
    if (state.mark === 'flash') {
      const env = state.env;
      const hold = env.kind === 'matrix' ? Math.max(1, frameCount(env.peak)) : 0;
      // A one-frame matrix flash is an instant flash; a longer peak is a plateau to keep.
      const holdUntil = env.kind === 'matrix' && hold > 1 ? atMs + (frameCount(env.fadeIn) + hold) * LDJ_FRAME_MS : null;
      const peak = env.kind === 'matrix' ? state.to : state.bri;
      this.hints[i] = { at: atMs, peak, colour: { ...state.colour }, floor: env.kind === 'matrix' ? state.from : 0, holdUntil, cutAt: null };
      return;
    }
    const hint = this.hints[i];
    if (state.mark === 'rest' && hint) {
      // The first rest inside a plateau starts its release; later rests change nothing.
      if (hint.holdUntil !== null && hint.cutAt === null && atMs < hint.holdUntil) hint.cutAt = atMs;
      hint.floor = Math.max(hint.floor, state.to);
      return;
    }
    if (!state.mark) this.hints[i] = null;
  }

  private install(i: number, state: LampTransition, atMs: number): boolean {
    this.lamps[i] = state;
    // Matrix activation exposes frame zero once, whether it starts at the
    // baseline or immediately at its peak. A queued activation does the same.
    if (state.env.kind === 'matrix') {
      if (frameCount(state.env.fadeIn) === 0) {
        state.bri = state.to;
        state.colour = state.env.peakColour ?? state.fromColour;
      }
      this.hint(i, state, atMs);
      return true;
    }
    this.hint(i, state, atMs);
    return false;
  }

  off(i: number): void {
    if (i < 0 || i >= this.lamps.length) return;
    this.lamps[i] = null;
    this.pending = this.pending.filter((request) => request.slot !== i);
  }

  /** Resolve the next render's cache before advancing; real blends retain their launch endpoints. */
  resolveColours(access: PaletteAccess): void {
    const resolve = (state: LampTransition | null) => {
      if (!state) return;
      if (state.binding) state.fromColour = state.toColour = { ...access.colour(state.binding.index, state.binding.key) };
      const env = state.env;
      if (env.kind === 'matrix') {
        if (state.peakBinding) env.peakColour = { ...access.colour(state.peakBinding.index, state.peakBinding.key) };
        const rise = frameCount(env.fadeIn), hold = Math.max(1, frameCount(env.peak));
        state.colour = state.tick >= rise && state.tick < rise + hold ? env.peakColour ?? state.fromColour : state.fromColour;
      } else if (state.binding) state.colour = state.fromColour;
    };
    this.lamps.forEach(resolve);
    for (const request of this.pending) resolve(request.transition);
  }

  advance(dtMs: number, bpm: number): number {
    // Capture fresh requests before their delay starts, even on a zero-time
    // call. A later tap changes new notes, never an already scheduled fade.
    const bind = (state: LampTransition | null) => {
      if (state && state.seconds === null) state.seconds = 'beats' in state.env ? state.env.beats * 60 / tempoOf(bpm) : 0;
    };
    this.lamps.forEach(bind);
    for (const request of this.pending) bind(request.transition);
    const step = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
    // The last boundary passed, on the lamps' clock: each frame below starts one frame on.
    const boundary = this.clockMs - this.remainderMs;
    this.remainderMs += step;
    this.clockMs += step;
    const frames = Math.floor((this.remainderMs + 1e-8) / LDJ_FRAME_MS);
    this.remainderMs = Math.max(0, this.remainderMs - frames * LDJ_FRAME_MS);
    for (let frame = 0; frame < frames; frame++) {
      const exposed = new Set<number>();
      const waiting: PendingLamp[] = [];
      const atMs = boundary + (frame + 1) * LDJ_FRAME_MS;
      for (const request of this.pending) {
        if (request.delay > 0) { request.delay--; waiting.push(request); }
        else if (this.install(request.slot, request.transition, atMs)) exposed.add(request.slot);
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

  /**
   * The colour a lamp was drawn this frame: while its marked flash is still
   * lit, the flash's tail takes it (a live palette refresh, a per-frame
   * colour), and once it is out the tail keeps the last. No colour is drawn here.
   */
  observe(i: number, colour: Colour): void {
    const state = this.lamps[i], hint = this.hints[i];
    if (hint && state?.mark === 'flash' && state.bri > hint.floor) hint.colour = { ...colour };
  }

  /**
   * A Hue lamp's take on its last marked flash, as the strobe pulses it: full
   * from the flash (or through a held peak, to its end or an earlier rest),
   * falling to 40/255 of the peak over 200 ms and held there, never below the
   * lamp's own rest. Null for a lamp with no flash to soften.
   */
  pulse(i: number): { colour: Colour; bri: number } | null {
    const hint = this.hints[i];
    if (!hint) return null;
    const release = hint.holdUntil === null ? hint.at : Math.min(hint.holdUntil, hint.cutAt ?? Infinity);
    // Read to the microsecond, so float steps never tip a level across its rounding edge.
    const since = Math.round((this.clockMs - release) * 1000) / 1000;
    const bri = since < 0 ? hint.peak : Math.max(hint.floor, hint.peak * huePulseLevel(since) / 255);
    return { colour: hint.colour, bri };
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
  const stepMs = cadenceBeats * 60000 / tempoOf(bpm);
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

// A room's assignments, kept with the room: finding the nearest lamps for
// every anchor is quadratic in the lamps, too dear to repeat on every frame
// of a thousand-cell rig. The arrays are frozen, so no caller can alter one.
const channelMemo = new WeakMap<Room, Map<string, readonly number[]>>();
const ringMemo = new WeakMap<Room, readonly number[]>();

/** LDJ keeps its own corner indices; the legacy looks retain their established geometry. */
export function ldjChannels(room: Room, selector: LdjChannels, paletteCount = 1): number[] {
  let memo = channelMemo.get(room);
  if (!memo) { memo = new Map(); channelMemo.set(room, memo); }
  const key = selector === 'colours' ? `colours:${paletteCount}` : String(selector);
  let assigned = memo.get(key);
  if (!assigned) { assigned = Object.freeze(assignChannels(room, selector, paletteCount)); memo.set(key, assigned); }
  return assigned as number[];
}

/** The room's slots in ring order, the radial selectors' ranks. */
export function ldjRingOrder(room: Room): number[] {
  let order = ringMemo.get(room);
  if (!order) { order = Object.freeze(Array.from({ length: room.n }, (_, i) => i).sort((a, b) => room.ring[a] - room.ring[b])); ringMemo.set(room, order); }
  return order as number[];
}

function assignChannels(room: Room, selector: LdjChannels, paletteCount: number): number[] {
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
  // Each anchor's lamps nearest first, ties by index: its next pick is the
  // first of them still free, exactly the scan of every lamp for the nearest
  // free one, at n log n rather than n² (a thousand-cell rig in one frame).
  const nearest = anchors.map(([au, av]) => {
    const distance = Array.from({ length: n }, (_, i) => Math.hypot(room.u[i] - au, room.v[i] - av));
    return Array.from({ length: n }, (_, i) => i).sort((a, b) => distance[a] - distance[b] || a - b);
  });
  const cursor = Array<number>(count).fill(0);
  const assigned = Array<number>(n).fill(-1), sizes = Array<number>(count).fill(0);
  let remaining = n;
  while (remaining) {
    for (let channel = 0; channel < count; channel++) {
      if (sizes[channel] >= capacity[channel]) continue;
      const order = nearest[channel];
      while (assigned[order[cursor[channel]]] !== -1) cursor[channel]++;
      assigned[order[cursor[channel]]] = channel;
      sizes[channel]++;
      remaining--;
    }
  }
  return assigned;
}

/** `iterations` makes a row finite (a macro's single pulse, Flip's four updates): callbacks 0..iterations−1, then only its lamps' tails. */
export interface LdjParams { cadence: number; beats?: number; speed?: number; iterations?: number }
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

/** Positive safe integers only; omitted, a row calls back for as long as it runs. */
export const ldjIterationsSchema = z.number().int().positive().optional();
const paramsSchema = z.object({ cadence: z.number().min(MIN_CADENCE), beats: z.number().positive().optional(), speed: z.number().positive().optional(),
  iterations: ldjIterationsSchema });

export function makeLdjKind(name: string, row: LdjRow): EffectKindDef<LdjParams, LdjState> {
  return {
    kind: `ldj.${name}`, level: 'lamp', app: 'ldj', schema: paramsSchema,
    defaults: { params: { cadence: typeof row.cadence === 'number' ? row.cadence : 1, beats: row.beats ?? 32 } },
    rapidFlash: row.rapidFlash, stateful: true, rollOf: (state) => state.roll,
    ...(row.cadence === 'wall:50' ? { wallClock: true } : {}),
    rapidFlashWhen: (params) => row.cadence === 'wall:50' || (!row.nextDelayMs && params.cadence <= .25),
    init: (_params, room) => ({ lamps: new LdjLamps(room.n), lastIter: null, lastPick: null, recent: [], perm: null, roll: 0, scratch: {} }),
    render(params, state, room, frame, out) {
      if (!Number.isFinite(frame.nowMs)) throw new RangeError('Light DJ clock time must be finite');
      if (frame.paletteAccess) state.lamps.resolveColours(frame.paletteAccess);
      if (state.lastIter !== null) clockIteration(state.lastIter);
      if (params.iterations !== undefined && !(Number.isSafeInteger(params.iterations) && params.iterations > 0)) {
        throw new RangeError('Light DJ iterations must be a positive safe integer');
      }
      const limit = params.iterations ?? Infinity, finite = limit !== Infinity;
      const first = !state.timing;
      const originMs = frame.startedAtMs ?? state.timing?.originMs ?? frame.nowMs;
      const clock = row.cadence === 'wall:50'
        ? wallClock(frame.nowMs - originMs, 50, state.lastIter)
        : stepClock(frame.beatPos - frame.anchorBeat, params.cadence, frame.bpm, state.lastIter);
      // Where a callback falls on a cold render, at the current tempo for musical rows.
      const dueOf = (iter: number) => row.cadence === 'wall:50' ? originMs + iter * 50
        : frame.nowMs - (frame.beatPos - frame.anchorBeat - iter * params.cadence) * 60000 / tempoOf(frame.bpm);
      if (!state.timing) {
        // A cold finite row starts its lamps at its first callback, to replay them all.
        const lastMs = row.nextDelayMs ? originMs : finite && clock.iter >= 0 ? dueOf(0) : frame.nowMs - clock.phase * clock.stepMs;
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
        ringOrder: ldjRingOrder(room),
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
        while (timing.nextIter < limit && timing.nextDueMs <= frame.nowMs) {
          emit(timing.nextIter, timing.nextDueMs);
          const delay = row.nextDelayMs(ctx);
          if (!Number.isFinite(delay) || delay <= 0) throw new RangeError('Light DJ row delay must be finite and positive');
          const next = timing.nextDueMs + delay;
          if (!Number.isFinite(next) || next <= timing.nextDueMs) throw new RangeError('Light DJ row deadline must advance');
          timing.nextDueMs = next;
          timing.nextIter++;
        }
      } else if (first && !finite) emit(clock.iter, cursorMs);
      else if (first) {
        // Every callback so far, in order, so a late first render shows the
        // same tail as rendering every frame would have.
        for (let iter = 0; iter <= Math.min(clock.iter, limit - 1); iter++) emit(iter, Math.max(cursorMs, dueOf(iter)));
      } else if (clock.iter > (state.lastIter ?? (finite ? -1 : clock.iter))) {
        // Beat boundaries interpolate the conductor's consecutive samples;
        // a tap does not move an existing lamp fade or its integer iteration.
        // A finite row that has not started yet starts at callback 0.
        for (let iter = (state.lastIter ?? -1) + 1; iter <= Math.min(clock.iter, limit - 1); iter++) {
          const fraction = (frame.anchorBeat + iter * params.cadence - timing.lastBeat) / (frame.beatPos - timing.lastBeat);
          const due = row.cadence === 'wall:50' ? originMs + iter * 50
            : timing.lastMs + Math.max(0, Math.min(1, fraction)) * (frame.nowMs - timing.lastMs);
          emit(iter, Math.max(cursorMs, Math.min(frame.nowMs, due)));
        }
      } else if (clock.changed && (!finite || (clock.iter >= 0 && clock.iter < limit))) emit(clock.iter, frame.nowMs);
      advanceTo(frame.nowMs);
      timing.lastMs = frame.nowMs;
      timing.lastBeat = frame.beatPos;
      ctx.nowMs = frame.nowMs; ctx.elapsedMs = frame.nowMs - originMs;
      // A Hue lamp in pulse mode takes a row's marked hard flashes as the
      // strobe's pulse; everything else, and every other lamp, as drawn.
      const pulse = frame.hueStrobe === 'pulse';
      for (let i = 0; i < room.n; i++) {
        const lamp = state.lamps.read(i);
        const colour = row.outputColour?.(ctx, i, lamp) ?? lamp.colour;
        state.lamps.observe(i, colour);
        const tail = pulse && room.hue[i] ? state.lamps.pulse(i) : null;
        out[i] = tail ? { colour: { ...tail.colour }, level: tail.bri, strength: 1 } : { colour, level: lamp.bri, strength: 1 };
      }
    },
  };
}
