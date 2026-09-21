'use strict';

const { state, getFixtureCount, universeOf, maxBrightnessOf, activeUniverses } = require('./state');
const { COLOR_PRESETS, STROBE_FUNCTIONS } = require('./presets');
const { getProfile } = require('./profiles');
const { sendUniverse, sendHue, stopHue } = require('./output');
const universes = require('./universes');
const { PATTERN_FUNCS } = require('../shared/patterns');
const { spatialLayout } = require('../shared/stage');
// Shared with the browser's rehearsal preview so the two cannot drift. See the
// header of that file for why this is not simply inlined here.
const {
  EXPRESSION_REST, resolveEnergyOverride, blendExpression, emitterValues, blendFixture,
  fadeCycleSec, fadeBrightness, hitBeatSec, hitBrightness, motionCycleSec,
} = require('../shared/look-math');

const fixtureColors = Array.from({ length: 4 }, () => ({
  r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0,
}));

function resizeFixtureBuffers() {
  while (fixtureColors.length < state.fixtures.length) {
    fixtureColors.push({ r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0 });
  }
  if (fixtureColors.length > state.fixtures.length) {
    fixtureColors.length = state.fixtures.length;
  }
  while (state._twinkle.length < state.fixtures.length) state._twinkle.push(0);
  state._twinkle.length = state.fixtures.length;
}

function setFixtureColor(idx, color, dim, strobe) {
  fixtureColors[idx] = {
    r: color.r,
    g: color.g,
    b: color.b,
    w: color.w || 0,
    a: color.a || 0,
    uv: color.uv || 0,
    dim,
    strobe,
  };
}

/**
 * Patterns write to slots 0…n−1 in the order they travel; this routes slot k to
 * the k-th fixture from stage left, as placed on the stage plot, and hands the
 * continuous patterns each slot's real position across the rig. With nothing
 * placed it is the identity, and every pattern renders exactly as before.
 */
function layoutWriter() {
  const { order, xs } = spatialLayout(state.fixtures);
  return { xs, write: (k, color, dim, strobe) => setFixtureColor(order[k], color, dim, strobe) };
}

function tickPattern() {
  if (!state.running) return;
  const fn = PATTERN_FUNCS[state.pattern];
  if (!fn) return;
  const { xs, write } = layoutWriter();

  fn({
    colors: [
      COLOR_PRESETS[state.colorA],
      COLOR_PRESETS[state.colorB],
      COLOR_PRESETS[state.colorC],
      COLOR_PRESETS[state.colorD],
    ],
    fixtureCount: getFixtureCount(),
    step: state._step,
    hue: state._hue,
    twinkle: state._twinkle,
    // Every pattern gets the expression channel, not only the two built around
    // it. The stepped patterns use it for the things that are genuinely a
    // property of the music rather than of the step — how far the unlit lamps
    // sit above black, how dense a scatter is — and ignore it otherwise.
    dynamics: state.showDynamics ? expression : null,
    write,
    xs,
    resetHitPhase: () => { state._hitPhase = 0; },
  });

  state._step++;
  state._hue = (state._hue + 360 / Math.max(1, getFixtureCount())) % 360;
}

// The continuous expression channel, smoothed towards whatever the show last
// asked for. `glow` reads it: a soft accent that ignored what the music was
// doing would be a flash with a lower number on it.
let expression = { ...EXPRESSION_REST };
let expressionPhase = 0;

// ── Crossfades ───────────────────────────────────────────────────────────────
// A scene change used to be a cut, always. The show now asks for a fade where
// the music does — long into a breakdown, none into a drop — and the engine
// blends each fixture from what it was last showing to what the new look
// renders, frame by frame, so a moving pattern keeps moving underneath.
// Only the pattern layer fades: a burst or a pinned fixture sits on top.
const shown = [];                // the pattern layer as it went out last frame
let fade = null;                 // { start, ms, from }

/** Fade from what is on stage now over `ms`; 0 cuts, cancelling any fade. */
function beginFade(ms) {
  fade = ms > 0 ? { start: performance.now(), ms, from: shown.map((c) => ({ ...c })) } : null;
}

