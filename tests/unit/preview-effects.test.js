// The rehearsal preview plays the party effects as the rig does: a base
// effect in place of the look's pattern and voices over it, stepped through
// the renderer's own layer on the engine's 44 Hz frame grid. Each parity test
// drives the real renderer through the same frames and compares bytes.

import test from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';

import { createRenderer } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile, profilesRevision, registerProfile, unregisterProfile, BUILTIN_PROFILE_ID, HUE_COLOR_PROFILE_ID } from '../../src/server/profiles.ts';
import { COLOR_PRESETS } from '../../src/server/presets.ts';
import { FRAME_MS } from '../../src/server/frame-clock.ts';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { registerKind, validateSpec } from '../../src/shared/effects/registry.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { bundleSpec } from '../../src/shared/effects/bundle.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { anchorStep, beatPositionAt, localBpm, makeGrid } from '../../src/shared/beat-clock.ts';
import { HOLD_STROBE } from '../../src/shared/look-math.ts';

const fixture = (id, address, profileId = BUILTIN_PROFILE_ID, extra = {}) => ({
  id, address, universe: 0, profileId, maxBrightness: 255, override: null,
  position: null, group: null, geometry: null, hue: false, ...extra,
});

// Ids that are not slot numbers, and a Hue lamp among the pars.
const PARS = [fixture(10, 1), fixture(11, 13), fixture(12, 25), fixture(13, 37)];
const LAMP = fixture(14, 60, HUE_COLOR_PROFILE_ID, { hue: true, output: { protocol: 'hue', channel: 1 } });
const RIG = [...PARS, LAMP];

// A bar of four bare RGB cells: no fixture dimmer, so every cell drives as the preview counts it.
const BAR = {
  id: 'preview-effects-bar', name: 'Preview bar', channelCount: 12, channelMap: {},
  cells: Array.from({ length: 4 }, (_, i) => ({ channelMap: { red: i * 3, green: i * 3 + 1, blue: i * 3 + 2 } })),
};

const preset = (id) => { const row = presetById(id); assert.ok(row && !row.legacy, id); return row.spec; };
const FADE = preset('ldj.FadeCycle');
const BLINDER = preset('energy.blinder');
// The catalogue as the browser resolves a pattern id, and a few looks of the tests' own.
// A kind that counts its frames: its red is how many renders its state has
// seen, its green the launch time it was handed (whole ms, mod 256).
// probeRenders counts every render of it, kept or thrown away.
let probeInits = 0;
let probeRenders = 0;
registerKind({
  kind: 'test.previewProbe', app: 'own', schema: z.object({}).strict(), defaults: { params: {} }, stateful: true,
  init: () => { probeInits++; return { renders: 0 }; },
  render(_params, state, room, frame, out) {
    probeRenders++;
    state.renders++;
    const g = Math.round(frame.startedAtMs ?? 0) % 256;
    for (let i = 0; i < room.n; i++) out[i] = { colour: { r: state.renders % 256, g, b: 0, w: 0, a: 0, uv: 0 }, level: 1, strength: 1 };
  },
});
const OWN = {
  probe: validateSpec({ kind: 'test.previewProbe', params: {} }),
  'wave-once': validateSpec({ kind: 'ldj.BigRoomWave', params: { once: true }, palette: [{ random: true }, { random: true }] }),
  twinkle8: validateSpec({ kind: 'hd.twinkle', palette: ['#FFFFFF'], brightness: 1,
    params: { probability: 1, attack: 0, hold: 0.0625, release: 0, loopLength: 0.125 } }),
};
const resolveEffect = (id) => OWN[id] ?? (presetById(id) && !presetById(id).legacy ? presetById(id).spec : null);

const LOOK = { colorA: 0, colorB: 5, colorC: 3, colorD: 8, bpm: 120, beatDivision: 1 };
// 120 BPM from the top as an analysed track, so both sides read one beat position.
const BEATS = Array.from({ length: 81 }, (_, i) => i * 0.5);
const GRID = { beats: BEATS };
const beatGrid = makeGrid(BEATS);
const beat = (ms) => beatPositionAt(beatGrid, ms);
const ACK = { hdFlashIntervalMs: 350, acknowledged: true };

/** The engine's frames from `from` to `to`, on the grid from 0. */
const frames = (from, to) => {
  const out = [];
  for (let k = Math.ceil(from / FRAME_MS - 1e-9); k * FRAME_MS <= to + 1e-6; k++) out.push(k * FRAME_MS);
  return out;
};

const voice = (id, spec, extra = {}) => ({
  id, spec, targets: null, tier: 'voice', launchSeq: 1, startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: seedFrom(id), ...extra,
});

// ── Both sides, frame by frame ──────────────────────────────────────────────

const EMITTER_KEYS = { red: 'r', green: 'g', blue: 'b', white: 'w', coolWhite: 'w', amber: 'a', warmWhite: 'a', uv: 'uv' };

/** What the rig drives each light's emitters at: one entry per par, one per cell of a bar. */
function rigLights(store, fixtures) {
  const lights = [];
  for (const f of fixtures) {
    const profile = getProfile(f);
    const maps = profile.cells?.length >= 2 ? profile.cells.map((c) => c.channelMap) : [profile.channelMap];
    const dmx = store.getBuffer(f.universe);
    for (const ch of maps) {
      const light = {};
      for (const [name, key] of Object.entries(EMITTER_KEYS)) if (ch[name] !== undefined) light[key] = dmx[f.address - 1 + ch[name]];
      lights.push(light);
    }
  }
  return lights;
}

const BASE_INPUT = {
  running: true, pattern: 'solid', ...LOOK, split: null, pixelMap: 'stage', strobeSpeed: 0, strobeFunction: 'standard',
  masterDimmer: 255, masterBlackout: false, energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null,
  universes: [0],
};

/** The renderer at each of `times`; `at(t)` gives that frame's input fields and, optionally, its reading (GRID's otherwise). */
function rigRun(fixtures, times, at) {
  const store = universes.createUniverseStore(universes.allocateShared());
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: times[0] });
  return times.map((t) => {
    const { reading, ...patch } = at(t);
    const { bpm: _bpm, ...look } = patch;
    renderer.frame({ ...BASE_INPUT, fixtures, ...look }, reading ?? { beatPos: beat(t), bpm: localBpm(beatGrid, t), epoch: 0 }, t, store, 0);
    return rigLights(store, fixtures);
  });
}

const previewRun = (sample, fixtures, times) => {
  const rig = buildRig(fixtures, getProfile);
  return times.map((t) => sample(t, fixtures, COLOR_PRESETS, rig));
};

/** Every light, every frame, on the emitters the rig has. */
function assertSame(rigFrames, previewFrames, times, label = '') {
  assert.strictEqual(previewFrames.length, rigFrames.length);
  rigFrames.forEach((lights, i) => {
    assert.strictEqual(previewFrames[i].length, lights.length, `${label} lights at ${times[i]}`);
    lights.forEach((light, u) => {
      const seen = Object.fromEntries(Object.keys(light).map((k) => [k, previewFrames[i][u][k]]));
      assert.deepStrictEqual(seen, light, `${label} light ${u} at ${times[i].toFixed(3)} ms`);
    });
  });
}

const key = (c) => `${c.r},${c.g},${c.b},${c.w},${c.a},${c.uv}`;
const distinct = (outputs, u) => new Set(outputs.map((o) => key(o[u]))).size;

// ── The brief's cases ───────────────────────────────────────────────────────

