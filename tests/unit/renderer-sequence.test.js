// The renderer plays a sequence's clip table (renderer.setSequence): on each
// fixture the clip on top is its base, fixtures no clip covers keep the look,
// voices stay above. The engine hands the table to its worker once per
// revision, and the rehearsal preview renders the same clips.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';

import { createRenderer } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile, profilesRevision, BUILTIN_PROFILE_ID } from '../../src/server/profiles.ts';
import { COLOR_PRESETS } from '../../src/server/presets.ts';
import { FRAME_MS, hrtimeMs } from '../../src/server/frame-clock.ts';
import { transmitConfig } from '../../src/server/output.ts';
import { state } from '../../src/server/state.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { startEngine, stopEngine, engineStatus, renderInput, setSequenceSource } from '../../src/server/engine.ts';
import { Sequencer } from '../../src/server/sequencer.ts';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { registerKind, validateSpec } from '../../src/shared/effects/registry.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { beatPositionAt, localBpm, makeGrid } from '../../src/shared/beat-clock.ts';

const WORKER = path.join(import.meta.dirname, '..', '..', 'src', 'server', 'engine-worker.ts');

const fixture = (id, address, extra = {}) => ({
  id, address, universe: 0, profileId: BUILTIN_PROFILE_ID, maxBrightness: 255, override: null,
  position: null, group: null, geometry: null, hue: false, ...extra,
});
// Ids that are not slot numbers.
const PARS = [fixture(10, 1), fixture(11, 13), fixture(12, 25), fixture(13, 37)];

// Colour A red, B blue: the look is a solid red wash.
const LOOK = { pattern: 'solid', colorA: 0, colorB: 5, colorC: 0, colorD: 5, beatDivision: 1 };
const input = (patch = {}) => ({
  running: true, ...LOOK, split: null, pixelMap: 'stage', strobeSpeed: 0, strobeFunction: 'standard',
  masterDimmer: 255, masterBlackout: false, energy: null, showDynamics: null, patternAnchor: null,
  fade: null, syncTest: null, universes: [0], fixtures: PARS, ...patch,
});

// A kind that paints its first colour, at a strength it is given (0 leaves the slot transparent).
registerKind({
  kind: 'test.seqPaint', app: 'own', schema: z.object({ strength: z.number().min(0).max(1).default(1) }).strict(),
  defaults: { params: { strength: 1 }, palette: ['#FFFFFF'] },
  init: () => null,
  render(params, _state, room, frame, out) {
    for (let i = 0; i < room.n; i++) out[i] = { colour: { ...frame.palette[0] }, level: 1, strength: params.strength };
  },
});
// A kind that counts its renders and reports what each instance was handed.
const probeLog = [];
let probeInits = 0;
registerKind({
  kind: 'test.seqProbe', app: 'own', schema: z.object({ tag: z.string().default('') }).strict(), defaults: { params: { tag: '' } }, stateful: true,
  init: () => { probeInits++; return { renders: 0 }; },
  render(params, s, room, frame, out) {
    s.renders++;
    probeLog.push({ tag: params.tag, id: frame.instanceId, seed: frame.seed, anchorBeat: frame.anchorBeat, startedAtMs: frame.startedAtMs,
      beatPos: frame.beatPos, renders: s.renders });
    for (let i = 0; i < room.n; i++) out[i] = { colour: { r: s.renders % 256, g: 1, b: 2, w: 0, a: 0, uv: 0 }, level: 1, strength: 1 };
  },
});

const paint = (hex, extra = {}) => validateSpec({ kind: 'test.seqPaint', palette: [hex], ...extra });
const probe = (tag) => validateSpec({ kind: 'test.seqProbe', params: { tag } });

const lane = (id, extra = {}) => ({ id, kind: 'shared', name: id, mute: false, solo: false, ...extra });
const track = (id, fixtureId) => ({ id, kind: 'track', fixtureId, name: id, mute: false, solo: false });
/** A table clip, as the sequencer resolves one. */
const tclip = (id, laneId, startBeat, lengthBeats, spec, extra = {}) => ({
  id, laneId, fixtureIds: null, startBeat, lengthBeats, loopBeats: lengthBeats, spec, seed: seedFrom(`clip:test:${id}`), mute: false, ...extra,
});
const table = (revision, lanes, clips) => ({ revision, lanes, clips });
const playing = (t, startBeat = 0, loop = null, generation = 0) => ({ sequenceRevision: t.revision, sequenceTransport: { startBeat, loop, generation } });

/** One renderer and its store, rendered at 120 BPM: beat = ms / 500 unless told otherwise. */
function rig(fixtures = PARS) {
  const store = universes.createUniverseStore(universes.allocateShared());
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
  const read = (fix) => {
    const ch = getProfile(fix).channelMap;
    const dmx = store.getBuffer(fix.universe);
    const at = (name) => dmx[fix.address - 1 + ch[name]];
    return { dim: at('dimmer'), r: at('red'), g: at('green'), b: at('blue'), w: at('white') };
  };
  return {
    renderer,
    dmx: (fix) => store.getBuffer(fix.universe).subarray(fix.address - 1),
    at(ms, patch = {}, { beatPos = ms / 500, bpm = 120, epoch = 0 } = {}) {
      const given = input({ fixtures, ...patch });
      renderer.frame(given, { beatPos, bpm, epoch }, ms, store, 0);
      return Object.fromEntries(given.fixtures.map((f) => [f.id, read(f)]));
    },
  };
}

