// Every built-in preset rehearses as the rig plays it: as the base look and
// as a voice over two lights, with Hue lamps taking flashes either way, the
// renderer and the preview stepped through the same frames. Going back and a
// moment between two frames land on the same bytes too.

import test from 'node:test';
import assert from 'node:assert';

import { createRenderer } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile, profilesRevision, registerProfile, BUILTIN_PROFILE_ID } from '../../src/server/profiles.ts';
import { HUE_COLOR } from './hue-test-lamps.js';
import { COLOR_PRESETS } from '../../src/server/presets.ts';
import { FRAME_MS } from '../../src/server/frame-clock.ts';
import { CATALOGUE } from '../../src/shared/effects/index.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { beatPositionAt, localBpm, makeGrid } from '../../src/shared/beat-clock.ts';

// A Hue lamp's profile is built from its bridge; this one is laid out as the
// generic colour lamp the expectations were taken with.
registerProfile(HUE_COLOR);

const fixture = (id, address, profileId = BUILTIN_PROFILE_ID, extra = {}) => ({
  id, address, universe: 0, profileId, maxBrightness: 255, override: null,
  position: null, group: null, geometry: null, ...extra,
});
const PARS = [fixture(10, 1), fixture(11, 13), fixture(12, 25), fixture(13, 37)];
const LAMP = fixture(14, 60, HUE_COLOR.id, { output: { protocol: 'hue', bridge: 'b1', channels: [1] } });
const RIG = [...PARS, LAMP];
const LOOK = { colorA: 0, colorB: 5, colorC: 3, colorD: 8, bpm: 120, beatDivision: 1 };
const BEATS = Array.from({ length: 41 }, (_, i) => i * 0.5);
const GRID = { beats: BEATS };
const beatGrid = makeGrid(BEATS);
const beat = (ms) => beatPositionAt(beatGrid, ms);
// The catalogue is rehearsed as an acknowledged room would see it.
const ACK = { hdFlashIntervalMs: 350, acknowledged: true };

const ROWS = CATALOGUE.filter((row) => !row.legacy);
const resolveEffect = (id) => ROWS.find((row) => row.id === id)?.spec ?? null;

const frames = (to) => Array.from({ length: Math.floor(to / FRAME_MS + 1e-9) + 1 }, (_, k) => k * FRAME_MS);

const EMITTER_KEYS = { red: 'r', green: 'g', blue: 'b', white: 'w', coolWhite: 'w', amber: 'a', warmWhite: 'a', uv: 'uv' };
const BASE_INPUT = {
  running: true, pattern: 'solid', ...LOOK, split: null, pixelMap: 'stage', strobeSpeed: 0, strobeFunction: 'standard',
  masterDimmer: 255, masterBlackout: false, energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null,
  universes: [0], fixtures: RIG, safety: ACK,
};

/** The rig's emitters per light at each of `times`, `at(t)` giving that frame's input fields. */
function rigRun(times, at) {
  const store = universes.createUniverseStore(universes.allocateShared());
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: times[0] });
  const { bpm: _bpm, ...input } = BASE_INPUT;
  return times.map((t) => {
    renderer.frame({ ...input, ...at(t) }, { beatPos: beat(t), bpm: localBpm(beatGrid, t), epoch: 0 }, t, store, 0);
    const dmx = store.getBuffer(0);
    return RIG.map((f) => {
      const ch = getProfile(f).channelMap;
      return Object.fromEntries(Object.entries(EMITTER_KEYS).filter(([name]) => ch[name] !== undefined).map(([name, k]) => [k, dmx[f.address - 1 + ch[name]]]));
    });
  });
}

/** The first difference between the rig's lights and the preview's, or null. */
function differs(rig, preview, times) {
  for (let i = 0; i < rig.length; i++) {
    for (let u = 0; u < rig[i].length; u++) {
      for (const [k, v] of Object.entries(rig[i][u])) {
        if (preview[i][u][k] !== v) return `light ${u} ${k} at ${times[i].toFixed(3)} ms: rig ${v}, preview ${preview[i][u][k]}`;
      }
    }
  }
  return null;
}

