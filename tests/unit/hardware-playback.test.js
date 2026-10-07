import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { hardwareOf } from '../../src/shared/hardware.ts';
import { HardwareGuard } from '../../src/shared/hardware-guard.ts';
import { registerKind, validateSpec } from '../../src/shared/effects/registry.ts';
import { renderEffect } from '../../src/shared/effects/render.ts';
import { EffectStepper } from '../../src/shared/effects/stepper.ts';
import { renderVoices } from '../../src/shared/effects/layer.ts';
import { newSequenceRun, renderPlaced } from '../../src/shared/effects/sequence.ts';
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { buildRoom } from '../../src/shared/room.ts';
import { buildRig } from '../../src/shared/rig.ts';

const WHITE = { r: 255, g: 255, b: 255 };
const SEED = seedFrom('hardware');
const caps = (maxFlashHz, admission = 'max') => hardwareOf({ hardware: { maxFlashHz, minTransitionMs: 0 }, admission });
const frame = (nowMs, hardware, more = {}) => ({ nowMs, beatPos: nowMs / 500, dtMs: 25, bpm: 120, anchorBeat: 0,
  lookPalette: [WHITE], paletteOverride: null, audio: null, audioMode: 'tempo', master: HD_MASTER_DEFAULTS,
  seed: SEED, acknowledged: true, hueStrobe: 'flash', hardware, ...more });
registerKind({ kind: 'test.hardware', app: 'own', schema: z.object({ cadence: z.number() }), defaults: { params: { cadence: .125 } },
  init: () => ({ frames: 0 }), render(p, state, room, f, out) {
    state.frames++;
    for (let k = 0; k < room.n; k++) out[k] = { colour: { r: f.nowMs, g: f.beatPos, b: k }, level: .5, strength: 1 };
  } });
const spec = validateSpec({ kind: 'test.hardware' });
const instance = (over = {}) => ({ id: 'test', spec, seed: SEED, anchorBeat: 0, startedAtMs: 0, targets: null, ...over });
const room = buildRoom(3, (i) => i / 2, () => .5, () => .5, null);
const render = (stepper, t, hardware, inst = instance()) => {
  const out = new Array(3);
  renderEffect(inst, frame(t, hardware), room, stepper, out);
  return out;
};

test('mixed rates slow time without changing room slots or target masks', () => {
  const stepper = new EffectStepper(), hardware = [caps(20), caps(4), caps(2)];
  render(stepper, 0, hardware);
  const out = render(stepper, 1000, hardware, instance({ targets: [0, 1] }));
  assert.deepEqual(out.slice(0, 2).map((s) => s.colour), [{ r: 1000, g: 2, b: 0 }, { r: 250, g: .5, b: 1 }]);
  assert.equal(out[2], undefined);
});

test('supported fixtures share one render despite different rate limits', () => {
  const stepper = new EffectStepper();
  render(stepper, 100, [caps(20), caps(30), caps(40)]);
  assert.equal(stepper.values('test').reduce((sum, state) => sum + state.frames, 0), 1);
});

test('clock rebases reset slowed musical phases while retaining wall state', () => {
  const stepper = new EffectStepper(), hardware = [caps(4), caps(4), caps(4)];
  render(stepper, 0, hardware);
  render(stepper, 1000, hardware);
  const out = [];
  renderEffect(instance({ anchorBeat: 20 }), frame(1025, hardware, { beatPos: 20 }), room, stepper, out);
  assert.equal(out[0].colour.g, 20);
  assert.equal(out[0].colour.r, 256.25);
  assert.equal(stepper.values('test')[0].frames, 3);
});

test('hold captures one value and exclude remains transparent', () => {
  const hardware = [caps(4, 'hold'), caps(4, 'exclude'), caps(20)];
  const stepper = new EffectStepper();
  const first = render(stepper, 100, hardware);
  const next = render(stepper, 1000, hardware);
  assert.deepEqual(next[0], first[0]);
  assert.equal(next[1].excluded, true);
  assert.equal(next[1].strength, 0);
  assert.notDeepEqual(next[2], first[2]);
});