const colour = (out) => (out.dim === 0 ? 'black' : `${out.r},${out.g},${out.b},${out.w}`);
const RED = colour({ dim: 255, ...COLOR_PRESETS[0], w: COLOR_PRESETS[0].w ?? 0 });
const shown = (out) => Object.fromEntries(Object.entries(out).map(([id, o]) => [id, colour(o)]));

// ── Clips on the rig ────────────────────────────────────────────────────────

test('the renderer renders clips over their fixtures and the look elsewhere', () => {
  const r = rig();
  const t = table(1, [lane('a'), track('t13', 13)], [
    tclip('green', 'a', 0, 8, paint('#00FF00'), { fixtureIds: [10, 11] }),
    tclip('white', 't13', 2, 4, paint('#FFFFFF'), { fixtureIds: [13] }),
    // Transparent everywhere: what it selects still owns its fixtures, black.
    tclip('clear', 'a', 8, 4, paint('#FF00FF', { params: { strength: 0 } })),
  ]);
  r.renderer.setSequence(t);
  const GREEN = '0,255,0,0';
  const WHITE = '255,255,255,0';
  // Played from beat 100 (50 s): before that the look shows.
  assert.deepEqual(shown(r.at(49_500, playing(t, 100))), { 10: RED, 11: RED, 12: RED, 13: RED });
  assert.deepEqual(shown(r.at(50_500, playing(t, 100))), { 10: GREEN, 11: GREEN, 12: RED, 13: RED });
  assert.deepEqual(shown(r.at(51_500, playing(t, 100))), { 10: GREEN, 11: GREEN, 12: RED, 13: WHITE });
  assert.deepEqual(shown(r.at(54_250, playing(t, 100))), { 10: 'black', 11: 'black', 12: 'black', 13: 'black' });
  assert.deepEqual(shown(r.at(56_000, playing(t, 100))), { 10: RED, 11: RED, 12: RED, 13: RED }, 'nothing covers beat 12');
  // A voice stays above the clips; a pinned fixture over its clip too.
  const pad = { id: 'pad:1', spec: paint('#0000FF'), targets: [10], tier: 'voice', launchSeq: 1, startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: seedFrom('pad:1') };
  const pinned = PARS.map((f) => (f.id === 11 ? { ...f, override: { enabled: true, r: 9, g: 8, b: 7, w: 0, dim: 255 } } : f));
  assert.deepEqual(shown(r.at(51_500, { ...playing(t, 100), voices: [pad], fixtures: pinned })), { 10: '0,0,255,0', 11: '9,8,7,0', 12: RED, 13: WHITE });
  // A hand-built input that names no sequence, or another revision, plays the look alone.
  assert.deepEqual(shown(r.at(51_500)), { 10: RED, 11: RED, 12: RED, 13: RED });
  assert.deepEqual(shown(r.at(51_500, { ...playing(t, 100), sequenceRevision: 2 })), { 10: RED, 11: RED, 12: RED, 13: RED });
  // The table taken away: the look everywhere.
  r.renderer.setSequence(null);
  assert.deepEqual(shown(r.at(51_500, playing(t, 100))), { 10: RED, 11: RED, 12: RED, 13: RED });
});

test('a clip owns its fixture\'s strobe channel: the look\'s strobe runs only where no clip plays', () => {
  const r = rig();
  const plain = rig();
  const t = table(1, [lane('a')], [tclip('blue', 'a', 0, 4, paint('#0000FF'), { fixtureIds: [10] })]);
  r.renderer.setSequence(t);
  const strobeLook = { pattern: 'strobe', strobeSpeed: 200, strobeFunction: 'standard' };
  // Each fixture's strobe channel after a frame.
  const read = (rr, patch) => {
    rr.at(250, patch);
    const ch = getProfile(PARS[0]).channelMap.strobe;
    return Object.fromEntries(PARS.map((f) => [f.id, rr.dmx(f)[ch]]));
  };
  const withClip = read(r, { ...strobeLook, ...playing(t) });
  const without = read(plain, strobeLook);
  const solid = read(rig(), {});
  assert.notEqual(without[10], solid[10], 'the look strobes every fixture');
  assert.equal(withClip[10], solid[10], 'the clip\'s fixture runs the clip\'s own (no) strobe');
  assert.equal(withClip[11], without[11], 'the look strobes the rest');
});

test('Hue Dynamics\' flash limit covers a clip\'s own kind as it covers the base\'s', () => {
  const twinkle = validateSpec({ kind: 'hd.twinkle', palette: ['#FFFFFF'], brightness: 1,
    params: { probability: 1, attack: 0, hold: 0.0625, release: 0, loopLength: 0.125 } });
  const t = table(1, [lane('a')], [tclip('tw', 'a', 0, 64, twinkle, { fixtureIds: [10] })]);
  const risesOf = (hdFlashIntervalMs) => {
    const r = rig();
    r.renderer.setSequence(t);
    const times = [];
    let before = 0;
    for (let k = 0; k <= 44; k++) {
      const ms = k * FRAME_MS;
      const level = r.at(ms, { ...playing(t), safety: { hdFlashIntervalMs, acknowledged: true } })[10].dim / 255;
      if (level >= 0.55 && before === 0) times.push(ms);
      before = level > 0.3 ? 1 : 0;
    }
    return times;
  };
  const guarded = risesOf(350);
  assert.ok(guarded.length >= 2 && guarded.length <= 3, `${guarded.length} rises in a second`);
  for (let i = 1; i < guarded.length; i++) assert.ok(guarded[i] - guarded[i - 1] >= 350 - 1e-9, `rises ${guarded[i - 1]} → ${guarded[i]}`);
  assert.ok(risesOf(0).length >= 12, 'interval 0: every event');
});