test('the preview drives the same bytes as the rig for a base effect and a voice, stepped through the same frames', () => {
  const times = frames(0, 1000);
  assert.strictEqual(times.length, 45);
  const pad = voice('pad:1', BLINDER, { targets: [PARS[1].id] });
  const rig = rigRun(RIG, times, () => ({ pattern: 'ldj.FadeCycle', effect: FADE, voices: [pad] }));
  const sample = createPreviewSampler([
    { timeMs: 0, action: 'patch', data: { pattern: 'ldj.FadeCycle', ...LOOK } },
    { timeMs: 0, action: 'voice', data: { id: 'pad:1', effect: BLINDER, targets: [PARS[1].id], tier: 'voice', launchSeq: 1 } },
  ], GRID, { resolveEffect });
  const preview = previewRun(sample, RIG, times);
  assertSame(rig, preview, times);
  // Not a still picture: the base moves, and the voice holds its par white.
  assert.ok(distinct(preview, 0) > 3, 'the fade cycle moves on the first par');
  for (const out of preview) assert.deepStrictEqual([out[1].r, out[1].g, out[1].b, out[1].w], [255, 255, 255, 255]);
  // The same without an analysed track: the free clock at the timeline's tempo, counted as the preview counts it.
  const free = createPreviewSampler([
    { timeMs: 0, action: 'patch', data: { pattern: 'ldj.FadeCycle', ...LOOK } },
    { timeMs: 0, action: 'voice', data: { id: 'pad:1', effect: BLINDER, targets: [PARS[1].id], tier: 'voice', launchSeq: 1 } },
  ], null, { resolveEffect });
  const freeRig = rigRun(RIG, times, (t) => ({ pattern: 'ldj.FadeCycle', effect: FADE, voices: [pad], reading: { beatPos: (t / 60000) * 120, bpm: 120, epoch: 0 } }));
  assertSame(freeRig, previewRun(free, RIG, times), times, 'free clock');
});

test('sampling earlier than the last sample restarts from the keyframe and reaches the same bytes', () => {
  const events = [
    { timeMs: 0, action: 'patch', data: { pattern: 'ldj.FadeCycle', ...LOOK } },
    { timeMs: 140, action: 'voice', data: { id: 'pad:1', effect: preset('ldj.CrossFade'), targets: [PARS[2].id, LAMP.id], tier: 'voice', launchSeq: 1 } },
    { timeMs: 620, action: 'patch', data: { pattern: 'ldj.StrobeCycle' } },
  ];
  const rig = buildRig(RIG, getProfile);
  const sample = createPreviewSampler(events, GRID, { resolveEffect });
  const late = sample(1000, RIG, COLOR_PRESETS, rig);
  const back = sample(300, RIG, COLOR_PRESETS, rig);
  const fresh = createPreviewSampler(events, GRID, { resolveEffect });
  assert.deepStrictEqual(back, fresh(300, RIG, COLOR_PRESETS, rig));
  // And forward again, past the second scene, as a sampler that never went back.
  assert.deepStrictEqual(sample(1000, RIG, COLOR_PRESETS, rig), late);
  assert.deepStrictEqual(sample(800, RIG, COLOR_PRESETS, rig), createPreviewSampler(events, GRID, { resolveEffect })(800, RIG, COLOR_PRESETS, rig));
  // 300 ms is between two frames: the rig's frames up to 295.5 ms, then one at 300.
  const times = [...frames(0, 300), 300];
  const rigFrames = rigRun(RIG, times, (t) => ({ pattern: 'ldj.FadeCycle', effect: FADE,
    voices: t >= 140 ? [voice('pad:1', preset('ldj.CrossFade'), { targets: [PARS[2].id, LAMP.id], startedAtMs: 140, anchorBeat: beat(140) })] : [] }));
  assertSame(rigFrames.slice(-1), [back], [300]);
});

test('a seek keyframe resets the instance states', () => {
  // A seek marker at 500 ms: the base starts again at the next frame on its
  // own id and seed; the voice keeps its launch and takes the scene's beat.
  const wave = preset('ldj.BigRoomWave');
  const events = [
    { timeMs: 0, action: 'patch', data: { pattern: 'ldj.FadeCycle', ...LOOK } },
    { timeMs: 60, action: 'voice', data: { id: 'pad:w', effect: wave, targets: [PARS[0].id, PARS[3].id], tier: 'voice', launchSeq: 1 } },
    { timeMs: 500, action: 'seek' },
  ];
  const times = frames(0, 1500);
  const rig = rigRun(RIG, times, (t) => ({
    pattern: 'ldj.FadeCycle', effect: FADE,
    voices: t >= 60 ? [voice('pad:w', wave, { targets: [PARS[0].id, PARS[3].id], startedAtMs: 60, anchorBeat: beat(60) })] : [],
    reading: { beatPos: beat(t), bpm: localBpm(beatGrid, t), epoch: t >= 500 - 1e-6 ? 1 : 0, anchorBeat: 0 },
  }));
  const preview = previewRun(createPreviewSampler(events, GRID, { resolveEffect }), RIG, times);
  assertSame(rig, preview, times);
  const unseeked = previewRun(createPreviewSampler(events.slice(0, 2), GRID, { resolveEffect }), RIG, times);
  const after = times.map((t, i) => i).filter((i) => times[i] >= 500);
  assert.deepStrictEqual(times.map((t, i) => i).filter((i) => times[i] < 500).map((i) => preview[i]),
    times.map((t, i) => i).filter((i) => times[i] < 500).map((i) => unseeked[i]), 'nothing changes before the seek');
  assert.ok(after.some((i) => key(preview[i][1]) !== key(unseeked[i][1])), 'the base starts again at the seek');
});

test('a seek after a scene part way into the track puts a voice on the scene\'s beat, as the rig does', () => {
  // Beats from 200 ms, so the scene at 2300 ms is on beat 4.2 and the voice launched on 4.622.
  const beats = Array.from({ length: 40 }, (_, i) => 0.2 + i * 0.5);
  const grid = makeGrid(beats);
  const wave = preset('ldj.BigRoomWave');
  const targets = [PARS[0].id, PARS[3].id];
  const events = [
    { timeMs: 0, action: 'patch', data: { pattern: 'solid', ...LOOK } },
    { timeMs: 2300, action: 'patch', data: { pattern: 'ldj.FadeCycle', beatDivision: 2 } },
    { timeMs: 2511, action: 'voice', data: { id: 'pad:w', effect: wave, targets, tier: 'voice', launchSeq: 1 } },
    { timeMs: 3700, action: 'seek' },
  ];
  const sceneBeat = beatPositionAt(grid, 2300);
  const times = frames(0, 6000);
  const rig = rigRun(RIG, times, (t) => ({
    ...(t < 2300 ? { pattern: 'solid', patternAnchor: { step: anchorStep(beatPositionAt(grid, 0)), epoch: 0 } } : {
      pattern: 'ldj.FadeCycle', effect: FADE, beatDivision: 2, patternAnchor: { step: anchorStep(sceneBeat, 2), epoch: 0 } }),
    voices: t >= 2511 ? [voice('pad:w', wave, { targets, startedAtMs: 2511, anchorBeat: beatPositionAt(grid, 2511) })] : [],
    // After the jump the rig counts from the beat the running scene was scheduled on.
    reading: { beatPos: beatPositionAt(grid, t), bpm: localBpm(grid, t), epoch: t >= 3700 - 1e-6 ? 1 : 0,
      anchorBeat: t >= 2300 ? sceneBeat : beatPositionAt(grid, 0) },
  }));
  const preview = previewRun(createPreviewSampler(events, { beats }, { resolveEffect }), RIG, times);
  assertSame(rig, preview, times);
  const unseeked = previewRun(createPreviewSampler(events.slice(0, 3), { beats }, { resolveEffect }), RIG, times);
  assert.ok(times.some((t, i) => t >= 3700 && key(preview[i][0]) !== key(unseeked[i][0])), 'the voice re-anchors at the seek');
});

