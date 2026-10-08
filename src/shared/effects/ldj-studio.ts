// Studio keeps note brightness separate from colour ownership. Commands can
// change the background without stealing an active note or its queued start.

import { z } from 'zod';
import type { Colour } from '../../types/rig.ts';
import { tempoOf } from '../look-math.ts';
import type { Room } from '../room.ts';
import { pickExcluding } from './hash.ts';
import { LDJ_FRAME_MS } from './ldj-engine.ts';
import { paletteBinding } from './palette.ts';
import type { PaletteAccess, PaletteBinding } from './palette.ts';
import { registerKind } from './registry.ts';
import type { EffectCommand, Seed } from './types.ts';

const f32 = Math.fround, BASELINE = f32(.05);
const BLACK: Colour = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
const colourCopy = (colour: Colour): Colour => ({ ...colour });
const sameColour = (a: Colour, b: Colour) => (['r', 'g', 'b', 'w', 'a', 'uv'] as const).every((key) => (a[key] ?? 0) === (b[key] ?? 0));
type StudioMode = 'note' | 'swirl' | 'wave' | 'fireworks' | 'flashes' | 'stop' | 'fade'
  | 'visualizerSolid' | 'visualizerSwirl' | 'visualizerWave' | 'none';
export type StudioBackground = 'solid' | 'swirl' | 'wave' | 'none';
interface StudioLamp {
  bri: number; colour: Colour; binding?: PaletteBinding; target: Colour; targetBinding?: PaletteBinding;
  seconds: number; note: boolean; rgbFrom: Colour | null; rgbTo: Colour | null; rgbTick: number | null;
}
interface StudioPending {
  slot: number; delay: number; colour: Colour; binding?: PaletteBinding; seconds: number;
}
export interface StudioState {
  lamps: StudioLamp[]; pending: StudioPending[]; ring: number[]; angles: number[]; distances: number[]; waveLength: number;
  seed: Seed; recent: number[]; lastChosen: number | null; forward: boolean; notes: number;
  mode: StudioMode; baselineColour: Colour; baselineBinding?: PaletteBinding;
  backgroundColour: Colour; backgroundBinding?: PaletteBinding; pendingColour: Colour | null; restoreBackgroundColour: boolean;
  frame: number; remainderMs: number; lastMs: number; lastBpm: number; swirl: number; wave: number;
}

/** Plain state can be owned by a standalone preset or a retained visualizer bed. */
export function initStudio(room: Room, seed: Seed, colour: Colour, nowMs = 0, source = paletteBinding(colour)): StudioState {
  return {
    lamps: Array.from({ length: room.n }, () => ({ bri: BASELINE, colour: colourCopy(colour), binding: source && { ...source },
      target: colourCopy(colour), targetBinding: source && { ...source }, seconds: 0, note: false, rgbFrom: null, rgbTo: null, rgbTick: null })),
    pending: [], ring: Array.from({ length: room.n }, (_, slot) => slot).sort((a, b) => room.ring[a] - room.ring[b]),
    angles: [...room.ringDegrees], distances: [...room.waveDistance(0)], waveLength: room.waveLength(0, 4),
    seed: [...seed], recent: [], lastChosen: null, forward: false, notes: 0, mode: 'note',
    baselineColour: colourCopy(colour), baselineBinding: source && { ...source },
    backgroundColour: colourCopy(colour), backgroundBinding: source && { ...source }, pendingColour: null, restoreBackgroundColour: false,
    frame: 0, remainderMs: 0, lastMs: nowMs, lastBpm: 120, swirl: 0, wave: 20,
  };
}

function remember(state: StudioState, rank: number): void {
  state.recent.push(rank);
  state.recent.splice(0, Math.max(0, state.recent.length - Math.floor(state.lamps.length / 2)));
}
function install(state: StudioState, pending: StudioPending): void {
  const lamp = state.lamps[pending.slot];
  lamp.bri = 1; lamp.colour = colourCopy(pending.colour); lamp.binding = pending.binding && { ...pending.binding };
  lamp.seconds = pending.seconds; lamp.note = true; lamp.rgbFrom = null; lamp.rgbTo = null; lamp.rgbTick = null;
}

