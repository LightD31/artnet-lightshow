'use strict';

const { state, getFixtureCount, setDefaultUniverse } = require('./state');
const { restartBeatTimer } = require('./engine');
const { patchSchema, overrideSchema, validate } = require('./validation');
const { STROBE_FUNCTIONS, ENERGY_EFFECTS } = require('./presets');
const { paletteSlots } = require('./palettes');

const COLOR_SLOTS = ['colorA', 'colorB', 'colorC', 'colorD'];

// Hooks the rest of the system can register to react to specific patch keys.
// (Used for prolink enable/disable, autoShow palette/intensity, broadcasting.)
const hooks = {
  prolinkEnable: () => {},
  prolinkDisable: () => {},
  autoPaletteSize: () => {},
  autoIntensity: () => {},
  autoSyncOffsetMs: () => {},
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
  // A palette writes all four slots at once, before the individual ones, so a
  // patch carrying both ("this look, but slot A in red") lands the way it reads.
  //
  // `paletteSize` on its own re-resolves the look already on stage at the new
  // size — "same palette, two colours" — rather than doing nothing, which is
  // what a size change with no palette named can only sensibly mean.
  const wantsPalette = data.palette !== undefined
    || (data.paletteSize !== undefined && state.palette);
  let paletteApplied = false;

  if (wantsPalette) {
    const id = data.palette !== undefined ? data.palette : state.palette;
    if (id === null) {
      state.palette = null;
    } else {
      const slots = paletteSlots(id, data.paletteSize || 4);
      if (slots) {
        Object.assign(state, slots);
        state.palette = id;
        paletteApplied = true;
      }
    }
  }

  // Writing a slot by hand means the rig is no longer showing the named look,
  // so the label goes. Writing the value it already had changes nothing and is
  // left alone — re-clicking the swatch that is already lit is not an edit.
  for (const slot of COLOR_SLOTS) {
    if (data[slot] === undefined) continue;
    if (!paletteApplied && data[slot] !== state[slot]) state.palette = null;
    state[slot] = data[slot];
  }
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
  if (data.autoIntensity !== undefined) {
    // Mirror it into state as well as handing it to the auto show: the MIDI
    // surface reads state to light the encoder ring, and rounding here keeps
    // the two copies telling the same story.
    state.autoIntensity = Math.round(data.autoIntensity);
    hooks.autoIntensity(state.autoIntensity);
  }
  if (data.autoSyncOffsetMs !== undefined) {
    // Persisted, unlike the rest of the auto controls: the right offset is a
    // property of the room and the rig, not of tonight's set, so it should
    // survive a restart rather than being dialled in again every show.
    state.autoSyncOffsetMs = Math.round(data.autoSyncOffsetMs);
    persist({ auto: { syncOffsetMs: state.autoSyncOffsetMs } });
    hooks.autoSyncOffsetMs(state.autoSyncOffsetMs);
  }
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

/**
 * Set a fixture's brightness trim: a scale on everything it outputs.
 *
 * Separate from applyOverride on purpose: a trim is not a look. It survives the
 * override being cleared, it is not captured in a cue, and it applies to
 * whatever is driving the fixture — the pattern engine, an override, or an
 * energy override. Trimming a fixture that is too close to the audience should
 * not also mean taking it out of the show.
 */
function setFixtureMaxBrightness(id, value) {
  if (id < 0 || id >= getFixtureCount()) return;
  const raw = Number(value);
  if (!Number.isFinite(raw)) return;
  state.fixtures[id].maxBrightness = Math.max(0, Math.min(255, Math.round(raw)));
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

module.exports = {
  applyPatch,
  applyOverride,
  setFixtureMaxBrightness,
  processTap,
  setHooks,
  setPersist,
};
