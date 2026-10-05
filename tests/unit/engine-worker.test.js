// The engine's worker thread renders exactly what the main thread would, and
// keeps rendering when the main thread cannot.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { state } from '../../src/server/state.ts';
import * as universes from '../../src/server/universes.ts';
import { baseIntentOf, createRenderer } from '../../src/server/renderer.ts';
import { startEngine, stopEngine, engineStatus, effectCommand, setEffectSource } from '../../src/server/engine.ts';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { hrtimeMs } from '../../src/server/frame-clock.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { getProfile, profilesRevision, registerProfile, unregisterProfile } from '../../src/server/profiles.ts';
import { barProfile } from '../../src/server/bar-profile.ts';
import { FRAME_MS } from '../../src/server/frame-clock.ts';

const WORKER = path.join(import.meta.dirname, '..', '..', 'src', 'server', 'engine-worker.ts');

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
  const decided = [];
  await new Promise((resolve, reject) => {
    w.on('message', (m) => {
      if (m.type === 'ready') resolve();
      if (m.type === 'rendered') { decided.push(...(m.commands ?? [])); pending.get(m.id)(m.frames); pending.delete(m.id); }
    });
    w.once('error', reject);
  });
  return {
    profiles: (profiles) => w.postMessage({ type: 'profiles', profiles }),
    render: (input, reading, now, gridOriginMs) => new Promise((resolve) => {
      const k = ++id;
      pending.set(k, resolve);
      w.postMessage({ type: 'render', id: k, input, reading, now, ...(gridOriginMs === undefined ? {} : { gridOriginMs }) });
    }),
    command: (seq, cmd, arg, intent) => w.postMessage({ type: 'command', seq, cmd, arg, intent }),
    /** The commands the worker has decided so far, as its replies carried them. */
    decided,
    close: () => w.terminate(),
  };
}

/** The same renderer on this thread, on its own store and its own dice. */
function localRenderer({ seed, startNow }) {
  const store = universes.createUniverseStore(universes.allocateShared());
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: startNow });
  const dice = seeded(seed);
  const render = (input, reading, now, gridOriginMs) => {
    const realRandom = Math.random;
    Math.random = dice;
    try {
      renderer.frame(input, reading, now, store, gridOriginMs);
    } finally {
      Math.random = realRandom;
    }
    const frames = {};
    for (const universe of store.list()) frames[universe] = Array.from(store.getBuffer(universe));
    for (const [universe] of store.drainRetired()) frames[universe] = null;
    return frames;
  };
  render.renderer = renderer;
  return render;
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
  // The pars and the bars on a look each, random dice on both sides included.
  run({ pattern: 'hit', pixelPattern: 'impact' });
  run({ pattern: 'sections', pixelPattern: 'rise', pixelSpan: 16, pixelFrom: 0.25, pixelMap: 'mirror' });
  run({ pattern: 'twinkle', pixelPattern: 'sparkle' });
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

// ── Effects, on both threads ─────────────────────────────────────────────────

/** A run of frames of one effect look, with voices over it, as (input, reading, now) triples from `now`. */
function effectScenes(fixtures, { pattern, effect, voices, frames = 120, now = 1000, extra = {} }) {
  const out = [];
  for (let f = 0; f < frames; f++) {
    const input = {
      running: true, pattern, effect, colorA: 1, colorB: 5, colorC: 3, colorD: 8, split: null, pixelMap: 'stage',
      beatDivision: 1, strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false,
      energy: null, showDynamics: null, patternAnchor: { step: 0, epoch: 0, seq: 1 }, fade: null, syncTest: null,
      universes: [...new Set([0, ...fixtures.map((x) => x.universe)])].sort((a, b) => a - b), fixtures,
      safety: { hdFlashIntervalMs: 350, acknowledged: true }, hueStrobe: 'pulse', ...(voices ? { voices } : {}), ...extra,
    };
    out.push([input, { beatPos: f * FRAME_MS / 500, bpm: 120, source: 'tap', epoch: 0 }, now + f * FRAME_MS]);
  }
  return out;
}

