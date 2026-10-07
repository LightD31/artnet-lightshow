import { PATTERN_FUNCS, CELL_PATTERNS } from './patterns.ts';
import { fadeBrightness, grooveBrightness, hitBrightness } from './look-math.ts';
import { fadePhase, hitPhase } from './beat-clock.ts';
import type { PatternContext } from './patterns.ts';
import type { LayerPart, Layout, Rig } from './rig.ts';
import type { Colour, Expression, PulseReading } from '../types/rig.ts';

export interface LayerLook {
  pattern: string;
  colors: readonly Colour[];
  split?: number | null;
  pixelMap?: string | null;
  pixelPattern?: string | null;
  pixelSpan?: number | null;
  pixelFrom?: number | null;
  panelPattern?: string | null;
}

export interface LayerClock {
  beatPos: number;
  step: number;
  anchor: number;
  division: number;
  phase: number;
  expression: Readonly<Expression>;
  dynamicsOn: boolean;
  pulse?: Readonly<PulseReading> | null;
  bpm?: number | null;
  hueStrobe?: 'flash' | 'pulse';
  fixtureCount: number;
  twinkle: number[];
  pixelTwinkle?: number[];
  panelTwinkle?: number[];
}

interface Span { beats: number; from: number }

export type LayerSet = (unit: number, colour: Colour, dim: number, strobe: number) => void;

function renderLayer(rig: Rig, look: LayerLook, clock: LayerClock | null, set: LayerSet,
  { skipPattern = false, skipPixelPattern = false, skipPanelPattern = false } = {}): void {
  const whole = rig.layout(look.split, look.pixelMap);
  if (look.panelPattern && rig.hasPanels) {
    const part = (only: LayerPart, map = look.pixelMap) => rig.layout(look.split, map, only);
    if (!skipPanelPattern) {
      paintPart(rig, part('panels'), look.panelPattern, look, clock, clock?.panelTwinkle ?? clock?.twinkle, null, set);
    }
    if (look.pixelPattern) {
      if (!skipPattern) paintPart(rig, part('pars', 'stage'), look.pattern, look, clock, clock?.twinkle, null, set);
      if (!skipPixelPattern) {
        paintPart(rig, part('strips'), look.pixelPattern, look, clock, clock?.pixelTwinkle ?? clock?.twinkle, spanOf(look), set);
      }
    } else if (!skipPattern) {
      paintPart(rig, part('unpanelled'), look.pattern, look, clock, clock?.twinkle, spanOf(look), set);
    }
  } else if (look.pixelPattern && rig.hasPixels) {
    if (!skipPattern) paint(rig, rig.layout(look.split, 'stage', 'pars'), look.pattern, look, clock, clock?.twinkle, null, set, false);
    if (!skipPixelPattern) {
      paint(rig, rig.layout(look.split, look.pixelMap, 'cells'), look.pixelPattern, look, clock,
        clock?.pixelTwinkle ?? clock?.twinkle, spanOf(look), set, false);
    }
  } else if (!skipPattern) {
    paint(rig, whole, look.pattern, look, clock, clock?.twinkle, spanOf(look), set, true);
  }

  // Apply wash after the pattern so its selected fixtures keep the contrast colour.
  for (const i of whole.wash) {
    const { start, count } = rig.ranges[i];
    for (let u = start; u < start + count; u++) set(u, look.colors[1], 255, 0);
  }
}

function paintPart(rig: Rig, layout: Layout, pattern: string, look: LayerLook, clock: LayerClock | null,
  twinkle: number[] | undefined, span: Span | null, set: LayerSet): void {
  if (layout.units.list.length) paint(rig, layout, pattern, look, clock, twinkle, span, set, false);
}

function spanOf(look: LayerLook): Span | null {
  return look.pixelSpan ? { beats: look.pixelSpan, from: look.pixelFrom ?? 0 } : null;
}

function paint(rig: Rig, layout: Layout, pattern: string, look: LayerLook, clock: LayerClock | null,
  twinkle: number[] | undefined, span: Span | null, set: LayerSet, everyUnit: boolean): void {
  if (!clock) return;
  const { colors } = look;
  if (pattern === 'fade' || pattern === 'hit') {
    const groove = clock.pulse?.groove;
    const bright = pattern === 'fade'
      ? fadeBrightness(fadePhase(clock.beatPos, clock.anchor, clock.division))
      : groove === undefined ? hitBrightness(hitPhase(clock.beatPos, clock.division))
        : grooveBrightness(hitBrightness(hitPhase(clock.beatPos, clock.division)), groove);
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
    // Expressive patterns always need a resting expression, even without an active show.
    dynamics: pattern === 'ensemble' || pattern === 'ribbon' || clock.dynamicsOn ? clock.expression : null,
    pulse: clock.pulse ?? null,
    progress: span && span.beats > 0 ? Math.min(1, span.from + stepPos / division / span.beats) : null,
    stepMs: clock.bpm && clock.bpm > 0 ? 60000 / clock.bpm / division : null,
    hueStrobe: clock.hueStrobe,
  };

  if (CELL_PATTERNS.has(pattern)) {
    const { list, xs, ys, plan, noFlash } = layout.units;
    return {
      ...common,
      fixtureCount: list.length,
      xs,
      ys,
      plan,
      noFlash,
      write: (k, colour, dim, strobe) => set(list[k], colour, dim, strobe),
    };
  }
  const { members, order, xs, folded, plan, noFlash } = layout.fixtures;
  if (folded) {
    // Folded pairs have no single position, so mirrored patterns travel the fold instead of the plot.
    const slotOf = (member: number) => order.indexOf(member);
    return {
      ...common,
      fixtureCount: folded.length,
      xs: folded.length > 1 ? folded.map((_, k) => k / (folded.length - 1)) : null,
      ys: null,
      plan: null,
      noFlash: noFlash && folded.map((pair) => pair.some((slot) => noFlash[slotOf(slot)])),
      write: (k, colour, dim, strobe) => {
        for (const slot of folded[k]) {
          const { start, count } = rig.ranges[members[slot]];
          for (let u = start; u < start + count; u++) set(u, colour, dim, strobe);
        }
      },
    };
  }
  return {
    ...common,
    fixtureCount: members.length,
    xs,
    ys: null,
    plan,
    noFlash,
    write: (k, colour, dim, strobe) => {
      const { start, count } = rig.ranges[members[order[k]]];
      for (let u = start; u < start + count; u++) set(u, colour, dim, strobe);
    },
  };
}

export {
  renderLayer,
};
