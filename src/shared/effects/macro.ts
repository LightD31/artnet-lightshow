// Light DJ's Scene Maker rows that change renderer mid-row (BigRoomMix, the
// genre scores) as one kind: a score of effects in beats that loops. Each step
// plays as its own instance with fresh state and its own seed, anchored where
// the step starts, so it plays the same on every lap however it is sampled.

import { z, ZodError } from 'zod';
import type { RefinementCtx, ZodType } from 'zod';
import type { Colour } from '../../types/rig.ts';
import type { Room } from '../room.ts';
import { seedFrom } from './hash.ts';
import { registerKind, requiresAcknowledgement, validateSpec } from './registry.ts';
import { renderEffect } from './render-instance.ts';
import { EffectStepper } from './stepper.ts';
import type { EffectFrame, EffectSlot, EffectSpec, PaletteEntry, Seed } from './types.ts';

export interface MacroStep {
  effect: EffectSpec;
  beats: number;
  /** Palette roles: the step plays these entries of the override, else of the macro's palette, else of the look. */
  paletteIndices?: number[];
}
export interface MacroParams { steps: MacroStep[]; loopBeats: number }

/** Macros inside macros stop here, long before validation or rendering could exhaust the stack. */
export const MAX_MACRO_DEPTH = 32;
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

// The step tables being validated, outermost first. Meeting one again means a
// macro inside itself; one child object shared by siblings is not a cycle.
const open: unknown[] = [];

const schema: ZodType<MacroParams> = z.unknown().transform((input, ctx): MacroParams => {
  const shape = shapeSchema.safeParse(input);
  if (!shape.success) { forward(ctx, shape.error, []); return z.NEVER; }
  // The caller's own array, not zod's copy: identity is what reveals a cycle.
  const raw = (input as { steps: unknown[] }).steps;
  if (open.includes(raw)) { ctx.addIssue({ code: 'custom', message: 'a macro may not contain itself', path: ['steps'] }); return z.NEVER; }
  if (open.length >= MAX_MACRO_DEPTH) {
    ctx.addIssue({ code: 'custom', message: `macros nest at most ${MAX_MACRO_DEPTH} deep`, path: ['steps'] });
    return z.NEVER;
  }
  open.push(raw);
  const steps: MacroStep[] = [];
  try {
    shape.data.steps.forEach((item, k) => {
      const step = stepSchema.safeParse(item);
      if (!step.success) { forward(ctx, step.error, ['steps', k]); return; }
      let effect: EffectSpec;
      try { effect = validateSpec(step.data.effect); } catch (error) { forward(ctx, error, ['steps', k, 'effect']); return; }
      // Every step is a fresh instance, so a strobe there would restart its
      // five-a-second permit each lap; the strobe plays as a voice of its own.
      if (effect.kind === STROBE) { ctx.addIssue({ code: 'custom', message: 'a macro may not hold the strobe', path: ['steps', k, 'effect', 'kind'] }); return; }
      steps.push({ ...step.data, effect });
    });
  } finally {
    open.pop();
  }
  if (steps.length !== shape.data.steps.length) return z.NEVER;
  const total = steps.reduce((sum, step) => sum + step.beats, 0), loop = shape.data.loopBeats;
  // Decimal tables (4 + 3.6 + 3.6 + 4.8) can miss their loop by rounding
  // alone; a real gap or overhang would leave beats nobody plays, or cut some.
  if (Math.abs(total - loop) > 4 * steps.length * Number.EPSILON * Math.max(total, loop)) {
    ctx.addIssue({ code: 'custom', message: `a macro's steps must fill its loop: ${total} beats of steps in a ${loop}-beat loop`, path: ['steps'] });
    return z.NEVER;
  }
  return { steps, loopBeats: loop };
});

interface Activation { lap: number; step: number; kind: string; id: string; seed: Seed; anchorBeat: number; startedAtMs: number }
/** The children live in the macro's own stepper, so they are cloned, swept and reset with it. */
interface MacroState { children: EffectStepper; active: Activation | null; last: { beat: number; ms: number } | null }

const tempo = (bpm: number) => Number.isFinite(bpm) && bpm > 0 ? bpm : 120;

/** The step playing `rel` beats after the macro's anchor: its lap, its index and where it starts in the loop. */
function locate(p: MacroParams, rel: number): { lap: number; step: number; start: number } {
  const lap = Math.floor(rel / p.loopBeats);
  const within = rel - lap * p.loopBeats;
  let start = 0;
  for (let k = 0; k < p.steps.length - 1; k++) {
    if (within < start + p.steps[k].beats) return { lap, step: k, start };
    start += p.steps[k].beats;
  }
  // The last step runs to the end of the loop, taking up the table's rounding.
  return { lap, step: p.steps.length - 1, start };
}

/**
 * When a step began in wall time, for its wall-clock children. Known at the
 * launch for the very first step; otherwise between the two samples around
 * its boundary, or, on a cold sample, back-projected at the current tempo but
 * never before the launch. History the frames never showed cannot be recovered.
 */
