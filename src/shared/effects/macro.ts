import { z, ZodError } from 'zod';
import type { RefinementCtx, ZodType } from 'zod';
import type { Colour } from '../../types/rig.ts';
import { tempoOf } from '../look-math.ts';
import type { Room } from '../room.ts';
import { seedFrom } from './hash.ts';
import { MAX_NEST_DEPTH, anyChildSpec, nestRefusal, registerChildren, withinNest } from './nesting.ts';
import { pacesOwnFlashes, registerKind, requiresAcknowledgement, validateSpec } from './registry.ts';
import { renderEffect } from './render-instance.ts';
import { EffectStepper } from './stepper.ts';
import type { EffectFrame, EffectSlot, EffectSpec, PaletteEntry, Seed } from './types.ts';

export interface MacroStep {
  effect: EffectSpec;
  beats: number;
  paletteIndices?: number[];
}
export interface MacroParams { steps: MacroStep[]; loopBeats: number }

export const MAX_MACRO_DEPTH = MAX_NEST_DEPTH;
const STROBE = 'strobe';

const shapeSchema = z.object({ steps: z.array(z.unknown()).min(1), loopBeats: z.number().positive() }).strict();
const stepSchema = z.object({
  effect: z.unknown(),
  beats: z.number().positive(),
  paletteIndices: z.array(z.number().int().min(0).max(7)).min(1).max(8).optional(),
}).strict();

const forward = (ctx: RefinementCtx, error: unknown, path: PropertyKey[]) => {
  if (!(error instanceof ZodError)) throw error;
  for (const issue of error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: [...path, ...issue.path] });
};

const schema: ZodType<MacroParams> = z.unknown().transform((input, ctx): MacroParams => {
  const shape = shapeSchema.safeParse(input);
  if (!shape.success) { forward(ctx, shape.error, []); return z.NEVER; }
  // Validate the original array because its identity reveals cycles.
  const raw = (input as { steps: unknown[] }).steps;
  const refusal = nestRefusal(raw);
  if (refusal) {
    ctx.addIssue({ code: 'custom', message: refusal === 'cycle' ? 'a macro may not contain itself' : `macros nest at most ${MAX_MACRO_DEPTH} deep`, path: ['steps'] });
    return z.NEVER;
  }
  const steps: MacroStep[] = [];
  withinNest(raw, () => {
    shape.data.steps.forEach((item, k) => {
      const step = stepSchema.safeParse(item);
      if (!step.success) { forward(ctx, step.error, ['steps', k]); return; }
      let effect: EffectSpec;
      try { effect = validateSpec(step.data.effect); } catch (error) { forward(ctx, error, ['steps', k, 'effect']); return; }
      // Fresh steps reset self-paced flash limits, so strobe kinds cannot run inside macros.
      if (pacesOwnFlashes(effect)) {
        const strobe = effect.kind === STROBE;
        ctx.addIssue({ code: 'custom', message: `a macro may not hold ${strobe ? 'the strobe' : 'an automatic strobe'}`, path: ['steps', k, 'effect', strobe ? 'kind' : 'params'] });
        return;
      }
      steps.push({ ...step.data, effect });
    });
  });
  if (steps.length !== shape.data.steps.length) return z.NEVER;
  const total = steps.reduce((sum, step) => sum + step.beats, 0), loop = shape.data.loopBeats;
  // Allow rounding slack for decimal scores without accepting real gaps or overlaps.
  if (Math.abs(total - loop) > 4 * steps.length * Number.EPSILON * Math.max(total, loop)) {
    ctx.addIssue({ code: 'custom', message: `a macro's steps must fill its loop: ${total} beats of steps in a ${loop}-beat loop`, path: ['steps'] });
    return z.NEVER;
  }
  return { steps, loopBeats: loop };
});

interface Activation { lap: number; step: number; kind: string; id: string; seed: Seed; anchorBeat: number; startedAtMs: number }
interface MacroState { children: EffectStepper; active: Activation | null; last: { beat: number; ms: number } | null }


function locate(p: MacroParams, rel: number): { lap: number; step: number; start: number } {
  const lap = Math.floor(rel / p.loopBeats);
  const within = rel - lap * p.loopBeats;
  let start = 0;
  for (let k = 0; k < p.steps.length - 1; k++) {
    if (within < start + p.steps[k].beats) return { lap, step: k, start };
    start += p.steps[k].beats;
  }
  return { lap, step: p.steps.length - 1, start };
}

function stepAt(p: MacroParams, beatPos: number, anchorBeat: number): { lap: number; step: number; anchorBeat: number } | null {
  const rel = beatPos - anchorBeat;
  if (!Number.isFinite(rel)) return null;
  const { lap, step, start } = locate(p, rel);
  return { lap, step, anchorBeat: anchorBeat + lap * p.loopBeats + start };
}