test('hardware histories clone independently and expire with their instance', () => {
  const hardware = [caps(4), caps(4), caps(4)], original = new EffectStepper();
  render(original, 0, hardware);
  render(original, 100, hardware);
  const copy = original.clone();
  assert.deepEqual(render(original, 200, hardware), render(copy, 200, hardware));
  render(copy, 300, hardware);
  assert.equal(original.values('test')[0].frames, 3);
  assert.equal(copy.values('test')[0].frames, 4);
  original.sweep(2300);
  assert.equal(original.seenAt('test'), null);
});

test('excluded voices let a slower supported voice win', () => {
  const fixtures = [{ id: 10 }, { id: 20 }, { id: 30 }], rig = buildRig(fixtures, () => null), layout = rig.layout();
  const voices = [
    { ...instance(), spec: { ...spec, admission: 'exclude' }, launchSeq: 2, tier: 'voice' },
    { ...instance({ id: 'lower' }), spec: { ...spec, params: { cadence: 4 } }, launchSeq: 1, tier: 'voice' },
  ];
  const out = renderVoices(rig, layout, frame(500, [caps(4), caps(20), caps(4)], { fixtureIds: [10, 20, 30] }), voices, new EffectStepper());
  assert.ok(out.every((s) => s && s.level === .5));
  assert.equal(out[0].colour.r, 500);
});

test('excluded top clips allow the lower clip to win before rendering', () => {
  const table = { revision: 1, lanes: [0, 1].map((i) => ({ id: `l${i}`, kind: 'shared', name: `L${i}`, mute: false, solo: false })),
    clips: [0, 1].map((i) => ({ id: `c${i}`, laneId: `l${i}`, fixtureIds: null, startBeat: 0, lengthBeats: 8, loopBeats: 8, seed: SEED, mute: false,
      spec: { ...spec, admission: i ? 'exclude' : 'max', params: { cadence: i ? .125 : 4 } } })) };
  const out = [];
  renderPlaced(frame(500, [caps(4), caps(4), caps(4)]), table, { startBeat: 0, loop: null, generation: 0 }, newSequenceRun(), new EffectStepper(), room,
    [10, 20, 30], (k, slot) => { out[k] = slot; });
  assert.equal(out.length, 3);
  assert.ok(out.every((s) => s.colour.r === 500));
});

test('output flash permits survive blackouts and rapid owner changes', () => {
  const guard = new HardwareGuard(), limits = { maxFlashHz: 2, minTransitionMs: 0 };
  assert.equal(guard.apply('lamp', 1, 0, limits), 1);
  guard.blackout();
  assert.equal(guard.apply('lamp', 1, 100, limits), 0);
  assert.equal(guard.apply('lamp', 1, 499, limits), 0);
  assert.equal(guard.apply('lamp', 1, 500, limits), 1);
  assert.equal(guard.apply('other', 1, 100, limits), 1);
});

test('transition limits bound movement and cloned histories retain it', () => {
  const guard = new HardwareGuard(), limits = { maxFlashHz: 20, minTransitionMs: 200 };
  guard.apply('lamp', 0, 0, limits);
  assert.equal(guard.apply('lamp', 1, 50, limits), .25);
  assert.equal(guard.clone().apply('lamp', 1, 100, limits), .5);
  assert.equal(guard.apply('lamp', 0, 100, limits), 0);
});

test('ordinary off frames retain colour through their falling transition', () => {
  const guard = new HardwareGuard(), limits = { maxFlashHz: 20, minTransitionMs: 200 };
  const black = { r: 0, g: 0, b: 0 };
  guard.light('lamp', WHITE, 255, 0, limits, 'owner');
  guard.light('lamp', WHITE, 255, 200, limits, 'owner');
  const light = guard.light('lamp', black, 0, 225, limits, 'owner');
  assert.deepEqual(light, { colour: WHITE, dim: 255 * .875 });
  assert.equal(guard.clone().light('lamp', black, 0, 400, limits, 'owner').dim, 0);
});

test('owner changes discard the previous light instead of reviving its tail', () => {
  const limits = { maxFlashHz: 20, minTransitionMs: 200 };
  for (const dim of [0, 25.5]) {
    const guard = new HardwareGuard();
    guard.light('lamp', WHITE, 255, 0, limits, 'voice');
    guard.light('lamp', WHITE, 255, 200, limits, 'voice');
    assert.equal(guard.light('lamp', WHITE, dim, 225, limits, 'base').dim, dim);
  }
});

