// Matrix loops run on wall deadlines while each lamp keeps its own quantized
// transition. A new selection never discards another lamp's unfinished tail.

import { z } from 'zod';
import type { Colour } from '../../types/rig.ts';
import { hash01, pickExcluding } from './hash.ts';
import { ldjChannels, ldjIterationsSchema, makeLdjKind } from './ldj-engine.ts';
import type { LdjEnvelope, LdjParams, LdjState } from './ldj-engine.ts';
import { LDJ_ITERATION_ROWS } from './ldj-iteration.ts';
import { parseHex } from './palette.ts';
import { registerKind } from './registry.ts';
import type { EffectKindDef } from './types.ts';

type MatrixMode = 'pulse' | 'flash' | 'firework' | 'splotch';
const NUMERATOR = { pulse: 100, flash: 1000, firework: 1200, splotch: 600 };
const MINIMUM = { pulse: 100, flash: 135, firework: 150, splotch: 0 };

/** Integer wall intervals include a floor that matters on larger rigs. */
export function matrixInterval(mode: MatrixMode, n: number): number {
  if (n <= 0) return 1000;
  const base = n === 1 ? 200 : n <= 6 ? 100 - 10 * (n - 2) : 50;
  return Math.max(MINIMUM[mode], Math.floor(NUMERATOR[mode] / n) + base);
}

const paramsSchema = z.object({ cadence: z.number().min(.125), beats: z.number().positive().optional(), speed: z.number().positive().optional(),
  iterations: ldjIterationsSchema }).strict();
const definitions = new Map<MatrixMode, EffectKindDef<LdjParams, LdjState>>();

for (const [name, mode] of Object.entries({ PartyStrobe: 'pulse', MatrixPulse: 'pulse', MatrixFlash: 'flash',
  MatrixFirework: 'firework', MatrixSplotch: 'splotch' }) as [string, MatrixMode][]) {
  const def = makeLdjKind(name, {
    cadence: 1, channels: 'lights', rapidFlash: true,
    nextDelayMs: (ctx) => matrixInterval(mode, ctx.n),
    step(ctx) {
      if (!ctx.n) return;
      const rank = pickExcluding(ctx.seed, ctx.iter, ctx.n, ctx.state.recent), slot = ctx.ringOrder[rank];
      ctx.state.lastPick = rank;
      ctx.state.recent.push(rank);
      ctx.state.recent.splice(0, Math.max(0, ctx.state.recent.length - (ctx.n - 1)));
      const index = Math.floor(hash01(ctx.seed, 73, ctx.iter) * ctx.pal.length);
      const envelope: LdjEnvelope = mode === 'pulse' ? { kind: 'matrix', fadeIn: 0, peak: 350, fadeOut: 0 }
        : mode === 'flash' ? { kind: 'matrix', fadeIn: 0, peak: 10, fadeOut: 0 }
          : mode === 'splotch' ? { kind: 'matrix', fadeIn: 10, peak: 200, fadeOut: 1500 }
            : { kind: 'matrix', fadeIn: 50, peak: 150 + Math.floor(hash01(ctx.seed, 79, ctx.iter) * 101), fadeOut: 2000 };
      ctx.lamps.set(slot, ctx.colour(index, slot), 1, envelope);
      ctx.refresh(slot);
    },
  });
  def.schema = paramsSchema;
  registerKind(def);
  definitions.set(mode, def);
}

const cycle = makeLdjKind('MatrixCycle', LDJ_ITERATION_ROWS.MatrixCycle);
const boardSchema = z.object({
  colours: z.array(z.string().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i)).min(1).max(8),
  mode: z.enum(['fireworks', 'flashes', 'pulses', 'cycle', 'solid']),
}).strict();
type BoardParams = z.infer<typeof boardSchema>;
interface BoardState {
  key: string; mode: BoardParams['mode']; colours: Colour[]; lastSolidAtMs: number;
  child: LdjState | null; startedAtMs: number; anchorBeat: number;
}
const rapidMode = (params: BoardParams) => ['fireworks', 'flashes', 'pulses'].includes(params.mode);

registerKind<BoardParams, BoardState>({
  kind: 'ldj.matrixBoard', app: 'ldj', schema: boardSchema,
  defaults: { params: { colours: ['#FFFFFF'], mode: 'solid' } }, stateful: true,
  rapidFlashWhen: rapidMode, rollOf: (state) => state.child?.roll ?? 0,
  init: (params, _room, frame) => ({ key: JSON.stringify(params), mode: params.mode, colours: params.colours.map(parseHex),
    lastSolidAtMs: frame.nowMs, child: null, startedAtMs: frame.startedAtMs ?? frame.nowMs, anchorBeat: frame.anchorBeat }),
  render(params, state, room, frame, out) {
    const key = JSON.stringify(params);
    if (key !== state.key && !(params.mode === 'solid' && state.mode === 'solid' && frame.nowMs - state.lastSolidAtMs < 20)) {
      state.key = key; state.mode = params.mode; state.colours = params.colours.map(parseHex);
      state.lastSolidAtMs = frame.nowMs; state.child = null;
      state.startedAtMs = frame.nowMs; state.anchorBeat = frame.beatPos;
    }
    // The touched list is the local fallback, never a replacement for an
    // explicit spec palette or a global override. Its colours are parsed once.
    const common = Boolean(frame.paletteOverride?.length || frame.spec.palette?.length);
    const palette = common ? frame.palette : state.colours;
    const childFrame = { ...frame, palette, paletteAccess: common ? frame.paletteAccess : undefined,
      startedAtMs: state.startedAtMs, anchorBeat: state.anchorBeat };
    if (state.mode === 'solid') {
      const channels = ldjChannels(room, 'colours', palette.length);
      for (let i = 0; i < room.n; i++) out[i] = { colour: palette[channels[i]], level: 1, strength: 1 };
      return;
    }
    const mode = state.mode === 'pulses' ? 'pulse' : state.mode === 'flashes' ? 'flash' : 'firework';
    const def = state.mode === 'cycle' ? cycle : definitions.get(mode)!;
    state.child ??= def.init(def.defaults.params, room, childFrame);
    def.render(def.defaults.params, state.child, room, childFrame, out);
  },
});
