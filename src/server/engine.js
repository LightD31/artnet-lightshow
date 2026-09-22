'use strict';

const { state, getFixtureCount, universeOf, maxBrightnessOf, activeUniverses } = require('./state');
const { COLOR_PRESETS, STROBE_FUNCTIONS } = require('./presets');
const { getProfile } = require('./profiles');
const { sendUniverse, sendHue, stopHue } = require('./output');
const universes = require('./universes');
const { guarded } = require('./guard');
const { conductor } = require('./conductor');
const { PATTERN_FUNCS } = require('../shared/patterns');
const { spatialLayout, washFixtures } = require('../shared/stage');
// Shared with the browser's rehearsal preview so the two cannot drift. See the
// header of that file for why this is not simply inlined here.
const {
  EXPRESSION_REST, resolveEnergyOverride, blendExpression, emitterValues, blendFixture,
  fadeBrightness, hitBrightness,
} = require('../shared/look-math');
const {
  anchorStep, stepAt, hitPhase, fadePhase, motionAdvance,
} = require('../shared/beat-clock');

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
  // In a split look the wash group is not the pattern's to write: the pattern
  // travels across the rest of the rig, in stage order among themselves.
  const wash = washFixtures(state.fixtures, state.split);
  const members = state.fixtures.map((_, i) => i).filter((i) => !wash.has(i));
  const { order, xs } = spatialLayout(members.map((i) => state.fixtures[i]));
  return {
    xs, count: members.length,
    write: (k, color, dim, strobe) => setFixtureColor(members[order[k]], color, dim, strobe),
  };
}

/** Hold the split look's wash group on colour B, at full, under the music. */
function paintWash() {
  const wash = washFixtures(state.fixtures, state.split);
  if (!wash.size || !state.running) return;
  const colB = COLOR_PRESETS[state.colorB];
  for (const i of wash) setFixtureColor(i, colB, 255, 0);
}

// Patterns that roll dice. They re-roll when the step moves or the look
// changes — a twinkle redrawn forty times a second is noise, not a twinkle.
const RANDOM_PATTERNS = new Set(['twinkle', 'sparkle', 'random-flash']);
let lastRandomKey = null;

/**
 * The step the pattern is on, counted from its anchor on the step grid.
 *
 * The anchor is set when a scene changes the pattern or the division (see
 * patch.js). When the music itself jumps — a seek, a new track, another source
 * taking over the clock — the old anchor belongs to a beat position that no
 * longer exists, so the pattern re-anchors where the music now is.
 */
function patternStep(reading) {
  const division = Math.max(1, state.beatDivision || 1);
  if (!state.patternAnchor || state.patternAnchor.epoch !== reading.epoch) {
    state.patternAnchor = { step: anchorStep(reading.beatPos, division), epoch: reading.epoch };
  }
  const anchor = state.patternAnchor.step;
  return { step: stepAt(reading.beatPos, anchor, division), anchor, division };
}

/**
 * Write the pattern layer for this frame, from the musical clock.
 *
 * The step is a function of where the music is, not a counter a timer
 * advances, so it cannot drift off the beat and lands on the same step
 * however the moment was reached. Deterministic patterns render every frame,
 * so a colour or a split shows the moment it is set rather than on the next
 * beat.
 */
function renderPattern(reading) {
  if (!state.running) return;
  const fn = PATTERN_FUNCS[state.pattern];
  if (!fn) return;
  const { step, anchor, division } = patternStep(reading);
  const colors = [state.colorA, state.colorB, state.colorC, state.colorD].map((i) => COLOR_PRESETS[i]);
  const total = getFixtureCount();

  // The two whole-rig envelopes: an eight-beat breath from the scene's
  // anchor, and a decay across every step.
  if (state.pattern === 'fade' || state.pattern === 'hit') {
    const bright = state.pattern === 'fade'
      ? fadeBrightness(fadePhase(reading.beatPos, anchor, division))
      : hitBrightness(hitPhase(reading.beatPos, division));
    for (let i = 0; i < total; i++) setFixtureColor(i, colors[0], bright, 0);
    return;
  }

  const { xs, write, count } = layoutWriter();
  if (state.pattern === 'ensemble' || state.pattern === 'ribbon') {
    fn({ colors, fixtureCount: count, phase: expressionPhase, dynamics: expression, write, xs });
    return;
  }

  if (RANDOM_PATTERNS.has(state.pattern)) {
    const key = `${state.pattern}|${step}|${state.colorA},${state.colorB},${state.colorC},${state.colorD}|${state.split}|${total}`;
    if (key === lastRandomKey) return;
    lastRandomKey = key;
  }

  fn({
    colors,
    fixtureCount: count,
    step,
    hue: (step * 360 / Math.max(1, total)) % 360,
    twinkle: state._twinkle,
    // Every pattern gets the expression channel, not only the two built around
    // it. The stepped patterns use it for the things that are genuinely a
    // property of the music rather than of the step — how far the unlit lamps
    // sit above black, how dense a scatter is — and ignore it otherwise.
    dynamics: state.showDynamics ? expression : null,
    write,
    xs,
    resetHitPhase: () => {},
  });
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

// Run at the top of every frame, before the clock is read: the auto show fires
// whatever is due by now, so a cue lands on the frame it was scheduled for
// rather than up to a poll interval later.
let frameHook = null;
const runFrameHook = guarded('frame-hook', () => { if (frameHook) frameHook(); });

/** Register what runs at the start of each frame (the auto show's cursor). */
function setFrameHook(fn) {
  frameHook = typeof fn === 'function' ? fn : null;
}

let lastReading = null;

function renderDmx() {
  const now = performance.now();
  const dt = Math.max(0, Math.min(0.25, (now - lastRenderTs) / 1000));
  lastRenderTs = now;

  runFrameHook();

  const target = state.showDynamics;
  expression = blendExpression(expression, target, dt);

  const reading = conductor.now();
  // How fast the expressive patterns travel across the rig: motion decides how
  // many beats one crossing takes, eight when the track is barely moving and
  // two when it is driving. Counted in beats of the musical clock, so the sweep
  // follows the track's own tempo — and a jump in the music does not fling it.
  const dBeats = lastReading && lastReading.epoch === reading.epoch
    ? Math.min(4, Math.max(0, reading.beatPos - lastReading.beatPos)) : 0;
  lastReading = reading;
  expressionPhase = (expressionPhase + motionAdvance(dBeats, expression.motion)) % 1;

  renderPattern(reading);
  // After the pattern has written, so the wash wins on its own lamps.
  paintWash();

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

let renderInterval = null;

// One bad frame is reported and the next one renders; unguarded, a throw here
// ended the process and left every fixture latched on its last frame.
const safeRender = guarded('render', renderDmx);

function startEngine() {
  if (renderInterval) return;           // idempotent: never stack render loops
  renderInterval = setInterval(safeRender, 25);
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
  if (renderInterval) clearInterval(renderInterval);
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
  setFrameHook,
  resizeFixtureBuffers,
  startSyncTest,
  beginFade,
};