// The Hue sync test: every fixture flashes white for a tenth of a second,
// once a second, so the pars and the Hue lamps can be filmed side by side and
// the latency setting turned until the two flashes land together.
const SYNC_FLASH_MS = 100;
let syncTest = null;             // { start, until } on the monotonic clock

function startSyncTest(seconds = 10) {
  const start = performance.now();
  syncTest = { start, until: start + seconds * 1000 };
  return seconds;
}

function syncTestEnergy() {
  if (!syncTest) return null;
  const now = performance.now();
  if (now >= syncTest.until) { syncTest = null; return null; }
  const lit = (now - syncTest.start) % 1000 < SYNC_FLASH_MS;
  return { col: { r: 255, g: 255, b: 255, w: 255, a: 0, uv: 0 }, dim: lit ? 255 : 0, strobe: 0 };
}

/** The burst currently forced on every fixture, or null. */
function currentEnergy() {
  const test = syncTestEnergy();
  if (test) return test;
  const id = state.heldEnergy ?? state.energyOverride;
  return id ? resolveEnergyOverride(id, COLOR_PRESETS[state.colorA], expression.level) : null;
}

// Frame time comes from the monotonic clock. Date.now() is the wall clock, and
// an NTP correction steps it: forwards and a fade jumps; backwards and dt
// clamps to zero and the rig freezes for a frame.
let lastRenderTs = performance.now();

