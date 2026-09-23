'use strict';

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

const { parentPort, workerData } = require('worker_threads');

const { createRenderer } = require('./renderer');
const { createUniverseStore } = require('./universes');
const { createTransmitter } = require('./transmit');
const { createTicker, hrtimeMs, FRAME_MS } = require('./frame-clock');
const { createClockFollower } = require('./clock-follow');
const { getProfile, profilesRevision, registerProfile, clearNonBuiltinProfiles } = require('./profiles');
const { guarded } = require('./guard');

const {
  shared, epochMs, periodMs = FRAME_MS, capture = false, seed = null, startNow = null,
} = workerData || {};

/** A seeded stand-in for Math.random, so a test can roll the same dice on both threads. */
function seeded(value) {
  let a = value >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
if (capture && Number.isInteger(seed)) Math.random = seeded(seed);

const store = createUniverseStore(shared);
const transmitter = createTransmitter();
const renderer = createRenderer({
  profileOf: getProfile,
  profilesRevision,
  now: Number.isFinite(startNow) ? startNow : hrtimeMs(),
});
const follow = createClockFollower();

let snapshot = null;             // { input, outputs } from the main thread
let lastStatsAt = -Infinity;

/** The imported profiles, replaced wholesale. The built-ins are already here. */
function setProfiles(profiles) {
  clearNonBuiltinProfiles();
  for (const profile of profiles || []) registerProfile(profile);
}

function transmit(outputs) {
  for (const universe of store.list()) transmitter.send(universe, store.getBuffer(universe), outputs);
  for (const [universe, frame] of store.drainRetired()) transmitter.send(universe, frame, outputs, { immediate: true });
}

let ticker = null;

function renderTick(due, now) {
  if (!snapshot) return;
  const reading = follow.at(now);
  if (!reading) return;
  renderer.frame(snapshot.input, reading, now, store);
  transmit(snapshot.outputs);
  parentPort.postMessage({ type: 'frame' });
  if (now - lastStatsAt >= 1000) {
    lastStatsAt = now;
    parentPort.postMessage({ type: 'stats', stats: ticker.stats.summary() });
  }
}

/** Every universe out now, bypassing the Hue delay, then say so. */
function blackout() {
  if (snapshot) {
    store.sync(snapshot.input.universes);
    store.clearAll();
    const outputs = snapshot.outputs;
    for (const universe of store.list()) {
      transmitter.send(universe, store.getBuffer(universe), outputs, { immediate: true });
    }
    for (const [universe, frame] of store.drainRetired()) transmitter.send(universe, frame, outputs, { immediate: true });
  } else {
    store.clearAll();
  }
}

/** One frame on request, for tests: the universes' bytes come back. */
function renderOnce({ input, reading, now }) {
  renderer.frame(input, reading, now, store);
  const frames = {};
  for (const universe of store.list()) frames[universe] = Array.from(store.getBuffer(universe));
  for (const [universe] of store.drainRetired()) frames[universe] = null;
  return frames;
}

parentPort.on('message', guarded('engine-worker', (msg) => {
  switch (msg && msg.type) {
    case 'profiles':
      setProfiles(msg.profiles);
      break;
    case 'snapshot':
      snapshot = { input: msg.input, outputs: msg.outputs };
      follow.push(msg.reading, msg.at);
      break;
    case 'render':
      parentPort.postMessage({ type: 'rendered', id: msg.id, frames: renderOnce(msg) });
      break;
    case 'stop':
      if (ticker) ticker.stop();
      blackout();
      parentPort.postMessage({ type: 'stopped' });
      break;
    default:
      break;
  }
}));

if (!capture) {
  ticker = createTicker({ onTick: guarded('render', renderTick), periodMs, epochMs });
  ticker.start();
}
parentPort.postMessage({ type: 'ready' });
