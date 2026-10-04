// tests/unit/effects-render.test.js
import test from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import { registerKind, validateSpec, kindOf, KINDS, specWithDefaults } from '../../src/shared/effects/registry.ts';
import { renderEffect, compositeVoices, slotToWrite } from '../../src/shared/effects/render.ts';
import { EffectStepper } from '../../src/shared/effects/stepper.ts';
import { EventAdmission } from '../../src/shared/effects/envelope.ts';
import { parseHex, preparePalette, resolvePalette } from '../../src/shared/effects/palette.ts';
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';
import { buildRoom } from '../../src/shared/room.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';

const WHITE = { r: 255, g: 255, b: 255, w: 0, a: 0, uv: 0 };
const frame = (over = {}) => ({ beatPos: 0, bpm: 120, nowMs: 0, dtMs: 22.7, anchorBeat: 0, lookPalette: [WHITE], paletteOverride: null,
  audio: null, audioMode: 'tempo', master: HD_MASTER_DEFAULTS, seed: seedFrom('t'), acknowledged: true, hueStrobe: 'pulse', ...over });
const blank = (n) => Array.from({ length: n }, () => ({ colour: WHITE, level: 0, strength: 0 }));

test.before(() => {
  registerKind({ kind: 'test.half', app: 'own', schema: z.object({ level: z.number().min(0).max(1) }), defaults: { params: { level: 0.5 }, brightness: 0.8 },
    init: () => ({ frames: 0 }), render: (p, s, room, f, out) => { s.frames++; for (let i = 0; i < room.n; i++) out[i] = { colour: f.palette[0], level: p.level, strength: 1 }; } });
  registerKind({ kind: 'test.rapid', app: 'own', schema: z.object({}), defaults: { params: {} }, rapidFlash: true,
    init: () => ({}), render: (p, s, room, f, out) => { for (let i = 0; i < room.n; i++) out[i] = { colour: f.palette[0], level: 1, strength: 1 }; } });
});

test('validateSpec fills the kind\'s defaults (params and brightness) and rejects unknown kinds and bad palettes', () => {
  const spec = validateSpec({ kind: 'test.half' });
  assert.deepStrictEqual(spec.params, { level: 0.5 });
  assert.strictEqual(spec.brightness, 0.8);
  assert.throws(() => validateSpec({ kind: 'nope' }));
  assert.throws(() => validateSpec({ kind: 'test.half', palette: ['red'] }));
  assert.strictEqual(validateSpec({ kind: 'test.half', palette: ['#FF0000'] }).palette[0], '#FF0000');
});

test('renderEffect writes every slot at level × brightness and keeps state per instance', () => {
  const room = buildRoom(3, (i) => i / 2, () => 0.5, () => 0.5, null);
  const stepper = new EffectStepper();
  const inst = { id: 'a', spec: validateSpec({ kind: 'test.half' }), seed: seedFrom('a'), anchorBeat: 0, startedAtMs: 0, targets: null };
  const out = blank(3);
  renderEffect(inst, frame(), room, stepper, out);
  renderEffect(inst, frame({ nowMs: 23 }), room, stepper, out);
  assert.ok(Math.abs(out[2].level - 0.4) < 1e-12);
  assert.strictEqual(stepper.get('a', () => null, 23).frames, 2);
});

test('targets restrict the slots written; the rest stay transparent', () => {
  const room = buildRoom(3, (i) => i / 2, () => 0.5, () => 0.5, null);
  const inst = { id: 'b', spec: validateSpec({ kind: 'test.half' }), seed: seedFrom('b'), anchorBeat: 0, startedAtMs: 0, targets: [1] };
  const out = blank(3);
  renderEffect(inst, frame(), room, new EffectStepper(), out);
  assert.deepStrictEqual(out.map((s) => s.strength), [0, 1, 0]);
});

