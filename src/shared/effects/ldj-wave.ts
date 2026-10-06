// Sine waves retain an integer musical phase. Transition fronts instead
// accumulate distance at the tempo of each whole frame and restart on cue.

import { z } from 'zod';
import type { Colour } from '../../types/rig.ts';
import { tempoOf } from '../look-math.ts';
import { LDJ_FRAME_MS } from './ldj-engine.ts';
import { continuousSchema, ldjFrameAt, mixColours } from './ldj-rotation.ts';
import { registerKind } from './registry.ts';
import type { EffectFrame } from './types.ts';

const f32 = Math.fround;
const BLACK: Colour = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
const at = (frame: EffectFrame, index: number, key: number) => frame.paletteAccess?.colour(index, key)
  ?? frame.palette[((index % frame.palette.length) + frame.palette.length) % frame.palette.length] ?? BLACK;

interface SineState {
  originMs: number; frame: number; index: number; shownIndex: number; steps: number; refreshToggle: boolean;
}

for (const name of ['GrooveWave', 'Ascent', 'Vortex', 'Impact']) {
  const groove = name === 'GrooveWave', reverse = name === 'Vortex', radial = reverse || name === 'Impact';
  const wavelength = groove ? 4 : 2, heading = name === 'Ascent' ? 99 : 0;
  registerKind({
    kind: `ldj.${name}`, app: 'ldj', schema: continuousSchema, defaults: { params: { beats: 32 } }, stateful: true,
    init: (_params, _room, frame): SineState => ({ originMs: frame.startedAtMs ?? frame.nowMs, frame: -1,
      index: groove ? 20 : 0, shownIndex: groove ? 20 : 0, steps: 1, refreshToggle: false }),
    render(_params, state, room, frame, out) {
      const reached = ldjFrameAt(frame.nowMs, state.originMs), steps = Math.max(1, Math.floor(60000 / tempoOf(frame.bpm) / 22));
      if (!Number.isSafeInteger(steps * 2 * wavelength)) throw new RangeError('Wave phase exceeds the safe integer range');
      while (state.frame < reached) {
        state.frame++; state.shownIndex = state.index; state.steps = steps;
        if (!room.n) continue;
        state.index += reverse ? -1 : 1;
        if (Math.abs(state.index) >= steps * 2 * wavelength) state.index = 0;
        // Requests happen after that frame's sample. Palette access consumes
        // them on the next outer render, including a repeated timestamp.
        if (!state.refreshToggle && state.index === Math.floor(wavelength / 2) * steps - 1) {
          frame.paletteAccess?.refresh(1); state.refreshToggle = true;
        } else if (state.refreshToggle && state.index === Math.floor(3 * wavelength / 2) * steps + 1) {
          frame.paletteAccess?.refresh(0); state.refreshToggle = false;
        }
      }
      const distance = radial ? room.u.map((u, i) => Math.hypot(u, room.v[i])) : room.waveDistance(heading);
      const length = radial ? 2 : room.waveLength(heading, wavelength);
      for (let slot = 0; slot < room.n; slot++) {
        const sine = Math.sin(((length - distance[slot]) + state.shownIndex / state.steps * length) / length * Math.PI / wavelength);
        const local = sine < 0 ? 1 : 0;
        out[slot] = { colour: { ...at(frame, groove ? local : 1 - local, local) }, level: f32(Math.abs(sine)), strength: 1 };
      }
    },
  });
}

const HEADINGS = [0, 0, 180, 180];
const SWAGGER_HEADINGS = Array.from({ length: 7 }, (_, i) => (180 / 7 + 360 * i / 7) % 360);
const bigRoomSchema = continuousSchema.extend({ phase: z.number().int().min(0).max(3).default(0), once: z.boolean().default(false) });
interface WaveParams { beats: number; phase?: number; once?: boolean }
interface FrontState {
  originMs: number; lastNowMs: number; lastBeat: number; frontMs: number; frame: number;
  recreation: number; phase: number; heading: number; progress: number;
  endpoints: [Colour, Colour]; paletteKey: string; pendingCapture: boolean;
}