// Cold samples back-project at the current tempo because earlier tempo history is unavailable.
function stepStart(s: MacroState, frame: EffectFrame, anchorBeat: number, first: boolean): number {
  const launch = Number.isFinite(frame.startedAtMs) ? frame.startedAtMs! : null;
  if (!s.last) {
    if (first && launch !== null) return launch;
    const back = frame.nowMs - (frame.beatPos - anchorBeat) * 60000 / tempoOf(frame.bpm);
    return launch !== null ? Math.max(launch, back) : back;
  }
  const span = frame.beatPos - s.last.beat, gone = anchorBeat - s.last.beat;
  if (!(span > 0) || gone >= span) return frame.nowMs;
  if (gone <= 0) return s.last.ms;
  return s.last.ms + (frame.nowMs - s.last.ms) * gone / span;
}

// Inherit raw palette entries so random colours roll in each child's own cache.
function stepColours(step: MacroStep, frame: EffectFrame): { spec: EffectSpec; override: Colour[] | null; look: Colour[] } {
  const override = frame.paletteOverride?.length ? frame.paletteOverride : null;
  const inherited = frame.spec.palette?.length ? frame.spec.palette : null;
  const { gradients, sets, gradient, gradientSet, gradientRole } = frame.spec;
  const settings = { gradients, sets, gradient, gradientSet, gradientRole };
  const roles = step.paletteIndices;
  if (!roles) return { spec: step.effect.palette?.length ? step.effect : { ...step.effect, ...settings, palette: inherited }, override, look: frame.lookPalette };
  const pick = <T>(source: readonly T[]): T[] => roles.map((i) => source[i % source.length]);
  if (override) return { spec: step.effect, override: pick(override), look: frame.lookPalette };
  if (inherited) return { spec: { ...step.effect, ...settings, palette: pick<PaletteEntry>(inherited) }, override: null, look: frame.lookPalette };
  return { spec: { ...step.effect, palette: null }, override: null, look: frame.lookPalette.length ? pick(frame.lookPalette) : frame.lookPalette };
}

function renderMacro(p: MacroParams, s: MacroState, room: Room, frame: EffectFrame, out: EffectSlot[]): void {
  const at = stepAt(p, frame.beatPos, frame.anchorBeat);
  if (!at || !Number.isFinite(frame.nowMs)) return;
  const { lap, step: k, anchorBeat } = at;
  const step = p.steps[k];
  let active = s.active;
  if (active && active.lap === lap && active.step === k && active.kind === step.effect.kind) {
    // Re-anchoring keeps child state and wall origin so clock jumps do not relaunch its effect.
    active.anchorBeat = anchorBeat;
  } else {
    s.children.reset();
    active = s.active = {
      lap, step: k, kind: step.effect.kind, id: `${frame.instanceId ?? ''}:${k}`,
      seed: seedFrom(`macro:${frame.seed.join(':')}:${k}:${lap}`), anchorBeat,
      startedAtMs: stepStart(s, frame, anchorBeat, lap === 0 && k === 0),
    };
  }
  s.last = { beat: frame.beatPos, ms: frame.nowMs };
  if (pacesOwnFlashes(step.effect)) return;
  const { spec, override, look } = stepColours(step, frame);
  // Children apply brightness once; the caller applies the macro's brightness and targets.
  renderEffect({ id: active.id, spec, seed: active.seed, anchorBeat: active.anchorBeat, startedAtMs: active.startedAtMs, targets: null },
    { ...frame, paletteOverride: override, lookPalette: look }, room, s.children, out);
  // Keep the innermost kind so family-specific guards see effects inside nested macros.
  for (let i = 0; i < room.n; i++) if (out[i]?.strength > 0) out[i].kind ??= step.effect.kind;
}

function anyStepRapid(params: MacroParams): boolean {
  const steps: unknown = (params as Partial<MacroParams> | null)?.steps;
  return Array.isArray(steps) && anyChildSpec(steps.map((item) => (item as Partial<MacroStep> | null)?.effect), requiresAcknowledgement);
}

registerChildren('macro', (params, beatPos, anchorBeat) => {
  const p = params as MacroParams;
  const at = stepAt(p, beatPos, anchorBeat);
  const effect = at && p.steps[at.step].effect;
  return effect && !pacesOwnFlashes(effect) ? [{ spec: effect, anchorBeat: at.anchorBeat }] : [];
});

registerKind<MacroParams, MacroState>({
  kind: 'macro', app: 'own', schema, stateful: true,
  defaults: { params: { steps: [{ effect: { kind: 'energy.glow', params: {} }, beats: 4 }], loopBeats: 4 } },
  rapidFlashWhen: anyStepRapid,
  init: () => ({ children: new EffectStepper(), active: null, last: null }),
  render: renderMacro,
});
