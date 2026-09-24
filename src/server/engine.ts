import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { state, universeOf, maxBrightnessOf, activeUniverses } from './state.ts';
import { getProfile, profilesRevision, listProfiles, isBuiltinProfile } from './profiles.ts';
import * as output from './output.ts';
import * as universes from './universes.ts';
import { guarded, report } from './guard.ts';
import { conductor } from './conductor.ts';
import { invalidateRig } from './rig.ts';
import { createRenderer } from './renderer.ts';
import { createTicker, hrtimeMs, FRAME_MS } from './frame-clock.ts';
import { messageOf } from '../errors.ts';
import type { FromWorker, ToWorker } from './engine-messages.ts';
import type { FrameSummary, Ticker } from './frame-clock.ts';
import type { FadeRequest, RenderInput, SyncTestRequest } from './renderer.ts';
import type { Profile, PulseReading } from '../types/rig.ts';

/** Where frames are rendered: a thread of their own, or this one. */
export type EngineThread = 'worker' | 'main';

/** Where frames are rendered and how the frames have been going. */
export type EngineStatus = {
  thread: EngineThread | null;
  running: boolean;
  rate: number;
  fellBack: string | null;
} & Partial<FrameSummary>;

/**
 * The engine: renders a frame of the rig on every tick of the frame clock and
 * puts it on the wire.
 *
 * What a frame *is* lives in renderer.js, which reads nothing global. This
 * module is the part that knows about the running server: it builds the
 * renderer's input from the live state, reads the musical clock, runs the auto
 * show's cursor at the top of each frame, and hands the result to the outputs.
 *
 * It runs the renderer in one of two places:
 *
 *   worker  (the server's default) a thread of its own, engine-worker.ts. The
 *           main thread runs a *control tick* a few milliseconds ahead of every
 *           frame on the same frame grid — the auto show's cursor, the musical
 *           clock, a snapshot posted across — and the worker renders on time
 *           whether or not the main thread got there.
 *   main    this thread, straight from the live state, as it always used to.
 *           What the tests drive, and the fallback when a worker cannot run.
 */

// How far ahead of each frame the control tick runs, so its snapshot is there
// before the worker renders. Comfortably more than a timer's jitter, and a
// fraction of a frame.
const CONTROL_LEAD_MS = 6;

// A worker that dies this often is not going to settle: render here instead.
const MAX_CRASHES = 3;
const CRASH_WINDOW_MS = 60000;
const RESTART_DELAY_MS = 250;

// How long a stopping worker gets to black the rig out before this thread
// does it instead.
const STOP_TIMEOUT_MS = 300;

// Frame times come from the monotonic clock. Date.now() is the wall clock, and
// an NTP correction steps it: forwards and a fade jumps; backwards and dt
// clamps to zero and the rig freezes for a frame. On this thread the engine
// counts in performance.now(); with a worker, fades and sync tests are stamped
// on the process-wide clock the worker renders by.
let clock = () => performance.now();

const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: clock() });

// Requests the renderer picks up at the start of its next frame. Numbered, so
// the same request is never adopted twice and a new one always is.
let fadeRequest: FadeRequest | null = null;
let syncRequest: SyncTestRequest | null = null;
let requestSeq = 0;

/** Fade from what is on stage now over `ms`; 0 cuts, cancelling any fade. */
function beginFade(ms: number): void {
  fadeRequest = { seq: ++requestSeq, ms, at: clock() };
}

/** Flash every fixture once a second for `seconds`, for the Hue sync test. */
function startSyncTest(seconds = 10): number {
  syncRequest = { seq: ++requestSeq, seconds, at: clock() };
  return seconds;
}

/**
 * Everything a frame depends on, read off the live state: the look, the
 * masters, the patch (each fixture's universe and trim resolved), and any
 * fade or sync test asked for.
 */
function renderInput(): RenderInput {
  // A fixture a Hue lamp follows is never strobed in software: the lamp would
  // flash with it, and a Hue bridge is no strobe (see renderer.js).
  const followed = output.hueFollowedFixtures ? output.hueFollowedFixtures() : null;
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
    universes: activeUniverses(),
    pulse: runPulseSource(),
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
      hue: !!(followed && followed.has(f.id)),
    })),
  };
}

// Run at the top of every frame, before the clock is read: the auto show fires
// whatever is due by now, so a cue lands on the frame it was scheduled for
// rather than up to a poll interval later.
let frameHook: (() => void) | null = null;
const runFrameHook = guarded('frame-hook', () => { if (frameHook) frameHook(); });

/** Register what runs at the start of each frame (the auto show's cursor). */
function setFrameHook(fn: (() => void) | null | undefined): void {
  frameHook = typeof fn === 'function' ? fn : null;
}

// Where the music is at pixel rate (show/pulse.ts): read with each frame's
// input, after the frame hook has moved the show on. Seven numbers, so it
// rides in the snapshot the engine thread renders from.
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

/** Register what says how the music moves inside the beat (the auto show's pulse). */
function setPulseSource(fn: (() => PulseReading | null) | null | undefined): void {
  pulseSource = typeof fn === 'function' ? fn : null;
  pulseFailed = false;
}

/**
 * The patch changed: forget the picture of the rig, so the next frame builds
 * it afresh rather than finding out from its signature.
 */
function resizeFixtureBuffers(): void {
  invalidateRig();
  renderer.invalidateRig();
}

