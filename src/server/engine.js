'use strict';

const { state, getFixtureCount, universeOf, maxBrightnessOf, activeUniverses } = require('./state');
const { COLOR_PRESETS, STROBE_FUNCTIONS } = require('./presets');
const { getProfile } = require('./profiles');
const { sendUniverse, sendHue, stopHue } = require('./output');
const universes = require('./universes');
const { guarded } = require('./guard');
const { conductor } = require('./conductor');
const { currentRig, invalidateRig } = require('./rig');
const { PATTERN_FUNCS } = require('../shared/patterns');
const { renderLayer } = require('../shared/layer');
// Shared with the browser's rehearsal preview so the two cannot drift. See the
// header of that file for why this is not simply inlined here.
const {
  EXPRESSION_REST, resolveEnergyOverride, blendExpression, emitterValues, blendFixture, cellDrive,
} = require('../shared/look-math');
const { anchorStep, stepAt, motionAdvance } = require('../shared/beat-clock');

// The pattern layer, one entry per light: a par is one, each cell of an LED
// bar another (see shared/rig.js). On a rig of pars, entry i is fixture i.
const unitColors = Array.from({ length: 4 }, () => ({
  r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0,
}));

/** Size the per-light buffers to the rig. Cheap when nothing changed. */
function sizeUnitBuffers(count) {
  while (unitColors.length < count) {
    unitColors.push({ r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0 });
  }
  if (unitColors.length > count) unitColors.length = count;
  while (state._twinkle.length < count) state._twinkle.push(0);
  state._twinkle.length = count;
}

/**
 * The patch changed: rebuild the picture of the rig and size the buffers to
 * it now, rather than on the next frame.
 */
function resizeFixtureBuffers() {
  invalidateRig();
  sizeUnitBuffers(currentRig().units.length);
}