function stepStart(s: MacroState, frame: EffectFrame, anchorBeat: number, first: boolean): number {
  const launch = Number.isFinite(frame.startedAtMs) ? frame.startedAtMs! : null;
  if (!s.last) {
    if (first && launch !== null) return launch;
    const back = frame.nowMs - (frame.beatPos - anchorBeat) * 60000 / tempo(frame.bpm);
    return launch !== null ? Math.max(launch, back) : back;
  }
  const span = frame.beatPos - s.last.beat, gone = anchorBeat - s.last.beat;
  if (!(span > 0) || gone >= span) return frame.nowMs;
  if (gone <= 0) return s.last.ms;
  return s.last.ms + (frame.nowMs - s.last.ms) * gone / span;
}

/**
 * A step's colours. Without roles an override passes through, and a step with
 * no palette of its own (an explicit null included) takes the macro's raw
 * entries, so random ones roll in the step's own cache. With roles the step
 * plays those entries of the override, the macro's palette or the look,
 * whatever it would have picked itself.
 */
function stepColours(step: MacroStep, frame: EffectFrame): { spec: EffectSpec; override: Colour[] | null; look: Colour[] } {
  const override = frame.paletteOverride?.length ? frame.paletteOverride : null;
  const inherited = frame.spec.palette?.length ? frame.spec.palette : null;
  const roles = step.paletteIndices;
  if (!roles) return { spec: step.effect.palette?.length ? step.effect : { ...step.effect, palette: inherited }, override, look: frame.lookPalette };
  const pick = <T>(source: readonly T[]): T[] => roles.map((i) => source[i % source.length]);
  if (override) return { spec: step.effect, override: pick(override), look: frame.lookPalette };
  if (inherited) return { spec: { ...step.effect, palette: pick<PaletteEntry>(inherited) }, override: null, look: frame.lookPalette };
  return { spec: { ...step.effect, palette: null }, override: null, look: frame.lookPalette.length ? pick(frame.lookPalette) : frame.lookPalette };
}

function renderMacro(p: MacroParams, s: MacroState, room: Room, frame: EffectFrame, out: EffectSlot[]): void {
  const rel = frame.beatPos - frame.anchorBeat;
  if (!Number.isFinite(rel) || !Number.isFinite(frame.nowMs)) return;
  const { lap, step: k, start } = locate(p, rel);
  const step = p.steps[k];
  let active = s.active;
  if (!active || active.lap !== lap || active.step !== k || active.kind !== step.effect.kind) {
    // A new activation forgets the last one entirely: state, palette cache and all.
    const anchorBeat = frame.anchorBeat + lap * p.loopBeats + start;
    s.children.reset();
    active = s.active = {
      lap, step: k, kind: step.effect.kind, id: `${frame.instanceId ?? ''}:${k}`,
      seed: seedFrom(`macro:${frame.seed.join(':')}:${k}:${lap}`), anchorBeat,
      startedAtMs: stepStart(s, frame, anchorBeat, lap === 0 && k === 0),
    };
  }
  s.last = { beat: frame.beatPos, ms: frame.nowMs };
  // An unvalidated spec gets no further than validation would have let it.
  if (step.effect.kind === STROBE) return;
  const { spec, override, look } = stepColours(step, frame);
  // The child applies its own brightness and acknowledgement; the macro's
  // brightness and targets are applied once, by its caller, after this.
  renderEffect({ id: active.id, spec, seed: active.seed, anchorBeat: active.anchorBeat, startedAtMs: active.startedAtMs, targets: null },
    { ...frame, paletteOverride: override, lookPalette: look }, room, s.children, out);
  // Each slot names the step kind that drew it (the innermost, through
  // nested macros), so guards kept for one family still find its kinds here.
  for (let i = 0; i < room.n; i++) if (out[i]?.strength > 0) out[i].kind ??= step.effect.kind;
}

// A macro with a rapid step is itself rapid, so admission and rendering refuse
// it alike. Unvalidated specs may be cyclic: past the depth limit, assume the worst.
let asking = 0;
function anyStepRapid(params: MacroParams): boolean {
  if (asking >= MAX_MACRO_DEPTH) return true;
  asking++;
  try {
    const steps: unknown = (params as Partial<MacroParams> | null)?.steps;
    return Array.isArray(steps) && steps.some((item) => {
      const effect: unknown = (item as Partial<MacroStep> | null)?.effect;
      return effect !== null && typeof effect === 'object' && requiresAcknowledgement(effect as EffectSpec);
    });
  } finally {
    asking--;
  }
}

registerKind<MacroParams, MacroState>({
  kind: 'macro', app: 'own', schema, stateful: true,
  defaults: { params: { steps: [{ effect: { kind: 'energy.glow', params: {} }, beats: 4 }], loopBeats: 4 } },
  rapidFlashWhen: anyStepRapid,
  init: () => ({ children: new EffectStepper(), active: null, last: null }),
  render: renderMacro,
});