test('a preset renders the same bytes on the worker as on the main thread', async () => {
  registerProfile(BAR);
  const seed = 5;
  const worker = await captureWorker({ seed, startNow: 0 });
  try {
    worker.profiles([BAR]);
    const local = localRenderer({ seed, startNow: 0 });
    const fadeCycle = presetById('ldj.FadeCycle').spec;
    const runs = [
      // The base effect as its spec rides in the snapshot.
      { pattern: 'ldj.FadeCycle', effect: fadeCycle },
      // A stateful random kind, with voices on chosen fixtures over it.
      { pattern: 'ldj.ScatterStrobe', effect: presetById('ldj.ScatterStrobe').spec, voices: [
        { id: 'pad:1', spec: presetById('hd.neonPulse').spec, targets: [0, 4], tier: 'voice', launchSeq: 1, startedAtMs: 1200, untilMs: 2500, anchorBeat: 0, seed: seedFrom('pad:1') },
        { id: 'strobe', spec: presetById('palette-strobe').spec, targets: null, tier: 'strobe', launchSeq: 2, startedAtMs: 1800, untilMs: null, anchorBeat: 0, seed: seedFrom('strobe') },
      ] },
    ];
    for (const fixtures of [RIGS.pars, RIGS.bars]) {
      for (const run of runs) {
        let frame = 0;
        for (const [input, reading, now] of effectScenes(fixtures, run)) {
          const grid = 1000 + 7.3;
          assert.deepStrictEqual(await worker.render(input, reading, now, grid), local(input, reading, now, grid), `${run.pattern} frame ${frame}`);
          frame++;
        }
      }
    }
  } finally {
    await worker.close();
    unregisterProfile(BAR.id);
  }
});

test('commands decide alike on both threads: the same results, then the same bytes', async () => {
  const seed = 11;
  const worker = await captureWorker({ seed, startNow: 0 });
  try {
    const local = localRenderer({ seed, startNow: 0 });
    // Studio Fireworks starts notes by itself; a stop ends that, a toggle and a duplicate land once.
    const studio = validateSpec({ kind: 'ldj.StudioFireworks', palette: ['#FF0000', '#00FF00'] });
    const intent = baseIntentOf({ pattern: 'studio', effect: studio });
    const scenes = effectScenes(RIGS.pars, { pattern: 'studio', effect: studio, frames: 90 });
    const plan = { 10: [[1, 'toggleDirection'], [2, 'toggleDirection'], [2, 'toggleDirection']], 30: [[3, 'setPulserBaselineColor', { r: 0, g: 0, b: 255 }]],
      50: [[4, 'stop'], [5, 'explode']] };
    const localDecided = [];
    for (let f = 0; f < scenes.length; f++) {
      for (const [seq, cmd, arg] of plan[f] ?? []) {
        worker.command(seq, cmd, arg, intent);
        local.renderer.command(seq, cmd, arg, intent);
      }
      const [input, reading, now] = scenes[f];
      assert.deepStrictEqual(await worker.render(input, reading, now, 1000), local(input, reading, now, 1000), `frame ${f}`);
      localDecided.push(...local.renderer.takeCommandResults());
    }
    assert.deepStrictEqual(worker.decided, localDecided);
    assert.deepStrictEqual(localDecided, [
      { seq: 1, status: 'applied' }, { seq: 2, status: 'applied' }, { seq: 2, status: 'duplicate' },
      { seq: 3, status: 'applied' }, { seq: 4, status: 'applied' }, { seq: 5, status: 'invalid' },
    ]);
  } finally {
    await worker.close();
  }
});

// A stand-in engine worker that answers a command late, after the engine has
// let it go, and counts in its stats what reached it: a retired worker's word
// must not count, and nothing may be sent on to the next one.
const FAKE_WORKER = `
import { parentPort } from 'node:worker_threads';
let commands = 0;
const stats = () => parentPort.postMessage({ type: 'stats', stats: { frames: commands, lateMs: { p50: 0, p95: 0, max: 0 }, renderMs: { p50: 0, p95: 0, max: 0 }, lateFrames: 0, skippedFrames: 0 } });
parentPort.on('message', (msg) => {
  if (msg.type === 'command') {
    commands++;
    stats();
    if (process.env.FAKE_WORKER_CRASH) process.exit(1);
    setTimeout(() => parentPort.postMessage({ type: 'commands', results: [{ seq: msg.seq, status: 'applied' }], processed: msg.seq, applied: msg.seq }), 100);
  }
  if (msg.type === 'stop') setTimeout(() => parentPort.postMessage({ type: 'stopped' }), 200);
});
parentPort.postMessage({ type: 'ready' });
stats();
`;

