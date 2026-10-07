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

/** Where frames are rendered: a thread of their own, or this one. */
export type EngineThread = 'worker' | 'main';

/** Where frames are rendered and how the frames have been going. */
export type EngineStatus = {
  thread: EngineThread | null;
  running: boolean;
  rate: number;
  fellBack: string | null;
  /**
   * The base effect's commands: the last one submitted, the last one the
   * renderer decided (applied or refused) and the last it applied. A driver
   * that starts afresh keeps these as history; its effect state is new.
   */
  commands: { submitted: number; processed: number; applied: number };
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

// The voices are timed on performance.now() (state.ts), the worker renders by
// the process-wide clock: both count the same nanoseconds from different
// origins, so one difference, read once, moves the one onto the other.
const WORKER_CLOCK_SHIFT = hrtimeMs() - performance.now();

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

// The fixtures showing themselves on the rig (identify.ts), stamped on the
// same clock as the fades so the worker times them as it times those.
const identify = createIdentify({ clock: () => clock() });

// What the look's pattern id plays as an effect (the effect library answers):
// null plays the pattern, as every look did before effects. Nothing answers
// until a library is registered, so until then every look is a pattern.
let effectSource: ((pattern: string) => EffectSpec | null) | null = null;
let effectFailed = false;

/** What a pattern id plays as an effect, or null: a pattern, an id nothing knows, or no library yet. */
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

/** The base look's effect, or null for a pattern. */
function currentEffect(): EffectSpec | null {
  return resolveEffect(state.pattern);
}

/** Register what a pattern id plays as an effect (the effect library). */
function setEffectSource(fn: ((pattern: string) => EffectSpec | null) | null | undefined): void {
  effectSource = typeof fn === 'function' ? fn : null;
  effectFailed = false;
  validatedEffect = null;
}

// The base effect's revision: moved once whenever the effect the renderer was
// last handed for this pattern changes its kind or settings (the renderer's
// content key), goes away or comes back, so it starts again. The renderer
// keeps its state when an effect goes and returns, so that is counted here.
// A colour or brightness edit is the same effect playing on: the renderer
// takes the new colours and level on its next frame, and a command sent
// before the edit still lands. A rename, an edit to another preset or an
// equal copy moves nothing.
let effectRevision = 0;
let handed: { pattern: string; spec: EffectSpec | null; key: string | null } | null = null;

function noteEffect(pattern: string, spec: EffectSpec | null): void {
  if (handed && handed.pattern === pattern) {
    // The library hands out the same frozen spec until it changes.
    if (handed.spec === spec) return;
    const key = spec ? effectContentKey(spec) : null;
    if (key !== handed.key) effectRevision++;
    handed = { pattern, spec, key };
    return;
  }
  // Another pattern is another base (its own id): nothing to start again.
  handed = { pattern, spec, key: spec ? effectContentKey(spec) : null };
}

/**
 * The library changed: look again now rather than at the next frame, so an
 * effect deleted and saved again between two frames still starts again. Only
 * for the pattern the renderer was last handed; one picked since, and not
 * rendered yet, is new to it anyway.
 */
function effectChanged(): void {
  if (handed && handed.pattern === state.pattern) noteEffect(state.pattern, currentEffect());
}

let validatedEffect: { raw: EffectSpec; spec: EffectSpec } | null = null;

/**
 * The base look's effect as the audio detectors see it, validated (an
 * effect that does not validate owns no detector), or null for a pattern.
 */
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

// What the sequencer hands over each frame (sequencer.ts frame()): its clip
// table and, while it plays, where it is. Read once a frame, before the
// input is built; nothing plays until a sequencer registers.
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

/**
 * Register what plays the sequence (the sequencer's frame()). A revision
 * counts within one source, so another source's table is handed over again
 * whatever revision it carries.
 */
function setSequenceSource(fn: ((reading: MusicalTime) => SequenceFrame | null) | null | undefined): void {
  sequenceSource = typeof fn === 'function' ? fn : null;
  sequenceFailed = false;
  sequenceNow = NO_SEQUENCE;
  mainSequence = undefined;
  postedSequence = undefined;
}

/** The table's revision, as a snapshot names it: null for no table. */
const revisionOf = (frame: SequenceFrame): number | null => frame.table?.revision ?? null;

/**
 * The voices playing now, on the clock this frame renders by. The worker
 * renders a moment after the control tick posts, and perhaps again on the
 * same snapshot: a voice that starts before then rides along, and the
 * renderer holds it until its start. Always a list, even an empty one: the
 * renderer then plays nothing of its own for the energy field (R4).
 */
function voiceFrames(): VoiceFrame[] {
  const worker = thread === 'worker';
  const frames = voices.frames(performance.now(), worker ? CONTROL_LEAD_MS + FRAME_MS : 0);
  if (!worker) return frames;
  return frames.map((v) => ({ ...v, startedAtMs: v.startedAtMs + WORKER_CLOCK_SHIFT,
    untilMs: v.untilMs === null ? null : v.untilMs + WORKER_CLOCK_SHIFT }));
}

/**
 * Everything a frame depends on, read off the live state: the look, the
 * masters, the patch (each fixture's universe and trim resolved), the voices
 * over it, and any fade or sync test asked for.
 */
function renderInput(): RenderInput {
  const effect = currentEffect();
  noteEffect(state.pattern, effect);
  // A Hue lamp is never strobed in software: a Hue bridge is no strobe (see
  // renderer.js).
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
    // Explicit, always: an input without safety would keep the old energy
    // burst's admission, which the live rig must never fall back to.
    safety: {
      hdFlashIntervalMs: settings.get('safety.hdFlashIntervalMs'),
      acknowledged: settings.get('safety.photosensitivityAcknowledged'),
    },
    hueStrobe: settings.get('hue.strobe'),
    hardware: settings.group('hardware'),
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
      output: f.output ? { protocol: f.output.protocol } : null,
      productId: f.productId, hardware: f.hardware, admission: f.admission,
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

// What the party effects hear this frame (audio-features.ts): the hop for the
// stream time the room hears now. Plain JSON, like the pulse, so it rides in
// the snapshot too.
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

/** Register what the party effects hear (the live input's audio features). */
function setAudioSource(fn: (() => AudioFrame | null) | null | undefined): void {
  audioSource = typeof fn === 'function' ? fn : null;
  audioFailed = false;
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

// Where the main thread's frame grid starts, on its own clock: the effects
// count their frames from it. Unset when no driver runs (a test's frames).
let mainGridOrigin: number | undefined;
// The table revision this thread's renderer was last handed; undefined hands it again.
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
// The table revision the running worker was last sent; undefined until it has been sent one.
let postedSequence: number | null | undefined;
let stopping: (() => void) | null = null;       // resolves when the worker has blacked out
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let workerFile = path.join(import.meta.dirname, 'engine-worker.ts');
// The control tick's last reading, for a snapshot posted ahead of a command.
let lastPosted: { at: number; reading: ReturnType<typeof conductor.now> } | null = null;

// ── Commands for the base effect ────────────────────────────────────────────
// Studio's and the visualizer's commands are data the renderer applies to
// the base effect's own state, wherever it renders: numbered here, decided
// there once each, in order, and acknowledged as they were actually decided.
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

/**
 * A driver went away with commands it may or may not have applied: they are
 * reported unavailable, never sent again to the next one, which starts its
 * effects afresh (a toggle replayed there would toggle a different state).
 */
function failPendingCommands(): void {
  for (const [seq, resolve] of pendingCommands) resolve({ seq, status: 'unavailable' });
  pendingCommands.clear();
}

/**
 * Send the base effect a command (stop, comboBreak, toggleDirection,
 * fadeToBaseline, setPulserBaselineColor). Resolves with what the renderer
 * did with it: applied, or why not (another effect plays now, the effect
 * takes no commands, it cannot play yet, the engine is not running).
 */
function effectCommand(cmd: string, arg?: unknown): Promise<CommandResult> {
  const seq = ++commandSeq;
  if (!thread) return Promise.resolve({ seq, status: 'unavailable' });
  const input = renderInput();
  const intent = baseIntentOf(input);
  return new Promise((resolve) => {
    pendingCommands.set(seq, resolve);
    if (thread === 'worker') {
      if (!worker) { failPendingCommands(); return; }
      // The look the command is meant for goes first, so it is what the
      // command meets at the worker's next frame.
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

/** Tell the worker something. */
function post(w: Worker, msg: ToWorker): void {
  w.postMessage(msg);
}

/**
 * Send the worker the sequence's table when it has not got this revision:
 * a new one, none (null), or a new worker that has never had one. Always
 * before the snapshot that names it, which the worker renders it by.
 */
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
  // The ticker keeps its grid on the process clock; this thread renders on
  // its own, so the grid's origin is noted on both at once.
  const epochMs = hrtimeMs();
  mainGridOrigin = clock();
  mainSequence = undefined;
  ticker = createTicker({ onTick: safeRender, periodMs: FRAME_MS, epochMs });
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
    // The free clock stands still while the patterns are stopped and no voice
    // or sequence plays; carried forward it must too. Read after the input,
    // whose voices may have just ended.
    reading: { ...reading, moving: freeClockRuns() },
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
  // A new worker has no table, whatever revision the last one had.
  postedSequence = undefined;
  w.on('message', (msg: FromWorker | null) => {
    if (msg && msg.type === 'ready') ready = true;
    // A retired worker's word on a command is no answer: its commands were failed when it went.
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
  lastPosted = null;
  mainGridOrigin = undefined;
  failPendingCommands();
  // What this thread's renderer still holds was just reported unavailable:
  // decided so here, so the next driver's first frame never applies it.
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

/** Where frames are rendered and how the frames have been going (FrameStats). */
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
