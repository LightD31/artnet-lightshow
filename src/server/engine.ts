import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { state, universeOf, maxBrightnessOf, activeUniverses, voices, freeClockRuns } from './state.ts';
import { settings } from './settings.ts';
import { getProfile, profilesRevision, listProfiles, isBuiltinProfile } from './profiles.ts';
import * as output from './output.ts';
import * as universes from './universes.ts';
import { guarded, report } from './guard.ts';
import { conductor } from './conductor.ts';
import { invalidateRig } from './rig.ts';
import { baseIntentOf, createRenderer } from './renderer.ts';
import { createTicker, hrtimeMs, FRAME_MS } from './frame-clock.ts';
import { messageOf } from '../errors.ts';
import { createIdentify } from './identify.ts';
import { hasNoAddress } from '../shared/placement.ts';
import type { FromWorker, ToWorker } from './engine-messages.ts';
import type { FrameSummary, Ticker } from './frame-clock.ts';
import type { CommandResult, FadeRequest, RenderInput, SyncTestRequest, VoiceFrame } from './renderer.ts';
import type { Profile, PulseReading } from '../types/rig.ts';
import type { AudioFrame } from '../shared/effects/audio-frame.ts';
import type { EffectSpec } from '../shared/effects/types.ts';
import type { MusicalTime } from './conductor.ts';
import type { SequenceFrame } from './sequencer.ts';
import { validateSpec } from '../shared/effects/registry.ts';
import { effectContentKey } from '../shared/effects/layer.ts';

export type EngineThread = 'worker' | 'main';

export type EngineStatus = {
  thread: EngineThread | null;
  running: boolean;
  rate: number;
  fellBack: string | null;
  commands: { submitted: number; processed: number; applied: number };
} & Partial<FrameSummary>;

// Send control snapshots ahead of the deadline so the worker has them before rendering.
const CONTROL_LEAD_MS = 6;

// A worker that dies this often is not going to settle: render here instead.
const MAX_CRASHES = 3;
const CRASH_WINDOW_MS = 60000;
const RESTART_DELAY_MS = 250;

const STOP_TIMEOUT_MS = 300;

let clock = () => performance.now();

const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: clock() });

// Translate performance.now() into the process clock once so voice and worker lifetimes align.
const WORKER_CLOCK_SHIFT = hrtimeMs() - performance.now();

let fadeRequest: FadeRequest | null = null;
let syncRequest: SyncTestRequest | null = null;
let requestSeq = 0;

function beginFade(ms: number): void {
  fadeRequest = { seq: ++requestSeq, ms, at: clock() };
}

function startSyncTest(seconds = 10): number {
  syncRequest = { seq: ++requestSeq, seconds, at: clock() };
  return seconds;
}

const identify = createIdentify({ clock: () => clock() });

let effectSource: ((pattern: string) => EffectSpec | null) | null = null;
let effectFailed = false;

function resolveEffect(pattern: string): EffectSpec | null {
  if (!effectSource) return null;
  try {
    return effectSource(pattern) ?? null;
  } catch (err) {
    if (!effectFailed) console.warn(`[engine] effect source failed: ${messageOf(err)}`);
    effectFailed = true;
    return null;
  }
}

function currentEffect(): EffectSpec | null {
  return resolveEffect(state.pattern);
}

function setEffectSource(fn: ((pattern: string) => EffectSpec | null) | null | undefined): void {
  effectSource = typeof fn === 'function' ? fn : null;
  effectFailed = false;
  validatedEffect = null;
}

// Count disappearance and return as revisions so deleted and restored effects restart.
let effectRevision = 0;
let handed: { pattern: string; spec: EffectSpec | null; key: string | null } | null = null;

function noteEffect(pattern: string, spec: EffectSpec | null): void {
  if (handed && handed.pattern === pattern) {
    if (handed.spec === spec) return;
    const key = spec ? effectContentKey(spec) : null;
    if (key !== handed.key) effectRevision++;
    handed = { pattern, spec, key };
    return;
  }
  handed = { pattern, spec, key: spec ? effectContentKey(spec) : null };
}