test('a pattern bundle voice plays as the rig plays it, across a seek and back from a kept copy', () => {
  const beats = Array.from({ length: 40 }, (_, i) => 0.2 + i * 0.5);
  const grid = makeGrid(beats);
  const lane = (id, kind, fixtureId) => ({ id, kind, ...(fixtureId !== undefined ? { fixtureId } : {}), name: id, mute: false, solo: false });
  const clip = (id, laneId, spec, startBeat, lengthBeats, fixtureIds = null) => ({ id, laneId, fixtureIds, startBeat, lengthBeats, loopBeats: lengthBeats, spec, seed: seedFrom(id), mute: false });
  // Shared clips over all three targets and one fixture, a track lane on the fourth par, a gap at beat 3.
  const table = { revision: 0, lanes: [lane('shared:0', 'shared'), lane('track:0', 'track', PARS[3].id)], clips: [
    clip('0:0', 'shared:0', FADE, 0, 2), clip('0:1', 'shared:0', preset('ldj.BigRoomWave'), 2, 1, [PARS[1].id]), clip('1:0', 'track:0', FADE, 1, 2.5),
  ] };
  const bundle = bundleSpec({ patternId: 'p', lengthBeats: 4, table }, false);
  const targets = [PARS[0].id, PARS[1].id, PARS[3].id];
  const events = [
    { timeMs: 0, action: 'patch', data: { pattern: 'solid', ...LOOK } },
    { timeMs: 2300, action: 'patch', data: { pattern: 'ldj.FadeCycle', beatDivision: 2 } },
    { timeMs: 2511, action: 'voice', data: { id: 'pad:b', effect: bundle, targets, tier: 'voice', launchSeq: 1 } },
    { timeMs: 3700, action: 'seek' },
  ];
  const sceneBeat = beatPositionAt(grid, 2300);
  const times = frames(0, 9000);
  const rig = rigRun(RIG, times, (t) => ({
    ...(t < 2300 ? { pattern: 'solid', patternAnchor: { step: anchorStep(beatPositionAt(grid, 0)), epoch: 0 } } : {
      pattern: 'ldj.FadeCycle', effect: FADE, beatDivision: 2, patternAnchor: { step: anchorStep(sceneBeat, 2), epoch: 0 } }),
    voices: t >= 2511 ? [voice('pad:b', bundle, { targets, startedAtMs: 2511, anchorBeat: beatPositionAt(grid, 2511) })] : [],
    reading: { beatPos: beatPositionAt(grid, t), bpm: localBpm(grid, t), epoch: t >= 3700 - 1e-6 ? 1 : 0,
      anchorBeat: t >= 2300 ? sceneBeat : beatPositionAt(grid, 0) },
  }));
  const sample = createPreviewSampler(events, { beats }, { resolveEffect });
  const preview = previewRun(sample, RIG, times);
  assertSame(rig, preview, times);
  const bare = previewRun(createPreviewSampler(events.filter((e) => e.action !== 'voice'), { beats }, { resolveEffect }), RIG, times);
  for (const k of [0, 1, 3]) assert.ok(times.some((t, i) => t >= 2511 && key(preview[i][k]) !== key(bare[i][k])), `the bundle lights par ${k}`);
  assert.ok(times.every((t, i) => key(preview[i][2]) === key(bare[i][2])), 'an untargeted par shows the look');
  // Back over the seek and the bundle's laps: each frame from a kept copy matches the rig's.
  const r = buildRig(RIG, getProfile);
  for (let i = times.length - 1; i >= 0; i -= 37) assert.deepStrictEqual(sample(times[i], RIG, COLOR_PRESETS, r), rig[i], `back at ${times[i]}`);
});

// ── Going back ──────────────────────────────────────────────────────────────

// Free clock at the timeline's 120 BPM: these timelines run longer than GRID.
const LONG = [
  { timeMs: 0, action: 'patch', data: { pattern: 'ldj.FadeCycle', ...LOOK } },
  { timeMs: 0, action: 'voice', data: { id: 'count', effect: OWN.probe, targets: [PARS[3].id], tier: 'voice', launchSeq: 1 } },
  { timeMs: 3000, action: 'voice', data: { id: 'pad:t', effect: OWN.twinkle8, targets: [PARS[0].id, LAMP.id], tier: 'voice', launchSeq: 2, durationMs: 9000 } },
  { timeMs: 6100, action: 'patch', data: { colorA: 3, fadeMs: 2000 } },
  { timeMs: 9000, action: 'seek' },
  { timeMs: 40000, action: 'patch', data: { pattern: 'ldj.StrobeCycle' } },
];

test('going back within the last 16 s walked replays at most a second of frames, from a copy kept on the way, and shows what a fresh sampler shows', () => {
  const r = buildRig(RIG, getProfile);
  const options = { resolveEffect, safety: ACK };
  const sample = createPreviewSampler(LONG, null, options);
  const fresh = (t) => createPreviewSampler(LONG, null, options)(t, RIG, COLOR_PRESETS, r);
  sample(16000, RIG, COLOR_PRESETS, r);
  // A second back at a time, on the grid and between frames, across the fade, the seek and the twinkle's flash limit.
  for (let t = 15500; t >= 500; t -= 1000 + 1 / 3) {
    const before = probeRenders;
    const out = sample(t, RIG, COLOR_PRESETS, r);
    // The probe voice renders once a frame: a second's frames, and one for a moment between two.
    assert.ok(probeRenders - before <= 46, `${probeRenders - before} renders to go back to ${t}`);
    assert.deepStrictEqual(out, fresh(t), `at ${t}`);
  }
  // A whole second's frame is kept with its lights: shown from its copy, nothing rendered.
  const before = probeRenders;
  const second = sample(10000, RIG, COLOR_PRESETS, r);
  assert.strictEqual(probeRenders - before, 0);
  assert.deepStrictEqual(second, fresh(10000));
});

test('the copies kept every second are the 16 most recently used, and a sampler that jumps about still shows what a fresh one shows', () => {
  const r = buildRig(RIG, getProfile);
  const options = { resolveEffect, safety: ACK };
  const renders = (sample, t) => { const before = probeRenders; sample(t, RIG, COLOR_PRESETS, r); return probeRenders - before; };
  // A walk to 70 s keeps the seconds from 55 s on, and going back to 55.5 s uses the copy at 55 s.
  // The walk to 3 s keeps 0–3 s: the four copies used longest ago, 56–59 s, give way.
  const bounded = createPreviewSampler(LONG, null, options);
  bounded(70000, RIG, COLOR_PRESETS, r);
  assert.ok(renders(bounded, 55500) <= 23, 'from the copy at 55 s');
  bounded(3000, RIG, COLOR_PRESETS, r);
  assert.ok(renders(bounded, 60500) <= 23, 'from the copy at 60 s');
  assert.ok(renders(bounded, 55600) <= 28, 'the copy at 55 s was used lately: kept');
  assert.ok(renders(bounded, 59500) > 100, 'the copies at 56–59 s are gone: from the one at 55 s');
  // Far enough apart that copies keep giving way to newer ones.
  const sample = createPreviewSampler(LONG, null, options);
  const fresh = (t) => createPreviewSampler(LONG, null, options)(t, RIG, COLOR_PRESETS, r);
  for (const t of [70000, 3000, 65000, 20000.5, 50000, 33333, 69000, 1000, 45454.5, 39990, 40010, 12]) {
    assert.deepStrictEqual(sample(t, RIG, COLOR_PRESETS, r), fresh(t), `at ${t}`);
  }
});

test('a moment just before the first frame, within the grid\'s rounding, renders on a copy rather than failing', () => {
  // The scene lands 1.5 ns after the fifth frame; the moment asked for is 0.6 ns after it.
  const at = 5 * FRAME_MS;
  const events = [{ timeMs: at + 1.5e-6, action: 'patch', data: { pattern: 'ldj.FadeCycle', ...LOOK } }];
  const sample = createPreviewSampler(events, GRID, { resolveEffect });
  const out = sample(at + 0.6e-6, PARS, COLOR_PRESETS);
  assert.strictEqual(out.length, PARS.length);
  assert.deepStrictEqual(sample(6 * FRAME_MS, PARS, COLOR_PRESETS), createPreviewSampler(events, GRID, { resolveEffect })(6 * FRAME_MS, PARS, COLOR_PRESETS));
});

test('a frame asked for after a moment inside it is rendered from where the walk stands, not replayed', () => {
  const events = [
    { timeMs: 0, action: 'patch', data: { pattern: 'solid', ...LOOK } },
    { timeMs: 0, action: 'voice', data: { id: 'count', effect: OWN.probe, targets: [PARS[0].id], tier: 'voice', launchSeq: 1 } },
  ];
  const sample = createPreviewSampler(events, null, { resolveEffect });
  sample(300 * FRAME_MS + 9, PARS, COLOR_PRESETS);
  const before = probeRenders;
  const out = sample(300 * FRAME_MS, PARS, COLOR_PRESETS);
  assert.strictEqual(probeRenders - before, 0, 'frame 300 was the walk\'s last');
  assert.strictEqual(out[0].r, 301 % 256);
});

// ── The canonical grid ──────────────────────────────────────────────────────

