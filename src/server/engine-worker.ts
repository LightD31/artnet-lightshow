import { parentPort, workerData } from 'node:worker_threads';

import { createRenderer } from './renderer.ts';
import { allocateShared, createUniverseStore } from './universes.ts';
import { createTransmitter } from './transmit.ts';
import { createTicker, hrtimeMs, FRAME_MS } from './frame-clock.ts';
import { createClockFollower } from './clock-follow.ts';
import { getProfile, profilesRevision, registerProfile, clearNonBuiltinProfiles, BUILTIN_PROFILE_ID, HUE_COLOR_PROFILE_ID } from './profiles.ts';
import { HOLD_STROBE } from '../shared/look-math.ts';
import { guarded } from './guard.ts';
import type { MusicalTime } from './conductor.ts';
import type { EngineWorkerData, FromWorker, RenderedFrames, ToWorker } from './engine-messages.ts';
import type { Ticker } from './frame-clock.ts';
import type { RenderInput } from './renderer.ts';
import type { SequenceTable } from '../shared/effects/sequence.ts';
import type { TransmitConfig } from './transmit.ts';
import type { Profile } from '../types/rig.ts';

if (!parentPort) throw new Error('engine-worker.ts runs as a worker thread');
const port = parentPort;

const post = (msg: FromWorker) => port.postMessage(msg);

const {
  shared, epochMs, periodMs = FRAME_MS, capture = false, seed = null, startNow = null,
} = (workerData || {}) as EngineWorkerData;

function seeded(value: number): () => number {
  let a = value >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
if (capture && Number.isInteger(seed)) Math.random = seeded(seed as number);

const store = createUniverseStore();               // rendered into, this thread only
const published = createUniverseStore(shared);     // what the main thread reads
const transmitter = createTransmitter();
const renderer = createRenderer({
  profileOf: getProfile,
  profilesRevision,
  now: typeof startNow === 'number' && Number.isFinite(startNow) ? startNow : hrtimeMs(),
});
const follow = createClockFollower();

// Warm effects on private buffers so first-use compilation cannot overrun a live frame.
function warmUp(): void {
  const scratch = createUniverseStore(allocateShared());
  const warm = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
  const par = (id: number) => ({ id, address: 1 + 12 * id, universe: 0, profileId: BUILTIN_PROFILE_ID, maxBrightness: 255, override: null,
    position: { x: 20 + 20 * id, y: 40 }, group: null, geometry: null, hue: false });
  const fixtures = [par(0), par(1), par(2), { ...par(3), profileId: HUE_COLOR_PROFILE_ID, hue: true }];
  const look: RenderInput = {
    running: true, pattern: 'chase', colorA: 0, colorB: 5, colorC: 3, colorD: 8, split: null, pixelMap: 'stage', beatDivision: 1,
    strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false, energy: null, showDynamics: null,
    patternAnchor: null, fade: null, syncTest: null, universes: [0], fixtures, safety: { hdFlashIntervalMs: 350, acknowledged: true },
  };
  let now = 0;
  for (const energy of [null, 'blinder', HOLD_STROBE, 'white-strobe']) {
    for (const hueStrobe of ['flash', 'pulse'] as const) {
      for (let k = 0; k < 2; k++) {
        warm.frame({ ...look, energy, hueStrobe }, { beatPos: now / 500, bpm: 120, source: 'tap', epoch: 0 }, now, scratch, 0);
        now += FRAME_MS;
      }
    }
  }
}

let snapshot: { input: RenderInput; outputs: TransmitConfig } | null = null;   // from the main thread
let pendingSequence: { table: SequenceTable | null } | null = null;

function takeSequence(): void {
  if (!pendingSequence) return;
  renderer.setSequence(pendingSequence.table);
  pendingSequence = null;
}

let lastStatsAt = -Infinity;

function setProfiles(profiles: Profile[] | null | undefined): void {
  clearNonBuiltinProfiles();
  for (const profile of profiles || []) registerProfile(profile);
}

function publish(): void {
  const live = store.list();
  published.sync(live);
  for (const universe of live) published.getBuffer(universe).set(store.getBuffer(universe));
  published.drainRetired();
}

function transmit(outputs: TransmitConfig): void {
  for (const universe of store.list()) transmitter.send(universe, store.getBuffer(universe), outputs);
  for (const [universe, frame] of store.drainRetired()) {
    transmitter.send(universe, frame, outputs, { immediate: true, terminate: true });
  }
  transmitter.endFrame(outputs);
}

let ticker: Ticker | null = null;

function postCommands(): void {
  const results = renderer.takeCommandResults();
  if (!results.length) return;
  const { processed, applied } = renderer.commandStatus();
  post({ type: 'commands', results, processed, applied });
}

function renderTick(due: number, now: number): void {
  const reading = snapshot ? follow.at(now) : null;
  if (!snapshot || !reading) {
    renderer.rejectCommands('unavailable');
    postCommands();
    return;
  }
  renderer.frame(snapshot.input, reading, now, store, epochMs);
  postCommands();
  transmit(snapshot.outputs);
  publish();
  post({ type: 'frame' });
  if (now - lastStatsAt >= 1000) {
    lastStatsAt = now;
    if (ticker) post({ type: 'stats', stats: ticker.stats.summary() });
  }
}

function blackout(): void {
  if (snapshot) {
    store.sync(snapshot.input.universes);
    store.clearAll();
    const outputs = snapshot.outputs;
    for (const universe of store.list()) {
      transmitter.send(universe, store.getBuffer(universe), outputs, { immediate: true, terminate: true });
    }
    for (const [universe, frame] of store.drainRetired()) {
      transmitter.send(universe, frame, outputs, { immediate: true, terminate: true });
    }
    transmitter.endFrame(outputs);
  } else {
    store.clearAll();
  }
  publish();
}

function renderOnce({ input, reading, now, gridOriginMs }: { input: RenderInput; reading: MusicalTime; now: number; gridOriginMs?: number }): RenderedFrames {
  renderer.frame(input, reading, now, store, gridOriginMs);
  const frames: RenderedFrames = {};
  for (const universe of store.list()) frames[universe] = Array.from(store.getBuffer(universe));
  for (const [universe] of store.drainRetired()) frames[universe] = null;
  return frames;
}

port.on('message', guarded('engine-worker', (msg: ToWorker | null) => {
  if (!msg) return;
  switch (msg.type) {
    case 'profiles':
      setProfiles(msg.profiles);
      break;
    case 'snapshot':
      takeSequence();
      snapshot = { input: msg.input, outputs: msg.outputs };
      follow.push(msg.reading, msg.at);
      break;
    case 'sequence':
      pendingSequence = { table: msg.table ?? null };
      break;
    case 'render': {
      takeSequence();
      if (msg.table !== undefined) renderer.setSequence(msg.table);
      const frames = renderOnce(msg);
      const commands = renderer.takeCommandResults();
      post({ type: 'rendered', id: msg.id, frames, ...(commands.length ? { commands } : {}) });
      break;
    }
    case 'command':
      renderer.command(msg.seq, msg.cmd, msg.arg, msg.intent ?? null);
      break;
    case 'stop':
      if (ticker) ticker.stop();
      blackout();
      post({ type: 'stopped' });
      break;
    default:
      break;
  }
}));

if (!capture) {
  try { warmUp(); } catch { /* nothing to undo: it touched only its own renderer */ }
  ticker = createTicker({ onTick: guarded('render', renderTick), periodMs, epochMs });
  ticker.start();
}
post({ type: 'ready' });