// Observe library edits immediately so delete-and-resave between frames still restarts the effect.
function effectChanged(): void {
  if (handed && handed.pattern === state.pattern) noteEffect(state.pattern, currentEffect());
}

let validatedEffect: { raw: EffectSpec; spec: EffectSpec } | null = null;

function baseEffect(): { id: string; spec: EffectSpec } | null {
  const raw = currentEffect();
  if (!raw) return null;
  if (!validatedEffect || validatedEffect.raw !== raw) {
    try {
      validatedEffect = { raw, spec: validateSpec(raw) };
    } catch {
      return null;
    }
  }
  return { id: `base:${state.pattern}`, spec: validatedEffect.spec };
}

const NO_SEQUENCE: SequenceFrame = Object.freeze({ table: null, transport: null });
let sequenceSource: ((reading: MusicalTime) => SequenceFrame | null) | null = null;
let sequenceFailed = false;
let sequenceNow: SequenceFrame = NO_SEQUENCE;

function runSequenceSource(reading: MusicalTime): void {
  if (!sequenceSource) { sequenceNow = NO_SEQUENCE; return; }
  try {
    sequenceNow = sequenceSource(reading) ?? NO_SEQUENCE;
  } catch (err) {
    if (!sequenceFailed) console.warn(`[engine] sequence source failed: ${messageOf(err)}`);
    sequenceFailed = true;
    sequenceNow = NO_SEQUENCE;
  }
}

// Resend sequence tables when their source changes because revisions are only local to one source.
function setSequenceSource(fn: ((reading: MusicalTime) => SequenceFrame | null) | null | undefined): void {
  sequenceSource = typeof fn === 'function' ? fn : null;
  sequenceFailed = false;
  sequenceNow = NO_SEQUENCE;
  mainSequence = undefined;
  postedSequence = undefined;
}

const revisionOf = (frame: SequenceFrame): number | null => frame.table?.revision ?? null;

function voiceFrames(): VoiceFrame[] {
  const worker = thread === 'worker';
  const frames = voices.frames(performance.now(), worker ? CONTROL_LEAD_MS + FRAME_MS : 0);
  if (!worker) return frames;
  return frames.map((v) => ({ ...v, startedAtMs: v.startedAtMs + WORKER_CLOCK_SHIFT,
    untilMs: v.untilMs === null ? null : v.untilMs + WORKER_CLOCK_SHIFT }));
}

function renderInput(): RenderInput {
  const effect = currentEffect();
  noteEffect(state.pattern, effect);
  return {
    running: state.running,
    pattern: state.pattern,
    colorA: state.colorA,
    colorB: state.colorB,
    colorC: state.colorC,
    colorD: state.colorD,
    split: state.split,
    pixelMap: state.pixelMap,
    pixelPattern: state.pixelPattern,
    pixelSpan: state.pixelSpan,
    pixelFrom: state.pixelFrom,
    panelPattern: state.panelPattern,
    flashLimit: state.flashLimit,
    beatDivision: state.beatDivision,
    strobeSpeed: state.strobeSpeed,
    strobeFunction: state.strobeFunction,
    masterDimmer: state.masterDimmer,
    masterBlackout: state.masterBlackout,
    energy: state.heldEnergy ?? state.energyOverride,
    showDynamics: state.showDynamics,
    patternAnchor: state.patternAnchor,
    fade: fadeRequest,
    syncTest: syncRequest,
    identify: identify.request(),
    universes: activeUniverses(),
    pulse: runPulseSource(),
    audio: runAudioSource(),
    audioMode: settings.get('audio.mode'),
    master: { ...settings.get('audio.master') },
    // Always include safety settings so live output cannot use legacy absent-safety admission.
    safety: {
      hdFlashIntervalMs: settings.get('safety.hdFlashIntervalMs'),
      acknowledged: settings.get('safety.photosensitivityAcknowledged'),
    },
    hueStrobe: settings.get('hue.strobe'),
    effect,
    effectRevision,
    voices: voiceFrames(),
    paletteOverride: state.paletteOverride,
    basePalette: state.basePalette,
    overridePalette: state.overridePalette,
    sequenceRevision: revisionOf(sequenceNow),
    sequenceTransport: sequenceNow.transport,
    fixtures: state.fixtures.map((f) => ({
      id: f.id,
      address: f.address,
      universe: universeOf(f),
      profileId: f.profileId,
      maxBrightness: maxBrightnessOf(f),
      override: f.override || null,
      position: f.position || null,
      group: f.group || null,
      geometry: f.geometry || null,
      hue: hasNoAddress(f),
    })),
  };
}