test('an exact frame asked for twice is the same bytes and consumes nothing a later frame needs', () => {
  // A wave played once keeps a queued colour change for its next render: a
  // second render of the same moment would take it.
  const events = [{ timeMs: 0, action: 'patch', data: { pattern: 'wave-once', ...LOOK } }];
  const fixtures = PARS;
  const times = frames(0, 400);
  const rig = rigRun(fixtures, times, () => ({ pattern: 'wave-once', effect: OWN['wave-once'] }));
  const twice = createPreviewSampler(events, GRID, { resolveEffect });
  const r = buildRig(fixtures, getProfile);
  const seen = [];
  for (const t of times) {
    const first = twice(t, fixtures, COLOR_PRESETS, r);
    assert.deepStrictEqual(twice(t, fixtures, COLOR_PRESETS, r), first, `again at ${t}`);
    seen.push(first);
  }
  assertSame(rig, seen, times);
  assert.ok(new Set(seen.map((o) => o.map(key).join('|'))).size > 2, 'the wave plays');
});

test('off-grid samples render on a copy: the frames after them are the ones a sampler that never saw them renders', () => {
  const events = [
    { timeMs: 0, action: 'patch', data: { pattern: 'ldj.FadeCycle', ...LOOK } },
    { timeMs: 90, action: 'voice', data: { id: 'pad:x', effect: preset('ldj.CrossFade'), targets: [PARS[0].id, LAMP.id], tier: 'voice', launchSeq: 1 } },
    { timeMs: 333, action: 'patch', data: { pattern: 'wave-once', fadeMs: 250 } },
    { timeMs: 700, action: 'patch', data: { pattern: 'ldj.CrossFade' } },
  ];
  const r = buildRig(RIG, getProfile);
  const onGrid = createPreviewSampler(events, GRID, { resolveEffect });
  const between = createPreviewSampler(events, GRID, { resolveEffect });
  const grid = frames(0, 1200);
  const a = grid.map((t) => onGrid(t, RIG, COLOR_PRESETS, r));
  const b = [];
  for (const t of grid) {
    // Two moments inside each frame, one of them asked for twice.
    const mid = between(t + 7, RIG, COLOR_PRESETS, r);
    assert.deepStrictEqual(between(t + 7, RIG, COLOR_PRESETS, r), mid);
    between(t + 15.5, RIG, COLOR_PRESETS, r);
    b.push(between(t, RIG, COLOR_PRESETS, r));
  }
  assert.deepStrictEqual(b, a);
  assert.deepStrictEqual(createPreviewSampler(events, GRID, { resolveEffect })(1200, RIG, COLOR_PRESETS, r), a.at(-1));
  // A moment between two frames is the rig's frames before it, then one at that moment.
  const times = [...frames(0, 350), 350];
  const late = createPreviewSampler(events, GRID, { resolveEffect })(350, RIG, COLOR_PRESETS, r);
  const rig = rigRun(RIG, times, (t) => ({
    pattern: t >= 333 ? 'wave-once' : 'ldj.FadeCycle', effect: t >= 333 ? OWN['wave-once'] : FADE,
    patternAnchor: t >= 333 ? { step: anchorStep(beat(333)), epoch: 0 } : { step: 0, epoch: 0 },
    fade: t >= 333 ? { seq: 1, ms: 250, at: 333 } : null,
    voices: t >= 90 ? [voice('pad:x', preset('ldj.CrossFade'), { targets: [PARS[0].id, LAMP.id], startedAtMs: 90, anchorBeat: beat(90) })] : [],
  }));
  assertSame(rig.slice(-1), [late], [350]);
});

test('only the frames of the grid count: repeats, moments between frames and going back render nothing into the history', () => {
  // Under a blue look, whose red is 0.
  const events = [
    { timeMs: 0, action: 'patch', data: { pattern: 'solid', ...LOOK, colorA: 5 } },
    { timeMs: 30, action: 'voice', data: { id: 'count', effect: OWN.probe, targets: 'shared', tier: 'voice', launchSeq: 1 } },
  ];
  const sample = createPreviewSampler(events, GRID, { resolveEffect });
  // The voice's first render is the frame at 45.5 ms, its k-th the frame k + 1 after.
  const renders = (t) => sample(t, PARS, COLOR_PRESETS)[0].r;
  assert.strictEqual(renders(2 * FRAME_MS), 1);
  assert.strictEqual(renders(2 * FRAME_MS), 1, 'the same frame again');
  assert.strictEqual(renders(10 * FRAME_MS), 9);
  assert.strictEqual(renders(10 * FRAME_MS + 5), 10, 'a moment after it: one more render, on a copy');
  assert.strictEqual(renders(10 * FRAME_MS + 5), 10);
  assert.strictEqual(renders(11 * FRAME_MS), 10, 'and the next frame is still the tenth');
  assert.strictEqual(renders(40), 1, 'back before the frame at 45.5 ms: one render, at 40');
  assert.strictEqual(renders(20), 0, 'before the voice began: none');
  assert.strictEqual(renders(5 * FRAME_MS), 4);
  assert.strictEqual(renders(30 * FRAME_MS), 29);
});

test('a base effect starts on the first frame that plays it, whatever was asked in between; a voice on its event\'s own moment', () => {
  const events = [
    { timeMs: 0, action: 'patch', data: { pattern: 'solid', ...LOOK, colorA: 5 } },
    { timeMs: 30, action: 'voice', data: { id: 'count', effect: OWN.probe, targets: [PARS[3].id], tier: 'voice', launchSeq: 1 } },
    { timeMs: 101, action: 'patch', data: { pattern: 'probe' } },
  ];
  const sample = createPreviewSampler(events, GRID, { resolveEffect });
  // Asked at 105 ms, on a copy, the base begins there and then.
  const between = sample(105, PARS, COLOR_PRESETS);
  assert.deepStrictEqual([between[0].r, between[0].g], [1, 105]);
  assert.deepStrictEqual([between[3].r, between[3].g], [4, 30], 'the voice from its own event, 30 ms');
  // On the grid it began on the frame at 113.6 ms, never at 105.
  const frame5 = sample(5 * FRAME_MS, PARS, COLOR_PRESETS);
  assert.deepStrictEqual([frame5[0].r, frame5[0].g], [1, 114]);
  const later = sample(9 * FRAME_MS, PARS, COLOR_PRESETS);
  assert.deepStrictEqual([later[0].r, later[0].g], [5, 114]);
  assert.deepStrictEqual(later, createPreviewSampler(events, GRID, { resolveEffect })(9 * FRAME_MS, PARS, COLOR_PRESETS));
  // The rig's base begins on the same frame.
  const times = frames(0, 9 * FRAME_MS);
  const rig = rigRun(PARS, times, (t) => ({
    ...(t < 101 ? { pattern: 'solid', colorA: 5 } : { pattern: 'probe', effect: OWN.probe, colorA: 5, patternAnchor: { step: anchorStep(beat(101)), epoch: 0 } }),
    voices: t >= 30 ? [voice('count', OWN.probe, { targets: [PARS[3].id], startedAtMs: 30, anchorBeat: beat(30) })] : [],
  }));
  assertSame(rig.slice(-1), [later], times.slice(-1));
});

test('scenes between two frames render once, as the last of them, and a voice keeps its own launch', () => {
  const pad = { id: 'pad:w', effect: FADE, targets: [PARS[0].id, PARS[1].id], tier: 'voice', launchSeq: 1 };
  const events = [
    { timeMs: 0, action: 'patch', data: { pattern: 'ldj.FadeCycle', ...LOOK } },
    { timeMs: 0, action: 'voice', data: pad },
    { timeMs: 101, action: 'patch', data: { pattern: 'ldj.StrobeCycle' } },
    { timeMs: 107, action: 'patch', data: { pattern: 'ldj.CrossFade' } },
  ];
  const times = frames(0, 900);
  const preview = previewRun(createPreviewSampler(events, GRID, { resolveEffect }), RIG, times);
  const skipped = previewRun(createPreviewSampler(events.filter((e) => e.timeMs !== 101), GRID, { resolveEffect }), RIG, times);
  assert.deepStrictEqual(preview, skipped, 'the scene no frame fell in never renders');
  const rig = rigRun(RIG, times, (t) => (t < 107 ? { pattern: 'ldj.FadeCycle', effect: FADE } : {
    pattern: 'ldj.CrossFade', effect: preset('ldj.CrossFade'), patternAnchor: { step: anchorStep(beat(107)), epoch: 0 },
  }));
  // The rig without the voice, then the voice's own lamps checked apart.
  const rigWithVoice = rigRun(RIG, times, (t) => ({
    ...(t < 107 ? { pattern: 'ldj.FadeCycle', effect: FADE } : {
      pattern: 'ldj.CrossFade', effect: preset('ldj.CrossFade'), patternAnchor: { step: anchorStep(beat(107)), epoch: 0 } }),
    voices: [voice('pad:w', FADE, { targets: [PARS[0].id, PARS[1].id] })],
  }));
  assertSame(rigWithVoice, preview, times);
  assert.ok(times.some((t, i) => key(rig[i][0]) !== key(rigWithVoice[i][0]) || key(rig[i][1]) !== key(rigWithVoice[i][1])), 'the voice shows');
  // The voice plays as it would with no scene change at all.
  const still = previewRun(createPreviewSampler(events.filter((e) => e.action !== 'patch' || e.timeMs === 0), GRID, { resolveEffect }), RIG, times);
  assert.deepStrictEqual(preview.map((o) => o.slice(0, 2)), still.map((o) => o.slice(0, 2)));
});