test('a rapid-flash kind renders nothing until acknowledged', () => {
  const room = buildRoom(2, (i) => i, () => 0.5, () => 0.5, null);
  const inst = { id: 'c', spec: validateSpec({ kind: 'test.rapid' }), seed: seedFrom('c'), anchorBeat: 0, startedAtMs: 0, targets: null };
  const out = blank(2);
  renderEffect(inst, frame({ acknowledged: false }), room, new EffectStepper(), out);
  assert.ok(out.every((s) => s.strength === 0));
  renderEffect(inst, frame({ acknowledged: true }), room, new EffectStepper(), out);
  assert.ok(out.every((s) => s.strength === 1));
});

test('the palette override reaches the kind', () => {
  const room = buildRoom(1, () => 0.5, () => 0.5, () => 0.5, null);
  const inst = { id: 'd', spec: validateSpec({ kind: 'test.half', palette: ['#FF0000'] }), seed: seedFrom('d'), anchorBeat: 0, startedAtMs: 0, targets: null };
  const out = blank(1);
  renderEffect(inst, frame({ paletteOverride: [{ r: 0, g: 0, b: 255, w: 0, a: 0, uv: 0 }] }), room, new EffectStepper(), out);
  assert.strictEqual(out[0].colour.b, 255);
});

test('compositeVoices: the strobe tier first, then the latest launch, then selected over shared; transparent slots show the base', () => {
  const base = [{ colour: WHITE, level: 0.2, strength: 1 }, { colour: WHITE, level: 0.2, strength: 1 }];
  const slots = (level) => [{ colour: WHITE, level, strength: 1 }, { colour: WHITE, level: 0, strength: 0 }];
  const early = { slots: slots(0.6), tier: 'voice', launchSeq: 1, selected: false, startedAtMs: 0 };
  const late = { slots: slots(0.8), tier: 'voice', launchSeq: 2, selected: false, startedAtMs: 10 };
  const strobe = { slots: slots(1), tier: 'strobe', launchSeq: 0, selected: false, startedAtMs: 0 };
  const selected = { slots: slots(0.7), tier: 'voice', launchSeq: 2, selected: true, startedAtMs: 10 };
  assert.strictEqual(compositeVoices(base, [early, late])[0].level, 0.8, 'the later launch wins');
  assert.strictEqual(compositeVoices(base, [late, strobe])[0].level, 1, 'the strobe wins');
  assert.strictEqual(compositeVoices(base, [late, selected])[0].level, 0.7, 'selected lights beat shared at the same launch');
  assert.strictEqual(compositeVoices(base, [late, strobe])[1].level, 0.2, 'transparent: the base');
});

test('states are swept after two seconds unseen, and a clone is independent', () => {
  const s = new EffectStepper();
  s.get('old', () => ({ n: 1 }), 0);
  const c = s.clone();
  s.sweep(2500);
  let made = false; s.get('old', () => { made = true; return {}; }, 2500);
  assert.strictEqual(made, true);
  assert.strictEqual(c.get('old', () => null, 2500).n, 1);
});

