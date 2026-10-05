// Render one instance into slots, then compose voices in the same order in the
// server, its worker and the rehearsal preview.

import './index.ts';
import type { Colour } from '../../types/rig.ts';
import type { EffectSlot } from './types.ts';

export { renderEffect } from './render-instance.ts';

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