// Advance the show before reading the clock so cues reach their scheduled render frame.
let frameHook: (() => void) | null = null;
const runFrameHook = guarded('frame-hook', () => { if (frameHook) frameHook(); });

function setFrameHook(fn: (() => void) | null | undefined): void {
  frameHook = typeof fn === 'function' ? fn : null;
}

let pulseSource: (() => PulseReading | null) | null = null;
let pulseFailed = false;
function runPulseSource(): PulseReading | null {
  if (!pulseSource) return null;
  try {
    return pulseSource();
  } catch (err) {
    if (!pulseFailed) console.warn(`[engine] pulse source failed: ${err instanceof Error ? err.message : String(err)}`);
    pulseFailed = true;
    return null;
  }
}

function setPulseSource(fn: (() => PulseReading | null) | null | undefined): void {
  pulseSource = typeof fn === 'function' ? fn : null;
  pulseFailed = false;
}

let audioSource: (() => AudioFrame | null) | null = null;
let audioFailed = false;
function runAudioSource(): AudioFrame | null {
  if (!audioSource) return null;
  try {
    return audioSource();
  } catch (err) {
    if (!audioFailed) console.warn(`[engine] audio source failed: ${messageOf(err)}`);
    audioFailed = true;
    return null;
  }
}

function setAudioSource(fn: (() => AudioFrame | null) | null | undefined): void {
  audioSource = typeof fn === 'function' ? fn : null;
  audioFailed = false;
}

function resizeFixtureBuffers(): void {
  invalidateRig();
  renderer.invalidateRig();
}

function transmitFrame(): void {
  for (const universe of universes.list()) {
    output.sendUniverse(universe, universes.getBuffer(universe));
  }
  // Send retired universes one zero frame so receivers cannot latch the previous look.
  for (const [universe, frame] of universes.drainRetired()) {
    output.sendUniverse(universe, frame, { immediate: true, terminate: true });
  }
  output.endFrame();
}

let mainGridOrigin: number | undefined;
let mainSequence: number | null | undefined;

function renderDmx(): void {
  const now = clock();
  runFrameHook();
  const reading = conductor.now();
  runSequenceSource(reading);
  if (revisionOf(sequenceNow) !== mainSequence) {
    renderer.setSequence(sequenceNow.table);
    mainSequence = revisionOf(sequenceNow);
  }
  renderer.frame(renderInput(), reading, now, universes, mainGridOrigin);
  settleCommands(renderer.takeCommandResults(), renderer.commandStatus());
  transmitFrame();
  // Feed Hue once per frame because one Entertainment message covers the whole area.
  output.sendHue();
}

const safeRender = guarded('render', renderDmx);

let ticker: Ticker | null = null;               // this thread's frame loop, or the control tick
let worker: Worker | null = null;               // the engine thread, while one is running
let thread: EngineThread | null = null;         // null while stopped
let workerStats: FrameSummary | null = null;    // the worker's last timing report
let fellBack: string | null = null;             // why the engine is here and not in its worker
let crashes: number[] = [];
let postedRevision = -1;
let postedSequence: number | null | undefined;
let stopping: (() => void) | null = null;       // resolves when the worker has blacked out
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let workerFile = path.join(import.meta.dirname, 'engine-worker.ts');
let lastPosted: { at: number; reading: ReturnType<typeof conductor.now> } | null = null;

let commandSeq = 0;
let commandsProcessed = 0;
let commandsApplied = 0;
const pendingCommands = new Map<number, (result: CommandResult) => void>();

