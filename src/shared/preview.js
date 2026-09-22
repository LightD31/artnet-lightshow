'use strict';

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
const { PATTERN_FUNCS } = require('./patterns');
const { spatialLayout, washFixtures } = require('./stage');
const {
  EXPRESSION_REST, resolveEnergyOverride, blendExpression, emitterValues, blendFixture,
  fadeBrightness, hitBrightness,
} = require('./look-math');
const {
  gridFromAnalysis, beatPositionAt, anchorStep, stepAt, fadePhase, hitPhase, motionAdvance,
} = require('./beat-clock');

const LOOK_KEYS = ['pattern', 'palette', 'split', 'colorA', 'colorB', 'colorC', 'colorD'];

const OPENING = {
  pattern: 'solid', colorA: 0, colorB: 0, colorC: 0, colorD: 0, bpm: 120, beatDivision: 1,
};

/**
 * `grid` is the analysis the timeline was planned from — `{ beats, downbeats,
 * meter }`, as the timeline data carries it — or nothing.
 */
function createPreviewSampler(events = [], grid = null) {
  const beatGrid = gridFromAnalysis(grid);
  let look = { ...OPENING };
  let anchor = 0;
  let burst = null;
  // Carried across the walk so each frame records where the continuous channels
  // had got to by the time it fired. The blend below is a first-order lag, and
  // that is exact over any step while the target holds — so one step per event
  // lands on the same value the engine reaches in forty steps a second.
  let expression = { ...EXPRESSION_REST };
  let motionPhase = 0;
  // The crossfade in progress, as the engine keeps it: which frame was on
  // stage when it began, and when. A new look without a fade cuts it short.
  let fade = null;
  let lastMs = events.length && Number.isFinite(events[0].timeMs) ? events[0].timeMs : 0;
  // Without a grid, the beat count the free clock would have reached: each
  // stretch between events at the tempo in force across it.
  let freeBeats = 0;

  const frames = [];
  /** Where the music is at `timeMs`, in beats, within frame `f` (or the walk so far). */
  const beatAt = (timeMs, f) => (beatGrid
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

    const patch = event.data || {};
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
      if (patch.fadeMs > 0) fade = { from: frames.length - 1, start: event.timeMs, ms: patch.fadeMs };
      else if (LOOK_KEYS.some((k) => patch[k] !== undefined)) fade = null;
    } else if (event.action === 'energy') {
      burst = { id: patch.id || event.id, end: event.timeMs + (patch.durationMs || event.durationMs || 200) };
    }
    frames.push({ timeMs: event.timeMs, beatPos, look, anchor, burst, expression, motionPhase, fade });
  }

  /**
   * What the pattern layer shows at a moment: the pattern and colours, with the
   * two continuous patterns and any crossfade applied — everything the engine
   * computes before a burst, the music's level and the trims go on top.
   */
  function patternLayer(index, positionMs, fixtures, presets) {
    const frame = frames[index];
    const s = frame.look;
    const dyn = s.showDynamics || null;
    const since = Math.max(0, positionMs - frame.timeMs) / 1000;
    const expr = blendExpression(frame.expression, dyn, since);

    const division = Math.max(1, s.beatDivision || 1);
    const beatPos = beatAt(positionMs, frame);
    const step = stepAt(beatPos, frame.anchor, division);
    const phase = (frame.motionPhase + motionAdvance(beatPos - frame.beatPos, expr.motion)) % 1;

    const colors = ['colorA', 'colorB', 'colorC', 'colorD'].map((key) => presets[s[key]] || presets[0]);
    const output = fixtures.map(() => ({ color: colors[0], dim: 0 }));
    const fn = PATTERN_FUNCS[s.pattern] || PATTERN_FUNCS.solid;
    // The same stage order the engine routes through, so a chase rehearsed
    // here travels across the plot exactly as it will across the room — and in
    // a split look, across only the fixtures not holding the wash.
    const wash = washFixtures(fixtures, s.split);
    const members = fixtures.map((_, i) => i).filter((i) => !wash.has(i));
    const { order, xs } = spatialLayout(members.map((i) => fixtures[i]));
    fn({
      colors, fixtureCount: members.length, step, phase, xs,
      hue: (step * 360 / Math.max(1, fixtures.length)) % 360,
      dynamics: dyn ? expr : null, twinkle: fixtures.map(() => 0), resetHitPhase: () => {},
      write: (k, color, dim) => { output[members[order[k]]] = { color, dim }; },
    });

    // The two whole-rig envelopes, from the same beat position and anchor the
    // engine reads them from. The wash goes on last, as the engine paints it.
    let layer = output.map(({ color, dim }, i) => {
      if (wash.has(i)) return { color: colors[1], dim: 255 };
      if (s.pattern === 'fade') return { color: colors[0], dim: fadeBrightness(fadePhase(beatPos, frame.anchor, division)) };
      if (s.pattern === 'hit') return { color: colors[0], dim: hitBrightness(hitPhase(beatPos, division)) };
      return { color, dim };
    });

    // A crossfade starts from the look as it stood when the fade began, frozen
    // there, exactly as the engine snapshots it.
    const f = frame.fade;
    if (f && f.from >= 0 && positionMs < f.start + f.ms) {
      const from = patternLayer(f.from, f.start, fixtures, presets).layer;
      const t = Math.max(0, positionMs - f.start) / f.ms;
      layer = layer.map((to, i) => {
        const mixed = blendFixture({ ...from[i].color, dim: from[i].dim, strobe: 0 }, { ...to.color, dim: to.dim, strobe: 0 }, t);
        return { color: mixed, dim: mixed.dim };
      });
    }
    return { layer, colors, expr, dyn };
  }

  return (positionMs, fixtures, presets) => {
    let lo = 0, hi = frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (frames[mid].timeMs <= positionMs) lo = mid + 1; else hi = mid;
    }
    const frame = frames[lo - 1];
    if (!frame || !presets?.length) return fixtures.map(() => ({ r: 0, g: 0, b: 0 }));

    const { layer, colors, expr, dyn } = patternLayer(lo - 1, positionMs, fixtures, presets);
    const energy = frame.burst && positionMs < frame.burst.end
      ? resolveEnergyOverride(frame.burst.id, colors[0], expr.level)
      : null;

    return layer.map(({ color, dim }, i) => {
      if (energy) {
        color = energy.col;
        dim = energy.dim;
      } else {
        dim *= expr.level;
        if (dyn && dyn.level === 0) dim = 0;
      }
      const scale = (dim / 255) * ((fixtures[i].maxBrightness ?? 255) / 255);
      return emitterValues(color, scale);
    });
  };
}

module.exports = { createPreviewSampler };
