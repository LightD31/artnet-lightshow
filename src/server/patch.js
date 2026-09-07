'use strict';

const { state, getFixtureCount, setDefaultUniverse } = require('./state');
const { restartBeatTimer } = require('./engine');
const { patchSchema, overrideSchema, validate } = require('./validation');
const { STROBE_FUNCTIONS, ENERGY_EFFECTS } = require('./presets');

// Hooks the rest of the system can register to react to specific patch keys.
// (Used for prolink enable/disable, autoShow palette/intensity, broadcasting.)
const hooks = {
  prolinkEnable: () => {},
  prolinkDisable: () => {},
  autoPaletteSize: () => {},
  autoIntensity: () => {},
  autoPrefetchDepth: () => {},
  broadcast: () => {},
};

function setHooks(partial) { Object.assign(hooks, partial); }

// Art-Net and PRO DJ LINK are reachable from the main page as well as the
// settings page. Without this, changing them there would work until the next
// restart and then silently revert to whatever the settings page holds.
let persist = () => {};
function setPersist(fn) { persist = fn; }

function applyPatch(rawData) {
  // Validate at the boundary. Throws on invalid input.
  const data = validate(patchSchema, rawData || {}, 'patch');
  let restartTimer = false;

  if (data.bpm !== undefined) { state.bpm = data.bpm; restartTimer = true; }
  if (data.beatDivision !== undefined) { state.beatDivision = data.beatDivision; restartTimer = true; }
  if (data.running !== undefined) { state.running = data.running; restartTimer = true; }
  if (data.pattern !== undefined) {
    state.pattern = data.pattern;
    state._step = 0;
    state._fadePhase = 0;
    state._hitPhase = 1;
  }
  if (data.colorA !== undefined) state.colorA = data.colorA;
  if (data.colorB !== undefined) state.colorB = data.colorB;
  if (data.colorC !== undefined) state.colorC = data.colorC;
  if (data.colorD !== undefined) state.colorD = data.colorD;
  if (data.masterDimmer !== undefined) state.masterDimmer = data.masterDimmer;
  if (data.masterBlackout !== undefined) state.masterBlackout = data.masterBlackout;
  if (data.strobeSpeed !== undefined) state.strobeSpeed = data.strobeSpeed;
  if (data.strobeFunction !== undefined) {
    state.strobeFunction = STROBE_FUNCTIONS.some((f) => f.id === data.strobeFunction)
      ? data.strobeFunction : 'standard';
  }
  if (data.energyOverride !== undefined) {
    state.energyOverride = data.energyOverride && ENERGY_EFFECTS.some((e) => e.id === data.energyOverride)
      ? data.energyOverride : null;
  }
  if (data.artnet !== undefined) {
    // The universe field goes through setDefaultUniverse so fixtures sitting on
    // the rig's default universe move with it, as they did when there was only
    // one universe to be on.
    const { universe, ...rest } = data.artnet;
    Object.assign(state.artnet, rest);
    if (universe !== undefined) setDefaultUniverse(universe);
    persist({ artnet: { ...state.artnet } });
  }
  if (data.autoSource !== undefined) state.autoSource = data.autoSource;

  if (data.prolinkEnabled !== undefined) {
    if (data.prolinkEnabled && !state.prolinkEnabled) {
      state.prolinkEnabled = true;
      persist({ sources: { prolink: true } });
      hooks.prolinkEnable();
    } else if (!data.prolinkEnabled && state.prolinkEnabled) {
      state.prolinkEnabled = false;
      persist({ sources: { prolink: false } });
      hooks.prolinkDisable();
    }
  }

  if (data.autoPaletteSize !== undefined) hooks.autoPaletteSize(data.autoPaletteSize);
  if (data.autoIntensity !== undefined) hooks.autoIntensity(data.autoIntensity);
  if (data.autoPrefetchDepth !== undefined) {
    state.autoPrefetchDepth = data.autoPrefetchDepth;
    hooks.autoPrefetchDepth(data.autoPrefetchDepth);
  }

  if (restartTimer) restartBeatTimer();
  hooks.broadcast();
  return data;
}

function applyOverride(id, rawOverride) {
  if (id < 0 || id >= getFixtureCount()) return;
  const override = rawOverride === null
    ? null
    : validate(overrideSchema, rawOverride, 'override');
  state.fixtures[id].override = override;
  hooks.broadcast();
}

const tapTimes = [];

function processTap() {
  const now = Date.now();
  tapTimes.push(now);
  if (tapTimes.length > 8) tapTimes.shift();
  if (tapTimes.length >= 2) {
    const diffs = [];
    for (let i = 1; i < tapTimes.length; i++) diffs.push(tapTimes[i] - tapTimes[i - 1]);
    const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    state.bpm = Math.max(20, Math.min(300, Math.round(60000 / avg)));
  }
  // A tap *is* a beat: advance the pattern immediately and phase-align the next
  // tick. Without this, rapid taps would clear and re-arm the beat interval
  // faster than it could fire, freezing patterns.
  restartBeatTimer({ tickNow: true });
  hooks.broadcast();
  setTimeout(() => {
    if (tapTimes.length > 0 && Date.now() - tapTimes[tapTimes.length - 1] > 2500) tapTimes.length = 0;
  }, 3000);
}

module.exports = { applyPatch, applyOverride, processTap, setHooks, setPersist };