test('specs keep wire palettes and metadata defaults through repeated validation', () => {
  registerKind({ kind: 'test.defaults', app: 'own', schema: z.object({ level: z.number(), nested: z.object({ a: z.number(), b: z.number() }) }),
    defaults: { params: { level: 0.5, nested: { a: 1, b: 2 } }, palette: ['#FFFFFF'], brightness: 0.7,
      rapidFlash: true, minFlashIntervalMs: 400, scope: 'measure' }, init: () => null, render() {} });
  const spec = validateSpec({ kind: 'test.defaults', params: { nested: { b: 3 } } });
  assert.deepStrictEqual(spec, { kind: 'test.defaults', params: { level: 0.5, nested: { a: 1, b: 3 } },
    palette: ['#FFFFFF'], brightness: 0.7, rapidFlash: true, minFlashIntervalMs: 400, scope: 'measure' });
  assert.deepStrictEqual(validateSpec(spec), spec);
  assert.deepStrictEqual(specWithDefaults('test.defaults', { level: 0.2 }).params, { level: 0.2, nested: { a: 1, b: 2 } });
  assert.strictEqual(kindOf('test.defaults'), KINDS.get('test.defaults'));
  assert.strictEqual(kindOf('missing'), null);
  const explicit = validateSpec({ ...spec, palette: null, brightness: 0, rapidFlash: false, minFlashIntervalMs: 0, scope: 'singleBeat' });
  assert.strictEqual(explicit.palette, null);
  assert.strictEqual(explicit.brightness, 0);
  assert.strictEqual(explicit.rapidFlash, false);
  assert.strictEqual(explicit.minFlashIntervalMs, 0);
  assert.strictEqual(explicit.scope, 'singleBeat');
  const mixed = validateSpec({ kind: 'test.half', palette: ['#FF000080', { random: true }] });
  assert.deepStrictEqual(validateSpec(mixed), mixed);
  assert.deepStrictEqual(kindOf('test.defaults').defaults.params.nested, { a: 1, b: 2 }, 'validation does not mutate defaults');
});

test('validation rejects invalid metadata, palettes and params', () => {
  for (const invalid of [null, [], 'test.half', {}, { kind: 42 }]) assert.throws(() => validateSpec(invalid));
  for (const patch of [
    { brightness: -0.01 }, { brightness: 1.01 }, { brightness: NaN }, { brightness: Infinity },
    { rapidFlash: 'true' }, { minFlashIntervalMs: -1 }, { minFlashIntervalMs: Infinity }, { scope: 'bar' },
    { params: null }, { params: [] }, { params: { level: 2 } },
    { palette: [] }, { palette: Array(9).fill('#FFFFFF') }, { palette: [WHITE] }, { palette: [{ random: false }] },
    { palette: ['#GG0000'] }, { palette: ['#12345'] },
  ]) assert.throws(() => validateSpec({ kind: 'test.half', ...patch }), JSON.stringify(patch));
  assert.strictEqual(validateSpec({ kind: 'test.rapid' }).brightness, 1);
  assert.strictEqual(validateSpec({ kind: 'test.half', palette: Array(8).fill('#FFFFFF') }).palette.length, 8);
});

test('instance seed and anchor reach initialization and rendering; state roll wins over caller roll', () => {
  let initialized, rendered;
  registerKind({ kind: 'test.frame', app: 'own', schema: z.object({}), defaults: { params: {} },
    init: (_p, _room, f) => { initialized = { ...f }; return { roll: 2 }; }, rollOf: (s) => s.roll,
    render: (_p, s, _room, f, out) => { rendered = f; out[0] = { colour: f.palette[0], level: 1, strength: 1 }; s.roll++; } });
  const spec = validateSpec({ kind: 'test.frame', palette: [{ random: true }] });
  const inst = { id: 'frame', spec, seed: seedFrom('instance'), anchorBeat: 12, startedAtMs: 99, targets: null };
  const room = buildRoom(1, () => 0.5, () => 0.5, () => 0.5, null), stepper = new EffectStepper(), out = blank(1);
  const input = frame({ roll: 5, anchorBeat: 88 });
  renderEffect(inst, input, room, stepper, out);
  assert.deepStrictEqual(initialized.seed, inst.seed);
  assert.strictEqual(initialized.anchorBeat, 12);
  assert.deepStrictEqual(rendered.seed, inst.seed);
  assert.strictEqual(rendered.anchorBeat, 12);
  assert.strictEqual(rendered.spec, spec);
  assert.strictEqual(rendered.roll, 2);
  assert.deepStrictEqual(out[0].colour, resolvePalette(spec, null, [], inst.seed, 2)[0]);
  renderEffect(inst, input, room, stepper, out);
  assert.strictEqual(rendered.roll, 3);
  assert.strictEqual(input.anchorBeat, 88, 'the shared frame remains untouched');
  assert.deepStrictEqual(spec.palette, [{ random: true }]);
});

