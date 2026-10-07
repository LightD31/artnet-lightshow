// Containers import this module to avoid validating the catalogue before all kinds register.

import type { Colour } from '../../types/rig.ts';
import type { Room } from '../room.ts';
import { kindOf, requiresAcknowledgement } from './registry.ts';
import { createPaletteAccess, resolvePalette } from './palette.ts';
import type { EffectInstance, EffectStepper } from './stepper.ts';
import type { EffectFrame, EffectSlot, FrameBase } from './types.ts';

const BLACK: Colour = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };

// Prepare runs only after admission and initialization so queued commands see valid state.
export function renderEffect(inst: EffectInstance, frame: FrameBase & { roll?: number }, room: Room, stepper: EffectStepper, out: EffectSlot[],
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
    // Initialization needs a palette before the kind can expose its own roll.
    f.palette = paletteAt(initialRoll);
    return def.init(inst.spec.params, at, f);
  }, frame.nowMs);
  prepare?.(state);
  f.roll = def.rollOf?.(state) ?? initialRoll;
  f.paletteAccess = createPaletteAccess(inst.spec, frame.paletteOverride, frame.lookPalette, inst.seed, f.roll, prepared);
  f.palette = f.paletteAccess.palette;
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
