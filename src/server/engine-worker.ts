/**
 * The engine's own thread.
 *
 * The main thread serves the UI, plans each track, parses uploads, talks to
 * Spotify, the CDJs and the MIDI controller — and any of those can hold it for
 * tens of milliseconds at the moment a new track starts, which is exactly when
 * the rig's timing matters most. Here nothing else runs: this thread renders
 * every frame on its own clock and puts it on the wire.
 *
 * The main thread stays the owner of the show. A few milliseconds before each
 * frame it runs the auto show's cursor, reads the musical clock and posts a
 * snapshot — the renderer's input, the clock reading, the output settings (see
 * engine.js). This thread renders from the latest one. When a snapshot is late
 * the frame still goes out on time, from the last snapshot with the musical
 * clock carried forward (clock-follow.js), so a stall on the main thread no
 * longer shows on stage.
 *
 * Frames are written into memory the main thread shares (universes.js), which
 * is how the DMX monitor and the Hue lamps read them without a copy. After
 * each frame a one-word message tells the main thread to feed Hue.
 *
 * `capture` mode is for tests: no timer, no sockets — each `render` message
 * renders exactly one frame from the input and reading it carries, and the
 * reply carries the bytes.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { createRenderer } from './renderer.ts';
import { createUniverseStore } from './universes.ts';
import { createTransmitter } from './transmit.ts';
import { createTicker, hrtimeMs, FRAME_MS } from './frame-clock.ts';
import { createClockFollower } from './clock-follow.ts';
import { getProfile, profilesRevision, registerProfile, clearNonBuiltinProfiles } from './profiles.ts';
import { guarded } from './guard.ts';
import type { MusicalTime } from './conductor.ts';
import type { EngineWorkerData, FromWorker, RenderedFrames, ToWorker } from './engine-messages.ts';
import type { Ticker } from './frame-clock.ts';
import type { RenderInput } from './renderer.ts';
import type { TransmitConfig } from './transmit.ts';
import type { Profile } from '../types/rig.ts';

if (!parentPort) throw new Error('engine-worker.ts runs as a worker thread');
const port = parentPort;

/** Tell the main thread something. */
const post = (msg: FromWorker) => port.postMessage(msg);

const {
  shared, epochMs, periodMs = FRAME_MS, capture = false, seed = null, startNow = null,
} = (workerData || {}) as EngineWorkerData;

/** A seeded stand-in for Math.random, so a test can roll the same dice on both threads. */
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

const store = createUniverseStore(shared);
const transmitter = createTransmitter();
const renderer = createRenderer({
  profileOf: getProfile,
  profilesRevision,
  now: typeof startNow === 'number' && Number.isFinite(startNow) ? startNow : hrtimeMs(),
});
const follow = createClockFollower();

let snapshot: { input: RenderInput; outputs: TransmitConfig } | null = null;   // from the main thread
let lastStatsAt = -Infinity;

/** The imported profiles, replaced wholesale. The built-ins are already here. */
function setProfiles(profiles: Profile[] | null | undefined): void {
  clearNonBuiltinProfiles();
  for (const profile of profiles || []) registerProfile(profile);
}

function transmit(outputs: TransmitConfig): void {
  for (const universe of store.list()) transmitter.send(universe, store.getBuffer(universe), outputs);
  for (const [universe, frame] of store.drainRetired()) {
    transmitter.send(universe, frame, outputs, { immediate: true, terminate: true });
  }
  transmitter.endFrame(outputs);
}

let ticker: Ticker | null = null;

/** Tell the main thread what became of its commands, when anything did. */
function postCommands(): void {
  const results = renderer.takeCommandResults();
  if (!results.length) return;
  const { processed, applied } = renderer.commandStatus();
  post({ type: 'commands', results, processed, applied });
}

function renderTick(due: number, now: number): void {
  const reading = snapshot ? follow.at(now) : null;
  if (!snapshot || !reading) {
    // Nothing to render yet: a command waiting would wait for nothing.
    renderer.rejectCommands('unavailable');
    postCommands();
    return;
  }
  // The effects count their frames from the ticker's grid (epochMs, phase 0).
  renderer.frame(snapshot.input, reading, now, store, epochMs);
  postCommands();
  transmit(snapshot.outputs);
  post({ type: 'frame' });
  if (now - lastStatsAt >= 1000) {
    lastStatsAt = now;
    if (ticker) post({ type: 'stats', stats: ticker.stats.summary() });
  }
}

/** Every universe out now, bypassing the Hue delay, then say so. */
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
}

/** One frame on request, for tests: the universes' bytes come back. */
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
      snapshot = { input: msg.input, outputs: msg.outputs };
      follow.push(msg.reading, msg.at);
      break;
    case 'render': {
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
  ticker = createTicker({ onTick: guarded('render', renderTick), periodMs, epochMs });
  ticker.start();
}
post({ type: 'ready' });