test('a clip plays over a stopped look, which keeps its own layer underneath', () => {
  const r = rig();
  const look = rig();
  const t = table(1, [lane('a')], [tclip('blue', 'a', 0, 4, paint('#0000FF'), { fixtureIds: [10] })]);
  r.renderer.setSequence(t);
  // The look's pattern chases, then stops; the clip plays over it all the while.
  r.at(0, { pattern: 'chase', ...playing(t) });
  look.at(0, { pattern: 'chase' });
  const held = r.at(500, { pattern: 'chase', running: false, ...playing(t) });
  assert.equal(colour(held[10]), '0,0,255,0');
  look.at(500, { pattern: 'chase', running: false });
  // When the clip ends the fixture shows the look as it stands, not the clip's last frame.
  const after = r.at(2_500, { pattern: 'chase', running: false, ...playing(t) });
  assert.deepEqual(shown(after), shown(look.at(2_500, { pattern: 'chase', running: false })));
  assert.notEqual(colour(after[10]), '0,0,255,0');
});

test('a shared clip renders once a frame for all its fixtures; each lap is an activation of its own, clip:<id>:<lap>', () => {
  probeLog.length = 0;
  probeInits = 0;
  const r = rig();
  const t = table(1, [lane('a')], [tclip('p', 'a', 0, 8, probe('p'), { loopBeats: 2 })]);
  r.renderer.setSequence(t);
  const frames = Math.round(4000 / FRAME_MS);
  for (let k = 0; k < frames; k++) r.at(k * FRAME_MS, playing(t));
  assert.equal(probeLog.length, frames, 'one render a frame, whatever the fixtures');
  const ids = [...new Set(probeLog.map((e) => e.id))];
  assert.deepEqual(ids, ['clip:p:0.0.0', 'clip:p:0.0.1', 'clip:p:0.0.2', 'clip:p:0.0.3']);
  assert.equal(probeInits, 4, 'a fresh state each lap');
  // Each lap plays from its own start, with a seed from the clip and the lap alone.
  for (const e of probeLog) {
    const lap = Number(e.id.split('.').at(-1));
    assert.equal(e.anchorBeat, 2 * lap);
    assert.ok(e.beatPos - e.anchorBeat >= 0 && e.beatPos - e.anchorBeat < 2);
  }
  const seeds = ids.map((id) => probeLog.find((e) => e.id === id).seed);
  assert.equal(new Set(seeds.map(String)).size, 4);

  // The same clip in another revision of the table: the same laps, the same seeds.
  probeLog.length = 0;
  const again = rig();
  const t7 = { ...t, revision: 7 };
  again.renderer.setSequence(t7);
  for (let k = 0; k < frames; k++) again.at(k * FRAME_MS, playing(t7));
  assert.deepEqual(ids.map((id) => probeLog.find((e) => e.id === id).seed), seeds);

  // The arrangement loops [0, 3): the clip comes round again as a new activation, not its old lap.
  probeLog.length = 0;
  probeInits = 0;
  const looped = rig();
  looped.renderer.setSequence(t);
  for (let k = 0; k < frames; k++) looped.at(k * FRAME_MS, playing(t, 0, { on: true, startBeat: 0, endBeat: 3 }));
  assert.deepEqual([...new Set(probeLog.map((e) => e.id))], ['clip:p:0.0.0', 'clip:p:0.0.1', 'clip:p:0.1.0', 'clip:p:0.1.1', 'clip:p:0.2.0']);
  assert.equal(probeInits, 5);
  const wrapped = probeLog.find((e) => e.id === 'clip:p:0.1.0');
  assert.notDeepEqual(wrapped.seed, probeLog.find((e) => e.id === 'clip:p:0.0.0').seed, 'a new traversal rolls its own dice');
  assert.equal(wrapped.anchorBeat, 3, 'played from where the loop came round');
});

test('a lap\'s wall origin is where the music crossed its start, and stays there through a tempo change', () => {
  probeLog.length = 0;
  const r = rig();
  const t = table(1, [lane('a')], [tclip('p', 'a', 0, 64, probe('w'), { loopBeats: 1 })]);
  r.renderer.setSequence(t);
  // Played from beat 0.01: lap 1 starts at beat 1.01, 505 ms, between the frames at 500 and 522.7.
  // The frame that crosses it already reads the next tempo: the crossing is
  // placed between the two frames as the music went, not counted back at 60 BPM (487.3 ms).
  for (let k = 0; k <= 23; k++) r.at(k * FRAME_MS, playing(t, 0.01), { bpm: k === 23 ? 60 : 120 });
  const lap1 = probeLog.find((e) => e.id === 'clip:p:0.0.1');
  assert.ok(Math.abs(lap1.startedAtMs - 505) < 1e-6, `${lap1.startedAtMs}`);
  // The tempo moves to 128: the lap keeps the origin it had.
  let beat = 23 * FRAME_MS / 500;
  for (let k = 24; k < 30; k++) {
    beat += (FRAME_MS / 60000) * 128;
    r.at(k * FRAME_MS, playing(t, 0.01), { beatPos: beat, bpm: 128 });
  }
  assert.ok(probeLog.filter((e) => e.id === 'clip:p:0.0.1').every((e) => e.startedAtMs === lap1.startedAtMs));
  // A first look in the middle of a lap (nothing seen before it) counts back at the tempo now.
  probeLog.length = 0;
  const cold = rig();
  cold.renderer.setSequence(t);
  cold.at(1_250, playing(t, 0.01));
  assert.ok(Math.abs(probeLog[0].startedAtMs - (1_250 - 0.49 * 500)) < 1e-6, `${probeLog[0].startedAtMs}`);
});

