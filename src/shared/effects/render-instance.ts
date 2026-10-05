// One instance rendered into slots. A kind that renders other kinds (the
// macro) imports this rather than render.ts: render.ts loads every kind and the
// catalogue, and the catalogue's macros would validate before the macro kind
// had registered.

import type { Colour } from '../../types/rig.ts';
import type { Room } from '../room.ts';
import { kindOf, requiresAcknowledgement } from './registry.ts';
import { createPaletteAccess, resolvePalette } from './palette.ts';
import type { EffectInstance, EffectStepper } from './stepper.ts';
import type { EffectFrame, EffectSlot, FrameBase } from './types.ts';

const BLACK: Colour = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };

/**
 * `prepare`, when given, runs on the instance's state after its legitimate
 * initialization and before this frame's sample: the renderer applies queued
 * commands there. It does not run when the kind is unknown or not admitted.
 */
export function renderEffect(inst: EffectInstance, frame: FrameBase & { roll?: number }, room: Room, stepper: EffectStepper, out: EffectSlot[],
  prepare?: (state: unknown) => void): void {
  const def = kindOf(inst.spec.kind);
  if (!def || (requiresAcknowledgement(inst.spec) && !frame.acknowledged)) return;
  const prepared = stepper.palette(inst.id, inst.spec, frame.nowMs);
  const initialRoll = frame.roll ?? 0;
  const f: EffectFrame = { ...frame, spec: inst.spec, seed: inst.seed, anchorBeat: inst.anchorBeat, startedAtMs: inst.startedAtMs, instanceId: inst.id,
    palette: [], roll: initialRoll };
  const paletteAt = (roll: number) => resolvePalette(inst.spec, frame.paletteOverride, frame.lookPalette, inst.seed, roll, prepared);
  const state = stepper.get(inst.id, () => {
    // Initialization can read the palette; a kind's own roll becomes available
    // only after it has created its state.
    f.palette = paletteAt(initialRoll);
    return def.init(inst.spec.params, room, f);
  }, frame.nowMs);
  prepare?.(state);
  f.roll = def.rollOf?.(state) ?? initialRoll;
  f.paletteAccess = createPaletteAccess(inst.spec, frame.paletteOverride, frame.lookPalette, inst.seed, f.roll, prepared);
  f.palette = f.paletteAccess.palette;
  // A fresh transparent buffer prevents partial writes from dimming old slots
  // again, and keeps non-target slots entirely owned by the layer below.
  const slots: EffectSlot[] = Array.from({ length: room.n }, () => ({ colour: { ...BLACK }, level: 0, strength: 0 }));
  def.render(inst.spec.params, state, room, f, slots);
  const brightness = inst.spec.brightness ?? 1;
  const copy = (i: number) => {
    if (Number.isInteger(i) && i >= 0 && i < room.n) out[i] = { ...slots[i], level: slots[i].level * brightness };
  };
  if (inst.targets === null) for (let i = 0; i < room.n; i++) copy(i);
  else for (const i of inst.targets) copy(i);
}
