import { state, getFixture, setDefaultUniverse, latchEnergy, reconcileFreeClock } from './state.ts';
import { beginFade, resolveEffect } from './engine.ts';
import { conductor } from './conductor.ts';
import { safety } from './safety.ts';
import { anchorStep } from '../shared/beat-clock.ts';
import { parseHex } from '../shared/effects/palette.ts';
import { energyEffectSpec } from '../shared/effects/catalogue.ts';
import { patchSchema, overrideSchema, validate } from './validation.ts';
import { STROBE_FUNCTIONS } from './presets.ts';
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
  /** A hand on the master or the tempo (not the sequence's own change): the sequencer ends that automation. */
  handEdit(edit: { masterDimmer: boolean; bpm: boolean }): void;
}

const COLOR_SLOTS = ['colorA', 'colorB', 'colorC', 'colorD'] as const;

const hooks: PatchHooks = {
  prolinkEnable: () => {},
  prolinkDisable: () => {},
  autoPaletteSize: () => {},
  autoIntensity: () => {},
  autoSyncOffsetMs: () => {},
  autoPrefetchDepth: () => {},
  broadcast: () => {},
  // Registered by server.js: the show store reads this module, so importing it here is a cycle.
  showChanged: () => {},
  handEdit: () => {},
};

function setHooks(partial: Partial<PatchHooks>): void { Object.assign(hooks, partial); }

// Socket edits to Art-Net and PRO DJ LINK persist too, or a restart reverts them.
let persist: (partial: SettingsPatch) => void = () => {};
function setPersist(fn: (partial: SettingsPatch) => void): void { persist = fn; }

// Saved once the hand comes off, not per 5 ms encoder detent on the thread that renders DMX.
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

export interface PatchOptions {
  /** Runs after validation and admission, before any change; a throw refuses the whole patch. */
  beforeCommit?: () => void;
  /** 'sequence' is no hand edit, so it ends no automation, and the sequencer broadcasts itself. */
  origin?: 'hand' | 'sequence';
}

