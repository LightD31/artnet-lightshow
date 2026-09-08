'use strict';

const { state, getFixtureCount, universeOf, maxBrightnessOf, activeUniverses } = require('./state');
const { COLOR_PRESETS, STROBE_FUNCTIONS } = require('./presets');
const { getProfile, UV_BOOST } = require('./profiles');
const { sendUniverse } = require('./output');
const universes = require('./universes');
const { PATTERN_FUNCS } = require('./patterns');

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

function tickPattern() {
  if (!state.running) return;
  const fn = PATTERN_FUNCS[state.pattern];
  if (!fn) return;

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
    write: setFixtureColor,
    resetHitPhase: () => { state._hitPhase = 0; },
  });

  state._step++;
  state._hue = (state._hue + 360 / Math.max(1, getFixtureCount())) % 360;
}

function resolveEnergyOverride() {
  const colA = COLOR_PRESETS[state.colorA];
  switch (state.energyOverride) {
    case 'white-strobe': return { col: { r: 255, g: 255, b: 255, w: 255, a: 0,   uv: 0   }, dim: 255, strobe: 255 };
    case 'blinder':      return { col: { r: 255, g: 255, b: 255, w: 255, a: 0,   uv: 0   }, dim: 255, strobe: 0   };
    case 'uv-strobe':    return { col: { r: 60,  g: 0,   b: 200, w: 0,   a: 0,   uv: 255 }, dim: 255, strobe: 255 };
    case 'color-strobe': return {
      col: { r: colA.r, g: colA.g, b: colA.b, w: colA.w || 0, a: colA.a || 0, uv: colA.uv || 0 },
      dim: 255, strobe: 255,
    };
    case 'all-on':       return { col: { r: 255, g: 255, b: 255, w: 255, a: 255, uv: 255 }, dim: 255, strobe: 0   };
    default: return null;
  }
}

let lastRenderTs = Date.now();

function renderDmx() {
  const now = Date.now();
  const dt = Math.max(0, Math.min(0.25, (now - lastRenderTs) / 1000));
  lastRenderTs = now;

  // Continuous fade — runs at the full DMX rate (40 Hz). Full cycle spans 8 beats.
  if (state.running && state.pattern === 'fade') {
    const cycleSeconds = (60 / Math.max(1, state.bpm)) * 8;
    state._fadePhase = (state._fadePhase + dt / cycleSeconds) % 1;
    const bright = Math.round(((Math.sin(state._fadePhase * Math.PI * 2 - Math.PI / 2) + 1) / 2) * 230 + 25);
    const colA = COLOR_PRESETS[state.colorA];
    for (let i = 0; i < getFixtureCount(); i++) setFixtureColor(i, colA, bright, 0);
  }

  // 'hit' decay 255 → 35 over one beat. tickPattern resets _hitPhase on each beat.
  if (state.running && state.pattern === 'hit') {
    const beatSec = Math.max(0.05, (60 / Math.max(1, state.bpm)) / Math.max(1, state.beatDivision));
    state._hitPhase = Math.min(1, (state._hitPhase ?? 1) + dt / beatSec);
    const decay = Math.pow(1 - state._hitPhase, 1.8);
    const bright = Math.round(35 + decay * 220);
    const colA = COLOR_PRESETS[state.colorA];
    for (let i = 0; i < getFixtureCount(); i++) setFixtureColor(i, colA, bright, 0);
  }

  const energy = state.energyOverride ? resolveEnergyOverride() : null;

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

  // With the buffers already cleared, a blackout is simply empty universes.
  if (!state.masterBlackout) {
    const fixtureCount = getFixtureCount();
    for (let i = 0; i < fixtureCount; i++) {
      const fix = state.fixtures[i];
      const dmx = universes.getBuffer(universeOf(fix));
      const base = fix.address - 1;
      let col, dim, strobe;

      if (energy) {
        col = energy.col; dim = energy.dim; strobe = energy.strobe;
      } else if (fix.override && fix.override.enabled) {
        const ov = fix.override;
        if (ov.blackout) {
          col = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 }; dim = 0; strobe = 0;
        } else {
          col = { r: ov.r, g: ov.g, b: ov.b, w: ov.w, a: ov.a || 0, uv: ov.uv || 0 };
          dim = ov.dim !== undefined ? ov.dim : 255;
          strobe = ov.strobe !== undefined ? ov.strobe : 0;
        }
      } else {
        const fc = fixtureColors[i];
        col = { r: fc.r, g: fc.g, b: fc.b, w: fc.w, a: fc.a || 0, uv: fc.uv || 0 };
        dim = fc.dim; strobe = fc.strobe;
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

      if (ch.red !== undefined)   dmx[base + ch.red]   = Math.round(col.r * ts);
      if (ch.green !== undefined) dmx[base + ch.green] = Math.round(col.g * ts);
      if (ch.blue !== undefined)  dmx[base + ch.blue]  = Math.round(col.b * ts);
      if (ch.white !== undefined) dmx[base + ch.white] = Math.round(col.w * ts);
      if (ch.amber !== undefined) dmx[base + ch.amber] = Math.round(col.a * ts);
      if (ch.uv !== undefined)    dmx[base + ch.uv]    = Math.min(255, Math.round(col.uv * ts * UV_BOOST));
    }
  }

  for (const universe of universes.list()) {
    sendUniverse(universe, universes.getBuffer(universe));
  }
  // One last all-zero frame for any universe that just left the patch, so its
  // node doesn't sit holding the look it was showing when the fixture moved.
  for (const [universe, frame] of universes.drainRetired()) sendUniverse(universe, frame);
}

let beatInterval = null;
let renderInterval = null;

function bpmInterval() { return (60000 / state.bpm) / state.beatDivision; }

function restartBeatTimer({ tickNow = false } = {}) {
  if (beatInterval) clearInterval(beatInterval);
  beatInterval = null;
  if (state.running) {
    if (tickNow) tickPattern();
    beatInterval = setInterval(tickPattern, bpmInterval());
  }
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
  if (beatInterval) clearInterval(beatInterval);
  if (renderInterval) clearInterval(renderInterval);
  beatInterval = null;
  renderInterval = null;
  universes.sync(activeUniverses());
  universes.clearAll();
  for (const universe of universes.list()) {
    sendUniverse(universe, universes.getBuffer(universe));
  }
  for (const [universe, frame] of universes.drainRetired()) sendUniverse(universe, frame);
}

module.exports = {
  startEngine,
  stopEngine,
  restartBeatTimer,
  resizeFixtureBuffers,
};
