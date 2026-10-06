// The pattern bundle: the internal kind a pattern pad's voice plays. Its
// clips render through the sequence's own helpers inside one parent voice.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { BUNDLE_KIND, bundleSpec } from '../../src/shared/effects/bundle.ts';
import { CATALOGUE, presetById } from '../../src/shared/effects/index.ts';
import { MAX_NEST_DEPTH, playingLeaves } from '../../src/shared/effects/nesting.ts';
import { registerKind, requiresAcknowledgement, validateSpec } from '../../src/shared/effects/registry.ts';
import { renderEffect } from '../../src/shared/effects/render.ts';
import { EffectStepper } from '../../src/shared/effects/stepper.ts';
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { buildRoom } from '../../src/shared/room.ts';
import { resolveDetectors } from '../../src/server/audio-features.ts';
import { EffectLibrary } from '../../src/server/effect-library.ts';
import { voiceSpec } from '../../src/server/voices.ts';
import { statusOf } from '../../src/errors.ts';

const paint = (kind, extra = {}) => registerKind({
  kind, app: 'own', schema: z.object({ r: z.number() }).strict(), defaults: { params: { r: 255 } }, ...extra,
  init: () => ({}),
  render: (p, _s, room, _f, out) => { for (let i = 0; i < room.n; i++) out[i] = { colour: { r: p.r, g: 0, b: 0 }, level: 1, strength: 1 }; },
});
paint('test.bundle.paint');
paint('test.bundle.rapid', { rapidFlash: true });
registerKind({ kind: 'test.bundle.clear', app: 'own', schema: z.object({}).strict(), defaults: { params: {} }, init: () => ({}), render: () => {} });

const SEED = seedFrom('bundle-test');
const room = buildRoom(3, (i) => i / 2, () => 0.5, () => 0.5, null);
const IDS = [10, 11, 12];
const lane = (id, kind = 'shared', fixtureId) => ({ id, kind, ...(fixtureId !== undefined ? { fixtureId } : {}), name: id, mute: false, solo: false });
const clip = (id, laneId, spec, startBeat, lengthBeats, fixtureIds = null) => ({
  id, laneId, fixtureIds, startBeat, lengthBeats, loopBeats: lengthBeats, spec: validateSpec(spec), seed: seedFrom(id), mute: false,
});
const paintSpec = (r) => ({ kind: 'test.bundle.paint', params: { r } });
// Red over the room for two beats, then 128 on fixture 11 only, then a transparent clip.
const TABLE = {
  revision: 0, lanes: [lane('shared:0')],
  clips: [clip('0:0', 'shared:0', paintSpec(255), 0, 2), clip('0:1', 'shared:0', paintSpec(128), 2, 1, [11]), clip('0:2', 'shared:0', { kind: 'test.bundle.clear' }, 3, 1)],
};
const bundle = (once = false, table = TABLE) => bundleSpec({ patternId: 'p1', lengthBeats: 4, table }, once);
const frame = (beatPos, over = {}) => ({ beatPos, bpm: 120, nowMs: beatPos * 500, dtMs: 0, anchorBeat: 0, lookPalette: [], paletteOverride: null,
  audio: null, audioMode: 'off', master: HD_MASTER_DEFAULTS, seed: SEED, acknowledged: true, hueStrobe: 'flash', fixtureIds: IDS, ...over });
const draw = (spec, beats, over) => {
  const stepper = new EffectStepper();
  const inst = { id: 'pad:1', spec: validateSpec(spec, { internal: true }), seed: SEED, anchorBeat: 0, startedAtMs: 0, targets: null };
  return beats.map((b) => { const out = []; renderEffect(inst, frame(b, over), room, stepper, out); return out; });
};
const reds = (out) => [0, 1, 2].map((i) => (out[i]?.strength > 0 ? out[i].colour.r * out[i].level : null));

