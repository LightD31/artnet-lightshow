'use strict';

const { state, dmx, getFixtureCount } = require('./state');
const { COLOR_PRESETS, STROBE_FUNCTIONS } = require('./presets');
const { getProfile, UV_BOOST } = require('./profiles');
const { sendArtDmx } = require('./artnet');
const { PATTERN_FUNCS } = require('./patterns');

let fixtureColors = Array.from({ length: 4 }, () => ({
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

  for (let i = 0; i < getFixtureCount(); i++) {
    const fix = state.fixtures[i];
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

    const profile = getProfile(fix);
    const chCount = profile.channelCount;
    const ch = profile.channelMap;

    if (state.masterBlackout) {
      for (let c = 0; c < chCount; c++) dmx[base + c] = 0;
      continue;
    }

    for (let c = 0; c < chCount; c++) dmx[base + c] = 0;

    // Energy overrides bypass master dimmer — always full output
    const ms = energy ? 1 : state.masterDimmer / 255;
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

  sendArtDmx(state.artnet, dmx);
}

let beatInterval = null;

function bpmInterval() { return (60000 / state.bpm) / state.beatDivision; }

function restartBeatTimer({ tickNow = false } = {}) {
  if (beatInterval) clearInterval(beatInterval);
  if (state.running) {
    if (tickNow) tickPattern();
    beatInterval = setInterval(tickPattern, bpmInterval());
  }
}

function startEngine() {
  restartBeatTimer();
  setInterval(renderDmx, 25);
}

module.exports = {
  startEngine,
  restartBeatTimer,
  resizeFixtureBuffers,
};