function settleCommands(results: readonly CommandResult[], status?: { processed: number; applied: number }): void {
  for (const result of results) {
    const resolve = pendingCommands.get(result.seq);
    pendingCommands.delete(result.seq);
    if (resolve) resolve(result);
  }
  if (status) {
    commandsProcessed = Math.max(commandsProcessed, status.processed);
    commandsApplied = Math.max(commandsApplied, status.applied);
  }
}

// Fail commands when their driver disappears; replay could repeat an action already applied.
function failPendingCommands(): void {
  for (const [seq, resolve] of pendingCommands) resolve({ seq, status: 'unavailable' });
  pendingCommands.clear();
}

function effectCommand(cmd: string, arg?: unknown): Promise<CommandResult> {
  const seq = ++commandSeq;
  if (!thread) return Promise.resolve({ seq, status: 'unavailable' });
  const input = renderInput();
  const intent = baseIntentOf(input);
  return new Promise((resolve) => {
    pendingCommands.set(seq, resolve);
    if (thread === 'worker') {
      if (!worker) { failPendingCommands(); return; }
      // Post the intended base snapshot first so the worker command targets that look.
      if (lastPosted) {
        postSequence(worker);
        post(worker, { type: 'snapshot', at: lastPosted.at, input, reading: { ...lastPosted.reading, moving: freeClockRuns() }, outputs: output.transmitConfig() });
      }
      post(worker, { type: 'command', seq, cmd, arg, intent });
    } else {
      renderer.command(seq, cmd, arg, intent);
    }
  });
}

function post(w: Worker, msg: ToWorker): void {
  w.postMessage(msg);
}

// Send the sequence table before any snapshot naming its revision.
function postSequence(w: Worker): void {
  const revision = revisionOf(sequenceNow);
  if (revision === postedSequence) return;
  post(w, { type: 'sequence', table: sequenceNow.table });
  postedSequence = revision;
}

function startMainDriver(): void {
  thread = 'main';
  clock = () => performance.now();
  universes.setWritable(true);
  // Record the grid origin in both clocks so worker and main rendering use the same frame boundaries.
  const epochMs = hrtimeMs();
  mainGridOrigin = clock();
  mainSequence = undefined;
  ticker = createTicker({ onTick: safeRender, periodMs: FRAME_MS, epochMs });
  ticker.start();
}

function importedProfiles(): Profile[] {
  return Object.values(listProfiles()).filter((p) => !isBuiltinProfile(p.id));
}

function controlTick(): void {
  if (!worker) return;
  runFrameHook();
  const reading = conductor.now();
  runSequenceSource(reading);
  const at = hrtimeMs();
  lastPosted = { at, reading };
  const revision = profilesRevision();
  if (revision !== postedRevision) {
    post(worker, { type: 'profiles', profiles: importedProfiles() });
    postedRevision = revision;
  }
  postSequence(worker);
  post(worker, {
    type: 'snapshot',
    at,
    input: renderInput(),
    // Keep the free clock stopped when no pattern, voice or sequence needs it.
    reading: { ...reading, moving: freeClockRuns() },
    outputs: output.transmitConfig(),
  });
}

function onWorkerMessage(msg: FromWorker | null): void {
  if (!msg) return;
  switch (msg.type) {
    case 'frame':
      output.sendHue();
      break;
    case 'stats':
      workerStats = msg.stats;
      break;
    case 'commands':
      settleCommands(msg.results, { processed: msg.processed, applied: msg.applied });
      break;
    case 'stopped':
      if (stopping) stopping();
      break;
    default:
      break;
  }
}

function spawnWorker(epochMs: number): void {
  let ready = false;
  const w = new Worker(workerFile, {
    workerData: { shared: universes.shared, epochMs, periodMs: FRAME_MS },
  });
  worker = w;
  postedRevision = -1;
  postedSequence = undefined;
  w.on('message', (msg: FromWorker | null) => {
    if (msg && msg.type === 'ready') ready = true;
    if (msg && msg.type === 'commands' && worker !== w) return;
    guarded('engine', onWorkerMessage)(msg);
  });
  w.on('error', (err) => report('engine worker', err));
  w.on('exit', (code) => {
    if (worker !== w) return;           // a worker already replaced or stopped
    worker = null;
    failPendingCommands();
    if (thread !== 'worker') return;
    const now = Date.now();
    crashes = crashes.filter((at) => now - at < CRASH_WINDOW_MS).concat(now);
    if (!ready || crashes.length >= MAX_CRASHES) {
      fellBack = !ready
        ? `the engine thread could not start (exit ${code})`
        : `the engine thread stopped ${crashes.length} times in a minute`;
      console.warn(`[engine] ${fellBack} — rendering on the main thread instead`);
      if (ticker) ticker.stop();
      startMainDriver();
      return;
    }
    console.warn(`[engine] the engine thread stopped (exit ${code}) — restarting it`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (thread === 'worker' && !worker) spawnWorker(epochMs);
    }, RESTART_DELAY_MS);
  });
}