function renderDmx() {
  const now = performance.now();
  const dt = Math.max(0, Math.min(0.25, (now - lastRenderTs) / 1000));
  lastRenderTs = now;

  // Continuous fade — runs at the full DMX rate (40 Hz). Full cycle spans 8 beats.
  if (state.running && state.pattern === 'fade') {
    state._fadePhase = (state._fadePhase + dt / fadeCycleSec(state.bpm)) % 1;
    const bright = fadeBrightness(state._fadePhase);
    const colA = COLOR_PRESETS[state.colorA];
    for (let i = 0; i < getFixtureCount(); i++) setFixtureColor(i, colA, bright, 0);
  }

  // 'hit' decay 255 → 35 over one beat. tickPattern resets _hitPhase on each beat.
  if (state.running && state.pattern === 'hit') {
    state._hitPhase = Math.min(1, (state._hitPhase ?? 1) + dt / hitBeatSec(state.bpm, state.beatDivision));
    const bright = hitBrightness(state._hitPhase);
    const colA = COLOR_PRESETS[state.colorA];
    for (let i = 0; i < getFixtureCount(); i++) setFixtureColor(i, colA, bright, 0);
  }

  const target = state.showDynamics;
  expression = blendExpression(expression, target, dt);
  // How fast the expressive patterns travel across the rig.
  //
  // This used to advance in wall-clock seconds, and at a typical motion reading
  // one crossing took about seven seconds — which reads as ambient whatever is
  // playing underneath it. On a rig with no moving heads the travel *is* the
  // movement, so it is tied to the beat instead: motion decides how many beats
  // one crossing takes, eight when the track is barely moving and two when it
  // is driving, and the sweep speeds up with the tempo rather than ignoring it.
  expressionPhase = (expressionPhase + dt / motionCycleSec(state.bpm, expression.motion)) % 1;
  if (state.running && ['ensemble', 'ribbon'].includes(state.pattern)) {
    const { xs, write } = layoutWriter();
    PATTERN_FUNCS[state.pattern]({
      colors: [state.colorA, state.colorB, state.colorC, state.colorD].map(i => COLOR_PRESETS[i]),
      fixtureCount: getFixtureCount(), phase: expressionPhase, dynamics: expression,
      write, xs,
    });
  }

  const energy = currentEnergy();

  // Allocate a buffer for every universe the patch now spans and retire the
  // ones it left. Done every frame rather than on patch edits: a fixture moved
  // between universes takes effect immediately, and no caller has to remember.
  universes.sync(activeUniverses());

  // Clear every universe each frame, then let each fixture write its own
  // channels back. Zeroing per-fixture ranges instead used to leave any channel
  // no *current* fixture covers latched at its last value forever: delete a
  // fixture, re-address one, load a smaller show, or map a profile offset past
  // its channelCount, and the orphaned channels kept streaming at the render
  // rate with no way to clear them — master blackout only walked the current
  // fixtures, so it could not turn those lights off either. A 512-byte memset
  // per universe per frame is far cheaper than the bug.
  universes.clearAll();

  let fadeT = 1;
  if (fade) {
    fadeT = (now - fade.start) / fade.ms;
    if (fadeT >= 1) fade = null;
  }

  // With the buffers already cleared, a blackout is simply empty universes.
  if (!state.masterBlackout) {
    const fixtureCount = getFixtureCount();
    for (let i = 0; i < fixtureCount; i++) {
      const fix = state.fixtures[i];
      const dmx = universes.getBuffer(universeOf(fix));
      const base = fix.address - 1;
      let col, dim, strobe;

      // The pattern layer, partway through a fade if one is running. Kept
      // whatever sits on top of it this frame, so a fade that starts under a
      // burst starts from the look and not from the burst.
      const layer = fade && fade.from[i] ? blendFixture(fade.from[i], fixtureColors[i], fadeT) : fixtureColors[i];
      shown[i] = layer;

      if (energy) {
        col = energy.col; dim = energy.dim; strobe = energy.strobe;
      } else if (fix.override && (fix.override.enabled || fix.override.blackout)) {
        const ov = fix.override;
        if (ov.blackout) {
          col = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 }; dim = 0; strobe = 0;
        } else {
          col = { r: ov.r, g: ov.g, b: ov.b, w: ov.w, a: ov.a || 0, uv: ov.uv || 0 };
          dim = ov.dim !== undefined ? ov.dim : 255;
          strobe = ov.strobe !== undefined ? ov.strobe : 0;
        }
      } else {
        col = { r: layer.r, g: layer.g, b: layer.b, w: layer.w, a: layer.a || 0, uv: layer.uv || 0 };
        dim = layer.dim; strobe = layer.strobe;
      }

      const ch = getProfile(fix).channelMap;

      // Two scalers sit above whatever is driving the fixture, and both apply
      // to every source of light including an energy override. The grand master
      // is the operator's one hand on the whole rig; the per-fixture trim is for
      // the lamp hanging a metre from someone's face.
      //
      // Both multiply rather than clamp. A trim that clipped — min(level, trim)
      // — would leave a fixture already below the line untouched and only bite
      // at the top, so the bottom of the throw would go dead and two fixtures on
      // different trims would converge as they dimmed. Multiplying keeps the
      // whole range proportional: half the trim is half the output at every
      // level.
      //
      // An energy override used to bypass the master and always output full,
      // which meant the blinder came up at 100% no matter where the master sat —
      // the one moment you most want the master to still mean something.
      // Music scales the pattern underneath manual effects and fixture overrides.
      if (!energy && !(fix.override && fix.override.enabled)) dim *= expression.level;
      // Silence puts out what the music drives, and a pinned fixture is not
      // driven by the music: it holds through the quiet the same as it holds
      // through the level above.
      if (target?.level === 0 && !energy && !(fix.override && fix.override.enabled)) dim = 0;
      const ms = (state.masterDimmer / 255) * (maxBrightnessOf(fix) / 255);
      const ds = dim / 255;
      const ts = ms * ds;

      if (ch.dimmer !== undefined)     dmx[base + ch.dimmer] = Math.round(dim * ms);
      if (ch.dimmerFine !== undefined) dmx[base + ch.dimmerFine] = 0;

      // Energy overrides force 'standard' strobe so a colour-strobe burst never
      // inherits a slow ramp/break function from the prior segment.
      if (ch.strobe !== undefined) {
        const rawStrobe = energy
          ? strobe
          : (state.pattern === 'strobe' ? state.strobeSpeed : strobe);
        if (rawStrobe > 0) {
          const fnId = energy ? 'standard' : state.strobeFunction;
          const fn = STROBE_FUNCTIONS.find((f) => f.id === fnId) || STROBE_FUNCTIONS[0];
          dmx[base + ch.strobe] = fn.lo + Math.round((rawStrobe / 255) * (fn.hi - fn.lo));
        }
      }

      // One resolution of colour × scale for every emitter, shared with the
      // rehearsal preview; this loop only routes the results onto the channels
      // the fixture's profile actually names.
      const v = emitterValues(col, ts);

      if (ch.red !== undefined)   dmx[base + ch.red]   = v.r;
      if (ch.green !== undefined) dmx[base + ch.green] = v.g;
      if (ch.blue !== undefined)  dmx[base + ch.blue]  = v.b;
      if (ch.white !== undefined) dmx[base + ch.white] = v.w;
      if (ch.amber !== undefined) dmx[base + ch.amber] = v.a;

      // A lamp with separate warm and cool white dies (a Hue bulb) rather than
      // one white emitter and an amber one. The look's colour model has no
      // fourth and fifth primary to give them, and inventing one would leave
      // every existing preset and pattern driving nothing — so they are fed
      // from the two components that already carry exactly this meaning: the
      // neutral white content, and the warm content. "Cool White" (white at
      // full) and "Warm White" (white and amber together) then land on such a
      // lamp as the whites they are named after.
      if (ch.coolWhite !== undefined) dmx[base + ch.coolWhite] = v.w;
      if (ch.warmWhite !== undefined) dmx[base + ch.warmWhite] = v.a;
      if (ch.uv !== undefined)    dmx[base + ch.uv]    = v.uv;
    }
  }

  for (const universe of universes.list()) {
    sendUniverse(universe, universes.getBuffer(universe));
  }
  // One last all-zero frame for any universe that just left the patch, so its
  // node doesn't sit holding the look it was showing when the fixture moved.
  for (const [universe, frame] of universes.drainRetired()) sendUniverse(universe, frame, { immediate: true });

  // Hue is fed once per frame rather than once per universe: one message covers
  // the whole entertainment area, and it reads the colours back out of the
  // buffers that were just filled in above.
  sendHue();
}

