'use strict';

const { state, universeOf, maxBrightnessOf, activeUniverses } = require('./state');
const { getProfile, profilesRevision } = require('./profiles');
const { sendUniverse, sendHue, stopHue } = require('./output');
const universes = require('./universes');
const { guarded } = require('./guard');
const { conductor } = require('./conductor');
const { invalidateRig } = require('./rig');
const { createRenderer } = require('./renderer');
const { createTicker, FRAME_MS } = require('./frame-clock');

/**
 * The engine: renders a frame of the rig on every tick of the frame clock and
 * puts it on the wire.
 *
 * What a frame *is* lives in renderer.js, which reads nothing global. This
 * module is the part that knows about the running server: it builds the
 * renderer's input from the live state, reads the musical clock, runs the auto
 * show's cursor at the top of each frame, and hands the result to the outputs.
 */

// Frame times come from the monotonic clock. Date.now() is the wall clock, and
// an NTP correction steps it: forwards and a fade jumps; backwards and dt
// clamps to zero and the rig freezes for a frame.
const clock = () => performance.now();

const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: clock() });

// Requests the renderer picks up at the start of its next frame. Numbered, so
// the same request is never adopted twice and a new one always is.
let fadeRequest = null;          // { seq, ms, at }
let syncRequest = null;          // { seq, seconds, at }
let requestSeq = 0;

/** Fade from what is on stage now over `ms`; 0 cuts, cancelling any fade. */
function beginFade(ms) {
  fadeRequest = { seq: ++requestSeq, ms, at: clock() };
}

/** Flash every fixture once a second for `seconds`, for the Hue sync test. */
function startSyncTest(seconds = 10) {
  syncRequest = { seq: ++requestSeq, seconds, at: clock() };
  return seconds;
}

/**
 * Everything a frame depends on, read off the live state: the look, the
 * masters, the patch (each fixture's universe and trim resolved), and any
 * fade or sync test asked for.
 */
function renderInput() {
  return {
    running: state.running,
    pattern: state.pattern,
    colorA: state.colorA,
    colorB: state.colorB,
    colorC: state.colorC,
    colorD: state.colorD,
    split: state.split,
    pixelMap: state.pixelMap,
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
    })),
  };
}

// Run at the top of every frame, before the clock is read: the auto show fires
// whatever is due by now, so a cue lands on the frame it was scheduled for
// rather than up to a poll interval later.
let frameHook = null;
const runFrameHook = guarded('frame-hook', () => { if (frameHook) frameHook(); });

/** Register what runs at the start of each frame (the auto show's cursor). */
function setFrameHook(fn) {
  frameHook = typeof fn === 'function' ? fn : null;
}

/**
 * The patch changed: forget the picture of the rig, so the next frame builds
 * it afresh rather than finding out from its signature.
 */
function resizeFixtureBuffers() {
  invalidateRig();
  renderer.invalidateRig();
}

/** Put every allocated universe on the wire, and black out the ones retired. */
function transmitFrame() {
  for (const universe of universes.list()) {
    sendUniverse(universe, universes.getBuffer(universe));
  }
  // One last all-zero frame for any universe that just left the patch, so its
  // node doesn't sit holding the look it was showing when the fixture moved.
  for (const [universe, frame] of universes.drainRetired()) sendUniverse(universe, frame, { immediate: true });
}

function renderDmx() {
  const now = clock();
  runFrameHook();
  renderer.frame(renderInput(), conductor.now(), now, universes);
  transmitFrame();
  // Hue is fed once per frame rather than once per universe: one message
  // covers the whole entertainment area, and it reads the colours back out of
  // the buffers that were just filled in above.
  sendHue();
}

// One bad frame is reported and the next one renders; unguarded, a throw here
// ended the process and left every fixture latched on its last frame.
const safeRender = guarded('render', renderDmx);

let ticker = null;

function startEngine() {
  if (ticker) return;                   // idempotent: never stack render loops
  ticker = createTicker({ onTick: safeRender, periodMs: FRAME_MS });
  ticker.start();
}

/** Put every universe out now, bypassing any delay, and close the Hue stream. */
function blackout() {
  universes.sync(activeUniverses());
  universes.clearAll();
  for (const universe of universes.list()) {
    sendUniverse(universe, universes.getBuffer(universe), { immediate: true });
  }
  for (const [universe, frame] of universes.drainRetired()) sendUniverse(universe, frame, { immediate: true });
  // Same courtesy for the bridge: one black frame so the lamps go out, then
  // close the session rather than leaving the area locked to a stream that has
  // stopped arriving.
  sendHue();
  stopHue();
}

/**
 * Stop rendering and put the rig out.
 *
 * Art-Net receivers latch: they hold the last frame they were sent. Without a
 * final all-zero frame, quitting the server leaves the fixtures burning
 * whatever look was on stage — through the end of the night, or until someone
 * power-cycles them.
 */
function stopEngine() {
  if (ticker) ticker.stop();
  ticker = null;
  blackout();
  return Promise.resolve();
}

/** How the frames have been going: see frame-clock.js FrameStats. */
function engineStatus() {
  return {
    thread: 'main',
    running: !!ticker,
    rate: Math.round(1000 / FRAME_MS),
    ...(ticker ? ticker.stats.summary() : {}),
  };
}

module.exports = {
  startEngine,
  stopEngine,
  engineStatus,
  setFrameHook,
  resizeFixtureBuffers,
  startSyncTest,
  beginFade,
  renderInput,
  // One frame, synchronously: for tests that pin exactly what the rig puts out
  // and for measuring what a frame costs. The server only ever renders from
  // the loop startEngine runs.
  renderFrame: renderDmx,
};