test('prepared palettes belong to instances and survive independent stepper clones', () => {
  registerKind({ kind: 'test.palette', app: 'own', schema: z.object({}), defaults: { params: {} },
    init: () => null, render: (_p, _s, _room, f, out) => { out[0] = { colour: f.palette[0], level: 1, strength: 1 }; } });
  const room = buildRoom(1, () => 0.5, () => 0.5, () => 0.5, null), stepper = new EffectStepper();
  const spec = validateSpec({ kind: 'test.palette', palette: [{ random: true }] });
  const inst = { id: 'cache', spec, seed: seedFrom('cache'), anchorBeat: 0, startedAtMs: 0, targets: null };
  const draw = (s, instance, roll) => { const out = blank(1); renderEffect(instance, frame({ roll }), room, s, out); return out[0].colour; };
  const prepared = preparePalette(spec);
  for (let roll = 0; roll < 4; roll++) assert.deepStrictEqual(draw(stepper, inst, roll), resolvePalette(spec, null, [], inst.seed, roll, prepared)[0]);
  const clone = stepper.clone();
  const resumed = draw(stepper, inst, 4);
  assert.deepStrictEqual(draw(clone, inst, 4), resumed);
  assert.deepStrictEqual(draw(stepper, inst, 2), resolvePalette(spec, null, [], inst.seed, 2)[0], 'backward sampling replays');
  inst.spec = validateSpec({ kind: 'test.palette', palette: ['#FF0000'] });
  assert.deepStrictEqual(draw(stepper, inst, 4), parseHex('#FF0000'), 'changed specs prepare a new palette');
  inst.spec.palette[0] = '#0000FF';
  assert.deepStrictEqual(draw(stepper, inst, 4), parseHex('#0000FF'), 'edited palette entries invalidate preparation');
  assert.strictEqual(stepper.get('cache', () => 'wrong', 0), null, 'metadata does not wrap null kind state');
});

test('targets preserve existing slots and spec rapidFlash cannot bypass the acknowledgement', () => {
  const room = buildRoom(3, (i) => i / 2, () => 0.5, () => 0.5, null), stepper = new EffectStepper();
  const inst = { id: 'target', spec: validateSpec({ kind: 'test.half' }), seed: seedFrom('target'), anchorBeat: 0, startedAtMs: 0, targets: [1] };
  const out = blank(3); out[0].level = 0.9;
  renderEffect(inst, frame(), room, stepper, out);
  assert.strictEqual(out[0].level, 0.9);
  inst.targets = [];
  const before = structuredClone(out);
  renderEffect(inst, frame(), room, stepper, out);
  assert.deepStrictEqual(out, before);
  inst.targets = null;
  inst.spec = validateSpec({ kind: 'test.half', rapidFlash: true });
  renderEffect(inst, frame({ acknowledged: false }), room, stepper, out);
  assert.deepStrictEqual(out, before);
  inst.spec = validateSpec({ kind: 'test.rapid', rapidFlash: false });
  renderEffect(inst, frame({ acknowledged: false }), room, stepper, out);
  assert.deepStrictEqual(out, before, 'kind-level rapidFlash is authoritative too');
});