test('explicit blackout cuts immediately without clearing the flash permit', () => {
  const guard = new HardwareGuard(), limits = { maxFlashHz: 2, minTransitionMs: 200 };
  guard.light('lamp', WHITE, 255, 0, limits, 'owner');
  guard.light('lamp', WHITE, 255, 200, limits, 'owner');
  assert.equal(guard.light('lamp', WHITE, 255, 225, limits, 'owner', true).dim, 0);
  assert.equal(guard.light('lamp', WHITE, 255, 250, limits, 'owner').dim, 0);
});

test('a substep native frequency uses a positive software strobe', async () => {
  const { hardwareStrobe } = await import('../../src/shared/hardware-strobe.ts');
  const profile = { ...caps(.1), strobeHz: { min: 0, max: 30 } };
  assert.deepEqual(hardwareStrobe(255, profile, 0), { raw: null, level: 1, previewLevel: 1 });
  assert.deepEqual(hardwareStrobe(255, profile, 5001), { raw: null, level: 0, previewLevel: 0 });
});

test('RGB-only output approximates missing white, amber and UV dies', async () => {
  const { fitEmitters } = await import('../../src/shared/emitter-capability.ts');
  const rgb = { red: 0, green: 1, blue: 2 }, black = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
  for (const die of ['w', 'a', 'uv']) {
    const out = fitEmitters({ ...black, [die]: 255 }, rgb);
    assert.ok(out.r + out.g + out.b > 0, die);
    assert.equal(out[die], 0);
  }
  const native = { ...rgb, white: 3, amber: 4, uv: 5 }, colour = { r: 20, g: 30, b: 40, w: 100, a: 100, uv: 100 };
  assert.deepEqual(fitEmitters(colour, native), colour);
});

test('legacy strobe adapts Hue and honours product hardware frequencies', async () => {
  const { hardwareStrobe } = await import('../../src/shared/hardware-strobe.ts');
  const hue = hardwareOf({ hue: true, hardware: { maxFlashHz: 2 } });
  assert.equal(hardwareStrobe(255, hue, 0).level, 1);
  assert.equal(hardwareStrobe(255, hue, 300).level, 0);
  assert.equal(hardwareStrobe(255, hue, 500).level, 1);
  assert.equal(hardwareStrobe(255, { ...hue, policy: 'hold' }, 300).level, 1);
  assert.equal(hardwareStrobe(255, { ...hue, policy: 'exclude' }, 0).level, 0);
  const par = { ...hue, strobeHz: { min: 2, max: 12 }, maxFlashHz: 4, minTransitionMs: 0 };
  assert.equal(hardwareStrobe(255, par, 0).raw, 51);
});

test('final DMX quantization stays at the greatest rate below the cap', async () => {
  const { hardwareStrobe } = await import('../../src/shared/hardware-strobe.ts');
  const profile = { ...caps(20), strobeHz: { min: 2, max: 16 } };
  const planned = hardwareStrobe(26, profile, 0, 3);
  const step = Math.round(planned.raw / 255 * 122);
  assert.ok(2 + step / 122 * 14 <= 3);
  assert.ok(2 + (step + 1) / 122 * 14 > 3);
});

test('native speeds below the hardware cap preserve their rounded DMX bytes', async () => {
  const { hardwareStrobe } = await import('../../src/shared/hardware-strobe.ts');
  const profile = { ...caps(20), strobeHz: { min: 1, max: 20 } };
  for (const raw of [1, 51, 128, 200, 255]) assert.equal(hardwareStrobe(raw, profile, 0).raw, raw);
});

test('native strobe previews use the actual capped DMX frequency', async () => {
  const { hardwareStrobe } = await import('../../src/shared/hardware-strobe.ts');
  const profile = { ...caps(3), strobeHz: { min: 2, max: 16 } };
  const first = hardwareStrobe(255, profile, 0);
  const hz = 2 + Math.round(first.raw / 255 * 122) / 122 * 14;
  assert.ok(hz <= 3);
  assert.equal(hardwareStrobe(255, profile, 600 / hz).previewLevel, 0);
  assert.equal(hardwareStrobe(255, profile, 1100 / hz).previewLevel, 1);
  assert.equal(hardwareStrobe(255, profile, 600 / hz).level, 1);
});