test('a scene sending its pattern again on the same step plays on, as the rig does; on another step it starts again; a colour patch carries on', () => {
  const times = frames(0, 1200);
  const base = { timeMs: 0, action: 'patch', data: { pattern: 'ldj.FadeCycle', ...LOOK } };
  const plain = previewRun(createPreviewSampler([base], GRID, { resolveEffect }), RIG, times);
  // What patch.ts hands the renderer for a scheduled scene: the step of the beat
  // it was due on and the clock's epoch, and no effect revision.
  const anchorOf = (ms) => ({ step: anchorStep(beat(ms)), epoch: 0 });
  // 200 ms is 0.4 of a beat: the step of the scene at 0, so the same launch on both.
  assert.deepStrictEqual(anchorOf(200), anchorOf(0));
  const same = previewRun(createPreviewSampler([base, { timeMs: 200, action: 'patch', data: { pattern: 'ldj.FadeCycle' } }], GRID, { resolveEffect }), RIG, times);
  assertSame(rigRun(RIG, times, (t) => ({ pattern: 'ldj.FadeCycle', effect: FADE, patternAnchor: anchorOf(t >= 200 ? 200 : 0) })), same, times);
  assert.deepStrictEqual(same, plain, 'nothing starts again');
  // 700 ms is on a later step: a new id, so a new launch on both.
  assert.notDeepStrictEqual(anchorOf(700), anchorOf(0));
  const next = previewRun(createPreviewSampler([base, { timeMs: 700, action: 'patch', data: { pattern: 'ldj.FadeCycle' } }], GRID, { resolveEffect }), RIG, times);
  assertSame(rigRun(RIG, times, (t) => ({ pattern: 'ldj.FadeCycle', effect: FADE, patternAnchor: anchorOf(t >= 700 ? 700 : 0) })), next, times);
  assert.ok(times.some((t, i) => key(plain[i][0]) !== key(next[i][0])), 'the relaunch shows');
  const recoloured = previewRun(createPreviewSampler([base, { timeMs: 200, action: 'patch', data: { colorA: 7, colorB: 2 } }], GRID, { resolveEffect }), RIG, times);
  assert.deepStrictEqual(recoloured, plain, 'its own colours, carried on');
});

// ── Fades ───────────────────────────────────────────────────────────────────

test('a crossfade starts from what the base showed on the frame before, without the voice over it, and a second fade from the first', () => {
  const pad = { id: 'pad:b', effect: BLINDER, targets: [PARS[0].id], tier: 'voice', launchSeq: 1 };
  const events = [
    { timeMs: 0, action: 'patch', data: { pattern: 'ldj.FadeCycle', ...LOOK } },
    { timeMs: 0, action: 'voice', data: pad },
    { timeMs: 310, action: 'patch', data: { pattern: 'ldj.StrobeCycle', fadeMs: 400 } },
    { timeMs: 505, action: 'patch', data: { pattern: 'chase', fadeMs: 300 } },
    { timeMs: 1300, action: 'voice-end', data: { id: 'pad:b' } },
  ];
  const times = frames(0, 1600);
  const rig = rigRun(RIG, times, (t) => {
    const scene = t >= 505 ? 2 : t >= 310 ? 1 : 0;
    return {
      pattern: ['ldj.FadeCycle', 'ldj.StrobeCycle', 'chase'][scene],
      effect: [FADE, preset('ldj.StrobeCycle'), null][scene],
      patternAnchor: { step: [0, anchorStep(beat(310)), anchorStep(beat(505))][scene], epoch: 0 },
      fade: scene === 2 ? { seq: 2, ms: 300, at: 505 } : scene === 1 ? { seq: 1, ms: 400, at: 310 } : null,
      voices: t < 1300 ? [voice('pad:b', BLINDER, { targets: [PARS[0].id] })] : [],
    };
  });
  assertSame(rig, previewRun(createPreviewSampler(events, GRID, { resolveEffect }), RIG, times), times);
});

// ── Voices ──────────────────────────────────────────────────────────────────

test('voices: tiers and launches, a deadline, an end and a relaunch at one moment, fixtures a voice names, a split wash and a bar', () => {
  registerProfile(BAR);
  try {
    const placed = [...PARS.map((f, i) => ({ ...f, position: { x: 10 + 20 * i, y: 50 }, group: i < 2 ? 'front' : 'back' })),
      fixture(20, 80, BAR.id, { position: { x: 90, y: 30 }, group: 'back' }), { ...LAMP, position: { x: 50, y: 80 }, group: 'front' }];
    const uv = preset('energy.uvWash'), kill = preset('energy.kill'), wave = preset('ldj.BigRoomWave');
    const events = [
      { timeMs: 0, action: 'patch', data: { pattern: 'ldj.FadeCycle', ...LOOK, split: 1 } },
      { timeMs: 0, action: 'voice', data: { id: 'a', effect: uv, targets: [10, 20], tier: 'voice', launchSeq: 1 } },
      { timeMs: 100, action: 'voice', data: { id: 'b', effect: BLINDER, targets: [20, 11], tier: 'voice', launchSeq: 2, durationMs: 300 } },
      { timeMs: 150, action: 'voice', data: { id: 'c', effect: kill, targets: [11], tier: 'strobe', launchSeq: 1 } },
      { timeMs: 200, action: 'voice', data: { id: 'ghost', effect: BLINDER, targets: [99, 0, 1], tier: 'voice', launchSeq: 9 } },
      { timeMs: 210, action: 'voice', data: { id: 'none', effect: BLINDER, targets: [], tier: 'voice', launchSeq: 9 } },
      { timeMs: 450, action: 'voice', data: { id: 'w', effect: wave, targets: 'shared', tier: 'voice', launchSeq: 0 } },
      // At one moment: an end then a relaunch leaves the new launch; a launch then its end leaves none.
      { timeMs: 600, action: 'voice-end', data: { id: 'a' } },
      { timeMs: 600, action: 'voice', data: { id: 'a', effect: uv, targets: [12, 14], tier: 'voice', launchSeq: 5 } },
      { timeMs: 700, action: 'voice', data: { id: 'd', effect: BLINDER, targets: 'shared', tier: 'strobe', launchSeq: 9 } },
      { timeMs: 700, action: 'voice-end', data: { id: 'd' } },
      { timeMs: 800, action: 'voice-end', data: { id: 'c' } },
    ];
    const times = frames(0, 1100);
    const rig = rigRun(placed, times, (t) => {
      const voices = [];
      if (t < 600) voices.push(voice('a', uv, { targets: [10, 20] }));
      else voices.push(voice('a', uv, { targets: [12, 14], launchSeq: 5, startedAtMs: 600, anchorBeat: beat(600) }));
      if (t >= 100) voices.push(voice('b', BLINDER, { targets: [20, 11], launchSeq: 2, startedAtMs: 100, untilMs: 400, anchorBeat: beat(100) }));
      if (t >= 150 && t < 800) voices.push(voice('c', kill, { targets: [11], tier: 'strobe', startedAtMs: 150, anchorBeat: beat(150) }));
      if (t >= 200) voices.push(voice('ghost', BLINDER, { targets: [99, 0, 1], launchSeq: 9, startedAtMs: 200, anchorBeat: beat(200) }));
      if (t >= 210) voices.push(voice('none', BLINDER, { targets: [], launchSeq: 9, startedAtMs: 210, anchorBeat: beat(210) }));
      if (t >= 450) voices.push(voice('w', wave, { launchSeq: 0, startedAtMs: 450, anchorBeat: beat(450) }));
      return { pattern: 'ldj.FadeCycle', effect: FADE, split: 1, voices };
    });
    const preview = previewRun(createPreviewSampler(events, GRID, { resolveEffect }), placed, times);
    assertSame(rig, preview, times);
    const at = (t) => preview[times.findIndex((x) => x >= t)];
    // Par 11 at 300: the strobe-tier kill over the later blinder.
    assert.strictEqual(at(300)[1].r, 0);
    // The bar (units 4..7) at 300: the blinder over the uv wash; at 420 past the blinder's deadline, the uv wash.
    assert.deepStrictEqual([at(300)[4].r, at(300)[7].g], [255, 255]);
    assert.deepStrictEqual([at(420)[4].r, at(420)[4].b], [0, 0]);
  } finally {
    unregisterProfile(BAR.id);
  }
});

