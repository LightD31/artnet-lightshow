// The engine's worker thread renders exactly what the main thread would, and
// keeps rendering when the main thread cannot.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { state } from '../../src/server/state.js';
import * as universes from '../../src/server/universes.js';
import { createRenderer } from '../../src/server/renderer.js';
import { startEngine, stopEngine, engineStatus } from '../../src/server/engine.js';
import { applyPatch } from '../../src/server/patch.js';
import { getProfile, profilesRevision, registerProfile, unregisterProfile } from '../../src/server/profiles.js';
import { barProfile } from '../../src/server/bar-profile.js';
import { FRAME_MS } from '../../src/server/frame-clock.js';

const WORKER = path.join(import.meta.dirname, '..', '..', 'src', 'server', 'engine-worker.js');

/** The same seeded stand-in for Math.random the worker uses in capture mode. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A worker in capture mode: renders one frame per request and sends the bytes back. */
async function captureWorker({ seed, startNow }) {
  const w = new Worker(WORKER, { workerData: { shared: universes.allocateShared(), capture: true, seed, startNow } });
  const pending = new Map();
  let id = 0;
  await new Promise((resolve, reject) => {
    w.on('message', (m) => {
      if (m.type === 'ready') resolve();
      if (m.type === 'rendered') { pending.get(m.id)(m.frames); pending.delete(m.id); }
    });
    w.once('error', reject);
  });
  return {
    profiles: (profiles) => w.postMessage({ type: 'profiles', profiles }),
    render: (input, reading, now) => new Promise((resolve) => {
      const k = ++id;
      pending.set(k, resolve);
      w.postMessage({ type: 'render', id: k, input, reading, now });
    }),
    close: () => w.terminate(),
  };
}

/** The same renderer on this thread, on its own store and its own dice. */
function localRenderer({ seed, startNow }) {
  const store = universes.createUniverseStore(universes.allocateShared());
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: startNow });
  const dice = seeded(seed);
  return (input, reading, now) => {
    const realRandom = Math.random;
    Math.random = dice;
    try {
      renderer.frame(input, reading, now, store);
    } finally {
      Math.random = realRandom;
    }
    const frames = {};
    for (const universe of store.list()) frames[universe] = Array.from(store.getBuffer(universe));
    for (const [universe] of store.drainRetired()) frames[universe] = null;
    return frames;
  };
}

const BAR = barProfile({ id: 'worker-test-bar', name: 'Test Bar', cells: 8, firstChannel: 3, order: 'RGBW', dimmer: 1, strobe: 2 });

const fixture = (id, address, extra = {}) => ({
  id, address, universe: 0, profileId: 'cameo-root-par-6-12ch', maxBrightness: 255,
  override: null, position: null, group: null, geometry: null, ...extra,
});

const RIGS = {
  pars: [
    fixture(0, 1, { position: { x: 80, y: 20 }, group: 'front' }),
    fixture(1, 13, { position: { x: 10, y: 60 }, group: 'back' }),
    fixture(2, 25, { maxBrightness: 120 }),
    fixture(3, 37),
    fixture(4, 49, { profileId: 'generic-hue-lamp-7ch' }),
    fixture(5, 56, { profileId: 'generic-hue-white-ambiance-3ch' }),
  ],
  bars: [
    fixture(0, 1, { profileId: BAR.id, position: { x: 30, y: 30 }, geometry: { length: 20, angle: 0 } }),
    fixture(1, 40, { profileId: BAR.id, position: { x: 70, y: 30 }, geometry: { length: 20, angle: 90 } }),
    fixture(2, 80),
    fixture(3, 1, { universe: 1 }),
  ],
};

const DYNAMICS = { level: 0.7, bass: 0.8, vocal: 0.3, air: 0.5, width: 0.6, motion: 0.5, decay: 0.2 };

