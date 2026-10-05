// Render one instance into slots, then compose voices in the same order in the
// server, its worker and the rehearsal preview.

import './index.ts';
import type { Colour } from '../../types/rig.ts';
import type { Room } from '../room.ts';
import { kindOf, requiresAcknowledgement } from './registry.ts';
import { createPaletteAccess, resolvePalette } from './palette.ts';
import type { EffectInstance, EffectStepper } from './stepper.ts';
import type { EffectFrame, EffectSlot, FrameBase } from './types.ts';

const BLACK: Colour = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };

export function renderEffect(inst: EffectInstance, frame: FrameBase & { roll?: number }, room: Room, stepper: EffectStepper, out: EffectSlot[]): void {
  const def = kindOf(inst.spec.kind);
  if (!def || (requiresAcknowledgement(inst.spec) && !frame.acknowledged)) return;
  const prepared = stepper.palette(inst.id, inst.spec, frame.nowMs);
  const initialRoll = frame.roll ?? 0;
  const f: EffectFrame = { ...frame, spec: inst.spec, seed: inst.seed, anchorBeat: inst.anchorBeat, startedAtMs: inst.startedAtMs, palette: [], roll: initialRoll };
  const paletteAt = (roll: number) => resolvePalette(inst.spec, frame.paletteOverride, frame.lookPalette, inst.seed, roll, prepared);
  const state = stepper.get(inst.id, () => {
    // Initialization can read the palette; a kind's own roll becomes available
    // only after it has created its state.
    f.palette = paletteAt(initialRoll);
    return def.init(inst.spec.params, room, f);
  }, frame.nowMs);
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

export interface VoiceLayer {
  slots: EffectSlot[];
  tier: 'strobe' | 'voice';
  launchSeq: number;
  selected: boolean;
  startedAtMs: number;
}

export function compositeVoices(base: EffectSlot[], voices: VoiceLayer[]): EffectSlot[] {
  const priority = [...voices].sort((a, b) => Number(b.tier === 'strobe') - Number(a.tier === 'strobe')
    || b.launchSeq - a.launchSeq || Number(b.selected) - Number(a.selected) || b.startedAtMs - a.startedAtMs);
  // Strength is ownership, not opacity: even black can hide the base.
  return base.map((slot, i) => priority.find((voice) => (voice.slots[i]?.strength ?? 0) > 0)?.slots[i] ?? slot);
}

export function slotToWrite(slot: EffectSlot): { colour: Colour; dim: number; strobe: number } {
  return { colour: slot.colour, dim: Math.round(255 * slot.level), strobe: slot.strobe ?? 0 };
}