for (const name of ['BigRoomWave', 'DoubleWave', 'Swagger']) {
  const swagger = name === 'Swagger', bigRoom = name === 'BigRoomWave';
  const cadence = bigRoom ? .9 : swagger ? 1 : .5;
  registerKind<WaveParams, FrontState>({
    kind: `ldj.${name}`, app: 'ldj', schema: bigRoom ? bigRoomSchema : continuousSchema,
    defaults: { params: bigRoom ? { beats: 32, phase: 0, once: false } : { beats: 32 } }, stateful: true,
    init(_params, _room, frame) {
      const originMs = frame.startedAtMs ?? frame.nowMs;
      return { originMs, lastNowMs: originMs, lastBeat: frame.anchorBeat, frontMs: originMs, frame: -1,
        recreation: -1, phase: 0, heading: 0, progress: 0, endpoints: [{ ...BLACK }, { ...BLACK }],
        paletteKey: '', pendingCapture: false };
    },
    render(params, state, room, frame, out) {
      ldjFrameAt(frame.nowMs, state.originMs);
      if (!Number.isFinite(frame.beatPos) || !Number.isFinite(frame.anchorBeat)) throw new RangeError('Wave beats must be finite');
      const position = Math.max(0, frame.beatPos - frame.anchorBeat);
      const target = bigRoom && params.once ? 0 : Math.floor(position / cadence + 1e-9);
      if (!Number.isSafeInteger(target)) throw new RangeError('Wave recreation exceeds the safe integer range');
      const paletteKey = JSON.stringify(frame.paletteOverride?.length ? ['override', frame.paletteOverride]
        : frame.spec.palette?.length ? ['spec', frame.spec.palette] : ['look', frame.lookPalette]);
      const capture = () => {
        state.endpoints = [{ ...at(frame, 0, 0) }, { ...at(frame, 1, 1) }];
        state.paletteKey = paletteKey; state.pendingCapture = false;
      };
      // A front owns two captured endpoints. Its initial refresh is deferred
      // exactly once; later unrelated palette rolls cannot move the blend.
      if (state.pendingCapture || paletteKey !== state.paletteKey) capture();
      const advance = (untilMs: number) => {
        const reached = ldjFrameAt(untilMs, state.frontMs);
        while (state.frame < reached) {
          state.frame++;
          if (state.frame > 0) state.progress += LDJ_FRAME_MS * tempoOf(frame.bpm) / 60000;
        }
      };
      const recreate = (iteration: number, nowMs: number) => {
        state.recreation = iteration; state.phase = ((bigRoom ? params.phase ?? 0 : 0) + iteration) % (swagger ? 2 : 4);
        state.heading = swagger ? SWAGGER_HEADINGS[iteration % 7] : HEADINGS[state.phase % 4];
        state.frontMs = nowMs; state.frame = 0; state.progress = 0;
        frame.paletteAccess?.refresh(state.phase % 2 ? 0 : 1);
        capture(); state.pendingCapture = true;
      };
      if (state.recreation < 0) recreate(0, state.originMs);
      if (target < state.recreation) recreate(target, frame.nowMs);
      while (state.recreation < target) {
        const iteration = state.recreation + 1;
        const beat = frame.anchorBeat + iteration * cadence;
        const fraction = (beat - state.lastBeat) / (frame.beatPos - state.lastBeat);
        const due = state.lastNowMs + Math.max(0, Math.min(1, fraction)) * (frame.nowMs - state.lastNowMs);
        advance(due); recreate(iteration, due);
      }
      advance(frame.nowMs);
      state.lastNowMs = frame.nowMs; state.lastBeat = frame.beatPos;
      const distance = room.waveDistance(state.heading), front = state.progress * room.waveLength(state.heading, swagger ? 2 : 1);
      const [first, second] = state.endpoints;
      const ahead = state.phase % 2 ? second : first, behind = state.phase % 2 ? first : second;
      for (let slot = 0; slot < room.n; slot++) {
        const fraction = Math.max(0, Math.min(1, (distance[slot] - front) / .75));
        out[slot] = { colour: mixColours(ahead, behind, f32(fraction)), level: 1, strength: 1 };
      }
    },
  });
}