test("catalogue previews match rig output in each Hue strobe mode", () => {
  assert.ok(ROWS.length > 150, `${ROWS.length} presets`);
  const r = buildRig(RIG, getProfile);
  const times = frames(1200);
  const tail = [...frames(707), 707];
  const failures = [];
  ROWS.forEach((row, n) => {
    const hueStrobe = n % 2 ? 'pulse' : 'flash';
    const options = { resolveEffect, hueStrobe, safety: ACK };
    // The base look, every frame for 1.2 s.
    const events = [{ timeMs: 0, action: 'patch', data: { pattern: row.id, ...LOOK } }];
    const sample = createPreviewSampler(events, GRID, options);
    const base = differs(rigRun(times, () => ({ pattern: row.id, effect: row.spec, hueStrobe })),
      times.map((t) => sample(t, RIG, COLOR_PRESETS, r)), times);
    if (base) failures.push(`${row.id} base ${hueStrobe}: ${base}`);
    // Back to a moment between two frames: the rig's frames up to it, then that moment.
    const back = differs(rigRun(tail, () => ({ pattern: row.id, effect: row.spec, hueStrobe })).slice(-1),
      [sample(707, RIG, COLOR_PRESETS, r)], [707]);
    if (back) failures.push(`${row.id} back to 707 ms ${hueStrobe}: ${back}`);
    // A voice launched off the grid on a par and the Hue lamp, over the look, in the other Hue mode.
    const other = n % 2 ? 'flash' : 'pulse';
    const pad = { id: 'pad:x', effect: row.spec, targets: [PARS[1].id, LAMP.id], tier: 'voice', launchSeq: 1 };
    const voiced = createPreviewSampler([
      { timeMs: 0, action: 'patch', data: { pattern: 'solid', ...LOOK } },
      { timeMs: 130, action: 'voice', data: pad },
    ], GRID, { ...options, hueStrobe: other });
    const voice = differs(rigRun(times, (t) => ({ hueStrobe: other, voices: t >= 130 ? [{ id: 'pad:x', spec: row.spec, targets: pad.targets,
      tier: 'voice', launchSeq: 1, startedAtMs: 130, untilMs: null, anchorBeat: beat(130), seed: seedFrom('pad:x') }] : [] })),
    times.map((t) => voiced(t, RIG, COLOR_PRESETS, r)), times);
    if (voice) failures.push(`${row.id} voice ${other}: ${voice}`);
  });
  assert.deepStrictEqual(failures, []);
});

// The palette over every effect (PUT /api/palette-override) is the live
// state's, as the Hue strobe mode and the safety are: a rehearsal under it
// plays every preset in those colours, as the rig does.
test("catalogue previews match rig output under palette overrides", () => {
  const r = buildRig(RIG, getProfile);
  const times = frames(600);
  const hex = ['#FF0000', '#00FF0080'];
  const paletteOverride = [{ r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0 }, { r: 0, g: 255, b: 0, w: 128, a: 0, uv: 0 }];
  const failures = [];
  let differsFromOwn = 0;
  ROWS.forEach((row, n) => {
    const hueStrobe = n % 2 ? 'pulse' : 'flash';
    const options = { resolveEffect, hueStrobe, safety: ACK, paletteOverride: hex };
    const sample = createPreviewSampler([{ timeMs: 0, action: 'patch', data: { pattern: row.id, ...LOOK } }], GRID, options);
    const rig = rigRun(times, () => ({ pattern: row.id, effect: row.spec, hueStrobe, paletteOverride }));
    const base = differs(rig, times.map((t) => sample(t, RIG, COLOR_PRESETS, r)), times);
    if (base) failures.push(`${row.id} base: ${base}`);
    if (differs(rig, rigRun(times, () => ({ pattern: row.id, effect: row.spec, hueStrobe })), times)) differsFromOwn++;
    const pad = { id: 'pad:x', effect: row.spec, targets: [PARS[1].id, LAMP.id], tier: 'voice', launchSeq: 1 };
    const voiced = createPreviewSampler([
      { timeMs: 0, action: 'patch', data: { pattern: 'solid', ...LOOK } },
      { timeMs: 130, action: 'voice', data: pad },
    ], GRID, options);
    const voice = differs(rigRun(times, (t) => ({ hueStrobe, paletteOverride, voices: t >= 130 ? [{ id: 'pad:x', spec: row.spec, targets: pad.targets,
      tier: 'voice', launchSeq: 1, startedAtMs: 130, untilMs: null, anchorBeat: beat(130), seed: seedFrom('pad:x') }] : [] })),
    times.map((t) => voiced(t, RIG, COLOR_PRESETS, r)), times);
    if (voice) failures.push(`${row.id} voice: ${voice}`);
  });
  assert.deepStrictEqual(failures, []);
  assert.ok(differsFromOwn > ROWS.length / 2, `the override recolours most presets (${differsFromOwn} of ${ROWS.length})`);
});

test("invalid preview palette overrides preserve effect colours", () => {
  const r = buildRig(RIG, getProfile);
  const row = ROWS.find((p) => p.id === 'ldj.FadeCycle');
  const events = [{ timeMs: 0, action: 'patch', data: { pattern: row.id, ...LOOK } }];
  const own = createPreviewSampler(events, GRID, { resolveEffect, safety: ACK });
  const times = frames(600);
  const expected = times.map((t) => own(t, RIG, COLOR_PRESETS, r));
  for (const paletteOverride of [null, [], ['red'], [{ random: true }], '#FF0000']) {
    const sample = createPreviewSampler(events, GRID, { resolveEffect, safety: ACK, paletteOverride });
    assert.deepStrictEqual(times.map((t) => sample(t, RIG, COLOR_PRESETS, r)), expected, JSON.stringify(paletteOverride));
  }
  const red = createPreviewSampler(events, GRID, { resolveEffect, safety: ACK, paletteOverride: ['#FF0000'] });
  assert.notDeepStrictEqual(times.map((t) => red(t, RIG, COLOR_PRESETS, r)), expected, 'a real one recolours it');
});