function setUnitColor(u, color, dim, strobe) {
  unitColors[u] = {
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
 * longer exists, so the pattern re-anchors: on its scene's beat when the auto
 * show says which that is, else where the music now is.
 */
function patternStep(reading) {
  const division = Math.max(1, state.beatDivision || 1);
  if (!state.patternAnchor || state.patternAnchor.epoch !== reading.epoch) {
    // After a seek in the auto show, from the beat its scene was scheduled on,
    // so the chase is on the step that playing through would have reached.
    const from = Number.isFinite(reading.anchorBeat) ? reading.anchorBeat : reading.beatPos;
    state.patternAnchor = { step: anchorStep(from, division), epoch: reading.epoch };
  }
  const anchor = state.patternAnchor.step;
  return { step: stepAt(reading.beatPos, anchor, division), anchor, division };
}

/**
 * Write the pattern layer for this frame, from the musical clock, through the
 * layer the rehearsal preview draws with too (shared/layer.js).
 *
 * The step is a function of where the music is, not a counter a timer
 * advances, so it cannot drift off the beat and lands on the same step
 * however the moment was reached. Deterministic patterns render every frame,
 * so a colour or a split shows the moment it is set rather than on the next
 * beat. Stopped, the layer holds what it last showed.
 */
function renderPattern(rig, reading) {
  if (!state.running) return;
  const known = !!PATTERN_FUNCS[state.pattern];
  const look = {
    pattern: state.pattern,
    colors: [state.colorA, state.colorB, state.colorC, state.colorD].map((i) => COLOR_PRESETS[i]),
    split: state.split,
    pixelMap: state.pixelMap,
  };
  if (!known) {
    // Nothing to draw, but a split look's wash still holds.
    renderLayer(rig, look, null, setUnitColor, { skipPattern: true });
    return;
  }

  const { step, anchor, division } = patternStep(reading);
  let skipPattern = false;
  if (RANDOM_PATTERNS.has(state.pattern)) {
    const pixels = rig.hasPixels ? `|${rig.units.length}|${state.pixelMap}` : '';
    const key = `${state.pattern}|${step}|${state.colorA},${state.colorB},${state.colorC},${state.colorD}|${state.split}|${getFixtureCount()}${pixels}`;
    skipPattern = key === lastRandomKey;
    lastRandomKey = key;
  }

  renderLayer(rig, look, {
    beatPos: reading.beatPos,
    step,
    anchor,
    division,
    phase: expressionPhase,
    expression,
    dynamicsOn: !!state.showDynamics,
    fixtureCount: getFixtureCount(),
    twinkle: state._twinkle,
  }, setUnitColor, { skipPattern });
}

// The continuous expression channel, smoothed towards whatever the show last
// asked for. `glow` reads it: a soft accent that ignored what the music was
// doing would be a flash with a lower number on it.
let expression = { ...EXPRESSION_REST };
let expressionPhase = 0;

// ── Crossfades ───────────────────────────────────────────────────────────────
// A scene change used to be a cut, always. The show now asks for a fade where
// the music does — long into a breakdown, none into a drop — and the engine
// blends each light from what it was last showing to what the new look
// renders, frame by frame, so a moving pattern keeps moving underneath.
// Only the pattern layer fades: a burst or a pinned fixture sits on top.
const shown = [];                // the pattern layer as it went out last frame, per light
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

/**
 * What one light shows this frame before the masters: a burst over
 * everything, a pinned fixture over the look, else the pattern layer
 * (partway through a fade if one is running). The music scales the pattern
 * underneath manual effects and fixture overrides; silence puts out what the
 * music drives, and a pinned fixture is not driven by the music — it holds
 * through the quiet the same as it holds through the level above.
 */
function lightOf(u, fix, energy, fadeT, target) {
  // Kept whatever sits on top of it this frame, so a fade that starts under a
  // burst starts from the look and not from the burst.
  const layer = fade && fade.from[u] ? blendFixture(fade.from[u], unitColors[u], fadeT) : unitColors[u];
  shown[u] = layer;

  let col; let dim; let strobe;
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

  const pinned = fix.override && fix.override.enabled;
  if (!energy && !pinned) dim *= expression.level;
  if (target?.level === 0 && !energy && !pinned) dim = 0;
  return { col, dim, strobe };
}

// Two scalers sit above whatever is driving a fixture, and both apply to every
// source of light including an energy override. The grand master is the
// operator's one hand on the whole rig; the per-fixture trim is for the lamp
// hanging a metre from someone's face.
//
// Both multiply rather than clamp. A trim that clipped — min(level, trim) —
// would leave a fixture already below the line untouched and only bite at the
// top, so the bottom of the throw would go dead and two fixtures on different
// trims would converge as they dimmed. Multiplying keeps the whole range
// proportional: half the trim is half the output at every level.
//
// An energy override used to bypass the master and always output full, which
// meant the blinder came up at 100% no matter where the master sat — the one
// moment you most want the master to still mean something.
function mastersOf(fix) {
  return (state.masterDimmer / 255) * (maxBrightnessOf(fix) / 255);
}

/** The strobe channel's value, or null to leave it closed. */
function strobeValue(energy, strobe) {
  // Energy overrides force 'standard' strobe so a colour-strobe burst never
  // inherits a slow ramp/break function from the prior segment.
  const raw = energy ? strobe : (state.pattern === 'strobe' ? state.strobeSpeed : strobe);
  if (!(raw > 0)) return null;
  const fnId = energy ? 'standard' : state.strobeFunction;
  const fn = STROBE_FUNCTIONS.find((f) => f.id === fnId) || STROBE_FUNCTIONS[0];
  return fn.lo + Math.round((raw / 255) * (fn.hi - fn.lo));
}

/**
 * Route one resolved colour onto the channels a map names. One resolution of
 * colour × scale for every emitter, shared with the rehearsal preview.
 *
 * A lamp with separate warm and cool white dies (a Hue bulb) rather than one
 * white emitter and an amber one gets them from the two components that
 * already carry exactly that meaning: the neutral white content, and the warm
 * content. "Cool White" (white at full) and "Warm White" (white and amber
 * together) then land on such a lamp as the whites they are named after.
 */
function writeEmitters(dmx, base, ch, col, scale) {
  const v = emitterValues(col, scale);
  if (ch.red !== undefined)       dmx[base + ch.red]       = v.r;
  if (ch.green !== undefined)     dmx[base + ch.green]     = v.g;
  if (ch.blue !== undefined)      dmx[base + ch.blue]      = v.b;
  if (ch.white !== undefined)     dmx[base + ch.white]     = v.w;
  if (ch.amber !== undefined)     dmx[base + ch.amber]     = v.a;
  if (ch.coolWhite !== undefined) dmx[base + ch.coolWhite] = v.w;
  if (ch.warmWhite !== undefined) dmx[base + ch.warmWhite] = v.a;
  if (ch.uv !== undefined)        dmx[base + ch.uv]        = v.uv;
}

/** A fixture that is one light. */
function writePar(fix, { col, dim, strobe }, energy) {
  const dmx = universes.getBuffer(universeOf(fix));
  const base = fix.address - 1;
  const ch = getProfile(fix).channelMap;
  const ms = mastersOf(fix);

  if (ch.dimmer !== undefined)     dmx[base + ch.dimmer] = Math.round(dim * ms);
  if (ch.dimmerFine !== undefined) dmx[base + ch.dimmerFine] = 0;
  if (ch.strobe !== undefined) {
    const value = strobeValue(energy, strobe);
    if (value !== null) dmx[base + ch.strobe] = value;
  }
  writeEmitters(dmx, base, ch, col, ms * (dim / 255));
}

/**
 * An LED bar: the channels the bar shares, then every cell's own. Each cell
 * comes out as a par with the same channels would at its level (see cellDrive
 * in look-math.js), so a look the same on every cell drives a bar exactly as
 * it drives a par, and kill or silence closes the bar's dimmer too.
 */
function writeBar(fix, cells, lights, energy) {
  const dmx = universes.getBuffer(universeOf(fix));
  const base = fix.address - 1;
  const ch = getProfile(fix).channelMap;
  const ms = mastersOf(fix);

  let top = 0;
  let strobe = 0;
  for (const light of lights) {
    if (light.dim > top) top = light.dim;
    if (light.strobe > strobe) strobe = light.strobe;
  }
  const fixtureDimmer = ch.dimmer !== undefined;
  if (fixtureDimmer)               dmx[base + ch.dimmer] = Math.round(top * ms);
  if (ch.dimmerFine !== undefined) dmx[base + ch.dimmerFine] = 0;
  if (ch.strobe !== undefined) {
    const value = strobeValue(energy, strobe);
    if (value !== null) dmx[base + ch.strobe] = value;
  }

  for (let c = 0; c < cells.length; c++) {
    const cell = cells[c];
    const { col, dim } = lights[c];
    const { cellDim, scale } = cellDrive(dim, top, ms, fixtureDimmer, cell.dimmer !== undefined);
    if (cell.dimmer !== undefined) dmx[base + cell.dimmer] = cellDim;
    writeEmitters(dmx, base, cell, col, scale);
  }
}

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

  const rig = currentRig();
  sizeUnitBuffers(rig.units.length);
  renderPattern(rig, reading);

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
      const { start, count } = rig.ranges[i];
      const cells = rig.cellMaps[i];
      // Each light: its source (a burst, a pinned fixture, or the pattern
      // layer partway through any fade), then the music's level on top.
      const lights = [];
      for (let u = start; u < start + count; u++) lights.push(lightOf(u, fix, energy, fadeT, target));
      if (cells) writeBar(fix, cells, lights, energy);
      else writePar(fix, lights[0], energy);
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
  // One frame, synchronously: for tests that pin exactly what the rig puts out
  // and for measuring what a frame costs. The server only ever renders from
  // the loop startEngine runs.
  renderFrame: renderDmx,
};
