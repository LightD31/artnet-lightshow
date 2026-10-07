/**
 * The photosensitivity limit: no more than three large-area flashes a second.
 *
 * The threshold is the one broadcast and web guidance share (WCAG 2.3.1,
 * ITU-R BT.1702, Ofcom's guidance on flashing images): a *flash* is a pair
 * of opposing changes in brightness of at least a tenth of full, the darker
 * of the two below 80 % of it, and more than three of them in any second over
 * a large part of what someone sees is the risk. A rig is that large part —
 * the whole room goes with it — so what is measured is the rig's brightness
 * as a whole: the mean of every fixture's light, a bar counting once like a
 * par, after the masters and the trims.
 *
 * Two things flash a rig, and each is limited where it happens:
 *
 *   the look      a strobing pattern, a `hit` at sixteenths, a run of kills.
 *                 Once a second has had its three flashes, the next swing is
 *                 held to under a tenth of full around where the light last
 *                 turned — the pattern still moves, it no longer flashes —
 *                 until the oldest flash is a second old.
 *   the strobe    a fixture's own strobe channel flashes it faster than any
 *                 frame can see, and the software strobe (renderer.ts)
 *                 flashes a fixture without one. Both are capped at three
 *                 flashes a second.
 *
 * Off by default, because most of what a party rig is for is above this
 * line; on is the setting for a venue that has to meet it.
 */

/** Flashes allowed in any second. */
const FLASHES_PER_SECOND = 3;
/** A change counts at a tenth of full brightness… */
const SWING = 0.1;
/** …and only when the darker side of it is below this. */
const DARKER = 0.8;
const WINDOW_MS = 1000;
// A flash is two opposing changes; three flashes, six changes.
const MAX_CHANGES = 2 * FLASHES_PER_SECOND;
// Held just inside the swing that would count.
const HOLD = SWING * 0.9;

export interface FlashLimiter {
  /** The brightness this frame may have, given what the look asks for (0..1). */
  target(luminance: number, now: number): number;
  /** What the frame actually put out, so the count follows the light. */
  commit(luminance: number, now: number): void;
  /** Forget the count: the limit was switched off, or the rig went quiet. */
  reset(): void;
}

function createFlashLimiter(): FlashLimiter {
  // Where the light last turned, and which way it has gone since.
  let extreme: number | null = null;
  let rising = true;
  const changes: number[] = [];

  const engaged = (now: number) => {
    while (changes.length && now - changes[0] >= WINDOW_MS) changes.shift();
    return changes.length >= MAX_CHANGES;
  };

  return {
    target(luminance, now) {
      if (extreme === null || !engaged(now)) return luminance;
      return Math.min(extreme + HOLD, Math.max(extreme - HOLD, luminance));
    },
    commit(luminance, now) {
      if (extreme === null) { extreme = luminance; return; }
      if (rising) {
        if (luminance >= extreme) extreme = luminance;
        else if (extreme - luminance >= SWING && luminance < DARKER) {
          changes.push(now);
          rising = false;
          extreme = luminance;
        }
      } else if (luminance <= extreme) {
        extreme = luminance;
      } else if (luminance - extreme >= SWING && extreme < DARKER) {
        changes.push(now);
        rising = true;
        extreme = luminance;
      }
    },
    reset() {
      extreme = null;
      rising = true;
      changes.length = 0;
    },
  };
}

/**
 * How bright a light is, 0..1: its relative luminance at full, scaled by its
 * dimmer. White counts in full and amber by half; UV barely lights anything.
 */
function lightLuminance(col: { r: number; g: number; b: number; w?: number; a?: number }, dim: number): number {
  const y = (0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b + (col.w || 0) + 0.5 * (col.a || 0)) / 255;
  return Math.min(1, y) * Math.max(0, Math.min(1, dim / 255));
}

/**
 * The fastest a strobe may run under the limit, as the 1–255 strobe value
 * the renderer maps to flashes a second (renderer.ts softStrobeHz).
 */
function strobeCap(hzOf: (raw: number) => number): number {
  let raw = 1;
  while (raw < 255 && hzOf(raw + 1) <= FLASHES_PER_SECOND) raw++;
  return raw;
}

export {
  createFlashLimiter,
  lightLuminance,
  strobeCap,
  FLASHES_PER_SECOND,
  SWING,
  DARKER,
};
