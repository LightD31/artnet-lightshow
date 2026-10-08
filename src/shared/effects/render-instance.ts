import { resolveGradient } from '../palette-model.ts';
// Containers import this module to avoid validating the catalogue before all kinds register.

import type { Colour } from '../../types/rig.ts';
import type { Room } from '../room.ts';
import { kindOf, requiresAcknowledgement } from './registry.ts';
import { createPaletteAccess, resolvePalette } from './palette.ts';
import { EffectStepper } from './stepper.ts';
import type { EffectInstance } from './stepper.ts';
import { effectAdmission } from './hardware.ts';
import { stricterPolicy } from '../hardware.ts';
import type { EffectFrame, EffectSlot, FrameBase } from './types.ts';

const BLACK: Colour = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };

// Prepare runs only after admission and initialization so queued commands see valid state.
function renderCore(inst: EffectInstance, frame: FrameBase & { roll?: number }, room: Room, stepper: EffectStepper, out: EffectSlot[],
  prepare?: (state: unknown) => void): void {
  const def = kindOf(inst.spec.kind);
  if (!def || (requiresAcknowledgement(inst.spec) && !frame.acknowledged)) return;
  const lamps = def.level === 'lamp' ? room.lamps : undefined;
  const at = lamps ?? room;
  const prepared = stepper.palette(inst.id, inst.spec, frame.nowMs);
  const initialRoll = frame.roll ?? 0;
  const f: EffectFrame = { ...frame, spec: inst.spec, seed: inst.seed, anchorBeat: inst.anchorBeat, startedAtMs: inst.startedAtMs, instanceId: inst.id,
    palette: [], roll: initialRoll };
  if (lamps && frame.fixtureIds) f.fixtureIds = lamps.slots.map((slots) => frame.fixtureIds![slots[0]]);
  const paletteAt = (roll: number) => resolvePalette(inst.spec, frame.paletteOverride, frame.lookPalette, inst.seed, roll, prepared);
  const state = stepper.get(inst.id, () => {
    // Initialization can read the palette; a kind's own roll becomes available
    // only after it has created its state.
    f.palette = paletteAt(initialRoll);
    return def.init(inst.spec.params, at, f);
  }, frame.nowMs);
  prepare?.(state);
  f.roll = def.rollOf?.(state) ?? initialRoll;
  f.paletteAccess = createPaletteAccess(inst.spec, frame.paletteOverride, frame.lookPalette, inst.seed, f.roll, prepared);
  f.palette = f.paletteAccess.palette;
  f.gradient = resolveGradient(frame.paletteOverride?.length ? frame.overrideGradient
    : inst.spec.palette?.length ? inst.spec : frame.lookGradient, f.palette);
  // A fresh buffer prevents partial writes from dimming old slots or claiming untargeted cells.
  const cellsPass = lamps && def.renderCells;
  const slots: EffectSlot[] = Array.from({ length: cellsPass ? room.n : at.n }, () => ({ colour: { ...BLACK }, level: 0, strength: 0 }));
  if (cellsPass) cellsPass(inst.spec.params, state, lamps, f, slots);
  else def.render(inst.spec.params, state, at, f, slots);
  const brightness = inst.spec.brightness ?? 1;
  const copy = (i: number) => {
    if (Number.isInteger(i) && i >= 0 && i < room.n) {
      const slot = slots[lamps && !cellsPass ? lamps.lampOf[i] : i];
      out[i] = { ...slot, level: slot.level * brightness };
    }
  };
  if (inst.targets === null) for (let i = 0; i < room.n; i++) copy(i);
  else for (const i of inst.targets) copy(i);
}

// Each rate group keeps the full room and seed, preserving lamp selection and geometry.
export function renderEffect(inst: EffectInstance, frame: FrameBase & { roll?: number }, room: Room, stepper: EffectStepper, out: EffectSlot[],
  prepare?: (state: unknown) => void): void {
  if (!frame.hardware?.length || inst.spec.kind === 'macro' || inst.spec.kind === 'pattern.bundle') {
    renderCore(inst, { ...frame, admission: stricterPolicy(frame.admission, inst.spec.admission) }, room, stepper, out, prepare);
    return;
  }
  const runs = stepper.hardware(inst.id, frame.nowMs);
  const groups = new Map<string, { slots: number[]; decision: ReturnType<typeof effectAdmission> }>();
  const targets = inst.targets && new Set(inst.targets);
  const decisions = new Map();
  for (let k = 0; k < room.n; k++) {
    if (targets && !targets.has(k)) continue;
    const caps = frame.hardware[k];
    if (!caps) continue;
    const decision = decisions.get(caps) ?? effectAdmission(inst.spec, frame, caps);
    decisions.set(caps, decision);
    if (decision.mode === 'exclude') {
      out[k] = { colour: BLACK, level: 0, strength: 0, excluded: true };
      continue;
    }
    const key = decision.mode === 'play' ? 'play' : `${decision.mode}:${caps.maxFlashHz}:${caps.minTransitionMs}`;
    const group = groups.get(key);
    if (group) group.slots.push(k); else groups.set(key, { slots: [k], decision });
  }
  for (const key of runs.keys()) if (!groups.has(key)) runs.delete(key);
  for (const [key, { slots, decision }] of groups) {
    const ratio = decision.ratio;
    let run = runs.get(key);
    if (!run) {
      run = { stepper: new EffectStepper(), nowMs: inst.startedAtMs + (frame.nowMs - inst.startedAtMs) * ratio,
        beatPos: inst.anchorBeat + (frame.beatPos - inst.anchorBeat) * ratio, anchorBeat: inst.anchorBeat,
        lastMs: frame.nowMs, lastBeat: frame.beatPos, held: new Map() };
      runs.set(key, run);
    }
    if (run.anchorBeat !== inst.anchorBeat) {
      // Musical rebases restart the local phase without resetting wall-clock state.
      run.beatPos = inst.anchorBeat + (frame.beatPos - inst.anchorBeat) * ratio;
      run.anchorBeat = inst.anchorBeat;
      run.lastBeat = frame.beatPos;
    }
    const dtMs = Math.max(0, frame.nowMs - run.lastMs) * ratio;
    run.nowMs += dtMs;
    run.beatPos += (frame.beatPos - run.lastBeat) * ratio;
    run.lastMs = frame.nowMs; run.lastBeat = frame.beatPos;
    const rendered = new Array<EffectSlot>(room.n);
    renderCore({ ...inst, targets: slots }, { ...frame, hardware: undefined, nowMs: run.nowMs, beatPos: run.beatPos, dtMs }, room, run.stepper, rendered, prepare);
    for (const k of slots) {
      const slot = rendered[k];
      if (!slot) continue;
      slot.owner ??= inst.id;
      if (decision.mode === 'hold') {
        // Wait through an envelope's dark attack before capturing a meaningful value.
        if (!run.held.has(k) && slot.level > 0 && slot.strength > 0) run.held.set(k, { ...slot, strobe: 0 });
        out[k] = run.held.get(k) ?? slot;
      } else out[k] = slot;
    }
  }
}