/** C reuses this instance's last N; five-note groups never overwrite that identity. */
export function triggerStudioNote(state: StudioState, type: 'N' | 'C' | '5x', beats: number, colour: Colour, bpm: number,
  source = paletteBinding(colour)): void {
  if (!Number.isFinite(beats) || beats <= 0) throw new RangeError('Studio note duration must be finite and positive');
  const n = state.lamps.length, event = state.notes++;
  if (!n) return;
  let ranks: number[];
  if (type === '5x') {
    const start = n <= 5 ? state.forward ? 0 : n - 1 : pickExcluding(state.seed, event, n, state.recent);
    if (n > 5) remember(state, start);
    ranks = Array.from({ length: Math.min(n, 5) }, (_, i) => (start + (state.forward ? i : -i) + n) % n);
  } else {
    let rank = type === 'C' ? state.lastChosen : null;
    if (rank === null) { rank = pickExcluding(state.seed, event, n, state.recent); remember(state, rank); state.lastChosen = rank; }
    ranks = [rank];
  }
  const seconds = beats * 60 / tempoOf(bpm);
  ranks.forEach((rank, ordinal) => {
    const pending = { slot: state.ring[rank], delay: ordinal * 10, colour: colourCopy(colour), binding: source && { ...source }, seconds };
    if (pending.delay) state.pending.push(pending);
    else install(state, pending);
  });
}

export function studioSwirlLevel(angle: number, offset: number, visualizer: boolean): number {
  const wrapped = ((angle + offset) % 360 + 360) % 360;
  const amplitude = f32(1 - f32(Math.abs(Math.sin(wrapped * Math.PI / 180)) / 2));
  const value = f32(f32(amplitude / 2) + f32(amplitude / 4));
  return visualizer ? f32(value - f32(.3)) : value;
}

export function studioWaveLevel(distance: number, length: number, index: number): number {
  if (!(length > 0)) return f32(.9);
  const size = f32(length), offset = f32(Math.floor(index / 395) * size);
  const position = f32(f32(length - distance + offset) / size);
  const sine = Math.abs(f32(Math.sin(position * Math.PI / 4)));
  return f32(f32(1 - f32(sine * f32(.8))) - f32(.1));
}

function toward(lamp: StudioLamp, target: number, delta: number): boolean {
  if (target > f32(lamp.bri + delta)) lamp.bri = f32(lamp.bri + delta);
  else if (target < f32(lamp.bri - delta)) lamp.bri = f32(lamp.bri - delta);
  else { lamp.bri = target; return true; }
  return false;
}

function colourTick(lamp: StudioLamp): void {
  if (lamp.rgbTick === null) {
    if (sameColour(lamp.colour, lamp.target)) return;
    lamp.rgbTick = 0; lamp.rgbFrom = colourCopy(lamp.colour); lamp.rgbTo = colourCopy(lamp.target);
  }
  const count = Math.floor(lamp.seconds * 22);
  if (lamp.rgbTick < count) {
    const t = lamp.rgbTick / count, from = lamp.rgbFrom!, to = lamp.rgbTo!;
    const mix = (key: keyof Colour) => Math.round((from[key] ?? 0) * (1 - t) + (to[key] ?? 0) * t);
    lamp.colour = { r: mix('r'), g: mix('g'), b: mix('b'), w: mix('w'), a: mix('a'), uv: mix('uv') };
    lamp.binding = undefined; lamp.rgbTick++;
  } else {
    lamp.colour = colourCopy(lamp.rgbTo!); lamp.binding = undefined;
    lamp.rgbFrom = null; lamp.rgbTo = null; lamp.rgbTick = null;
  }
}

// Passive palette refreshes cannot bend a running RGB fade. An explicit colour
// change does retarget it, keeping its original start colour and elapsed ticks.
function retargetColour(lamp: StudioLamp, colour: Colour): void {
  if (!lamp.note && lamp.rgbTick !== null) lamp.rgbTo = colourCopy(colour);
}

/** Reconfiguration is explicit; routine rendering must never undo a command. */
export function configureBackground(state: StudioState, mode: StudioBackground, colour: Colour): void {
  state.mode = mode === 'none' ? 'none' : mode === 'solid' ? 'visualizerSolid' : mode === 'swirl' ? 'visualizerSwirl' : 'visualizerWave';
  state.backgroundColour = colourCopy(colour); state.backgroundBinding = paletteBinding(colour);
  state.restoreBackgroundColour = false;
  if (mode !== 'none') for (const lamp of state.lamps) retargetColour(lamp, colour);
  if (mode === 'wave') state.wave = 20;
  if (mode === 'solid') {
    state.baselineColour = colourCopy(colour); state.baselineBinding = paletteBinding(colour);
    for (const lamp of state.lamps) if (!lamp.note) lamp.seconds = 1;
  }
}

