/**
 * The pattern layer: what the look puts on every light, before a burst, a
 * pinned fixture, the music's level and the masters go on top.
 *
 * One function for the rig and the rehearsal preview. Each used to walk the
 * patterns its own way, and they had drifted — the preview handed the two
 * expressive patterns no dynamics where the rig handed them its resting ones,
 * so a ribbon rehearsed differently from how it played. Now both describe the
 * moment (the look, the clock) and this decides what every light shows, down
 * to the order a chase travels and which cells of a bar a wave rolls along.
 *
 * `set(u, colour, dim, strobe)` receives each unit's value (see shared/rig.js:
 * a par is one unit, each cell of a bar another). Units the pattern does not
 * write keep whatever the caller already holds for them.
 */

import { PATTERN_FUNCS, CELL_PATTERNS } from './patterns.ts';
import { fadeBrightness, hitBrightness } from './look-math.ts';
import { fadePhase, hitPhase } from './beat-clock.ts';
import type { PatternContext } from './patterns.ts';
import type { Layout, Rig } from './rig.ts';
import type { Colour, Expression } from '../types/rig.ts';

/** What the look asks the pattern layer for. */
export interface LayerLook {
  pattern: string;
  /** Colours A–D, resolved. */
  colors: readonly Colour[];
  /** The split look's wash seed, or nothing for an unsplit look. */
  split?: number | null;
  pixelMap?: string | null;
}

/** Where the music is, for the pattern layer. */
export interface LayerClock {
  beatPos: number;
  step: number;
  anchor: number;
  division: number;
  phase: number;
  expression: Readonly<Expression>;
  /** Is a show feeding the expression channel. */
  dynamicsOn: boolean;
  fixtureCount: number;
  twinkle: number[];
}

/** Receives each unit's value. */
export type LayerSet = (unit: number, colour: Colour, dim: number, strobe: number) => void;

/**
 * @param rig    from shared/rig.js buildRig
 * @param look   { pattern, colors: [A, B, C, D], split, pixelMap }
 * @param clock  { beatPos, step, anchor, division, phase, expression,
 *                 dynamicsOn, fixtureCount, twinkle }
 * @param set    (unit, colour, dim, strobe) => void
 * @param opts   skipPattern: leave the pattern's units as they are (a random
 *               pattern between re-rolls) and paint only the wash
 */
function renderLayer(rig: Rig, look: LayerLook, clock: LayerClock, set: LayerSet, { skipPattern = false } = {}): void {
  const { pattern, colors } = look;
  const layout = rig.layout(look.split, look.pixelMap);
  const unitTotal = rig.units.length;

  if (pattern === 'fade' || pattern === 'hit') {
    // The two whole-rig envelopes: an eight-beat breath from the scene's
    // anchor, and a decay across every step.
    const bright = pattern === 'fade'
      ? fadeBrightness(fadePhase(clock.beatPos, clock.anchor, clock.division))
      : hitBrightness(hitPhase(clock.beatPos, clock.division));
    for (let u = 0; u < unitTotal; u++) set(u, colors[0], bright, 0);
  } else if (!skipPattern) {
    const fn = PATTERN_FUNCS[pattern];
    if (fn) fn(patternContext(rig, layout, look, clock, set));
  }

  // The split look's wash group holds colour B, at full, under the music —
  // after the pattern, so the wash wins on its own lamps.
  for (const i of layout.wash) {
    const { start, count } = rig.ranges[i];
    for (let u = start; u < start + count; u++) set(u, colors[1], 255, 0);
  }
}

function patternContext(rig: Rig, layout: Layout, look: LayerLook, clock: LayerClock, set: LayerSet): PatternContext {
  const { pattern, colors } = look;
  const division = Math.max(1, clock.division || 1);
  const common = {
    colors,
    step: clock.step,
    stepPos: Math.max(0, clock.beatPos * division - clock.anchor),
    stepPhase: hitPhase(clock.beatPos, division),
    phase: clock.phase,
    hue: (clock.step * 360 / Math.max(1, clock.fixtureCount)) % 360,
    twinkle: clock.twinkle,
    // The two expressive patterns are built around the expression channel and
    // always get it — its resting values when no show is feeding it. The rest
    // use it only for what is genuinely a property of the music (how far the
    // unlit lamps sit above black, how dense a scatter is), and only when a
    // show is running it.
    dynamics: pattern === 'ensemble' || pattern === 'ribbon' || clock.dynamicsOn ? clock.expression : null,
  };

  if (CELL_PATTERNS.has(pattern)) {
    const { list, xs, ys } = layout.units;
    return {
      ...common,
      fixtureCount: list.length,
      xs,
      ys,
      write: (k, colour, dim, strobe) => set(list[k], colour, dim, strobe),
    };
  }
  const { members, order, xs } = layout.fixtures;
  return {
    ...common,
    fixtureCount: members.length,
    xs,
    ys: null,
    // A bar is one slot of a chase: every cell takes the slot's colour.
    write: (k, colour, dim, strobe) => {
      const { start, count } = rig.ranges[members[order[k]]];
      for (let u = start; u < start + count; u++) set(u, colour, dim, strobe);
    },
  };
}

export {
  renderLayer,
};