/** Put every allocated universe on the wire, and black out the ones retired. */
function transmitFrame(): void {
  for (const universe of universes.list()) {
    output.sendUniverse(universe, universes.getBuffer(universe));
  }
  // One last all-zero frame for any universe that just left the patch, so its
  // node doesn't sit holding the look it was showing when the fixture moved.
  for (const [universe, frame] of universes.drainRetired()) {
    output.sendUniverse(universe, frame, { immediate: true, terminate: true });
  }
  output.endFrame();
}

function renderDmx(): void {
  const now = clock();
  runFrameHook();
  renderer.frame(renderInput(), conductor.now(), now, universes);
  transmitFrame();
  // Hue is fed once per frame rather than once per universe: one message
  // covers the whole entertainment area, and it reads the colours back out of
  // the buffers that were just filled in above.
  output.sendHue();
}

// One bad frame is reported and the next one renders; unguarded, a throw here
// ended the process and left every fixture latched on its last frame.
const safeRender = guarded('render', renderDmx);

// ── The drivers ─────────────────────────────────────────────────────────────

let ticker: Ticker | null = null;               // this thread's frame loop, or the control tick
let worker: Worker | null = null;               // the engine thread, while one is running
let thread: EngineThread | null = null;         // null while stopped
let workerStats: FrameSummary | null = null;    // the worker's last timing report
let fellBack: string | null = null;             // why the engine is here and not in its worker
let crashes: number[] = [];
let postedRevision = -1;
let stopping: (() => void) | null = null;       // resolves when the worker has blacked out
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let workerFile = path.join(import.meta.dirname, 'engine-worker.ts');

/** Tell the worker something. */
function post(w: Worker, msg: ToWorker): void {
  w.postMessage(msg);
}

function startMainDriver(): void {
  thread = 'main';
  clock = () => performance.now();
  universes.setWritable(true);
  ticker = createTicker({ onTick: safeRender, periodMs: FRAME_MS });
  ticker.start();
}

/** The imported profiles; the worker has the built-ins already. */
function importedProfiles(): Profile[] {
  return Object.values(listProfiles()).filter((p) => !isBuiltinProfile(p.id));
}

/**
 * Ahead of every frame: fire what the auto show has due, read the musical
 * clock, and post the worker what it needs to render. The profiles go across
 * only when they have changed.
 */
function controlTick(): void {
  if (!worker) return;
  runFrameHook();
  const reading = conductor.now();
  const at = hrtimeMs();
  const revision = profilesRevision();
  if (revision !== postedRevision) {
    post(worker, { type: 'profiles', profiles: importedProfiles() });
    postedRevision = revision;
  }
  post(worker, {
    type: 'snapshot',
    at,
    input: renderInput(),
    // The free clock stands still while the patterns are stopped; carried
    // forward it must too.
    reading: { ...reading, moving: !!state.running },
    outputs: output.transmitConfig(),
  });
}

function onWorkerMessage(msg: FromWorker | null): void {
  if (!msg) return;
  switch (msg.type) {
    case 'frame':
      // The frame is already in the shared buffers: Hue reads it from there.
      output.sendHue();
      break;
    case 'stats':
      workerStats = msg.stats;
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
  w.on('message', (msg: FromWorker | null) => {
    if (msg && msg.type === 'ready') ready = true;
    guarded('engine', onWorkerMessage)(msg);
  });
  w.on('error', (err) => report('engine worker', err));
  w.on('exit', (code) => {
    if (worker !== w) return;           // a worker already replaced or stopped
    worker = null;
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
  // Only the rendering thread allocates a universe's slot in shared memory.
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

/**
 * Start rendering. `thread` is where: 'worker' (what the server runs) or
 * 'main' (the default here, so a test that starts the engine renders on its
 * own thread and can read the frames as they are written). `file` swaps the
 * worker's script, for testing what happens when one will not run.
 */
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

/** Put every universe out now, from this thread, bypassing any delay. */
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

/** One black frame so the Hue lamps go out, then close the stream. */
function hueOut(): void {
  // Rather than leaving the area locked to a stream that has stopped arriving.
  output.sendHue();
  output.stopHue();
}

/**
 * Stop rendering and put the rig out. Resolves once the blackout has gone.
 *
 * Art-Net receivers latch: they hold the last frame they were sent. Without a
 * final all-zero frame, quitting the server leaves the fixtures burning
 * whatever look was on stage — through the end of the night, or until someone
 * power-cycles them.
 *
 * On this thread that happens before this returns. A worker is asked to do it
 * (it owns the sockets the rig has been listening to); if it has not answered
 * in a moment, this thread does it instead.
 */
function stopEngine(): Promise<void> {
  if (ticker) ticker.stop();
  ticker = null;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  const w = worker;
  thread = null;
  worker = null;
  workerStats = null;
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

/** Where frames are rendered and how the frames have been going (FrameStats). */
function engineStatus(): EngineStatus {
  const stats = thread === 'worker' ? workerStats : (ticker ? ticker.stats.summary() : null);
  return {
    thread,
    running: !!thread,
    rate: Math.round(1000 / FRAME_MS),
    fellBack,
    ...(stats || {}),
  };
}

export {
  startEngine,
  stopEngine,
  engineStatus,
  setFrameHook,
  setPulseSource,
  resizeFixtureBuffers,
  startSyncTest,
  beginFade,
  renderInput,
  CONTROL_LEAD_MS,
  renderDmx as renderFrame,
};