let beatInterval = null;
let renderInterval = null;

function bpmInterval() { return (60000 / state.bpm) / state.beatDivision; }

/**
 * (Re)start the beat clock from now.
 *
 * Each beat is due at start + n × period and is scheduled against that, not a
 * period after the last one fired. setInterval does the latter, so every late
 * callback pushes all the ones after it: measured under the render load it
 * lost about half a millisecond a beat, which at 120 BPM puts a tapped tempo
 * a sixteenth behind the music inside three minutes.
 */
function restartBeatTimer({ tickNow = false } = {}) {
  if (beatInterval) clearTimeout(beatInterval);
  beatInterval = null;
  if (!state.running) return;
  if (tickNow) tickPattern();
  const period = bpmInterval();
  const start = performance.now();
  let n = 0;
  const schedule = () => {
    // After a stall (a blocked event loop, a suspended laptop) resume on the
    // grid rather than firing every missed beat back to back.
    n = Math.max(n + 1, Math.floor((performance.now() - start) / period) + 1);
    beatInterval = setTimeout(() => { tickPattern(); schedule(); }, start + n * period - performance.now());
  };
  schedule();
}

function startEngine() {
  if (renderInterval) return;           // idempotent: never stack render loops
  restartBeatTimer();
  renderInterval = setInterval(renderDmx, 25);
}

/**
 * Stop rendering and put the rig out.
 *
 * Art-Net receivers latch: they hold the last frame they were sent. Without a
 * final all-zero frame, quitting the server leaves the fixtures burning
 * whatever look was on stage — through the end of the night, or until someone
 * power-cycles them.
 */
function stopEngine() {
  if (beatInterval) clearTimeout(beatInterval);
  if (renderInterval) clearInterval(renderInterval);
  beatInterval = null;
  renderInterval = null;
  universes.sync(activeUniverses());
  universes.clearAll();
  for (const universe of universes.list()) {
    sendUniverse(universe, universes.getBuffer(universe), { immediate: true });
  }
  for (const [universe, frame] of universes.drainRetired()) sendUniverse(universe, frame, { immediate: true });
  // Same courtesy for the bridge: one black frame so the lamps go out, then
  // close the session rather than leaving the area locked to a stream that has
  // stopped arriving.
  sendHue();
  stopHue();
}

module.exports = {
  startEngine,
  stopEngine,
  restartBeatTimer,
  resizeFixtureBuffers,
  startSyncTest,
  beginFade,
};
