import { state, getFixture, setDefaultUniverse } from './state.ts';
import { beginFade } from './engine.ts';
import { conductor } from './conductor.ts';
import { anchorStep } from '../shared/beat-clock.ts';
import { patchSchema, overrideSchema, validate } from './validation.ts';
import { STROBE_FUNCTIONS, ENERGY_EFFECTS } from './presets.ts';
import { paletteSlots } from './palettes.ts';
import type { Patch } from './validation.ts';
import type { SettingsPatch } from './settings.ts';

/** What the rest of the server does when a patch touches it (set by integrations). */
export interface PatchHooks {
  prolinkEnable(): void;
  prolinkDisable(): void;
  autoPaletteSize(size: NonNullable<Patch['autoPaletteSize']>): void;
  autoIntensity(value: number): void;
  autoSyncOffsetMs(value: number): void;
  autoPrefetchDepth(value: number): void;
  broadcast(): void;
  showChanged(): void;
}

const COLOR_SLOTS = ['colorA', 'colorB', 'colorC', 'colorD'] as const;

// Hooks the rest of the system can register to react to specific patch keys.
// (Used for prolink enable/disable, autoShow palette/intensity, broadcasting.)
const hooks: PatchHooks = {
  prolinkEnable: () => {},
  prolinkDisable: () => {},
  autoPaletteSize: () => {},
  autoIntensity: () => {},
  autoSyncOffsetMs: () => {},
  autoPrefetchDepth: () => {},
  broadcast: () => {},
  // The patch changed: save it. Registered by server.js rather than required
  // here, because the show store reads this module's state and requiring it
  // back would be a cycle.
  showChanged: () => {},
};

function setHooks(partial: Partial<PatchHooks>): void { Object.assign(hooks, partial); }

// Art-Net and PRO DJ LINK are reachable from the main page as well as the
// settings page. Without this, changing them there would work until the next
// restart and then silently revert to whatever the settings page holds.
let persist: (partial: SettingsPatch) => void = () => {};
function setPersist(fn: (partial: SettingsPatch) => void): void { persist = fn; }

// The sync offset is dialled in with an encoder or a slider, 5 ms a detent,
// and each change used to rewrite settings.json synchronously on the thread
// that renders DMX. It is saved once the hand comes off instead; the value in
// memory — the one the show uses — changes at once either way.
const SYNC_OFFSET_SAVE_DELAY_MS = 750;
let syncOffsetSaveTimer: ReturnType<typeof setTimeout> | null = null;

function persistSyncOffsetSoon(): void {
  if (syncOffsetSaveTimer) clearTimeout(syncOffsetSaveTimer);
  const timer = setTimeout(flushPendingPersist, SYNC_OFFSET_SAVE_DELAY_MS);
  if (timer.unref) timer.unref();
  syncOffsetSaveTimer = timer;
}

/** Save a change still waiting on its delay. Called on the way down. */
function flushPendingPersist(): void {
  if (!syncOffsetSaveTimer) return;
  clearTimeout(syncOffsetSaveTimer);
  syncOffsetSaveTimer = null;
  persist({ auto: { syncOffsetMs: state.autoSyncOffsetMs } });
}