test('one strobe voice taking over from another carries the permit in the preview as on the rig, at once and after a dark gap', () => {
  const strobe = validateSpec({ kind: 'strobe', palette: ['#FFFFFF'], params: { flashesPerSecond: 5, clock: 'wall', continueBetween: false } });
  const times = frames(0, 1400);
  for (const [first, second] of [['energy:palette-strobe', 'strobe'], ['strobe', 'energy:palette-strobe']]) {
    for (const [ends, starts] of [[6, 6], [5, 7]]) {
      const end = times[ends], start = times[starts];
      const events = [
        { timeMs: 0, action: 'patch', data: { pattern: 'ldj.FadeCycle', ...LOOK } },
        { timeMs: 0, action: 'voice', data: { id: first, effect: strobe, targets: 'shared', tier: 'strobe', launchSeq: 1 } },
        { timeMs: end, action: 'voice-end', data: { id: first } },
        { timeMs: start, action: 'voice', data: { id: second, effect: strobe, targets: 'shared', tier: 'strobe', launchSeq: 2 } },
      ];
      const rig = rigRun(RIG, times, (t) => ({
        pattern: 'ldj.FadeCycle', effect: FADE, safety: ACK,
        voices: t < end ? [voice(first, strobe, { tier: 'strobe' })]
          : t < start ? [] : [voice(second, strobe, { tier: 'strobe', launchSeq: 2, startedAtMs: start, anchorBeat: beat(start) })],
      }));
      const preview = previewRun(createPreviewSampler(events, GRID, { resolveEffect, safety: ACK }), RIG, times);
      const label = `${first} → ${second}, frames ${ends}/${starts}`;
      assertSame(rig, preview, times, label);
      const white = preview.map((o) => o[0].r === 255 && o[0].g === 255 && o[0].b === 255);
      const rises = white.flatMap((on, k) => (on && !white[k - 1] ? [k] : []));
      assert.strictEqual(rises[0], 0, label);
      for (let i = 1; i < rises.length; i++) assert.ok(rises[i] - rises[i - 1] >= 8, `${label}: rises ${rises}`);
      assert.ok(rises.length >= 5, `${label}: ${rises}`);
    }
  }
});

test('a lamp keeps one strobe permit whoever draws it, in the preview as on the rig: a strobe voice ending over another strobe', () => {
  const strobe = validateSpec({ kind: 'strobe', palette: ['#FFFFFF'], params: { flashesPerSecond: 5, clock: 'wall', continueBetween: false } });
  const times = frames(0, 1800);
  for (const [from, ends] of [[3, 10], [5, 12], [7, 15]]) {
    const start = times[from], end = times[ends];
    const events = [
      { timeMs: 0, action: 'patch', data: { pattern: 'ldj.FadeCycle', ...LOOK } },
      { timeMs: 0, action: 'voice', data: { id: 'strobe', effect: strobe, targets: 'shared', tier: 'strobe', launchSeq: 5 } },
      { timeMs: start, action: 'voice', data: { id: 'pad:x', effect: strobe, targets: 'shared', tier: 'voice', launchSeq: 1 } },
      { timeMs: end, action: 'voice-end', data: { id: 'strobe' } },
    ];
    const rig = rigRun(RIG, times, (t) => ({
      pattern: 'ldj.FadeCycle', effect: FADE, safety: ACK,
      voices: [...(t < end ? [voice('strobe', strobe, { tier: 'strobe', launchSeq: 5 })] : []),
        ...(t >= start ? [voice('pad:x', strobe, { launchSeq: 1, startedAtMs: start, anchorBeat: beat(start) })] : [])],
    }));
    const preview = previewRun(createPreviewSampler(events, GRID, { resolveEffect, safety: ACK }), RIG, times);
    const label = `the lower from frame ${from}, the upper ending on ${ends}`;
    assertSame(rig, preview, times, label);
    const white = preview.map((o) => o[0].r === 255 && o[0].g === 255 && o[0].b === 255);
    const rises = white.flatMap((on, k) => (on && !white[k - 1] ? [k] : []));
    for (let i = 1; i < rises.length; i++) assert.ok(rises[i] - rises[i - 1] >= 8, `(a) ${label}: ${rises}`);
    for (let i = 5; i < rises.length; i++) assert.ok(rises[i] - rises[i - 5] >= 44, `(b) ${label}: ${rises}`);
    assert.ok(rises.length >= 6, `${label}: ${rises}`);
  }
});

test('a mixed timeline plays its energy bursts as tracked voices: replaced, expired and cancelled as the old lane', () => {
  const events = [
    { timeMs: 0, action: 'patch', data: { pattern: 'ldj.FadeCycle', ...LOOK } },
    { timeMs: 0, action: 'voice', data: { id: 'pad:1', effect: preset('energy.uvWash'), targets: [PARS[3].id], tier: 'voice', launchSeq: 1 } },
    { timeMs: 100, action: 'energy', data: { id: 'blinder', durationMs: 300 } },
    { timeMs: 250, action: 'energy', data: { id: 'blinder', durationMs: 300 } },
    { timeMs: 700, action: 'energy', data: { id: 'kill', durationMs: 400 } },
    { timeMs: 900, action: 'patch', data: { energyOverride: null } },
  ];
  const times = frames(0, 1300);
  let started = null;
  const rig = rigRun(RIG, times, (t) => {
    const voices = [voice('pad:1', preset('energy.uvWash'), { targets: [PARS[3].id] })];
    // The old lane: one burst at a time; the same burst again carries on, a new one starts afresh.
    const energy = t >= 700 && t < 900 ? 'kill' : t >= 100 && t < 550 ? 'blinder' : null;
    if (!energy) started = null;
    else {
      if (!started || started.energy !== energy) started = { energy, at: t };
      voices.push(voice(`energy:${energy}`, preset(`energy.${energy}`), { launchSeq: 0, startedAtMs: started.at }));
    }
    return { pattern: 'ldj.FadeCycle', effect: FADE, voices };
  });
  const preview = previewRun(createPreviewSampler(events, GRID, { resolveEffect }), RIG, times);
  assertSame(rig, preview, times);
  const at = (t) => preview[times.findIndex((x) => x >= t)];
  assert.strictEqual(at(500)[0].w, 255, 'the renewed blinder at 500');
  assert.notStrictEqual(at(600)[0].w, 255, 'gone at its new end');
  assert.deepStrictEqual([at(800)[0].r, at(800)[0].g], [0, 0], 'the kill');
  const plain = previewRun(createPreviewSampler(events.filter((e) => e.action !== 'energy'), GRID, { resolveEffect }), RIG, times);
  const at1000 = times.findIndex((x) => x >= 1000);
  assert.deepStrictEqual(preview[at1000], plain[at1000], 'cancelled by the patch before its end');
  assert.ok(preview[at1000].some((c) => c.r + c.g + c.b > 0));
});

// ── Safety, Hue lamps and Hue Dynamics' limit ───────────────────────────────