/** A run of scenes as (input, reading, now) triples, the same for both threads. */
function scenes(fixtures) {
  const out = [];
  let beat = 0;
  let now = 1000;
  let anchorSeq = 0;
  const base = {
    running: true, colorA: 1, colorB: 5, colorC: 3, colorD: 8, split: null, pixelMap: 'stage',
    beatDivision: 2, strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false,
    energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null,
    universes: [...new Set([0, ...fixtures.map((f) => f.universe)])].sort((a, b) => a - b),
    fixtures,
  };
  const run = (patch, frames = 16) => {
    const input = { ...base, ...patch, patternAnchor: { step: 0, epoch: 0, seq: ++anchorSeq } };
    for (let f = 0; f < frames; f++) {
      out.push([input, { beatPos: beat, bpm: 120, source: 'tap', epoch: 0 }, now]);
      beat += 0.125;
      now += FRAME_MS;
    }
  };
  const patterns = ['solid', 'fade', 'hit', 'chase', 'wave', 'rainbow', 'twinkle', 'sparkle', 'random-flash',
    'ensemble', 'ribbon', 'sections', 'gradient', 'comet', 'burst', 'plasma', 'meter', 'strobe'];
  for (const pattern of patterns) run({ pattern, strobeSpeed: pattern === 'strobe' ? 200 : 0 });
  for (const pattern of ['wave', 'twinkle', 'ribbon']) run({ pattern, showDynamics: DYNAMICS });
  for (const pixelMap of ['bar', 'mirror']) run({ pattern: 'comet', pixelMap });
  run({ pattern: 'chase', split: 0 });
  run({ pattern: 'chase', energy: 'color-strobe' }, 8);
  run({ pattern: 'wave', fade: { seq: 1, ms: 300, at: now }, colorA: 5 });
  run({ pattern: 'solid', fixtures: fixtures.map((f, i) => (i === 1 ? { ...f, override: { enabled: true, r: 200, g: 10, b: 30, w: 0, dim: 180 } } : f)) }, 4);
  run({ pattern: 'solid', masterBlackout: true }, 2);
  run({ pattern: 'solid', masterDimmer: 90, fixtures: fixtures.slice(0, 1), universes: [0] }, 4);
  return out;
}

for (const [name, fixtures] of Object.entries(RIGS)) {
  test(`the worker renders a rig of ${name} byte for byte as the main thread does`, async () => {
    registerProfile(BAR);
    const seed = 99;
    const startNow = 0;
    const worker = await captureWorker({ seed, startNow });
    try {
      worker.profiles([BAR]);
      const local = localRenderer({ seed, startNow });
      let frame = 0;
      for (const [input, reading, now] of scenes(fixtures)) {
        const expected = local(input, reading, now);
        const got = await worker.render(input, reading, now);
        assert.deepStrictEqual(got, expected, `frame ${frame} (${input.pattern}) differs`);
        frame++;
      }
      assert.ok(frame > 300);
    } finally {
      await worker.close();
      unregisterProfile(BAR.id);
    }
  });
}

// ── The server's engine, on its thread ───────────────────────────────────────

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lit = () => Array.from(universes.getBuffer(state.artnet.universe)).some((v) => v > 0);

test('with a worker, frames land in memory the main thread reads', async () => {
  state.artnet.enabled = false;
  applyPatch({ pattern: 'solid', running: true, masterDimmer: 255, masterBlackout: false, colorA: 1 });
  startEngine({ thread: 'worker' });
  try {
    await wait(250);
    assert.strictEqual(engineStatus().thread, 'worker');
    assert.ok(lit(), 'the rendered look is visible from the main thread');
  } finally {
    await stopEngine();
  }
  assert.ok(!lit(), 'stopping blacks the rig out');
  assert.strictEqual(engineStatus().thread, null);
});

test('frames keep coming while the main thread is busy', async () => {
  state.artnet.enabled = false;
  applyPatch({ pattern: 'chase', running: true, masterDimmer: 255, masterBlackout: false, colorA: 1 });
  startEngine({ thread: 'worker' });
  try {
    await wait(200);
    const until = Date.now() + 250;
    while (Date.now() < until) { /* hold the main thread, as a big track plan would */ }
    // The worker reports its timing once a second.
    await wait(1300);
    const status = engineStatus();
    assert.strictEqual(status.thread, 'worker');
    assert.ok(status.frames > 30, `${status.frames} frames reported`);
    assert.strictEqual(status.skippedFrames, 0, 'no frame skipped for the stall');
  } finally {
    await stopEngine();
  }
});

test('a worker that will not start leaves the engine rendering on the main thread', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-worker-'));
  const broken = path.join(dir, 'broken-worker.js');
  fs.writeFileSync(broken, "throw new Error('no engine here');\n");
  const errors = [];
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...args) => errors.push(args.join(' '));
  console.warn = (...args) => errors.push(args.join(' '));
  state.artnet.enabled = false;
  applyPatch({ pattern: 'solid', running: true, masterDimmer: 255, masterBlackout: false, colorA: 1 });
  try {
    startEngine({ thread: 'worker', file: broken });
    await wait(400);
    const status = engineStatus();
    assert.strictEqual(status.thread, 'main');
    assert.match(status.fellBack, /could not start/);
    assert.ok(lit(), 'and the rig is lit from here');
  } finally {
    await stopEngine();
    console.error = realError;
    console.warn = realWarn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(errors.some((line) => /main thread instead/.test(line)), 'the fallback is reported');
});
