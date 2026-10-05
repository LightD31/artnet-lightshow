// Hue Dynamics' manual strobe as one kind: hard flashes in the effect's
// colours over whatever plays, full for 100 ms, black for 100 ms, then the
// layer below shows through (or black holds). The wall clock is the app's;
// the beat clock is the fork's hold strobe grid. Either way a permit holds
// every lamp to five flashes a second through tempo changes, late frames,
// relaunches and live edits (see `permits`).

import { z } from 'zod';
import type { ZodType } from 'zod';
import type { Colour } from '../../types/rig.ts';
import type { Room } from '../room.ts';
import { HOLD_BLACK_MS, HOLD_FLASH_MS, HOLD_STROBE_MAX_HZ, HUE_PULSE_FLOOR, HUE_PULSE_MS, holdStrobeDivision, holdStrobeFlash, huePulseLevel } from '../look-math.ts';
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

/** The engine's frame, 44 a second (server/frame-clock.ts): how late a render may see a flash that was due. */
export const STROBE_FRAME_MS = 1000 / 44;
// Float rounding of grid and frame times; far below anything a lamp shows.
const CLOCK_SLACK_MS = 1e-6;

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

/** A grid flash: its identity (clock, origin, division or period, index), when it was due and its colour. */
interface Flash { id: string; startMs: number; colour: Colour }

/**
 * Plain data, so a preview checkpoint clones it. `seen`: the last grid flash
 * decided, so a refused one stays refused. `shown`: the last admitted flash.
 * `rises`: the last five admissions' render times. `ceiling`: each slot's
 * level on the frame before, its limit until the next admission.
 */
interface StrobeState { originMs: number; rises: number[]; seen: string | null; shown: Flash | null; ceiling: number[] }

/** A rate the grid and permit can use: a hand-built spec's stray value falls to one a second, never above five. */
const rateOf = (fps: number) => Number.isFinite(fps) ? Math.max(1, Math.min(HOLD_STROBE_MAX_HZ, fps)) : 1;

/**
 * The per-lamp permit: may a grid flash due at `dueMs` rise at `nowMs`? A
 * rise is the frame a lamp shows a newly admitted flash; in between it only
 * dims. The flash must be due 1000/fps after the last one was due (the rate,
 * on the grid, where jitter cannot reach), and on every lamp it lights:
 * (a) no two rises closer than 1000/MAX_LAMP_FLASH_HZ − one frame, 177.3 ms;
 *     the frame is the grace for render quantisation;
 * (b) no more than MAX_LAMP_FLASH_HZ rises in any half-open 1000 ms.
 * On an ideal 44 Hz clock a grid at or below its rate, five a second
 * included, shows every flash. With ±2 ms of jitter, exactly five a second
 * loses about one in seven: jitter pulls a sixth rise under a second.
 */
function permits(s: StrobeState, dueMs: number, nowMs: number, fps: number): boolean {
  if (s.shown && !(dueMs - s.shown.startMs >= 1000 / fps - CLOCK_SLACK_MS)) return false;
  const last = s.rises[s.rises.length - 1];
  if (last !== undefined && !(nowMs - last >= 1000 / HOLD_STROBE_MAX_HZ - STROBE_FRAME_MS)) return false;
  const fifth = s.rises.length >= HOLD_STROBE_MAX_HZ ? s.rises[s.rises.length - HOLD_STROBE_MAX_HZ] : undefined;
  return fifth === undefined || nowMs - fifth >= 1000 - CLOCK_SLACK_MS;
}

function gridFlash(p: StrobeParams, s: StrobeState, frame: EffectFrame, fps: number): Flash | null {
  const palette = frame.palette.length ? frame.palette : [WHITE];
  if (p.clock === 'wall') {
    const periodMs = Math.ceil(1000 / fps);
    const originMs = Number.isFinite(frame.startedAtMs) ? frame.startedAtMs! : s.originMs;
    const index = Math.floor((frame.nowMs - originMs) / periodMs);
    if (!Number.isFinite(index)) return null;
    // Hue Dynamics draws each flash's colour uniformly from the palette.
    const colour = palette[Math.floor(hash01(frame.seed, 0, index) * palette.length)];
    // The origin is part of the identity: a relaunch on the same instance is a new grid.
    return { id: `wall:${originMs}:${periodMs}:${index}`, startMs: originMs + index * periodMs, colour };
  }
  const pos = frame.beatPos - frame.anchorBeat;
  if (!Number.isFinite(pos)) return null;
  const flash = holdStrobeFlash(pos, frame.bpm, fps);
  const n = palette.length;
  return { id: `beat:${frame.anchorBeat}:${holdStrobeDivision(frame.bpm, fps)}:${flash.index}`, startMs: frame.nowMs - flash.sinceMs,
    colour: palette[((flash.index % n) + n) % n] };
}

function renderStrobe(p: StrobeParams, s: StrobeState, room: Room, frame: EffectFrame, out: EffectSlot[]): void {
  if (!Number.isFinite(frame.nowMs)) return;
  const fps = rateOf(p.flashesPerSecond);
  const pulse = frame.hueStrobe === 'pulse';
  const candidate = gridFlash(p, s, frame, fps);
  if (!candidate) return;
  let rose = false;
  if (candidate.id !== s.seen) {
    s.seen = candidate.id;
    // Only a flash still in its bright part can rise now: 100 ms, or the 200 ms
    // fall when the room has a pulsed Hue lamp. The room decides, not the
    // target mask, so a par-only voice in a mixed room is held conservatively.
    const window = pulse && room.hue.some(Boolean) ? HUE_PULSE_MS : p.onMs;
    if (frame.nowMs - candidate.startMs < window && permits(s, candidate.startMs, frame.nowMs, fps)) {
      s.rises = [...s.rises.slice(1 - HOLD_STROBE_MAX_HZ), frame.nowMs];
      s.shown = { ...candidate, colour: { ...candidate.colour } };
      rose = true;
    }
  }
  // A refused flash never cuts the admitted one short; before the first, the
  // ceiling keeps a missed flash's bright part dark.
  const flash = s.shown ?? candidate;
  const age = frame.nowMs - flash.startMs;
  if (s.ceiling.length > room.n) s.ceiling.length = room.n;
  for (let i = 0; i < room.n; i++) {
    const hue = pulse && room.hue[i];
    // What the flash's lifecycle asks for; null is transparent.
    const want = hue ? huePulseLevel(age) / 255 * p.brightness
      : age < p.onMs ? p.brightness
        : age < p.onMs + p.blackMs || !p.continueBetween ? 0 : null;
    // Between admissions a lamp only dims (or returns to its held floor):
    // no edit and no burst of renders lights it again.
    const floor = hue ? HUE_PULSE_FLOOR / 255 * p.brightness : 0;
    const level = want === null ? null : rose ? want : Math.min(want, Math.max(s.ceiling[i] ?? 0, floor));
    s.ceiling[i] = level ?? 0;
    if (level !== null) out[i] = { colour: level > 0 ? { ...flash.colour } : { ...BLACK }, level, strength: 1 };
  }
}

registerKind<StrobeParams, StrobeState>({
  kind: 'strobe', app: 'own', schema, defaults: { params: STROBE_DEFAULTS, palette: ['#FFFFFF'], brightness: 1 },
  rapidFlash: true, stateful: true,
  // The wall clock counts from the instance's launch; a frame without one counts from the first render.
  init: (_params, _room, frame) => ({ originMs: Number.isFinite(frame.nowMs) ? frame.nowMs : 0, rises: [], seen: null, shown: null, ceiling: [] }),
  render: renderStrobe,
});