test('a new table keeps the clips that did not change playing, and starts the changed ones again', () => {
  probeLog.length = 0;
  const r = rig();
  const a = tclip('a', 'x', 0, 64, probe('a'), { fixtureIds: [10] });
  const b = tclip('b', 'x', 0, 64, probe('b'), { fixtureIds: [11] });
  const t1 = table(1, [lane('x')], [a, b]);
  r.renderer.setSequence(t1);
  for (let k = 0; k < 10; k++) r.at(k * FRAME_MS, playing(t1));
  const last = (tag) => probeLog.filter((e) => e.tag === tag).at(-1).renders;
  assert.deepEqual([last('a'), last('b')], [10, 10]);
  // a: its colours and brightness change, it plays on; b: a new setting starts it again.
  const t2 = table(2, [lane('x')], [{ ...a, spec: { ...a.spec, palette: ['#123456'], brightness: 0.5 } },
    { ...b, spec: validateSpec({ kind: 'test.seqProbe', params: { tag: 'b2' } }) }]);
  r.renderer.setSequence(t2);
  r.at(10 * FRAME_MS, playing(t2));
  assert.equal(last('a'), 11);
  assert.equal(last('b2'), 1);
  // Moved to start a beat later, b2 starts again; taken out, its fixture shows the look.
  const t3 = table(3, [lane('x')], [t2.clips[0], { ...t2.clips[1], startBeat: 0.5 }]);
  r.renderer.setSequence(t3);
  r.at(11 * FRAME_MS, playing(t3));
  assert.equal(last('a'), 12);
  assert.equal(last('b2'), 1);
  r.renderer.setSequence(table(4, [lane('x')], [t2.clips[0]]));
  const out = r.at(12 * FRAME_MS, playing({ revision: 4 }));
  assert.equal(colour(out[11]), RED);
  assert.equal(last('a'), 13);
});

// ── On the worker ───────────────────────────────────────────────────────────

/** The worker's seeded stand-in for Math.random in capture mode. */
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

/** A capture-mode worker; a render request may carry the table. */
async function captureWorker() {
  const w = new Worker(WORKER, { workerData: { shared: universes.allocateShared(), capture: true, seed: 3, startNow: 0 } });
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
    render: (given, reading, now, extra = {}) => new Promise((resolve) => {
      const k = ++id;
      pending.set(k, resolve);
      w.postMessage({ type: 'render', id: k, input: given, reading, now, gridOriginMs: 0, ...extra });
    }),
    close: () => w.terminate(),
  };
}

/** The ldj/hd catalogue (the worker has no test kinds): a stateful fade on a shared lane, a pulse on a track. */
function catalogueTable(revision) {
  return table(revision, [lane('a'), track('t12', 12)], [
    tclip('fade', 'a', 0, 16, presetById('ldj.FadeCycle').spec, { loopBeats: 4 }),
    tclip('pulse', 't12', 2, 6, presetById('hd.neonPulse').spec, { fixtureIds: [12], loopBeats: 2 }),
  ]);
}

test('the worker renders a table it is handed with a render request, byte for byte as the main thread does', async () => {
  const worker = await captureWorker();
  try {
    const store = universes.createUniverseStore(universes.allocateShared());
    const local = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
    const dice = seeded(3);
    const t = catalogueTable(5);
    local.setSequence(t);
    for (let k = 0; k < 300; k++) {
      const now = k * FRAME_MS;
      const given = input({ ...playing(t, 0, { on: true, startBeat: 0, endBeat: 6 }), safety: { hdFlashIntervalMs: 350, acknowledged: true } });
      const reading = { beatPos: now / 500, bpm: 120, epoch: 0 };
      const realRandom = Math.random;
      Math.random = dice;
      try { local.frame(given, reading, now, store, 0); } finally { Math.random = realRandom; }
      const expected = { 0: Array.from(store.getBuffer(0)) };
      // The table travels with the first request only, as the engine posts it once.
      const got = await worker.render(given, reading, now, k === 0 ? { table: t } : {});
      assert.deepEqual(got, expected, `frame ${k}`);
    }
    // A null table stops it there as here.
    local.setSequence(null);
    const given = input(playing(t));
    local.frame(given, { beatPos: 300 * FRAME_MS / 500, bpm: 120, epoch: 0 }, 300 * FRAME_MS, store, 0);
    assert.deepEqual(await worker.render(given, { beatPos: 300 * FRAME_MS / 500, bpm: 120, epoch: 0 }, 300 * FRAME_MS, { table: null }),
      { 0: Array.from(store.getBuffer(0)) });
  } finally {
    await worker.close();
  }
});

