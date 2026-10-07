import { maximumFlashHz } from './hardware.ts';
import type { Colour } from '../types/rig.ts';
import type { RateLimits } from './hardware.ts';

interface History { bright: boolean; lastRise: number; level: number; time: number; colour?: Colour; owner?: string }
const peakOf = (colour: Colour) => Math.max(colour.r, colour.g, colour.b, colour.w || 0, colour.a || 0, colour.uv || 0) / 255;

// This history belongs to an output unit, surviving preset and voice handovers.
export class HardwareGuard {
  private history = new Map<string, History>();

  apply(id: string, level: number, now: number, limits: RateLimits): number {
    let held = this.history.get(id);
    if (!held || now < held.time) {
      held = { bright: false, lastRise: -Infinity, level: 0, time: now - 1000 / 44 };
      this.history.set(id, held);
    }
    const bright = level > 0.15;
    const rising = bright && !held.bright;
    const interval = 1000 / maximumFlashHz(limits);
    if (rising && now - held.lastRise < interval - 1e-6) level = Math.min(level, held.level);
    else if (rising) held.lastRise = now;
    const delta = limits.minTransitionMs > 0 ? Math.max(0, now - held.time) / limits.minTransitionMs : 1;
    const next = Math.max(held.level - delta, Math.min(held.level + delta, level));
    held.bright = level > 0.15; held.level = next; held.time = now;
    return next;
  }

  light(id: string, colour: Colour, dim: number, now: number, limits: RateLimits,
    owner: string, immediateBlack = false): { colour: Colour; dim: number } {
    const requested = dim / 255 * peakOf(colour);
    const previous = this.history.get(id);
    if (previous && (immediateBlack || previous.owner !== owner)) {
      previous.colour = undefined;
      previous.level = immediateBlack ? 0 : Math.min(previous.level, requested);
      previous.bright = !immediateBlack && previous.bright && requested > .15;
    }
    const allowed = this.apply(id, immediateBlack ? 0 : requested, now, limits);
    const held = this.history.get(id)!;
    held.owner = owner;
    if (immediateBlack) { held.level = 0; held.colour = undefined; return { colour, dim: 0 }; }
    if (requested > 0) {
      held.colour = { ...colour };
      return { colour, dim: Math.abs(allowed - requested) < 1e-12 ? dim : Math.min(255, dim * allowed / requested) };
    }
    // Only the same owner's ordinary off-frame may retain a visible fading tail.
    return held.colour && allowed > 0 ? { colour: held.colour, dim: Math.min(255, 255 * allowed / peakOf(held.colour)) } : { colour, dim: 0 };
  }

  blackout(): void {
    for (const entry of this.history.values()) { entry.level = 0; entry.bright = false; entry.colour = undefined; }
  }

  retain(ids: ReadonlySet<string>): void {
    for (const id of this.history.keys()) if (!ids.has(id)) this.history.delete(id);
  }

  clone(): HardwareGuard {
    const copy = new HardwareGuard();
    copy.history = new Map([...this.history].map(([id, value]) => [id, { ...value, colour: value.colour && { ...value.colour } }]));
    return copy;
  }
}