test('colour blackouts cannot bypass the output flash history', () => {
  const guard = new HardwareGuard(), limits = { maxFlashHz: 2, minTransitionMs: 0 };
  const black = { r: 0, g: 0, b: 0 };
  assert.equal(guard.light('lamp', WHITE, 255, 0, limits, 'owner').dim, 255);
  assert.equal(guard.light('lamp', black, 255, 50, limits, 'owner').dim, 0);
  assert.equal(guard.light('lamp', WHITE, 255, 100, limits, 'owner').dim, 0);
  assert.equal(guard.light('lamp', WHITE, 255, 500, limits, 'owner').dim, 255);
});

test('an excluded macro child stays transparent to lower voices', () => {
  const fixtures = [{ id: 10 }, { id: 20 }, { id: 30 }], rig = buildRig(fixtures, () => null);
  const macro = validateSpec({ kind: 'macro', admission: 'exclude', params: { loopBeats: 4, steps: [{ beats: 4, effect: spec }] } });
  const voices = [
    { ...instance(), spec: macro, launchSeq: 2, tier: 'voice' },
    { ...instance({ id: 'lower' }), spec: { ...spec, params: { cadence: 4 } }, launchSeq: 1, tier: 'voice' },
  ];
  const out = renderVoices(rig, rig.layout(), frame(500, [caps(4), caps(4), caps(4)], { fixtureIds: [10, 20, 30] }), voices, new EffectStepper());
  assert.ok(out.every((s) => s?.colour.r === 500));
});

test('RGB fallback preserves master and trim scaling', async () => {
  const { outputEmitters } = await import('../../src/shared/emitter-capability.ts');
  const colour = { r: 200, g: 150, b: 0, w: 0, a: 255, uv: 0 }, map = { red: 0, green: 1, blue: 2 };
  const full = outputEmitters(colour, 1, map), half = outputEmitters(colour, .5, map);
  for (const ch of ['r', 'g', 'b']) assert.equal(half[ch], Math.round(full[ch] / 2));
});

test('excluded macro clips reveal the lower sequence lane', () => {
  const fast = validateSpec({ kind: 'macro', params: { loopBeats: 4, steps: [{ beats: 4, effect: { ...spec, admission: 'exclude' } }] } });
  const table = { revision: 1, lanes: [0, 1].map((i) => ({ id: `l${i}`, kind: 'shared', name: `L${i}`, mute: false, solo: false })),
    clips: [0, 1].map((i) => ({ id: `c${i}`, laneId: `l${i}`, fixtureIds: null, startBeat: 0, lengthBeats: 8, loopBeats: 8, seed: SEED, mute: false,
      spec: i ? fast : { ...spec, params: { cadence: 4 } } })) };
  const out = [];
  renderPlaced(frame(500, [caps(4), caps(4), caps(4)]), table, { startBeat: 0, loop: null, generation: 0 }, newSequenceRun(), new EffectStepper(), room,
    [10, 20, 30], (k, slot) => { out[k] = slot; });
  assert.equal(out.length, 3);
  assert.ok(out.every((s) => s?.colour.r === 500));
});

test('held macro clips admit against their advancing local phase', () => {
  const slow = { ...spec, params: { cadence: 4 } };
  const macro = validateSpec({ kind: 'macro', params: { loopBeats: 2, steps: [
    { beats: 1, effect: slow }, { beats: 1, effect: { ...spec, admission: 'exclude' } },
  ] } });
  const table = { revision: 1, lanes: [0, 1].map((i) => ({ id: `l${i}`, kind: 'shared', name: `L${i}`, mute: false, solo: false })),
    clips: [0, 1].map((i) => ({ id: `c${i}`, laneId: `l${i}`, fixtureIds: null, startBeat: 0, lengthBeats: 8, loopBeats: 8,
      seed: SEED, mute: false, spec: i ? macro : slow })) };
  const transport = { startBeat: 0, loop: null, generation: 0, hold: { position: 0, traversal: 0, beat: 0 } };
  for (const t of [750, 4750]) {
    const out = [];
    renderPlaced(frame(t, [caps(4), caps(4), caps(4)]), table, transport, newSequenceRun(), new EffectStepper(), room,
      [10, 20, 30], (k, slot) => { out[k] = slot; });
    assert.ok(out.every((slot) => slot?.colour.r === t));
  }
});
