// Hue Dynamics' manual strobe as one kind: hard flashes in the effect's
// colours over whatever plays, full for 100 ms, black for 100 ms, then the
// layer below shows through (or black holds). The wall clock is the app's;
// the beat clock is the fork's hold strobe grid. Either way a permit on the
// engine's frame grid holds every lamp to five flashes a second through
// tempo changes, frame jitter, relaunches and live edits (see `permits`).

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

/** The engine's frame, 44 a second (server/frame-clock.ts): the clock the permit counts in. */
export const STROBE_FRAME_MS = 1000 / 44;
// Float rounding of grid times; far below anything a lamp shows.
const CLOCK_SLACK_MS = 1e-6;
/** (a): frames between two rises, ceil((1000/MAX_LAMP_FLASH_HZ − FRAME_MS) / FRAME_MS) = 8 at 44 Hz. */
const GAP_FRAMES = Math.ceil((1000 / HOLD_STROBE_MAX_HZ - STROBE_FRAME_MS) / STROBE_FRAME_MS);
/** (b): a second of frames, round(1000 / FRAME_MS) = 44, holds at most MAX_LAMP_FLASH_HZ rises. */
const WINDOW_FRAMES = Math.round(1000 / STROBE_FRAME_MS);

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
 * `rises`: the last five admissions' frames. `ceiling`: each slot's
 * level on the frame before, its limit until the next admission.
 */
interface StrobeState { originMs: number; rises: number[]; seen: string | null; shown: Flash | null; ceiling: number[] }

/** A rate the grid and permit can use: a hand-built spec's stray value falls to one a second, never above five. */
const rateOf = (fps: number) => Number.isFinite(fps) ? Math.max(1, Math.min(HOLD_STROBE_MAX_HZ, fps)) : 1;

/**
 * The per-lamp permit: may a grid flash due at `dueMs` rise on engine frame
 * `frameIndex`? A rise is the frame a lamp shows a newly admitted flash; in
 * between it only dims. The flash must be due 1000/fps after the last one was
 * due (the rate, on the grid), and on every lamp it lights:
 * (a) two rises are at least GAP_FRAMES frames apart (8: 181.8 ms);
 * (b) any WINDOW_FRAMES consecutive frames (44: one second) hold at most
 *     MAX_LAMP_FLASH_HZ rises.
 * Both count frames, round(t / FRAME_MS), not milliseconds: the lamps change
 * only once a frame, so the frame grid is the output's clock, and a render
 * a few ms early or late is still its frame, not a flash sooner. Which flash
 * is due is read at the frame's grid time too, so on an ideal clock or one
 * with ±2 ms of jitter a grid at or below its rate, five a second included,
 * shows every flash on the frame it falls due.
 */
function permits(s: StrobeState, dueMs: number, frameIndex: number, fps: number): boolean {
  if (s.shown && !(dueMs - s.shown.startMs >= 1000 / fps - CLOCK_SLACK_MS)) return false;
  const last = s.rises[s.rises.length - 1];
  if (last !== undefined && !(frameIndex - last >= GAP_FRAMES)) return false;
  const fifth = s.rises.length >= HOLD_STROBE_MAX_HZ ? s.rises[s.rises.length - HOLD_STROBE_MAX_HZ] : undefined;
  return fifth === undefined || frameIndex - fifth >= WINDOW_FRAMES;
}

function gridFlash(p: StrobeParams, s: StrobeState, frame: EffectFrame, fps: number, atMs: number): Flash | null {
  const palette = frame.palette.length ? frame.palette : [WHITE];
  if (p.clock === 'wall') {
    const periodMs = Math.ceil(1000 / fps);
    const originMs = Number.isFinite(frame.startedAtMs) ? frame.startedAtMs! : s.originMs;
    const index = Math.floor((atMs - originMs + CLOCK_SLACK_MS) / periodMs);
    if (!Number.isFinite(index)) return null;
    // Hue Dynamics draws each flash's colour uniformly from the palette.
    const colour = palette[Math.floor(hash01(frame.seed, 0, index) * palette.length)];
    // The origin is part of the identity: a relaunch on the same instance is a new grid.
    return { id: `wall:${originMs}:${periodMs}:${index}`, startMs: originMs + index * periodMs, colour };
  }
  // The beat at the frame's own time, at the current tempo.
  const shift = frame.bpm > 0 ? (atMs - frame.nowMs + CLOCK_SLACK_MS) * frame.bpm / 60000 : 0;
  const pos = frame.beatPos + shift - frame.anchorBeat;
  if (!Number.isFinite(pos)) return null;
  const flash = holdStrobeFlash(pos, frame.bpm, fps);
  const n = palette.length;
  return { id: `beat:${frame.anchorBeat}:${holdStrobeDivision(frame.bpm, fps)}:${flash.index}`, startMs: atMs - flash.sinceMs,
    colour: palette[((flash.index % n) + n) % n] };
}

function renderStrobe(p: StrobeParams, s: StrobeState, room: Room, frame: EffectFrame, out: EffectSlot[]): void {
  if (!Number.isFinite(frame.nowMs)) return;
  const fps = rateOf(p.flashesPerSecond);
  const pulse = frame.hueStrobe === 'pulse';
  // The engine frame this render is, and that frame's time on the grid;
  // the flash's own 100 ms profile still plays in real time.
  const frameIndex = Math.round(frame.nowMs / STROBE_FRAME_MS), atMs = frameIndex * STROBE_FRAME_MS;
  const candidate = gridFlash(p, s, frame, fps, atMs);
  if (!candidate) return;
  let rose = false;
  if (candidate.id !== s.seen) {
    s.seen = candidate.id;
    // Only a flash still in its bright part can rise now: 100 ms, or the 200 ms
    // fall when the room has a pulsed Hue lamp. The room decides, not the
    // target mask, so a par-only voice in a mixed room is held conservatively.
    const window = pulse && room.hue.some(Boolean) ? HUE_PULSE_MS : p.onMs;
    if (atMs - candidate.startMs < window && permits(s, candidate.startMs, frameIndex, fps)) {
      s.rises = [...s.rises.slice(1 - HOLD_STROBE_MAX_HZ), frameIndex];
      s.shown = { ...candidate, colour: { ...candidate.colour } };
      rose = true;
    }
  }
  // A refused flash never cuts the admitted one short; before the first, the
  // ceiling keeps a missed flash's bright part dark.
  const flash = s.shown ?? candidate;
  // Read to the microsecond: the grid's float slack must never tip a level
  // across its rounding edge (60 ms in is 191 of 255, 100 ms is 148).
  const age = Math.round((frame.nowMs - flash.startMs) * 1000) / 1000;
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