// Admission comes first: an effect awaiting the photosensitivity acknowledgement refuses it all (409).
function applyPatch(rawData: unknown, { beforeCommit, origin = 'hand' }: PatchOptions = {}): Patch {
  const data = validate(patchSchema, rawData || {}, 'patch');
  // Naming the pattern is starting it, even the one on stage; a fader moved under it is not.
  if (data.pattern !== undefined) {
    const effect = resolveEffect(data.pattern);
    if (effect) safety.requireAcknowledged(effect);
  }
  // Naming an energy effect is starting it too; an id that is none takes the latch off.
  if (data.energyOverride) {
    const energy = energyEffectSpec(data.energyOverride);
    if (energy) safety.requireAcknowledged(energy);
  }
  if (beforeCommit) beforeCommit();

  // A cut cancels a running fade, so a drop lands hard even mid-fade.
  const changesLook = data.pattern !== undefined || data.palette !== undefined
    || data.split !== undefined || data.pixelMap !== undefined || data.pixelPattern !== undefined
    || data.panelPattern !== undefined || data.paletteOverride !== undefined
    || COLOR_SLOTS.some((slot) => data[slot] !== undefined);
  if (data.fadeMs !== undefined || changesLook) beginFade(data.fadeMs || 0);

  // Before the BPM, which replaces the tempo a switch to 'manual' hands over; 'auto' again ends a hand.
  if (data.tempoMode !== undefined) {
    const switches = data.tempoMode !== state.tempoMode;
    state.tempoMode = data.tempoMode;
    conductor.setTempoMode(data.tempoMode);
    if (switches) persist({ clock: { tempoMode: data.tempoMode } });
  }
  if (data.bpm !== undefined) {
    // To a hundredth, so a nudge from 123.7 lands on 124.7 rather than float noise.
    data.bpm = Math.round(data.bpm * 100) / 100;
    // An auto show tempo mark (anchorMs) is no hand, and shows only if the clock took it.
    if (conductor.setBpm(data.bpm, { manual: data.anchorMs === undefined })) state.bpm = data.bpm;
  }
  if (data.running !== undefined) {
    state.running = data.running;
    // Stopped, the free clock stands still — unless a voice still plays on it.
    reconcileFreeClock(true);
  }

  // A scheduled scene counts from its beat, so a late or seek-restored scene lands on the same step.
  const patternChanges = (data.pattern !== undefined && data.pattern !== state.pattern)
    || (data.pixelPattern !== undefined && data.pixelPattern !== state.pixelPattern)
    || (data.panelPattern !== undefined && data.panelPattern !== state.panelPattern);
  const divisionChanges = data.beatDivision !== undefined && data.beatDivision !== state.beatDivision;
  const scheduled = data.anchorMs !== undefined
    && (data.pattern !== undefined || data.pixelPattern !== undefined || data.panelPattern !== undefined
      || data.beatDivision !== undefined);
  if (data.beatDivision !== undefined) state.beatDivision = data.beatDivision;
  if (data.pattern !== undefined) state.pattern = data.pattern;
  if (patternChanges || divisionChanges || scheduled) anchorPattern(data.anchorMs);
  // Before the single slots, so "this look, but slot A in red" lands as it reads.
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

  // A slot written by hand drops the look's label; re-sending the value it had is no edit.
  for (const slot of COLOR_SLOTS) {
    const value = data[slot];
    if (value === undefined) continue;
    if (!paletteApplied && value !== state[slot]) state.palette = null;
    state[slot] = value;
  }
  // Parsed once here: the renderer takes colours, the wire and cues hex.
  if (data.paletteOverride !== undefined) {
    state.paletteOverride = data.paletteOverride === null ? null : data.paletteOverride.map(parseHex);
  }
  if (data.split !== undefined) state.split = data.split;
  if (data.pixelMap !== undefined) state.pixelMap = data.pixelMap;
  if (data.pixelPattern !== undefined) state.pixelPattern = data.pixelPattern;
  // A pattern picked by hand runs the whole rig from its start: bar pictures and spans are the show's.
  else if (data.pattern !== undefined && data.anchorMs === undefined) {
    state.pixelPattern = null;
    state.pixelSpan = null;
    state.pixelFrom = null;
  }
  // The panels' too; a picture picked for the bars alone leaves theirs.
  if (data.panelPattern !== undefined) state.panelPattern = data.panelPattern;
  else if (data.pattern !== undefined && data.anchorMs === undefined) state.panelPattern = null;
  if (data.pixelSpan !== undefined) state.pixelSpan = data.pixelSpan;
  if (data.pixelFrom !== undefined) state.pixelFrom = data.pixelFrom;
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
  // An id that is no energy effect takes the latched one off.
  if (data.energyOverride !== undefined) latchEnergy(data.energyOverride);
  if (data.artnet !== undefined) {
    // Through setDefaultUniverse, so fixtures on the default universe move with it.
    const { universe, ...rest } = data.artnet;
    Object.assign(state.artnet, rest);
    if (universe !== undefined) setDefaultUniverse(universe);
    persist({ artnet: { ...state.artnet } });
    // Its fixtures moved, so the saved patch follows.
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
    // Rounded once, so the MIDI encoder ring and the auto show agree.
    state.autoIntensity = Math.round(data.autoIntensity);
    hooks.autoIntensity(state.autoIntensity);
  }
  if (data.autoSyncOffsetMs !== undefined) {
    // Persisted: the offset belongs to the room and the rig, not tonight's set.
    state.autoSyncOffsetMs = Math.round(data.autoSyncOffsetMs);
    persistSyncOffsetSoon();
    hooks.autoSyncOffsetMs(state.autoSyncOffsetMs);
  }
  if (data.autoPrefetchDepth !== undefined) {
    state.autoPrefetchDepth = data.autoPrefetchDepth;
    hooks.autoPrefetchDepth(data.autoPrefetchDepth);
  }

  if (origin === 'sequence') return data;
  // A tempo the auto show schedules (anchorMs) is the music's, not a hand's.
  const masterDimmer = data.masterDimmer !== undefined;
  const bpm = data.bpm !== undefined && data.anchorMs === undefined;
  if (masterDimmer || bpm) hooks.handEdit({ masterDimmer, bpm });
  hooks.broadcast();
  return data;
}

// Rounded onto the step grid, so the pattern steps on the beat.
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

// Apart from applyOverride: a trim is no look, survives clearing it, and is never cued.
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
    hooks.handEdit({ masterDimmer: false, bpm: true });
  }
  // A tap is a beat: the step lands on it, and a followed source's tempo is taken by hand.
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