export function studioCommand(state: StudioState, cmd: EffectCommand, arg?: Colour): void {
  switch (cmd) {
    case 'comboBreak': return;
    case 'toggleDirection': state.forward = !state.forward; return;
    case 'stop': state.mode = 'stop'; return;
    case 'setPulserBaselineColor': if (arg) state.pendingColour = colourCopy(arg); return;
    case 'fadeToBaseline':
      state.mode = 'fade';
      if (arg) {
        state.baselineColour = colourCopy(arg); state.baselineBinding = paletteBinding(arg);
        for (const lamp of state.lamps) retargetColour(lamp, arg);
      }
      // Continuous lamps have no note duration. A captured one-beat fallback
      // makes this command finish instead of leaving a zero-step fade stuck.
      for (const lamp of state.lamps) if (!(lamp.seconds > 0)) lamp.seconds = 60 / tempoOf(state.lastBpm);
      return;
  }
}

function resolveColours(state: StudioState, access?: PaletteAccess): void {
  if (!access) return;
  if (state.baselineBinding) state.baselineColour = colourCopy(access.colour(state.baselineBinding.index, state.baselineBinding.key));
  if (state.backgroundBinding) state.backgroundColour = colourCopy(access.colour(state.backgroundBinding.index, state.backgroundBinding.key));
  for (const lamp of state.lamps) {
    if (lamp.binding) lamp.colour = colourCopy(access.colour(lamp.binding.index, lamp.binding.key));
    if (lamp.targetBinding) lamp.target = colourCopy(access.colour(lamp.targetBinding.index, lamp.targetBinding.key));
  }
  for (const pending of state.pending) if (pending.binding) pending.colour = colourCopy(access.colour(pending.binding.index, pending.binding.key));
}

function tick(state: StudioState): void {
  state.frame++;
  if ((state.mode === 'fireworks' || state.mode === 'flashes') && state.frame % 5 === 0) {
    triggerStudioNote(state, 'N', state.mode === 'fireworks' ? 6 : 2, state.backgroundColour, state.lastBpm, state.backgroundBinding);
  }
  const waiting: StudioPending[] = [];
  for (const pending of state.pending) {
    if (pending.delay > 0) { pending.delay--; waiting.push(pending); }
    else install(state, pending);
  }
  state.pending = waiting;
  const pendingColour = state.pendingColour, restoreBackground = state.restoreBackgroundColour;
  state.restoreBackgroundColour = false;
  for (const slot of state.ring) {
    const lamp = state.lamps[slot], mode = state.mode;
    if (lamp.note || mode === 'note' || mode === 'fade' || mode === 'visualizerSolid') {
      const target = !lamp.note && mode === 'visualizerSolid' ? f32(.25) : BASELINE;
      const delta = !lamp.note && mode === 'visualizerSolid' ? f32(.02)
        : lamp.seconds > 0 ? f32(1 / f32(f32(lamp.seconds) * 22)) : 0;
      if (toward(lamp, target, delta) && lamp.note && mode !== 'note') {
        lamp.note = false;
        if (mode === 'visualizerSolid') lamp.seconds = 1;
      }
      lamp.target = colourCopy(state.baselineColour); lamp.targetBinding = state.baselineBinding && { ...state.baselineBinding };
    } else if (mode === 'stop' || mode === 'none') lamp.bri = 0;
    else if (mode === 'swirl' || mode === 'visualizerSwirl') {
      toward(lamp, studioSwirlLevel(state.angles[slot], state.swirl, mode === 'visualizerSwirl'), f32(.01));
      state.swirl = f32((f32(state.swirl + f32(.1)) + 360) % 360);
      lamp.target = colourCopy(state.backgroundColour); lamp.targetBinding = state.backgroundBinding && { ...state.backgroundBinding };
      if (restoreBackground) retargetColour(lamp, state.backgroundColour);
    } else if (mode === 'wave' || mode === 'visualizerWave') {
      toward(lamp, studioWaveLevel(state.distances[slot], state.waveLength, state.wave), f32(.01));
      state.wave = (state.wave + 1) % 3160;
      lamp.target = colourCopy(state.backgroundColour); lamp.targetBinding = state.backgroundBinding && { ...state.backgroundBinding };
      if (restoreBackground) retargetColour(lamp, state.backgroundColour);
    }
    // Brightness can release ownership on this tick. Pending colour then
    // becomes visible to the RGB stage, whose first interpolation sample is t0.
    if (pendingColour) {
      lamp.target = colourCopy(pendingColour); lamp.targetBinding = undefined;
      retargetColour(lamp, pendingColour);
    }
    if (!lamp.note) colourTick(lamp);
  }
  if (pendingColour) {
    state.baselineColour = colourCopy(pendingColour); state.baselineBinding = undefined;
    // The intent changes the baseline permanently, but Swirl/Wave own their
    // next tick's background target. Its one-tick RGB override must not latch.
    state.restoreBackgroundColour = true;
  }
  state.pendingColour = null;
}

