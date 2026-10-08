import { hardwareDecision, maximumFlashHz } from './hardware.ts';
import type { HardwareCaps } from './hardware.ts';

const STANDARD_STROBE_STEPS = 250 - 128;
interface StrobePlan { raw: number | null; level: number; previewLevel: number }
const plan = (raw: number | null, level: number, previewLevel = level): StrobePlan => ({ raw, level, previewLevel });

export function hardwareStrobe(raw: number, caps: HardwareCaps, nowMs: number, limitHz = Infinity): StrobePlan {
  if (!(raw > 0)) return plan(null, 1);
  const range = caps.strobeHz ?? { min: 1, max: 20 };
  const pulse = (hz: number) => ((nowMs * hz / 1000) % 1 + 1) % 1 < .5 ? 1 : 0;
  const nativeHz = (speed: number) => range.min + Math.round(speed / 255 * STANDARD_STROBE_STEPS) / STANDARD_STROBE_STEPS * (range.max - range.min);
  const fraction = Math.min(255, raw) / 255;
  const requested = caps.strobeHz ? Math.round(fraction * STANDARD_STROBE_STEPS) / STANDARD_STROBE_STEPS : fraction;
  const asked = range.min + requested * (range.max - range.min);
  const decision = hardwareDecision({ flashHz: asked, hardwareChannel: true }, caps);
  if (decision.mode === 'exclude') return plan(null, 0);
  if (decision.mode === 'hold') return plan(null, 1);
  const hz = Math.min(asked, maximumFlashHz(caps), limitHz, caps.strobeHz ? Infinity : 22);
  if (caps.strobeHz && hz >= range.min) {
    if (hz === asked && asked > 0) return plan(raw, 1, pulse(nativeHz(raw)));
    if (range.min === range.max) return plan(raw, 1, pulse(range.min));
    // Bound the final rounded DMX step, not only its intermediate speed byte.
    const step = Math.floor((hz - range.min) / (range.max - range.min) * STANDARD_STROBE_STEPS + 1e-9);
    const rawLimit = Math.ceil((step + .5) / STANDARD_STROBE_STEPS * 255) - 1;
    if (range.min + step / STANDARD_STROBE_STEPS * (range.max - range.min) > 0) {
      const speed = Math.max(0, Math.min(raw, rawLimit));
      return plan(speed, 1, pulse(nativeHz(speed)));
    }
  }
  return plan(null, pulse(hz));
}