test('an unacknowledged rapid effect or voice is gated as on the rig; the old burst keeps its admission only while no safety is given', () => {
  const times = frames(0, 600);
  const strobe = preset('ldj.TrueStrobe');
  const white = preset('energy.whiteStrobe');
  const run = (options, safety, extra = {}) => {
    const events = [
      { timeMs: 0, action: 'patch', data: { pattern: 'ldj.TrueStrobe', ...LOOK } },
      { timeMs: 0, action: 'voice', data: { id: 'energy:white-strobe', effect: white, targets: [PARS[1].id], tier: 'voice', launchSeq: 1 } },
      ...(extra.events ?? []),
    ];
    const preview = previewRun(createPreviewSampler(events, GRID, { resolveEffect, ...options }), RIG, times);
    const rig = rigRun(RIG, times, () => ({ pattern: 'ldj.TrueStrobe', effect: strobe, ...(safety ? { safety } : {}),
      voices: [voice('energy:white-strobe', white, { targets: [PARS[1].id] })] }));
    assertSame(rig, preview, times, JSON.stringify(options));
    return preview;
  };
  const gated = run({}, null);
  // A caller-chosen energy:* id is an explicit voice: no old admission.
  assert.ok(gated.every((o) => o.every((c) => c.r === 0 && c.g === 0 && c.b === 0)), 'base and voice dark');
  const open = run({ safety: ACK }, ACK);
  assert.ok(open.some((o) => o[0].r + o[0].g + o[0].b > 0) && open.every((o) => o[1].w === 255), 'acknowledged: both play');

  // The old energy lane on an effect timeline.
  const lane = (options, safety) => {
    const events = [
      { timeMs: 0, action: 'patch', data: { pattern: 'ldj.FadeCycle', ...LOOK } },
      { timeMs: 0, action: 'energy', data: { id: 'white-strobe', durationMs: 5000 } },
    ];
    const preview = previewRun(createPreviewSampler(events, GRID, { resolveEffect, ...options }), RIG, times);
    const rig = rigRun(RIG, times, () => ({ pattern: 'ldj.FadeCycle', effect: FADE, energy: 'white-strobe', ...(safety ? { safety } : {}) }));
    assertSame(rig, preview, times, `lane ${JSON.stringify(options)}`);
    return preview;
  };
  assert.ok(lane({}, null).every((o) => o[0].w === 255), 'no safety given: the burst plays as it always did');
  assert.ok(lane({ safety: { acknowledged: false } }, { hdFlashIntervalMs: 350, acknowledged: false }).every((o) => o[0].w !== 255), 'safety given: gated');
  assert.ok(lane({ safety: ACK }, ACK).every((o) => o[0].w === 255));
});

test('the old patch and energy timeline: the bursts gate with a safety given, Hue lamps take the setting, a Hue profile alone is a Hue lamp', () => {
  const times = [0, 60, 100, 170, 200, 250, 320, 480, 760, 1010];
  const profileOnly = fixture(15, 70, HUE_COLOR_PROFILE_ID);
  const fixtures = [PARS[0], LAMP, profileOnly];
  const at = (energy, options, input) => {
    const events = [
      { timeMs: 0, action: 'patch', data: { pattern: 'solid', ...LOOK } },
      { timeMs: 0, action: 'energy', data: { id: energy, durationMs: 5000 } },
    ];
    const preview = previewRun(createPreviewSampler(events, GRID, options), fixtures, times);
    // The rig is asked one moment at a time, as hold-strobe.test.js does.
    const rig = times.map((t) => rigRun(fixtures, [t], () => ({ energy, ...input }))[0]);
    assertSame(rig, preview, times, `${energy} ${JSON.stringify(options)}`);
    return preview;
  };
  at(HOLD_STROBE, {}, {});
  at(HOLD_STROBE, { hueStrobe: 'flash' }, { hueStrobe: 'flash' });
  const gated = at(HOLD_STROBE, { safety: { acknowledged: false } }, { safety: { hdFlashIntervalMs: 350, acknowledged: false } });
  assert.ok(gated.every((o) => o[0].r === 255 && o[0].g === 0), 'gated: the running look (solid red)');
  at(HOLD_STROBE, { safety: ACK, hueStrobe: 'flash' }, { safety: ACK, hueStrobe: 'flash' });
  for (const energy of ['white-strobe', 'color-strobe', 'blinder', 'glow', 'kill', 'uv-wash']) {
    at(energy, { safety: { acknowledged: false } }, { safety: { hdFlashIntervalMs: 350, acknowledged: false } });
    at(energy, {}, {});
  }
  // The flash looks of the pattern layer follow the setting too.
  for (const hueStrobe of ['flash', 'pulse']) {
    const ring = previewRun(createPreviewSampler([{ timeMs: 0, action: 'patch', data: { pattern: 'ring-strobe', ...LOOK } }], GRID, { hueStrobe }), fixtures, times);
    const rig = times.map((t) => rigRun(fixtures, [t], () => ({ pattern: 'ring-strobe', hueStrobe, patternAnchor: { step: 0, epoch: 0 } }))[0]);
    assertSame(rig, ring, times, `ring-strobe ${hueStrobe}`);
  }
});

test('Hue Dynamics\' flash limit, a trimmed lamp and Light DJ\'s flashes on a Hue lamp in both modes rehearse as the rig plays them', () => {
  const trimmed = [{ ...PARS[0], maxBrightness: 100 }, PARS[1], PARS[2], LAMP];
  const times = frames(0, 1500);
  for (const hueStrobe of ['flash', 'pulse']) {
    for (const [pattern, spec] of [['twinkle8', OWN.twinkle8], ['ldj.ScatterStrobe', preset('ldj.ScatterStrobe')], ['ldj.MatrixPulse', preset('ldj.MatrixPulse')]]) {
      const events = [{ timeMs: 0, action: 'patch', data: { pattern, ...LOOK } }];
      const preview = previewRun(createPreviewSampler(events, GRID, { resolveEffect, hueStrobe, safety: ACK }), trimmed, times);
      const rig = rigRun(trimmed, times, () => ({ pattern, effect: spec, hueStrobe, safety: ACK }));
      assertSame(rig, preview, times, `${pattern} ${hueStrobe}`);
    }
  }
  // The limit bites: eight rises a second asked for, at most three admitted on the full-trim par.
  const twinkle = previewRun(createPreviewSampler([{ timeMs: 0, action: 'patch', data: { pattern: 'twinkle8', ...LOOK } }], GRID, { resolveEffect }), trimmed, times);
  const bright = twinkle.map((o) => o[1].r > 140);
  const rises = bright.filter((on, i) => on && !bright[i - 1]).length;
  assert.ok(rises >= 3 && rises <= 5, `${rises} rises in 1.5 s`);
});

test('a scene part way into an analysed track, a tempo change under it and a voice launched off the grid', () => {
  // 120 BPM, then 128 from the eighth beat.
  const beats = [];
  for (let t = 0.2, i = 0; i < 40; i++) { beats.push(t); t += i < 8 ? 0.5 : 60 / 128; }
  const grid = makeGrid(beats);
  const events = [
    { timeMs: 0, action: 'patch', data: { pattern: 'solid', ...LOOK } },
    { timeMs: 2300, action: 'patch', data: { pattern: 'ldj.FadeCycle', beatDivision: 2 } },
    { timeMs: 2511, action: 'voice', data: { id: 'pad:g', effect: preset('ldj.Glow'), targets: [PARS[2].id, LAMP.id], tier: 'voice', launchSeq: 3 } },
  ];
  const times = frames(0, 7000);
  const sceneBeat = beatPositionAt(grid, 2300);
  const rig = rigRun(RIG, times, (t) => ({
    ...(t < 2300 ? { pattern: 'solid', patternAnchor: { step: anchorStep(beatPositionAt(grid, 0)), epoch: 0 } } : {
      pattern: 'ldj.FadeCycle', effect: FADE, beatDivision: 2, patternAnchor: { step: anchorStep(sceneBeat, 2), epoch: 0 } }),
    voices: t >= 2511 ? [voice('pad:g', preset('ldj.Glow'), { targets: [PARS[2].id, LAMP.id], launchSeq: 3, startedAtMs: 2511, anchorBeat: beatPositionAt(grid, 2511) })] : [],
    reading: { beatPos: beatPositionAt(grid, t), bpm: localBpm(grid, t), epoch: 0 },
  }));
  const sample = createPreviewSampler(events, { beats }, { resolveEffect });
  assertSame(rig, previewRun(sample, RIG, times), times);
});

// ── What the sampler is handed ──────────────────────────────────────────────