/**
 * Advance the supplied state only; no timers, room handles or providers live inside it.
 * `onFrame` runs after each lamp frame: the Visualizer steps its spikes on the bed's own clock.
 */
export function advanceStudio(state: StudioState, nowMs: number, bpm: number, access?: PaletteAccess, onFrame?: () => void): void {
  if (!Number.isFinite(nowMs)) throw new RangeError('Studio time must be finite');
  resolveColours(state, access);
  state.lastBpm = tempoOf(bpm);
  state.remainderMs += Math.max(0, nowMs - state.lastMs); state.lastMs = nowMs;
  const frames = Math.floor((state.remainderMs + 1e-8) / LDJ_FRAME_MS);
  if (!Number.isSafeInteger(frames) || !Number.isSafeInteger(state.frame + frames)) throw new RangeError('Studio frame count exceeds the safe integer range');
  state.remainderMs = Math.max(0, state.remainderMs - frames * LDJ_FRAME_MS);
  for (let i = 0; i < frames; i++) { tick(state); onFrame?.(); }
}

export function readStudio(state: StudioState, slot: number): { colour: Colour; bri: number } {
  const lamp = state.lamps[slot];
  return lamp ? { colour: lamp.colour, bri: lamp.bri } : { colour: { ...BLACK }, bri: 0 };
}

const schema = z.object({}).strict();
const durations = [1, 2, 4, 6, 8];
const names = [...['N', 'C', '5x'].flatMap((prefix) => durations.map((_, i) => `Studio${prefix}${i + 1}`)),
  'StudioSwirl', 'StudioWave', 'StudioFireworks', 'StudioFlashes'];

for (const name of names) registerKind({
  kind: `ldj.${name}`, level: 'lamp', app: 'ldj', schema, defaults: { params: {} }, stateful: true,
  rapidFlash: name === 'StudioFireworks' || name === 'StudioFlashes', command: studioCommand,
  init(_params, room, frame) {
    const colour = frame.palette[0] ?? BLACK, binding = { index: 0, key: 0 };
    const state = initStudio(room, frame.seed, colour, frame.startedAtMs ?? frame.nowMs, binding);
    state.lastBpm = tempoOf(frame.bpm);
    const note = /^Studio(N|C|5x)([1-5])$/.exec(name);
    if (note) triggerStudioNote(state, note[1] as 'N' | 'C' | '5x', durations[Number(note[2]) - 1], colour, frame.bpm, binding);
    else if (name === 'StudioSwirl') state.mode = 'swirl';
    else if (name === 'StudioWave') state.mode = 'wave';
    else {
      state.mode = name === 'StudioFireworks' ? 'fireworks' : 'flashes';
      triggerStudioNote(state, 'N', state.mode === 'fireworks' ? 6 : 2, colour, frame.bpm, binding);
    }
    return state;
  },
  render(_params, state, room, frame, out) {
    advanceStudio(state, frame.nowMs, frame.bpm, frame.paletteAccess);
    for (let slot = 0; slot < room.n; slot++) {
      const lamp = readStudio(state, slot);
      out[slot] = { colour: lamp.colour, level: lamp.bri, strength: 1 };
    }
  },
});