function applyPatch(rawData: unknown): Patch {
  // Validate at the boundary. Throws on invalid input.
  const data = validate(patchSchema, rawData || {}, 'patch');

  // A new look fades if it asks to and cuts if it does not — and a cut
  // cancels a fade still running, so a drop lands hard even mid-breakdown-fade.
  const changesLook = data.pattern !== undefined || data.palette !== undefined
    || data.split !== undefined || data.pixelMap !== undefined
    || COLOR_SLOTS.some((slot) => data[slot] !== undefined);
  if (data.fadeMs !== undefined || changesLook) beginFade(data.fadeMs || 0);

  if (data.bpm !== undefined) {
    // To a hundredth: finer than any source measures, and 123.7 + 1 from a
    // nudge lands on 124.7 rather than on float noise.
    data.bpm = Math.round(data.bpm * 100) / 100;
    state.bpm = data.bpm;
    // The free clock's tempo, from the beat it is on now. A tempo typed or
    // nudged by hand also takes the clock back from a locked track; the auto
    // show's own tempo marks do not need to, since its grid outranks it.
    conductor.setBpm(data.bpm, { manual: data.anchorMs === undefined });
  }
  if (data.running !== undefined) {
    state.running = data.running;
    conductor.setRunning(data.running);
  }

  // A new pattern or division counts its steps from here — from fixture one on
  // the next step of the grid, as it always has. A scene from the auto show
  // says when it was scheduled, and counts from that beat instead, so a scene
  // fired a frame late and a scene restored by a seek land on the same step.
  // Re-sending the pattern already running (a button pressed twice) is not a
  // change and does not restart it.
  const patternChanges = data.pattern !== undefined && data.pattern !== state.pattern;
  const divisionChanges = data.beatDivision !== undefined && data.beatDivision !== state.beatDivision;
  const scheduled = data.anchorMs !== undefined && (data.pattern !== undefined || data.beatDivision !== undefined);
  if (data.beatDivision !== undefined) state.beatDivision = data.beatDivision;
  if (data.pattern !== undefined) state.pattern = data.pattern;
  if (patternChanges || divisionChanges || scheduled) anchorPattern(data.anchorMs);
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
    const value = data[slot];
    if (value === undefined) continue;
    if (!paletteApplied && value !== state[slot]) state.palette = null;
    state[slot] = value;
  }
  if (data.split !== undefined) state.split = data.split;
  if (data.pixelMap !== undefined) state.pixelMap = data.pixelMap;
  if (data.showDynamics !== undefined) {
    state.showDynamics = data.showDynamics === null ? null : { ...state.showDynamics, ...data.showDynamics };
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
    // Moving the rig's default universe takes its fixtures with it, so the
    // saved patch has to follow.
    if (universe !== undefined) hooks.showChanged();
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
    persistSyncOffsetSoon();
    hooks.autoSyncOffsetMs(state.autoSyncOffsetMs);
  }
  if (data.autoPrefetchDepth !== undefined) {
    state.autoPrefetchDepth = data.autoPrefetchDepth;
    hooks.autoPrefetchDepth(data.autoPrefetchDepth);
  }

  hooks.broadcast();
  return data;
}

/**
 * Anchor the running pattern's step count on the musical clock: at the beat a
 * scene was scheduled for when there is a grid to read it from, else where the
 * music is now. Rounded onto the step grid, so the pattern steps on the beat.
 */
function anchorPattern(anchorMs: number | undefined): void {
  const reading = conductor.now();
  const scheduled = anchorMs !== undefined ? conductor.beatAtTrackMs(anchorMs) : null;
  const beatPos = scheduled !== null && Number.isFinite(scheduled) ? scheduled : reading.beatPos;
  state.patternAnchor = { step: anchorStep(beatPos, state.beatDivision || 1), epoch: reading.epoch };
}

function applyOverride(id: number, rawOverride: unknown): void {
  const fixture = getFixture(id);
  if (!fixture) return;
  const override = rawOverride === null
    ? null
    : validate(overrideSchema, rawOverride, 'override');
  fixture.override = override;
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
function setFixtureMaxBrightness(id: number, value: unknown): void {
  const fixture = getFixture(id);
  if (!fixture) return;
  const raw = Number(value);
  if (!Number.isFinite(raw)) return;
  fixture.maxBrightness = Math.max(0, Math.min(255, Math.round(raw)));
  hooks.showChanged();
  hooks.broadcast();
}

const tapTimes: number[] = [];

function processTap(): void {
  const now = Date.now();
  tapTimes.push(now);
  if (tapTimes.length > 8) tapTimes.shift();
  if (tapTimes.length >= 2) {
    const diffs = [];
    for (let i = 1; i < tapTimes.length; i++) diffs.push(tapTimes[i] - tapTimes[i - 1]);
    const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    // A tenth of a BPM: finer than a hand can tap, coarse enough to read.
    state.bpm = Math.max(20, Math.min(300, Math.round(600000 / avg) / 10));
    conductor.setBpm(state.bpm);
  }
  // A tap *is* a beat: the clock jumps to the next whole beat, so the step
  // lands on the tap, and a track the clock was locked to hands the tempo over.
  conductor.tap();
  hooks.broadcast();
  setTimeout(() => {
    if (tapTimes.length > 0 && Date.now() - tapTimes[tapTimes.length - 1] > 2500) tapTimes.length = 0;
  }, 3000);
}

export {
  flushPendingPersist,
  applyPatch,
  applyOverride,
  setFixtureMaxBrightness,
  processTap,
  setHooks,
  setPersist,
};