test('voice ordering uses all tie breakers and owned black hides the base without mutating inputs', () => {
  const base = [{ colour: WHITE, level: 0.6, strength: 1 }];
  const voice = (level, props = {}) => ({ slots: [{ colour: WHITE, level, strength: 1 }],
    tier: 'voice', launchSeq: 1, selected: false, startedAtMs: 1, ...props });
  const early = voice(0.4), late = voice(0.8, { startedAtMs: 2 });
  const selected = voice(0.3, { selected: true }), launched = voice(0.7, { launchSeq: 2 });
  const strobe = voice(0, { tier: 'strobe', launchSeq: 0 });
  const voices = [late, early, selected, launched, strobe], snapshot = structuredClone(voices);
  assert.strictEqual(compositeVoices(base, [early, late])[0].level, 0.8);
  assert.strictEqual(compositeVoices(base, [late, selected])[0].level, 0.3);
  assert.strictEqual(compositeVoices(base, [selected, launched])[0].level, 0.7);
  assert.strictEqual(compositeVoices(base, voices)[0].level, 0, 'black is opaque when strength is positive');
  assert.strictEqual(compositeVoices(base, [voice(1, { slots: [{ colour: WHITE, level: 1, strength: 0 }] })])[0].level, 0.6);
  assert.deepStrictEqual(voices, snapshot);
  assert.strictEqual(base[0].level, 0.6);
});

test('slot writes round brightness and default the strobe channel to zero', () => {
  assert.deepStrictEqual(slotToWrite({ colour: WHITE, level: 0.5, strength: 1 }), { colour: WHITE, dim: 128, strobe: 0 });
  assert.deepStrictEqual(slotToWrite({ colour: WHITE, level: 1, strength: 1, strobe: 77 }), { colour: WHITE, dim: 255, strobe: 77 });
});

test('stepper expiry follows last use and reset clears every state, including undefined', () => {
  const s = new EffectStepper();
  let calls = 0;
  const make = () => { calls++; return undefined; };
  s.get('id', make, 0); s.get('id', make, 1000); s.sweep(2999); s.get('id', make, 2999);
  assert.strictEqual(calls, 1);
  s.sweep(5000); s.get('id', make, 5000);
  assert.strictEqual(calls, 2);
  s.reset(); s.get('id', make, 5001);
  assert.strictEqual(calls, 3);
  s.sweep(5102, 100); s.get('id', make, 5102);
  assert.strictEqual(calls, 4);
});

test('a cloned stepper retains class methods and deep independent Map state', () => {
  const s = new EffectStepper();
  const original = s.get('admission', () => ({ admission: new EventAdmission(350), nested: [{ n: 1 }] }), 0);
  original.admission.admit(0, 0);
  const copy = s.clone().get('admission', () => null, 1);
  assert.ok(copy.admission instanceof EventAdmission);
  assert.strictEqual(copy.admission.admit(1, 200), false);
  assert.strictEqual(copy.admission.admit(2, 400), true);
  assert.strictEqual(original.admission._answers.has(2), false);
  copy.nested[0].n = 2;
  assert.strictEqual(original.nested[0].n, 1);
  copy.admission.reset();
  assert.strictEqual(original.admission.admit(1, 200), false);
});

test('palette preparation shares expiry and clone lifetime without occupying another instance id', () => {
  const s = new EffectStepper(), spec = validateSpec({ kind: 'test.half', palette: [{ random: true }] });
  const kindState = s.get('a', () => ({ n: 1 }), 0);
  const other = s.get('a:palette', () => ({ n: 2 }), 0);
  const prepared = s.palette('a', spec, 0);
  resolvePalette(spec, null, [], seedFrom('a'), 3, prepared);
  assert.strictEqual(s.palette('a', structuredClone(spec), 1), prepared, 'equivalent snapshots keep preparation');
  assert.strictEqual(s.get('a', () => null, 1), kindState);
  assert.strictEqual(s.get('a:palette', () => null, 1), other);
  const clone = s.clone(), cloned = clone.palette('a', spec, 1);
  assert.deepStrictEqual(cloned, prepared);
  assert.notStrictEqual(cloned, prepared);
  resolvePalette(spec, null, [], seedFrom('a'), 4, prepared);
  assert.strictEqual(cloned.roll, 3);
  s.sweep(2002);
  assert.notStrictEqual(s.palette('a', spec, 2002), prepared, 'sweep drops the prepared palette too');
  clone.reset();
  assert.notStrictEqual(clone.palette('a', spec, 2), cloned, 'reset drops the prepared palette too');
});