function startWorkerDriver(): void {
  thread = 'worker';
  clock = hrtimeMs;
  universes.setWritable(false);
  const epochMs = hrtimeMs();
  spawnWorker(epochMs);
  ticker = createTicker({
    onTick: guarded('engine-control', controlTick),
    periodMs: FRAME_MS,
    phaseMs: -CONTROL_LEAD_MS,
    epochMs,
  });
  ticker.start();
}

function startEngine({ thread: where = 'main', file = null }: { thread?: EngineThread; file?: string | null } = {}): void {
  if (thread) return;                   // idempotent: never stack render loops
  workerFile = file || path.join(import.meta.dirname, 'engine-worker.ts');
  fellBack = null;
  crashes = [];
  if (where === 'worker') {
    try {
      startWorkerDriver();
      return;
    } catch (err) {
      fellBack = `the engine thread could not start (${messageOf(err)})`;
      console.warn(`[engine] ${fellBack} — rendering on the main thread instead`);
      if (ticker) ticker.stop();
      worker = null;
    }
  }
  startMainDriver();
}

function blackout(): void {
  universes.setWritable(true);
  universes.sync(activeUniverses());
  universes.clearAll();
  for (const universe of universes.list()) {
    output.sendUniverse(universe, universes.getBuffer(universe), { immediate: true, terminate: true });
  }
  for (const [universe, frame] of universes.drainRetired()) {
    output.sendUniverse(universe, frame, { immediate: true, terminate: true });
  }
  output.endFrame();
}

function hueOut(): void {
  // Rather than leaving the area locked to a stream that has stopped arriving.
  output.sendHue();
  output.stopHue();
}

function stopEngine(): Promise<void> {
  if (ticker) ticker.stop();
  ticker = null;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  const w = worker;
  thread = null;
  worker = null;
  workerStats = null;
  lastPosted = null;
  mainGridOrigin = undefined;
  failPendingCommands();
  // Discard commands already reported unavailable so a replacement driver cannot apply them later.
  renderer.rejectCommands('unavailable');
  renderer.takeCommandResults();
  clock = () => performance.now();

  if (!w) {
    blackout();
    hueOut();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const finish = (blackedOut: boolean) => {
      clearTimeout(timer);
      stopping = null;
      if (!blackedOut) blackout();
      universes.setWritable(true);
      hueOut();
      w.terminate().catch(() => {});
      resolve();
    };
    const timer = setTimeout(() => finish(false), STOP_TIMEOUT_MS);
    stopping = () => finish(true);
    try {
      post(w, { type: 'stop' });
    } catch (_) {
      finish(false);
    }
  });
}

function engineStatus(): EngineStatus {
  const stats = thread === 'worker' ? workerStats : (ticker ? ticker.stats.summary() : null);
  return {
    thread,
    running: !!thread,
    rate: Math.round(1000 / FRAME_MS),
    fellBack,
    commands: { submitted: commandSeq, processed: commandsProcessed, applied: commandsApplied },
    ...(stats || {}),
  };
}

export {
  startEngine,
  stopEngine,
  engineStatus,
  setFrameHook,
  setPulseSource,
  setAudioSource,
  setEffectSource,
  resolveEffect,
  effectChanged,
  setSequenceSource,
  resizeFixtureBuffers,
  startSyncTest,
  identify,
  beginFade,
  baseEffect,
  effectCommand,
  renderInput,
  CONTROL_LEAD_MS,
  renderDmx as renderFrame,
};
