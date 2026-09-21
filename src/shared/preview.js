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
const { PATTERN_FUNCS } = require('./patterns');
const { spatialLayout } = require('./stage');
const {
  EXPRESSION_REST, resolveEnergyOverride, blendExpression, emitterValues,
  fadeCycleSec, fadeBrightness, hitBeatSec, hitBrightness, motionCycleSec,
} = require('./look-math');

const OPENING = {
  pattern: 'solid', colorA: 0, colorB: 0, colorC: 0, colorD: 0, bpm: 120, beatDivision: 1,
};

function createPreviewSampler(events = []) {
  let look = { ...OPENING };
  let patternAt = 0;
  let burst = null;
  // Carried across the walk so each frame records where the continuous channels
  // had got to by the time it fired. The blend below is a first-order lag, and
  // that is exact over any step while the target holds — so one step per event
  // lands on the same value the engine reaches in forty steps a second.
  let expression = { ...EXPRESSION_REST };
  let motionPhase = 0;
  let lastMs = events.length && Number.isFinite(events[0].timeMs) ? events[0].timeMs : 0;

  const frames = [];
  for (const event of events) {
    if (!Number.isFinite(event.timeMs)) continue;
    const dt = Math.max(0, (event.timeMs - lastMs) / 1000);
    motionPhase = (motionPhase + dt / motionCycleSec(look.bpm, expression.motion)) % 1;
    expression = blendExpression(expression, look.showDynamics || null, dt);
    lastMs = event.timeMs;

    const patch = event.data || {};
    if (event.action === 'patch') {
      const dynamics = patch.showDynamics && { ...look.showDynamics, ...patch.showDynamics };
      look = { ...look, ...patch };
      if (dynamics) look.showDynamics = dynamics;
      if (patch.pattern) patternAt = event.timeMs;
      if ('energyOverride' in patch) burst = null;
    } else if (event.action === 'energy') {
      burst = { id: patch.id || event.id, end: event.timeMs + (patch.durationMs || event.durationMs || 200) };
    }
    frames.push({ timeMs: event.timeMs, look, patternAt, burst, expression, motionPhase });
  }

  return (positionMs, fixtures, presets) => {
    let lo = 0, hi = frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (frames[mid].timeMs <= positionMs) lo = mid + 1; else hi = mid;
    }
    const frame = frames[lo - 1];
    if (!frame || !presets?.length) return fixtures.map(() => ({ r: 0, g: 0, b: 0 }));

    const s = frame.look;
    const dyn = s.showDynamics || null;
    const since = Math.max(0, positionMs - frame.timeMs) / 1000;
    const expr = blendExpression(frame.expression, dyn, since);

    const elapsed = Math.max(0, positionMs - frame.patternAt) / 1000;
    const beatSec = 60 / Math.max(20, s.bpm || 120);
    const step = Math.floor(elapsed / beatSec * (s.beatDivision || 1));
    const phase = (frame.motionPhase + since / motionCycleSec(s.bpm, expr.motion)) % 1;

    const colors = ['colorA', 'colorB', 'colorC', 'colorD'].map((key) => presets[s[key]] || presets[0]);
    const output = fixtures.map(() => ({ color: colors[0], dim: 0 }));
    const fn = PATTERN_FUNCS[s.pattern] || PATTERN_FUNCS.solid;
    // The same stage order the engine routes through, so a chase rehearsed
    // here travels across the plot exactly as it will across the room.
    const { order, xs } = spatialLayout(fixtures);
    fn({
      colors, fixtureCount: fixtures.length, step, phase, xs,
      hue: (step * 360 / Math.max(1, fixtures.length)) % 360,
      dynamics: dyn ? expr : null, twinkle: fixtures.map(() => 0), resetHitPhase: () => {},
      write: (k, color, dim) => { output[order[k]] = { color, dim }; },
    });

    // The two patterns the engine drives continuously rather than per beat, so
    // they are recomputed here from elapsed time for the same reason.
    const energy = frame.burst && positionMs < frame.burst.end
      ? resolveEnergyOverride(frame.burst.id, colors[0], expr.level)
      : null;

    return output.map(({ color, dim }, i) => {
      if (s.pattern === 'fade') { color = colors[0]; dim = fadeBrightness(elapsed / fadeCycleSec(s.bpm) % 1); }
      if (s.pattern === 'hit') { color = colors[0]; dim = hitBrightness(elapsed / hitBeatSec(s.bpm, s.beatDivision) % 1); }
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