// A stand-in engine worker that counts the tables and snapshots it is sent,
// checks each snapshot names the table it already has, and reports it all as
// its frame stats. Told to (by the environment it starts with), it dies at the
// table of revision 7, so the engine has to start another.
const COUNTING_WORKER = `
import { parentPort } from 'node:worker_threads';
let tables = 0, snapshots = 0, mismatched = 0, revision = null;
const report = () => parentPort.postMessage({ type: 'stats', stats: { frames: tables, lateFrames: mismatched, skippedFrames: snapshots,
  lateMs: { p50: revision ?? -1, p95: 0, max: 0 }, renderMs: { p50: 0, p95: 0, max: 0 } } });
parentPort.on('message', (msg) => {
  if (msg.type === 'sequence') {
    tables++;
    revision = msg.table ? msg.table.revision : null;
    if (msg.table && msg.table.revision === 7 && process.env.COUNTING_WORKER_CRASH) process.exit(1);
  }
  if (msg.type === 'snapshot') {
    snapshots++;
    if ((msg.input.sequenceRevision ?? null) !== revision) mismatched++;
  }
  report();
  if (msg.type === 'stop') parentPort.postMessage({ type: 'stopped' });
});
parentPort.postMessage({ type: 'ready' });
report();
`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await wait(10);
  return check();
}

