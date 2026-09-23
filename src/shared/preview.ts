// Pure rehearsal sampler. Replays a planned timeline so the browser can show
// what a track will look like before the room is full.
//
// It shares its arithmetic with the live engine rather than restating it: the
// pattern functions come from patterns.js, and every curve, burst colour and
// emitter scale comes from shared/look-math.js. An earlier version kept its own
// copies and had already drifted — it showed a cool-white blinder where the rig
// throws warm and a UV wash at a little over half its real level. A rehearsal
// view that is confidently wrong is worse than none.
//
// Two things it deliberately does not reproduce, both operator state rather
// than show state:
//
//   * the grand master and master blackout — rehearsing a track with the rig
//     blacked out is exactly when this view is useful, and an operator who left
//     the master down should still see the show;
//   * strobe, which has no meaning at preview frame rates.
//
// Per-fixture maximum brightness *is* applied, because that is a property of
// where the lamp hangs rather than of what the operator is doing right now.
//
// Time is counted the way the rig counts it (shared/beat-clock.js): in beats of
// the track's analysed grid, with each scene's pattern anchored on the beat it
// was scheduled for. So a chase rehearsed here is on the step the room will
// see at that moment, not on one worked out from elapsed seconds at a rounded
// tempo. A timeline with no grid is counted at its own tempo marks, as the
// rig's free clock would.
//
// It draws the pattern layer through the same function the rig does
// (shared/layer.js), so it answers per light: one entry per par, one per cell
// of an LED bar, in the rig's order (shared/rig.js).
import { PATTERN_FUNCS } from './patterns.ts';
import { renderLayer } from './layer.ts';
import { buildRig } from './rig.ts';
import { EXPRESSION_REST, resolveEnergyOverride, blendExpression, emitterValues, blendFixture } from './look-math.ts';
import { gridFromAnalysis, beatPositionAt, anchorStep, stepAt, motionAdvance } from './beat-clock.ts';
import type { GridSource } from './beat-clock.ts';
import type { Rig } from './rig.ts';
import type { Colour, Expression, ShowDynamics, StageFixture } from '../types/rig.ts';

/** The look as a planned timeline builds it up, patch by patch. */
export interface PreviewLook {
  pattern: string;
  colorA: number;
  colorB: number;
  colorC: number;
  colorD: number;
  bpm: number;
  beatDivision: number;
  split?: number | null;
  pixelMap?: string | null;
  showDynamics?: ShowDynamics | null;
  [key: string]: unknown;
}

/** What a patch event carries: look keys, and how it arrives. */
export type PreviewPatch = Partial<PreviewLook> & {
  fadeMs?: number;
  id?: string;
  durationMs?: number;
};

/** One event of a planned timeline. */
export interface PreviewEvent {
  timeMs: number;
  action?: string;
  id?: string;
  durationMs?: number;
  data?: PreviewPatch | null;
}

/** A fixture as the preview needs it: where it stands and how bright it may go. */
export interface PreviewFixture extends StageFixture {
  maxBrightness?: number;
}

/** The rig's lights at a moment: one colour per unit, emitter values 0–255. */
export type PreviewSample = (
  positionMs: number,
  fixtures: readonly PreviewFixture[],
  presets: readonly Colour[] | null | undefined,
  rig?: Rig,
) => Colour[];

interface Frame {
  timeMs: number;
  beatPos: number;
  look: PreviewLook;
  anchor: number;
  burst: { id: string | undefined; end: number } | null;
  expression: Expression;
  motionPhase: number;
  fade: { from: number; start: number; ms: number } | null;
}

interface LayerEntry {
  color: Colour;
  dim: number;
}

const LOOK_KEYS = ['pattern', 'palette', 'split', 'pixelMap', 'colorA', 'colorB', 'colorC', 'colorD'];
const COLOUR_KEYS = ['colorA', 'colorB', 'colorC', 'colorD'] as const;

const OPENING: PreviewLook = {
  pattern: 'solid', colorA: 0, colorB: 0, colorC: 0, colorD: 0, bpm: 120, beatDivision: 1,
};

/**
 * `grid` is the analysis the timeline was planned from — `{ beats, downbeats,
 * meter }`, as the timeline data carries it — or nothing.
 */