test('the bundle kind is internal: no catalogue row, no preset, refused by validation, a hand-posted voice and a saved preset', () => {
  assert.equal(CATALOGUE.some((row) => row.spec?.kind === BUNDLE_KIND), false);
  assert.equal(presetById(BUNDLE_KIND), null);
  const raw = { kind: BUNDLE_KIND, params: { patternId: 'p1', lengthBeats: 4, table: TABLE, once: false } };
  assert.throws(() => validateSpec(raw), /unknown effect kind/);
  assert.equal(validateSpec(raw, { internal: true }).kind, BUNDLE_KIND);
  // A copy of a minted spec is still a hand post.
  assert.throws(() => voiceSpec(structuredClone(bundle())), (err) => statusOf(err) === 400);
  assert.equal(voiceSpec(bundle()).kind, BUNDLE_KIND);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-library-'));
  try {
    const library = new EffectLibrary(path.join(dir, 'effects.json')).load();
    assert.throws(() => library.create({ name: 'Bundle', spec: raw }), (err) => statusOf(err) === 400);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('clips play by the sequence rules: winners per fixture, uncovered cells transparent, a transparent winner owns its cells black', () => {
  const [a, b, c] = draw(bundle(), [1, 2.5, 3.5]);
  assert.deepEqual(reds(a), [255, 255, 255]);
  assert.deepEqual(reds(b), [null, 128, null]);
  assert.deepEqual(c.map((s) => [s.strength, s.level]), [[1, 0], [1, 0], [1, 0]]);
  assert.equal(a[0].kind, 'test.bundle.paint');
});

test('hold and loop repeat at the bundle length; once plays its length and no lap after it', () => {
  const [, loopNext] = draw(bundle(false), [1, 5]);
  assert.deepEqual(reds(loopNext), [255, 255, 255]);
  const [first, after] = draw(bundle(true), [1, 5]);
  assert.deepEqual(reds(first), [255, 255, 255]);
  assert.deepEqual(reds(after), [null, null, null]);
});

test('a rapid child makes the bundle rapid: it needs the acknowledgement and draws nothing without it', () => {
  const table = { ...TABLE, clips: [...TABLE.clips, clip('1:0', 'shared:0', { kind: 'test.bundle.rapid', params: { r: 9 } }, 0, 4)] };
  const spec = bundle(false, table);
  assert.equal(requiresAcknowledgement(spec), true);
  assert.equal(requiresAcknowledgement(bundle()), false);
  assert.deepEqual(reds(draw(spec, [1], { acknowledged: false })[0]), [null, null, null]);
});

test('the strobe is never a clip: validation refuses a strobe child and rendering skips an unvalidated one', () => {
  const strobe = { kind: 'strobe', params: { clock: 'beat', flashesPerSecond: 5 } };
  const raw = (s) => ({ kind: BUNDLE_KIND, params: { patternId: 'p', lengthBeats: 4, once: false,
    table: { revision: 0, lanes: [lane('shared:0')], clips: [{ ...clip('0:0', 'shared:0', paintSpec(1), 0, 4), spec: s }] } } });
  assert.throws(() => validateSpec(raw(validateSpec(strobe)), { internal: true }), /may not hold the strobe/);
  const forged = { ...validateSpec(raw(validateSpec(paintSpec(1))), { internal: true }) };
  forged.params = { ...forged.params, table: { ...forged.params.table, clips: [{ ...forged.params.table.clips[0], spec: validateSpec(strobe) }] } };
  const stepper = new EffectStepper(), out = [];
  renderEffect({ id: 'v', spec: forged, seed: SEED, anchorBeat: 0, startedAtMs: 0, targets: null }, frame(0.1), room, stepper, out);
  assert.deepEqual(reds(out), [null, null, null]);
});

test('macros and bundles share one nesting limit and one cycle check', () => {
  let inner = paintSpec(1);
  for (let k = 0; k < MAX_NEST_DEPTH - 1; k++) inner = { kind: 'macro', params: { steps: [{ effect: inner, beats: 4 }], loopBeats: 4 } };
  const wrap = (spec) => ({ kind: BUNDLE_KIND, params: { patternId: 'p', lengthBeats: 4, once: false,
    table: { revision: 0, lanes: [lane('shared:0')], clips: [{ ...clip('0:0', 'shared:0', paintSpec(1), 0, 4), spec }] } } });
  assert.doesNotThrow(() => validateSpec(wrap(inner), { internal: true }));
  const deeper = { kind: 'macro', params: { steps: [{ effect: inner, beats: 4 }], loopBeats: 4 } };
  assert.throws(() => validateSpec(wrap(deeper), { internal: true }), /nest at most 32 deep/);
  const cyclic = wrap(paintSpec(1));
  cyclic.params.table.clips[0].spec = cyclic;
  assert.throws(() => validateSpec(cyclic, { internal: true }), /may not contain itself/);
  // Asked about an unvalidated cycle, the acknowledgement assumes the worst.
  assert.equal(requiresAcknowledgement(cyclic), true);
});

test('the detector owner is looked up the same way for a bundle as for a macro: the container owns it while its child plays', () => {
  const disco = validateSpec({ kind: 'hd.disco' });
  const table = { revision: 0, lanes: [lane('shared:0')], clips: [{ ...clip('0:0', 'shared:0', paintSpec(1), 0, 4), spec: disco }] };
  const macro = validateSpec({ kind: 'macro', params: { steps: [{ effect: disco, beats: 4 }], loopBeats: 4 } });
  const owner = (spec) => resolveDetectors({ base: { id: 'look', spec: disco }, voices: [{ id: 'pad:1', spec, targets: null, tier: 'voice', launchSeq: 1, startedAtMs: 0, untilMs: null, anchorBeat: 0 }],
    nowMs: 10, beatPos: 1, fixtureIds: IDS, ldjTrigger: 0.5, acknowledged: true }).disco.owner;
  assert.deepEqual(owner(voiceSpec(bundle(false, table))), owner(macro));
  assert.deepEqual(owner(macro), { from: 'voice', id: 'pad:1', kind: 'hd.disco' });
});

test('the playing leaves change on the frame the bundle\'s rendered clip changes, highest lane first, a macro clip to its step', () => {
  const inner = validateSpec({ kind: 'macro', params: { steps: [{ effect: paintSpec(7), beats: 0.3 }, { effect: paintSpec(9), beats: 0.4 }], loopBeats: 0.7 } });
  const table = { revision: 0, lanes: [lane('shared:0'), lane('shared:1')],
    clips: [clip('a', 'shared:0', paintSpec(255), 0, 4), clip('b', 'shared:1', paintSpec(128), 1.5, 1, [11]), clip('c', 'shared:1', inner, 2.5, 1.1)] };
  const spec = bundle(false, table);
  const beats = [0, 1.5 - 1e-12, 1.5, 2.5 - 1e-12, 2.5, 2.8, 3.1, 3.6 - 1e-12, 3.6, 4, 5.5, 6.8, 40.1];
  draw(spec, beats).forEach((out, k) => {
    const leaves = playingLeaves(spec, beats[k], 0, IDS);
    // Fixture 11 shows the highest clip covering anything.
    assert.deepEqual(leaves[0].params.r, reds(out)[1], `beat ${beats[k]}`);
    assert.deepEqual(leaves.map((s) => s.kind), Array(leaves.length).fill('test.bundle.paint'));
  });
  assert.deepEqual(playingLeaves(spec, 2, 0, IDS).map((s) => s.params.r), [128, 255], 'every clip showing on a lamp, the highest lane first');
  assert.deepEqual(playingLeaves(bundle(true, table), 4, 0, IDS), [], 'once stops at the length');
  // Too deep to render is too deep to own: past the limit nothing plays.
  let deep = paintSpec(1);
  for (let i = 0; i <= MAX_NEST_DEPTH; i++) deep = { kind: 'macro', params: { steps: [{ effect: deep, beats: 1 }], loopBeats: 1 } };
  assert.deepEqual(playingLeaves(deep, 0.5, 0, IDS), []);
});