test('the table is posted once per revision, not per frame', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-sequence-worker-'));
  const file = path.join(dir, 'counting-worker.mjs');
  fs.writeFileSync(file, COUNTING_WORKER);
  state.artnet.enabled = false;
  let feed = { table: catalogueTable(1), transport: null };
  setSequenceSource(() => feed);
  try {
    process.env.COUNTING_WORKER_CRASH = '1';
    startEngine({ thread: 'worker', file });
    delete process.env.COUNTING_WORKER_CRASH;
    const stats = () => engineStatus();
    // One table, then a snapshot every control tick naming it.
    assert.ok(await until(() => stats().skippedFrames >= 10));
    assert.equal(stats().frames, 1, 'one table for many frames');
    assert.equal(stats().lateFrames, 0, 'every snapshot came after the table it names');
    assert.equal(renderInput().sequenceRevision, 1);
    // An edit: one more.
    feed = { table: catalogueTable(2), transport: { startBeat: 0, loop: null, generation: 0 } };
    assert.ok(await until(() => stats().lateMs.p50 === 2));
    const at = stats().skippedFrames;
    assert.ok(await until(() => stats().skippedFrames >= at + 10));
    assert.equal(stats().frames, 2);
    // A source that hands over a new object of the same revision posts nothing.
    feed = { ...feed, table: { ...feed.table } };
    await wait(100);
    assert.equal(stats().frames, 2);
    // Unloaded: the null goes over too.
    feed = { table: null, transport: null };
    assert.ok(await until(() => stats().frames === 3 && stats().lateMs.p50 === -1));
    assert.equal(renderInput().sequenceRevision, null);
    assert.equal(stats().lateFrames, 0);
    // The worker dies; the next one is sent the table it lacks, though its revision is old news here.
    feed = { table: catalogueTable(7), transport: null };
    assert.ok(await until(() => engineStatus().thread === 'worker' && stats().frames === 1 && stats().lateMs.p50 === 7 && stats().skippedFrames >= 3));
    assert.equal(stats().lateFrames, 0);
    // Another source (a sequencer of its own) whose table carries the same revision: it is sent all the same.
    const other = { table: catalogueTable(7), transport: null };
    setSequenceSource(() => other);
    assert.ok(await until(() => stats().frames === 2), 'a new source\'s table goes over');
    assert.equal(stats().lateFrames, 0);
  } finally {
    delete process.env.COUNTING_WORKER_CRASH;
    await stopEngine();
    setSequenceSource(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('on the main thread the engine plays the sequencer\'s table straight from its source', async () => {
  state.artnet.enabled = false;
  const sequencer = new Sequencer({ resolve: () => null });
  sequencer.load({ id: 's', name: 'S', lanes: [lane('a')], clips: [{ id: 'c', laneId: 'a', startBeat: 0, lengthBeats: 1e6, effect: { kind: 'test.seqPaint', palette: ['#00FF00'] } }] });
  let transport = null;
  setSequenceSource((reading) => ({ ...sequencer.frame(reading), transport }));
  applyPatch({ pattern: 'solid', colorA: 0, running: true, masterDimmer: 255, masterBlackout: false });
  const first = state.fixtures[0];
  const green = () => {
    const ch = getProfile(first).channelMap;
    const dmx = universes.getBuffer(first.universe ?? state.artnet.universe);
    return dmx[first.address - 1 + ch.green] === 255 && dmx[first.address - 1 + ch.red] === 0;
  };
  try {
    startEngine({ thread: 'main' });
    await wait(100);
    assert.equal(green(), false, 'loaded is not playing');
    transport = { startBeat: -1, loop: null, generation: 0 };
    assert.ok(await until(green, 1000), 'playing: the clip is the rig\'s base');
    assert.equal(renderInput().sequenceRevision, sequencer.table().revision);
    // Another source, a sequencer of its own at the same revision: its table plays, not the last one's.
    const other = new Sequencer({ resolve: () => null });
    other.load({ id: 's', name: 'S', lanes: [lane('a')], clips: [{ id: 'c', laneId: 'a', startBeat: 0, lengthBeats: 1e6, effect: { kind: 'test.seqPaint', palette: ['#0000FF'] } }] });
    assert.equal(other.table().revision, sequencer.table().revision);
    setSequenceSource((reading) => ({ ...other.frame(reading), transport }));
    const blue = () => {
      const ch = getProfile(first).channelMap;
      const dmx = universes.getBuffer(first.universe ?? state.artnet.universe);
      return dmx[first.address - 1 + ch.blue] === 255 && dmx[first.address - 1 + ch.green] === 0;
    };
    assert.ok(await until(blue, 1000), 'the new source\'s clip');
  } finally {
    await stopEngine();
    setSequenceSource(null);
  }
});

test('a worker takes a new table up with the snapshot that names it: no frame between the two plays the look', async () => {
  state.artnet.enabled = false;
  const shared = universes.allocateShared();
  const w = new Worker(WORKER, { workerData: { shared, epochMs: hrtimeMs(), periodMs: FRAME_MS } });
  let frames = 0;
  await new Promise((resolve, reject) => {
    w.on('message', (m) => { if (m.type === 'ready') resolve(); if (m.type === 'frame') frames++; });
    w.once('error', reject);
  });
  const out = universes.createUniverseStore(shared, { readOnly: true });
  const dimmer = (fix) => out.getBuffer(fix.universe)[fix.address - 1 + getProfile(fix).channelMap.dimmer];
  const after = (n) => { const k = frames + n; return until(() => frames >= k); };
  // A clip that darkens fixture 10 plays on through both tables; only the clip on 11 moves.
  const kill = validateSpec({ kind: 'energy.kill' });
  const t1 = table(1, [lane('a')], [tclip('dark', 'a', 0, 1e6, kill, { fixtureIds: [10] }), tclip('moved', 'a', 0, 1e6, kill, { fixtureIds: [11] })]);
  const t2 = table(2, [lane('a')], [t1.clips[0], { ...t1.clips[1], startBeat: 0.5 }]);
  const outputs = { ...transmitConfig(), armed: false };
  const snapshot = (t) => w.postMessage({ type: 'snapshot', at: hrtimeMs(), input: input(playing(t)), reading: { beatPos: 1, bpm: 120, epoch: 0, moving: true }, outputs });
  try {
    w.postMessage({ type: 'sequence', table: t1 });
    snapshot(t1);
    assert.ok(await after(3));
    assert.deepEqual([dimmer(PARS[0]), dimmer(PARS[2])], [0, 255], 'the clip on 10, the look on 12');
    // The next table arrives and its snapshot is late: the frames meanwhile play the last pair.
    w.postMessage({ type: 'sequence', table: t2 });
    assert.ok(await after(3));
    assert.equal(dimmer(PARS[0]), 0, 'still the clip, not a frame of the look');
    snapshot(t2);
    assert.ok(await after(3));
    assert.deepEqual([dimmer(PARS[0]), dimmer(PARS[2])], [0, 255]);
  } finally {
    await w.terminate();
  }
});

// ── The rehearsal preview ───────────────────────────────────────────────────

const EMITTERS = { red: 'r', green: 'g', blue: 'b', white: 'w', amber: 'a', uv: 'uv' };
function rigLights(store, fixtures) {
  return fixtures.map((f) => {
    const ch = getProfile(f).channelMap;
    const dmx = store.getBuffer(f.universe);
    const light = {};
    for (const [name, key] of Object.entries(EMITTERS)) if (ch[name] !== undefined) light[key] = dmx[f.address - 1 + ch[name]];
    return light;
  });
}

test('the preview renders the same clips', () => {
  const BEATS = Array.from({ length: 41 }, (_, i) => i * 0.5);
  const grid = makeGrid(BEATS);
  const t = table(3, [lane('a'), lane('b'), track('t13', 13)], [
    tclip('fade', 'a', 0, 12, presetById('ldj.FadeCycle').spec, { loopBeats: 4 }),
    tclip('probe', 'b', 2, 6, probe('preview'), { fixtureIds: [11, 12], loopBeats: 2 }),
    tclip('paint', 't13', 1, 3, paint('#FF8000')),
  ]);
  const transport = { startBeat: 1, loop: { on: true, startBeat: 0, endBeat: 10 }, generation: 0 };
  const times = Array.from({ length: Math.floor(8000 / FRAME_MS) + 1 }, (_, k) => k * FRAME_MS);

  const store = universes.createUniverseStore(universes.allocateShared());
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
  renderer.setSequence(t);
  const rigFrames = times.map((ms) => {
    const reading = { beatPos: beatPositionAt(grid, ms), bpm: localBpm(grid, ms), epoch: 0 };
    renderer.frame(input({ colorB: 5, colorC: 3, colorD: 8, sequenceRevision: t.revision, sequenceTransport: transport }), reading, ms, store, 0);
    return rigLights(store, PARS);
  });

  const sample = createPreviewSampler([{ timeMs: 0, action: 'patch', data: { ...LOOK, colorB: 5, colorC: 3, colorD: 8, bpm: 120 } }],
    { beats: BEATS }, { sequence: { table: t, transport } });
  const rigOf = buildRig(PARS, getProfile);
  const same = (i, label) => {
    const lights = sample(times[i], PARS, COLOR_PRESETS, rigOf);
    rigFrames[i].forEach((light, u) => {
      const seen = Object.fromEntries(Object.keys(light).map((k) => [k, lights[u][k]]));
      assert.deepEqual(seen, light, `${label}: light ${u} at ${times[i].toFixed(3)} ms`);
    });
  };
  times.forEach((_, i) => same(i, 'forward'));
  // Asked again backwards, the walk starts over from its copies: the laps and their states come out the same.
  for (let i = times.length - 1; i >= 0; i -= 7) same(i, 'backward');
  // Not the look alone: the clips show, and move.
  const keys = (u) => new Set(times.map((ms) => JSON.stringify(sample(ms, PARS, COLOR_PRESETS, rigOf)[u]))).size;
  assert.ok(keys(0) > 3, 'the fade cycle moves');
  assert.ok(keys(3) >= 2, 'the track\'s clip comes and goes');
});

test('the preview pauses and stops as the rig does: a held selection playing on, a held picture, black', () => {
  const BEATS = Array.from({ length: 41 }, (_, i) => i * 0.5);
  const grid = makeGrid(BEATS);
  const t = table(4, [lane('a'), lane('b')], [
    tclip('fade', 'a', 0, 4, presetById('ldj.FadeCycle').spec, { loopBeats: 2 }),
    tclip('probe', 'b', 1, 2, probe('held'), { fixtureIds: [11, 12], loopBeats: 1 }),
    tclip('later', 'a', 4, 8, paint('#FF8000')),
  ]);
  const times = Array.from({ length: Math.floor(6000 / FRAME_MS) + 1 }, (_, k) => k * FRAME_MS);
  const rigOf = buildRig(PARS, getProfile);
  const transports = {
    // Paused at beat 2.5 of the sequence: fade and probe stay on top past their ends, lapping on.
    paused: { startBeat: 0, loop: null, generation: 2, hold: { position: 2.5, traversal: 0, beat: 0.5 } },
    held: { startBeat: 0, loop: null, generation: 2, stop: { mode: 'hold', position: 1.5, traversal: 0 } },
    black: { startBeat: 0, loop: null, generation: 2, stop: { mode: 'black', position: 1.5, traversal: 0 } },
  };
  for (const [name, transport] of Object.entries(transports)) {
    const store = universes.createUniverseStore(universes.allocateShared());
    const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
    renderer.setSequence(t);
    const rigFrames = times.map((ms) => {
      const reading = { beatPos: beatPositionAt(grid, ms), bpm: localBpm(grid, ms), epoch: 0 };
      renderer.frame(input({ colorB: 5, sequenceRevision: t.revision, sequenceTransport: transport }), reading, ms, store, 0);
      return rigLights(store, PARS);
    });
    const sample = createPreviewSampler([{ timeMs: 0, action: 'patch', data: { ...LOOK, colorB: 5, bpm: 120 } }],
      { beats: BEATS }, { sequence: { table: t, transport } });
    const same = (i, label) => {
      const lights = sample(times[i], PARS, COLOR_PRESETS, rigOf);
      rigFrames[i].forEach((light, u) => {
        const seen = Object.fromEntries(Object.keys(light).map((k) => [k, lights[u][k]]));
        assert.deepEqual(seen, light, `${name}, ${label}: light ${u} at ${times[i].toFixed(3)} ms`);
      });
    };
    times.forEach((_, i) => same(i, 'forward'));
    for (let i = times.length - 1; i >= 0; i -= 5) same(i, 'backward');
    const keys = (u) => new Set(rigFrames.map((f) => JSON.stringify(f[u]))).size;
    if (name === 'paused') {
      assert.ok(keys(0) > 3, 'the paused fade moves on');
      assert.ok(rigFrames.every((f) => f[0].r !== 255 || f[0].g !== 128), 'and the later clip never takes over');
    } else {
      assert.equal(keys(0), 1, `${name}: one picture`);
      assert.equal(keys(2), 1);
    }
    if (name === 'black') assert.ok(rigFrames.every((f) => f.every((l) => Object.values(l).every((v) => v === 0))), 'black everywhere');
  }
});

test('glow rides the expression level on its own curve as the base and as a clip, as it does as a voice: never multiplied by it again', () => {
  const GLOW = presetById('energy.glow').spec;
  const WHITE = paint('#FFFFFF');
  const half = { showDynamics: { level: 0.5 } };
  const settled = (spec, patch) => {
    const r = rig();
    const t = table(1, [lane('a')], [tclip('c', 'a', 0, 1e6, spec, { fixtureIds: [10] })]);
    r.renderer.setSequence(t);
    let out;
    for (let k = 0; k < 400; k++) out = r.at(k * FRAME_MS, { ...half, ...(patch === 'clip' ? playing(t) : patch) });
    return out[10].dim;
  };
  const voice = { id: 'v', spec: GLOW, targets: [10], tier: 'voice', launchSeq: 1, startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: seedFrom('v') };
  assert.equal(settled(GLOW, { voices: [voice] }), 203, 'as a voice: 150 + 105 × 0.5');
  assert.equal(settled(GLOW, { effect: GLOW }), 203, 'as the base');
  assert.equal(settled(GLOW, 'clip'), 203, 'as a clip');
  // Any other kind follows the level as a base layer always has.
  assert.equal(settled(WHITE, 'clip'), 128);
  assert.equal(settled(WHITE, { effect: WHITE }), 128);
});

test('the preview plays glow\'s own curve too, as the base and as a clip', () => {
  const GLOW = presetById('energy.glow').spec;
  const BEATS = Array.from({ length: 41 }, (_, i) => i * 0.5);
  const half = { showDynamics: { level: 0.5, bass: 0.5, vocal: 0.5, air: 0.3, width: 0.5, motion: 0.3, decay: 0.25 } };
  const t = table(1, [lane('a')], [tclip('g', 'a', 0, 1e6, GLOW, { fixtureIds: [10] })]);
  const transport = { startBeat: 0, loop: null, generation: 0 };
  const times = Array.from({ length: Math.floor(4000 / FRAME_MS) + 1 }, (_, k) => k * FRAME_MS);
  const rigOf = buildRig(PARS, getProfile);
  for (const [label, look, options] of [['base', { pattern: 'energy.glow' }, {}], ['clip', {}, { sequence: { table: t, transport } }]]) {
    const store = universes.createUniverseStore(universes.allocateShared());
    const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
    renderer.setSequence(t);
    const grid = makeGrid(BEATS);
    const sample = createPreviewSampler([{ timeMs: 0, action: 'patch', data: { ...LOOK, ...look, ...half, bpm: 120 } }], { beats: BEATS },
      { ...options, resolveEffect: (id) => (id === 'energy.glow' ? GLOW : null) });
    for (const ms of times) {
      const reading = { beatPos: beatPositionAt(grid, ms), bpm: localBpm(grid, ms), epoch: 0 };
      const given = input({ ...look, ...half, ...(label === 'base' ? { effect: GLOW } : { sequenceRevision: t.revision, sequenceTransport: transport }) });
      renderer.frame(given, reading, ms, store, 0);
      const lights = sample(ms, PARS, COLOR_PRESETS, rigOf);
      rigLights(store, PARS).forEach((light, u) => {
        assert.deepEqual(Object.fromEntries(Object.keys(light).map((k) => [k, lights[u][k]])), light, `${label}: light ${u} at ${ms.toFixed(3)} ms`);
      });
    }
  }
});

test('one lamp: lanes, tracks and explicit fixture ids that miss it, a muted lane, the look\'s strobe and a voice', () => {
  const ONE = [fixture(10, 1)];
  const r = rig(ONE);
  const sequencer = new Sequencer({ resolve: () => null });
  const c = (id, laneId, startBeat, lengthBeats, hex, extra = {}) => ({ id, laneId, startBeat, lengthBeats, effect: { kind: 'test.seqPaint', palette: [hex] }, ...extra });
  const raw = {
    id: 's', name: 'S', lanes: [lane('a'), lane('b'), track('t10', 10), track('t11', 11)],
    clips: [
      c('wide', 'a', 0, 8, '#00FF00'),
      // Fixture ids the rig does not have: nothing here.
      c('elsewhere', 'b', 0, 8, '#0000FF', { targets: [11, 12] }),
      c('absent', 't11', 0, 8, '#FFFFFF'),
      // On the lamp's track, explicit ids keep only the lamp's own.
      c('own', 't10', 2, 2, '#FF8000', { targets: [10, 11] }),
      c('missed', 't10', 4, 2, '#FFFFFF', { targets: [11] }),
    ],
  };
  sequencer.load(raw);
  const t = sequencer.table();
  r.renderer.setSequence(t);
  const at = (beat, patch = {}) => colour(r.at(beat * 500, { ...playing(t), ...patch })[10]);
  assert.equal(at(1), '0,255,0,0', 'the shared lane; the later lane\'s clip names other fixtures');
  assert.equal(at(3), '255,128,0,0', 'the track');
  assert.equal(at(5), '0,255,0,0', 'a track clip whose ids miss the lamp covers nothing');
  assert.equal(at(9), RED, 'nothing plays: the look');
  // The shared lane muted: the look shows through, the track still plays.
  sequencer.load({ ...raw, lanes: [lane('a', { mute: true }), ...raw.lanes.slice(1)] });
  const muted = sequencer.table();
  r.renderer.setSequence(muted);
  assert.equal(colour(r.at(500, playing(muted))[10]), RED);
  assert.equal(colour(r.at(1500, playing(muted))[10]), '255,128,0,0');
  r.renderer.setSequence(t);
  // The look's strobe stays off the lamp while a clip plays on it.
  const strobeCh = getProfile(ONE[0]).channelMap.strobe;
  const strobing = { pattern: 'strobe', strobeSpeed: 200, strobeFunction: 'standard' };
  r.at(500, { ...playing(t), ...strobing });
  const covered = r.dmx(ONE[0])[strobeCh];
  const plain = rig(ONE);
  plain.at(500);
  assert.equal(covered, plain.dmx(ONE[0])[strobeCh], 'the clip\'s own (no) strobe, as under a look that does not strobe');
  r.at(4500, { ...playing(t), ...strobing });
  assert.notEqual(r.dmx(ONE[0])[strobeCh], covered, 'the look strobes the lamp once no clip plays');
  // A voice stays above the clip.
  const pad = { id: 'pad:1', spec: paint('#0000FF'), targets: [10], tier: 'voice', launchSeq: 1, startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: seedFrom('pad:1') };
  assert.equal(colour(r.at(1500, { ...playing(t), voices: [pad] })[10]), '0,0,255,0');
});