test('a command a driver took with it is reported unavailable, never sent on, and its late answer does not count', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-fake-worker-'));
  const file = path.join(dir, 'fake-worker.mjs');
  fs.writeFileSync(file, FAKE_WORKER);
  state.artnet.enabled = false;
  const studio = { kind: 'ldj.StudioSwirl', params: {} };
  setEffectSource((pattern) => (pattern === 'studio' ? studio : null));
  applyPatch({ pattern: 'studio', running: true, masterDimmer: 255, masterBlackout: false });
  try {
    startEngine({ thread: 'worker', file });
    const before = engineStatus().commands;
    const pending = effectCommand('toggleDirection');
    // The engine stops while the worker sits on the command; its answer comes 100 ms later.
    await new Promise((r) => setTimeout(r, 20));
    const stopped = stopEngine();
    assert.deepStrictEqual(await pending, { seq: before.submitted + 1, status: 'unavailable' }, 'ambiguous: neither applied nor refused there');
    await stopped;
    await new Promise((r) => setTimeout(r, 150));
    assert.deepStrictEqual(engineStatus().commands, { submitted: before.submitted + 1, processed: before.processed, applied: before.applied },
      'the retired worker\'s late "applied" is no acknowledgement');
    // A worker that dies with the command: the engine starts another, which never hears of it.
    process.env.FAKE_WORKER_CRASH = '1';
    startEngine({ thread: 'worker', file });
    const lost = await effectCommand('toggleDirection');
    assert.strictEqual(lost.status, 'unavailable');
    delete process.env.FAKE_WORKER_CRASH;
    const until = Date.now() + 3000;
    while (!(engineStatus().thread === 'worker' && engineStatus().frames === 0) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(engineStatus().frames, 0, 'the new worker was sent no command');
  } finally {
    delete process.env.FAKE_WORKER_CRASH;
    await stopEngine();
    setEffectSource(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── The server's engine, on its thread ───────────────────────────────────────

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lit = () => Array.from(universes.getBuffer(state.artnet.universe)).some((v) => v > 0);

test('with a worker, frames land in memory the main thread reads', async () => {
  state.artnet.enabled = false;
  applyPatch({ pattern: 'solid', running: true, masterDimmer: 255, masterBlackout: false, colorA: 1 });
  startEngine({ thread: 'worker' });
  try {
    // The worker compiles its modules before its first frame: seconds on a slow runner.
    const until = Date.now() + 5000;
    while (!lit() && Date.now() < until) await wait(20);
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
  // The eight-beat breath moves the first par's 16-bit dimmer on every frame, so each frame the worker renders shows.
  applyPatch({ pattern: 'fade', running: true, masterDimmer: 255, masterBlackout: false, colorA: 1 });
  startEngine({ thread: 'worker' });
  try {
    // Stall only once the worker renders: its module compile can outlast a fixed wait.
    const ready = Date.now() + 5000;
    while (!lit() && Date.now() < ready) await wait(20);
    assert.ok(lit(), 'the worker rendered a first frame');
    // Hold the main thread for 250 ms, as a big track plan would, and watch the shared
    // buffers meanwhile, on the clock the worker's ticker keeps its deadlines on.
    const buf = universes.getBuffer(state.artnet.universe);
    const fix = state.fixtures[0];
    const ch = getProfile(fix).channelMap;
    const level = () => buf[fix.address - 1 + ch.dimmer] * 256 + (ch.dimmerFine === undefined ? 0 : buf[fix.address - 1 + ch.dimmerFine]);
    const start = hrtimeMs(), end = start + 250;
    const seen = [];
    let last = level();
    for (let t = hrtimeMs(); t < end; t = hrtimeMs()) {
      const now = level();
      if (now === last) continue;
      last = now;
      // A frame lands in a few writes; changes closer than a third of a frame are one frame.
      if (!seen.length || t - seen[seen.length - 1] > FRAME_MS / 3) seen.push(t);
    }
    const deadlines = Math.floor((end - start) / FRAME_MS);
    // The main thread posted nothing for 250 ms: every frame seen was the worker's own, from its last snapshot.
    // A starved machine may cost the worker frames; a worker that waited on this thread would show none.
    assert.ok(seen.length >= Math.min(3, deadlines), `${seen.length} frames rendered while the main thread was held (${deadlines} deadlines)`);
    // Through the whole stall, not a burst at its start: frames in both its halves.
    const mid = start + (end - start) / 2;
    assert.ok(seen.some((t) => t < mid) && seen.some((t) => t >= mid), `frames at ${seen.map((t) => Math.round(t - start))} ms into the stall`);
    // And it reports its timing once a second: poll until a report covers the stall.
    const reported = Date.now() + 5000;
    while (!(engineStatus().frames > 30) && Date.now() < reported) await wait(50);
    assert.strictEqual(engineStatus().thread, 'worker');
    assert.ok(engineStatus().frames > 30, `${engineStatus().frames} frames reported`);
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
    // The broken script fails when its thread loads it, and under a full
    // suite's load that exit and the first main-thread frame can take far
    // longer than any fixed wait: poll for the fallback, then judge it.
    const until = Date.now() + 5000;
    while (!(engineStatus().thread === 'main' && lit()) && Date.now() < until) await wait(20);
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
