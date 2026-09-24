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
import type { Colour, Expression, PulseReading } from '../types/rig.ts';

/** What the look asks the pattern layer for. */
export interface LayerLook {
  pattern: string;
  /** Colours A–D, resolved. */
  colors: readonly Colour[];
  /** The split look's wash seed, or nothing for an unsplit look. */
  split?: number | null;
  pixelMap?: string | null;
  /**
   * The picture the LED bars draw while the pars run `pattern`: the pars
   * carry the colour and the wash, the bars the movement. Nothing runs
   * `pattern` on the whole rig, as every look did before.
   */
  pixelPattern?: string | null;
  /** How many beats `pixelPattern` takes to play once (a build-up's fill), or nothing. */
  pixelSpan?: number | null;
  /** How far through that span it already is when the scene starts, 0..1. */
  pixelFrom?: number | null;
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
  /** The music at pixel rate, when a show with an analysed track runs. */
  pulse?: Readonly<PulseReading> | null;
  fixtureCount: number;
  twinkle: number[];
  /** The dice memory of the bars' own picture, apart from the pars'. */
  pixelTwinkle?: number[];
}

/** A picture that plays once: over how many beats, and how far in it starts. */
interface Span { beats: number; from: number }

/** Receives each unit's value. */
export type LayerSet = (unit: number, colour: Colour, dim: number, strobe: number) => void;

/**
 * @param rig    from shared/rig.js buildRig
 * @param look   { pattern, colors: [A, B, C, D], split, pixelMap, pixelPattern,
 *                 pixelSpan }
 * @param clock  { beatPos, step, anchor, division, phase, expression,
 *                 dynamicsOn, fixtureCount, twinkle, pixelTwinkle }, or null to
 *                 paint only the wash
 * @param set    (unit, colour, dim, strobe) => void
 * @param opts   skipPattern, skipPixelPattern: leave that part's units as they
 *               are (a random pattern between re-rolls) and paint the rest
 */
function renderLayer(rig: Rig, look: LayerLook, clock: LayerClock | null, set: LayerSet,
  { skipPattern = false, skipPixelPattern = false } = {}): void {
  const whole = rig.layout(look.split, look.pixelMap);
  if (look.pixelPattern && rig.hasPixels) {
    // Two parts: the pars on the look's pattern, the bars on their picture.
    if (!skipPattern) paint(rig, rig.layout(look.split, 'stage', 'pars'), look.pattern, look, clock, clock?.twinkle, null, set, false);
    if (!skipPixelPattern) {
      paint(rig, rig.layout(look.split, look.pixelMap, 'cells'), look.pixelPattern, look, clock,
        clock?.pixelTwinkle ?? clock?.twinkle, look.pixelSpan ? { beats: look.pixelSpan, from: look.pixelFrom ?? 0 } : null, set, false);
    }
  } else if (!skipPattern) {
    paint(rig, whole, look.pattern, look, clock, clock?.twinkle, null, set, true);
  }

  // The split look's wash group holds colour B, at full, under the music —
  // after the pattern, so the wash wins on its own lamps.
  for (const i of whole.wash) {
    const { start, count } = rig.ranges[i];
    for (let u = start; u < start + count; u++) set(u, look.colors[1], 255, 0);
  }
}

/**
 * One pattern across one layout's lights. `everyUnit` is the whole rig, where
 * the two envelopes light every unit as they always have; a part lights only
 * its own.
 */
function paint(rig: Rig, layout: Layout, pattern: string, look: LayerLook, clock: LayerClock | null,
  twinkle: number[] | undefined, span: Span | null, set: LayerSet, everyUnit: boolean): void {
  if (!clock) return;
  const { colors } = look;
  if (pattern === 'fade' || pattern === 'hit') {
    // The two whole-rig envelopes: an eight-beat breath from the scene's
    // anchor, and a decay across every step.
    const bright = pattern === 'fade'
      ? fadeBrightness(fadePhase(clock.beatPos, clock.anchor, clock.division))
      : hitBrightness(hitPhase(clock.beatPos, clock.division));
    if (everyUnit) for (let u = 0; u < rig.units.length; u++) set(u, colors[0], bright, 0);
    else for (const u of layout.units.list) set(u, colors[0], bright, 0);
    return;
  }
  const fn = PATTERN_FUNCS[pattern];
  if (fn) fn(patternContext(rig, layout, pattern, colors, clock, twinkle ?? clock.twinkle, span, set));
}

function patternContext(rig: Rig, layout: Layout, pattern: string, colors: readonly Colour[], clock: LayerClock,
  twinkle: number[], span: Span | null, set: LayerSet): PatternContext {
  const division = Math.max(1, clock.division || 1);
  const stepPos = Math.max(0, clock.beatPos * division - clock.anchor);
  const common = {
    colors,
    step: clock.step,
    stepPos,
    stepPhase: hitPhase(clock.beatPos, division),
    phase: clock.phase,
    hue: (clock.step * 360 / Math.max(1, clock.fixtureCount)) % 360,
    twinkle,
    // The two expressive patterns are built around the expression channel and
    // always get it — its resting values when no show is feeding it. The rest
    // use it only for what is genuinely a property of the music (how far the
    // unlit lamps sit above black, how dense a scatter is), and only when a
    // show is running it.
    dynamics: pattern === 'ensemble' || pattern === 'ribbon' || clock.dynamicsOn ? clock.expression : null,
    pulse: clock.pulse ?? null,
    // How far through its span a picture that plays once has got: the beats
    // since the scene began, over the beats it was given.
    progress: span && span.beats > 0 ? Math.min(1, span.from + stepPos / division / span.beats) : null,
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
