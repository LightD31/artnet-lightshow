// Hue Dynamics' manual strobe as one kind: hard flashes in the effect's
// colours over whatever plays, full for 100 ms, black for 100 ms, then the
// layer below shows through (or black holds). The wall clock is the app's;
// the beat clock is the fork's hold strobe grid. Either way no flash rises
// sooner than ceil(1000 / rate) ms after the last one actually shown, so a
// tempo change or a late frame can never push it past five a second.

import { z } from 'zod';
import type { ZodType } from 'zod';
import type { Colour } from '../../types/rig.ts';
import type { Room } from '../room.ts';
import { HOLD_BLACK_MS, HOLD_FLASH_MS, HOLD_STROBE_MAX_HZ, HUE_PULSE_MS, holdStrobeDivision, holdStrobeFlash, huePulseLevel } from '../look-math.ts';
import { hdAutoStrobeFlash } from './disco.ts';
import { hash01 } from './hash.ts';
import { registerKind } from './registry.ts';
import type { EffectFrame, EffectSlot } from './types.ts';

export { hdAutoStrobeFlash } from './disco.ts';

/** The colours are the spec's palette (white by default), never a parameter. */
export interface StrobeParams {
  /** 1..5: Hue Dynamics' manual flashes per second. The beat clock takes the finest division within it. */
  flashesPerSecond: number;
  /** Between flashes the layer below shows (true) or black holds (false). */
  continueBetween: boolean;
  clock: 'wall' | 'beat';
  brightness: number;
  onMs: typeof HOLD_FLASH_MS;
  blackMs: typeof HOLD_BLACK_MS;
}

export const STROBE_DEFAULTS: StrobeParams = { flashesPerSecond: 2, continueBetween: true, clock: 'beat', brightness: 1, onMs: HOLD_FLASH_MS, blackMs: HOLD_BLACK_MS };

const schema: ZodType<StrobeParams> = z.object({
  flashesPerSecond: z.number().int().min(1).max(HOLD_STROBE_MAX_HZ),
  continueBetween: z.boolean(),
  clock: z.enum(['wall', 'beat']),
  brightness: z.number().min(0).max(1),
  onMs: z.literal(HOLD_FLASH_MS),
  blackMs: z.literal(HOLD_BLACK_MS),
}).strict();

const BLACK: Colour = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
const WHITE: Colour = { ...BLACK, r: 255, g: 255, b: 255 };

/** A grid flash: its identity (clock, division or period, index), where it started and its colour. */
interface Flash { id: string; startMs: number; colour: Colour }

/**
 * Plain data, so a preview checkpoint clones it. `seen` is the last grid flash
 * decided, admitted or not: a refused one stays refused for its whole interval.
 * `shown` is the last admitted flash, which plays out its full lifecycle.
 */
interface StrobeState { originMs: number; lastAdmitMs: number | null; seen: string | null; shown: Flash | null }

function gridFlash(p: StrobeParams, s: StrobeState, frame: EffectFrame, fps: number): Flash | null {
  const palette = frame.palette.length ? frame.palette : [WHITE];
  if (p.clock === 'wall') {
    const periodMs = Math.ceil(1000 / fps);
    const originMs = Number.isFinite(frame.startedAtMs) ? frame.startedAtMs! : s.originMs;
    const index = Math.floor((frame.nowMs - originMs) / periodMs);
    if (!Number.isFinite(index)) return null;
    // Hue Dynamics draws each flash's colour uniformly from the palette.
    const colour = palette[Math.floor(hash01(frame.seed, 0, index) * palette.length)];
    return { id: `wall:${periodMs}:${index}`, startMs: originMs + index * periodMs, colour };
  }
  const pos = frame.beatPos - frame.anchorBeat;
  if (!Number.isFinite(pos)) return null;
  const flash = holdStrobeFlash(pos, frame.bpm, fps);
  const n = palette.length;
  return { id: `beat:${holdStrobeDivision(frame.bpm, fps)}:${flash.index}`, startMs: frame.nowMs - flash.sinceMs, colour: palette[((flash.index % n) + n) % n] };
}

function renderStrobe(p: StrobeParams, s: StrobeState, room: Room, frame: EffectFrame, out: EffectSlot[]): void {
  if (!Number.isFinite(frame.nowMs)) return;
  const fps = Math.min(HOLD_STROBE_MAX_HZ, p.flashesPerSecond);
  const pulse = frame.hueStrobe === 'pulse';
  const candidate = gridFlash(p, s, frame, fps);
  if (!candidate) return;
  if (candidate.id !== s.seen) {
    s.seen = candidate.id;
    // Only a flash still in its bright part can rise now: 100 ms, or the 200 ms
    // fall when the room has a pulsed Hue lamp. The room decides, not the
    // target mask, so a par-only voice in a mixed room is held conservatively.
    const window = pulse && room.hue.some(Boolean) ? HUE_PULSE_MS : p.onMs;
    if (frame.nowMs - candidate.startMs < window && hdAutoStrobeFlash(frame.nowMs, s.lastAdmitMs ?? -Infinity, fps)) {
      s.lastAdmitMs = frame.nowMs;
      s.shown = { ...candidate, colour: { ...candidate.colour } };
    }
  }
  // A refused flash never cuts the admitted one short. Only an admitted flash
  // is ever lit: before the first, a sample shows the rest of the flash it
  // landed in — black, the layer below, or the Hue floor.
  const flash = s.shown ?? candidate;
  const age = frame.nowMs - flash.startMs;
  const hardAge = s.shown ? age : Math.max(age, p.onMs), pulseAge = s.shown ? age : Infinity;
  for (let i = 0; i < room.n; i++) {
    if (pulse && room.hue[i]) out[i] = { colour: { ...flash.colour }, level: huePulseLevel(pulseAge) / 255 * p.brightness, strength: 1 };
    else if (hardAge < p.onMs) out[i] = { colour: { ...flash.colour }, level: p.brightness, strength: 1 };
    else if (hardAge < p.onMs + p.blackMs || !p.continueBetween) out[i] = { colour: { ...BLACK }, level: 0, strength: 1 };
  }
}

registerKind<StrobeParams, StrobeState>({
  kind: 'strobe', app: 'own', schema, defaults: { params: STROBE_DEFAULTS, palette: ['#FFFFFF'], brightness: 1 },
  rapidFlash: true, stateful: true,
  // The wall clock counts from the instance's launch; a frame without one counts from the first render.
  init: (_params, _room, frame) => ({ originMs: Number.isFinite(frame.nowMs) ? frame.nowMs : 0, lastAdmitMs: null, seen: null, shown: null }),
  render: renderStrobe,
});
