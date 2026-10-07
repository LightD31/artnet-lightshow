import { hardwareDecision, stricterPolicy } from '../hardware.ts';
import type { HardwareCaps, OutputNeeds } from '../hardware.ts';
import { MAX_NEST_DEPTH, playingChildren } from './nesting.ts';
import { kindOf } from './registry.ts';
import type { EffectSpec, FrameBase } from './types.ts';

// Cadence is an upper bound on requested events, not a hardware measurement.
export function effectNeeds(spec: EffectSpec, bpm: number): OutputNeeds {
  if (['energy.blinder', 'energy.glow', 'energy.uvWash', 'energy.kill'].includes(spec.kind)) return { flashHz: 0 };
  const p = spec.params, tempo = Math.max(1, bpm) / 60;
  if (['energy.whiteStrobe', 'energy.colorStrobe'].includes(spec.kind)) return { flashHz: 20 };
  if (spec.kind === 'strobe') return { flashHz: Number(p.flashesPerSecond) || 1 };
  if (kindOf(spec.kind)?.wallClock) return { flashHz: 20, transitionMs: 50 };
  if (typeof p.cadence === 'number') return { flashHz: tempo / p.cadence, transitionMs: p.cadence / tempo * 1000 };
  if (spec.kind.startsWith('hd.')) {
    const trigger = p.trigger as { mode?: string; beatInterval?: number } | undefined;
    const loop = Number(p.loopLength) || (spec.scope === 'singleBeat' ? 1 : Math.max(4, Number(p.attack) + Number(p.hold) + Number(p.release) || 4));
    const interval = trigger?.mode === 'beatAccent' ? trigger.beatInterval || loop : loop;
    return { flashHz: tempo * Math.max(1, Number(p.repetitions) || 1) / interval };
  }
  return { flashHz: tempo };
}

export function effectAdmission(spec: EffectSpec, frame: Pick<FrameBase, 'bpm' | 'admission'> & Partial<Pick<FrameBase, 'beatPos' | 'anchorBeat' | 'fixtureIds'>>,
  caps: HardwareCaps, depth = 0): ReturnType<typeof hardwareDecision> {
  if (spec.kind === 'macro' && depth < MAX_NEST_DEPTH) {
    const children = playingChildren(spec, frame.beatPos ?? 0, frame.anchorBeat ?? 0, frame.fixtureIds ?? []);
    if (children?.length) {
      const decisions = children.map((c) => effectAdmission(c.spec, { ...frame, anchorBeat: c.anchorBeat,
        admission: stricterPolicy(frame.admission, spec.admission) }, caps, depth + 1));
      return decisions.find((d) => d.mode !== 'exclude') ?? decisions[0];
    }
  }
  return hardwareDecision({ ...effectNeeds(spec, frame.bpm), ...kindOf(spec.kind)?.requirements }, caps, stricterPolicy(spec.admission, frame.admission));
}