function createPreviewSampler(events: readonly PreviewEvent[] = [], grid: GridSource | null = null): PreviewSample {
  const beatGrid = gridFromAnalysis(grid);
  let look: PreviewLook = { ...OPENING };
  let anchor = 0;
  let burst: Frame['burst'] = null;
  // Carried across the walk so each frame records where the continuous channels
  // had got to by the time it fired. The blend below is a first-order lag, and
  // that is exact over any step while the target holds — so one step per event
  // lands on the same value the engine reaches in forty steps a second.
  let expression: Expression = { ...EXPRESSION_REST };
  let motionPhase = 0;
  // The crossfade in progress, as the engine keeps it: which frame was on
  // stage when it began, and when. A new look without a fade cuts it short.
  let fade: Frame['fade'] = null;
  let lastMs = events.length && Number.isFinite(events[0].timeMs) ? events[0].timeMs : 0;
  // Without a grid, the beat count the free clock would have reached: each
  // stretch between events at the tempo in force across it.
  let freeBeats = 0;

  const frames: Frame[] = [];
  /** Where the music is at `timeMs`, in beats, within frame `f` (or the walk so far). */
  const beatAt = (timeMs: number, f: Pick<Frame, 'timeMs' | 'beatPos' | 'look'>): number => (beatGrid
    ? beatPositionAt(beatGrid, timeMs)
    : f.beatPos + ((timeMs - f.timeMs) / 60000) * Math.max(20, f.look.bpm || 120));

  for (const event of events) {
    if (!Number.isFinite(event.timeMs)) continue;
    const dt = Math.max(0, (event.timeMs - lastMs) / 1000);
    const walked = { timeMs: lastMs, beatPos: freeBeats, look };
    const beatsBefore = beatAt(lastMs, walked);
    const beatPos = beatAt(event.timeMs, walked);
    freeBeats = beatPos;
    motionPhase = (motionPhase + motionAdvance(beatPos - beatsBefore, expression.motion)) % 1;
    expression = blendExpression(expression, look.showDynamics || null, dt);
    lastMs = event.timeMs;

    const patch: PreviewPatch = event.data || {};
    if (event.action === 'patch') {
      const dynamics = patch.showDynamics && { ...look.showDynamics, ...patch.showDynamics };
      look = { ...look, ...patch };
      if (dynamics) look.showDynamics = dynamics;
      // As the rig anchors a scheduled scene (server/patch.js): on the step
      // grid, at the beat the scene was due.
      if (patch.pattern !== undefined || patch.beatDivision !== undefined) {
        anchor = anchorStep(beatPos, look.beatDivision || 1);
      }
      if ('energyOverride' in patch) burst = null;
      if (patch.fadeMs && patch.fadeMs > 0) fade = { from: frames.length - 1, start: event.timeMs, ms: patch.fadeMs };
      else if (LOOK_KEYS.some((k) => patch[k] !== undefined)) fade = null;
    } else if (event.action === 'energy') {
      burst = { id: patch.id || event.id, end: event.timeMs + (patch.durationMs || event.durationMs || 200) };
    }
    frames.push({ timeMs: event.timeMs, beatPos, look, anchor, burst, expression, motionPhase, fade });
  }

  /**
   * What the pattern layer shows at a moment: the pattern and colours, with the
   * two continuous patterns and any crossfade applied — everything the engine
   * computes before a burst, the music's level and the trims go on top. One
   * entry per light of `rig`.
   */
  function patternLayer(index: number, positionMs: number, rig: Rig, presets: readonly Colour[]): {
    layer: LayerEntry[];
    colors: Colour[];
    expr: Expression;
    dyn: ShowDynamics | null;
  } {
    const frame = frames[index];
    const s = frame.look;
    const dyn = s.showDynamics || null;
    const since = Math.max(0, positionMs - frame.timeMs) / 1000;
    const expr = blendExpression(frame.expression, dyn, since);

    const division = Math.max(1, s.beatDivision || 1);
    const beatPos = beatAt(positionMs, frame);
    const step = stepAt(beatPos, frame.anchor, division);
    const phase = (frame.motionPhase + motionAdvance(beatPos - frame.beatPos, expr.motion)) % 1;

    const colors = COLOUR_KEYS.map((key) => presets[s[key]] || presets[0]);
    const layer: LayerEntry[] = rig.units.map(() => ({ color: colors[0], dim: 0 }));
    // The same layer the engine draws, so a chase rehearsed here travels across
    // the plot exactly as it will across the room — in stage order, around a
    // split look's wash, and along the cells of every bar.
    renderLayer(rig, {
      pattern: PATTERN_FUNCS[s.pattern] ? s.pattern : 'solid',
      colors,
      split: s.split,
      pixelMap: s.pixelMap,
    }, {
      beatPos,
      step,
      anchor: frame.anchor,
      division,
      phase,
      expression: expr,
      dynamicsOn: !!dyn,
      fixtureCount: rig.fixtures.length,
      twinkle: rig.units.map(() => 0),
    }, (u, color, dim) => { layer[u] = { color, dim }; });

    // A crossfade starts from the look as it stood when the fade began, frozen
    // there, exactly as the engine snapshots it.
    const f = frame.fade;
    if (f && f.from >= 0 && positionMs < f.start + f.ms) {
      const from = patternLayer(f.from, f.start, rig, presets).layer;
      const t = Math.max(0, positionMs - f.start) / f.ms;
      return {
        layer: layer.map((to, u) => {
          const mixed = blendFixture({ ...from[u].color, dim: from[u].dim, strobe: 0 }, { ...to.color, dim: to.dim, strobe: 0 }, t);
          return { color: mixed, dim: mixed.dim };
        }),
        colors, expr, dyn,
      };
    }
    return { layer, colors, expr, dyn };
  }

  /**
   * The rig's lights at `positionMs`, as emitter values: one entry per par and
   * one per cell of each bar. `rig` is the rig built with the profiles (see
   * shared/rig.js); without one, every fixture is taken as a single light.
   */
  return (positionMs, fixtures, presets, rig = buildRig(fixtures, () => null)) => {
    let lo = 0, hi = frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (frames[mid].timeMs <= positionMs) lo = mid + 1; else hi = mid;
    }
    const frame = frames[lo - 1];
    if (!frame || !presets?.length) return rig.units.map(() => ({ r: 0, g: 0, b: 0 }));

    const { layer, colors, expr, dyn } = patternLayer(lo - 1, positionMs, rig, presets);
    const energy = frame.burst && positionMs < frame.burst.end
      ? resolveEnergyOverride(frame.burst.id, colors[0], expr.level)
      : null;

    return layer.map(({ color, dim }, u) => {
      if (energy) {
        color = energy.col;
        dim = energy.dim;
      } else {
        dim *= expr.level;
        if (dyn && dyn.level === 0) dim = 0;
      }
      const fixture = fixtures[rig.units[u].fixture];
      const scale = (dim / 255) * ((fixture.maxBrightness ?? 255) / 255);
      return emitterValues(color, scale);
    });
  };
}

export {
  createPreviewSampler,
};