test('the rig, the colours and the effects are the whole timeline\'s: equal ones keep the history, changed ones are a fresh sampler\'s', () => {
  const events = [
    { timeMs: 0, action: 'patch', data: { pattern: 'fade-look', ...LOOK } },
    { timeMs: 0, action: 'voice', data: { id: 'count', effect: OWN.probe, targets: [PARS[3].id], tier: 'voice', launchSeq: 1 } },
  ];
  // Light DJ's fade cycle in the look's own colours, so the colour table shows.
  const specs = { 'fade-look': validateSpec({ kind: 'ldj.FadeCycle', params: { cadence: 1 }, palette: null }) };
  const resolver = (id) => specs[id] ?? resolveEffect(id);
  const sample = createPreviewSampler(events, GRID, { resolveEffect: resolver });
  const fresh = (fixtures, presets = COLOR_PRESETS) =>
    createPreviewSampler(events, GRID, { resolveEffect: resolver })(900, fixtures, presets, buildRig(fixtures, getProfile));
  for (const t of frames(0, 500)) sample(t, RIG, COLOR_PRESETS, buildRig(RIG, getProfile));
  // Rebuilt, equal: the history carries on, nothing starts again.
  let inits = probeInits;
  const copies = RIG.map((f) => ({ ...f }));
  const out = sample(900, copies, COLOR_PRESETS.map((c) => ({ ...c })), buildRig(copies, getProfile));
  assert.strictEqual(probeInits, inits, 'no state started again');
  assert.strictEqual(out[3].r, 41, 'forty frames and the moment at 900');
  assert.deepStrictEqual(out, fresh(RIG));
  // The output is the caller's: changing it changes nothing here.
  out[0].r = 7; out.length = 1;
  inits = probeInits;
  assert.deepStrictEqual(sample(900, RIG, COLOR_PRESETS, buildRig(RIG, getProfile)), fresh(RIG));
  assert.strictEqual(probeInits, inits + 1, 'only the fresh sampler started one');
  // Changed: a fixture's id, a trim, a place, a Hue flag, the colour table, an effect's settings.
  const changes = [
    RIG.map((f, i) => (i === 0 ? { ...f, id: 77 } : f)),
    RIG.map((f, i) => (i === 2 ? { ...f, maxBrightness: 90 } : f)),
    RIG.map((f, i) => (i === 0 ? { ...f, position: { x: 80, y: 20 } } : f)),
    RIG.map((f, i) => (i === 3 ? { ...f, hue: true } : f)),
  ];
  const before = sample(900, RIG, COLOR_PRESETS, buildRig(RIG, getProfile));
  for (const fixtures of changes) {
    const changed = sample(900, fixtures, COLOR_PRESETS, buildRig(fixtures, getProfile));
    assert.deepStrictEqual(changed, fresh(fixtures));
  }
  const recoloured = COLOR_PRESETS.map((c) => ({ ...c, g: 255 - (c.g ?? 0) }));
  const withColours = sample(900, RIG, recoloured, buildRig(RIG, getProfile));
  assert.deepStrictEqual(withColours, fresh(RIG, recoloured));
  assert.notDeepStrictEqual(withColours, before, 'the colours showed');
  specs['fade-look'] = validateSpec({ kind: 'ldj.FadeCycle', params: { cadence: 2 }, palette: null });
  const edited = sample(900, RIG, COLOR_PRESETS, buildRig(RIG, getProfile));
  assert.deepStrictEqual(edited, fresh(RIG));
  assert.notDeepStrictEqual(edited, before, 'the edit showed');
  // Back to the first: the history from before every change.
  specs['fade-look'] = validateSpec({ kind: 'ldj.FadeCycle', params: { cadence: 1 }, palette: null });
  assert.deepStrictEqual(sample(900, RIG, COLOR_PRESETS, buildRig(RIG, getProfile)), before);
});

test('a pattern no effect resolves plays the legacy layer; an unknown one plays solid', () => {
  const events = [{ timeMs: 0, action: 'patch', data: { pattern: 'no-such-look', ...LOOK } }];
  const out = createPreviewSampler(events, GRID, { resolveEffect })(100, PARS, COLOR_PRESETS);
  assert.deepStrictEqual(out.map((c) => [c.r, c.g, c.b]), PARS.map(() => [255, 0, 0]));
  // A timeline with voices still plays its legacy look under them.
  const times = frames(0, 400);
  const mixed = createPreviewSampler([
    { timeMs: 0, action: 'patch', data: { pattern: 'chase', ...LOOK } },
    { timeMs: 0, action: 'voice', data: { id: 'p', effect: BLINDER, targets: [PARS[0].id], tier: 'voice', launchSeq: 1 } },
  ], GRID, { resolveEffect });
  const rig = rigRun(PARS, times, () => ({ pattern: 'chase', voices: [voice('p', BLINDER, { targets: [PARS[0].id] })] }));
  assertSame(rig, previewRun(mixed, PARS, times), times);
});

test('voice events are checked once: a bad one is ignored, not played', () => {
  const ok = { id: 'v', effect: BLINDER, targets: [PARS[0].id], tier: 'voice', launchSeq: 1 };
  const bad = [
    { ...ok, effect: { kind: 'no.such.kind', params: {} } },
    { ...ok, targets: [1.5] },
    { ...ok, targets: 'all' },
    { ...ok, tier: 'pad' },
    { ...ok, launchSeq: 1.5 },
    { ...ok, durationMs: 0 },
    { ...ok, durationMs: Infinity },
    { ...ok, seed: [1, 2, 3] },
    { ...ok, id: '' },
  ];
  for (const data of bad) {
    const out = createPreviewSampler([
      { timeMs: 0, action: 'patch', data: { pattern: 'solid', ...LOOK } },
      { timeMs: 0, action: 'voice', data },
    ], GRID, { resolveEffect })(100, PARS, COLOR_PRESETS);
    assert.strictEqual(out[0].w, 0, JSON.stringify(data));
  }
  const played = createPreviewSampler([
    { timeMs: 0, action: 'patch', data: { pattern: 'solid', ...LOOK } },
    { timeMs: 0, action: 'voice', data: { ...ok, seed: [1, 2, 3, 4], durationMs: 50 } },
  ], GRID, { resolveEffect });
  assert.strictEqual(played(25, PARS, COLOR_PRESETS)[0].w, 255);
  assert.strictEqual(played(50, PARS, COLOR_PRESETS)[0].w, 0, 'gone at its deadline');
});

test('a timeline out of order rehearses as the same timeline in order, and the caller\'s array is left as it was', () => {
  const ordered = [
    { timeMs: 0, action: 'patch', data: { pattern: 'ldj.FadeCycle', ...LOOK } },
    { timeMs: 200, action: 'voice', data: { id: 'p', effect: BLINDER, targets: [PARS[0].id], tier: 'voice', launchSeq: 1 } },
    { timeMs: 200, action: 'voice-end', data: { id: 'p' } },
    { timeMs: 400, action: 'patch', data: { colorA: 3 } },
  ];
  const shuffled = [ordered[3], ordered[1], ordered[0], ordered[2]];
  const copy = [...shuffled];
  const a = createPreviewSampler(ordered, GRID, { resolveEffect }), b = createPreviewSampler(shuffled, GRID, { resolveEffect });
  for (const t of frames(0, 600)) assert.deepStrictEqual(b(t, PARS, COLOR_PRESETS), a(t, PARS, COLOR_PRESETS), `${t}`);
  assert.deepStrictEqual(shuffled, copy);
  const legacy = [{ timeMs: 1000, action: 'patch', data: { colorA: 5 } }, { timeMs: 0, action: 'patch', data: { pattern: 'chase', ...LOOK } }];
  const inOrder = createPreviewSampler([legacy[1], legacy[0]]);
  const outOfOrder = createPreviewSampler(legacy);
  for (const t of [100, 900, 1100, 1700]) assert.deepStrictEqual(outOfOrder(t, PARS, COLOR_PRESETS), inOrder(t, PARS, COLOR_PRESETS));
});

test('a patch that sets no fade cuts one in progress, as the engine does', () => {
  const sample = createPreviewSampler([
    { timeMs: 0, action: 'patch', data: { pattern: 'solid', colorA: 0, bpm: 120, beatDivision: 1 } },
    { timeMs: 1000, action: 'patch', data: { colorA: 5, fadeMs: 1000 } },
    { timeMs: 1200, action: 'patch', data: { fadeMs: 0 } },
  ]);
  const [first] = sample(1250, [{ maxBrightness: 255 }], COLOR_PRESETS);
  assert.deepStrictEqual([first.r, first.g, first.b], [0, 85, 255]);
});
