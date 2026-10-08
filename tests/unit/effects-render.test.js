// tests/unit/effects-render.test.js
import test from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import { registerKind, validateSpec, kindOf, KINDS, specWithDefaults } from '../../src/shared/effects/registry.ts';
import { renderEffect } from '../../src/shared/effects/render.ts';
import { ConstantTable, EffectStepper } from '../../src/shared/effects/stepper.ts';
import { EventAdmission } from '../../src/shared/effects/envelope.ts';
import { parseHex, preparePalette, resolvePalette } from '../../src/shared/effects/palette.ts';
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';
import { buildRoom } from '../../src/shared/room.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { slotToWrite } from '../helpers/slots.js';
import { CATALOGUE } from '../../src/shared/effects/index.ts';

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

test("spec validation fills kind defaults", () => {
  const spec = validateSpec({ kind: 'test.half' });
  assert.deepStrictEqual(spec.params, { level: 0.5 });
  assert.strictEqual(spec.brightness, 0.8);
});

test("spec validation rejects unknown kinds", () => {
  assert.throws(() => validateSpec({ kind: 'nope' }));
});

test("spec validation accepts only valid palette colours", () => {
  assert.throws(() => validateSpec({ kind: 'test.half', palette: ['red'] }));
  assert.strictEqual(validateSpec({ kind: 'test.half', palette: ['#FF0000'] }).palette[0], '#FF0000');
});

test("rendering applies brightness to every owned slot", () => {
  const room = buildRoom(3, (i) => i / 2, () => 0.5, () => 0.5, null);
  const stepper = new EffectStepper();
  const inst = { id: 'a', spec: validateSpec({ kind: 'test.half' }), seed: seedFrom('a'), anchorBeat: 0, startedAtMs: 0, targets: null };
  const out = blank(3);
  renderEffect(inst, frame(), room, stepper, out);
  renderEffect(inst, frame({ nowMs: 23 }), room, stepper, out);
  assert.ok(Math.abs(out[2].level - 0.4) < 1e-12);
  assert.strictEqual(stepper.get('a', () => null, 23).frames, 2);
});

test("target masks leave untargeted slots transparent", () => {
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

test("stepper expiry and cloning preserve independent state", () => {
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

test("instance context reaches the effect kernel", () => {
  let initialized, rendered;
  registerKind({ kind: 'test.frame', app: 'own', schema: z.object({}), defaults: { params: {} },
    init: (_p, _room, f) => { initialized = { ...f }; return { roll: 2 }; }, rollOf: (s) => s.roll,
    render: (_p, s, _room, f, out) => { rendered = f; out[0] = { colour: f.palette[0], level: 1, strength: 1 }; s.roll++; } });
  const spec = validateSpec({ kind: 'test.frame', palette: [{ random: true }] });
  const inst = { id: 'frame', spec, seed: seedFrom('instance'), anchorBeat: 12, startedAtMs: 99, targets: null };
  const room = buildRoom(1, () => 0.5, () => 0.5, () => 0.5, null), stepper = new EffectStepper(), out = blank(1);
  const input = frame({ roll: 5, anchorBeat: 88, startedAtMs: 700 });
  renderEffect(inst, input, room, stepper, out);
  assert.deepStrictEqual(initialized.seed, inst.seed);
  assert.strictEqual(initialized.anchorBeat, 12);
  assert.strictEqual(initialized.startedAtMs, 99);
  assert.deepStrictEqual(rendered.seed, inst.seed);
  assert.strictEqual(rendered.anchorBeat, 12);
  assert.strictEqual(rendered.startedAtMs, 99);
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

test("target masks retain slots while safety gates rapid effects", () => {
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

test('slot writes round brightness and default the strobe channel to zero', () => {
  assert.deepStrictEqual(slotToWrite({ colour: WHITE, level: 0.5, strength: 1 }), { colour: WHITE, dim: 128, strobe: 0 });
  assert.deepStrictEqual(slotToWrite({ colour: WHITE, level: 1, strength: 1, strobe: 77 }), { colour: WHITE, dim: 255, strobe: 77 });
});

test("stepper reset clears expired and undefined state", () => {
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

test("stepper clones preserve object aliases", () => {
  class Lamp { constructor() { this.level = 0.5; this.colour = { r: 1 }; } brighter() { return this.level * 2; } }
  const shared = { r: 9 };
  const tagged = { r: 3 };
  Object.defineProperty(tagged, Symbol('binding'), { value: { index: 2 } });
  const hidden = { visible: 1 };
  Object.defineProperty(hidden, 'secret', { value: [1, 2], enumerable: false, writable: true, configurable: true });
  const holey = [1, , 3]; // eslint-disable-line no-sparse-arrays
  const extra = [1, 2]; extra.label = 'kept';
  const frozen = Object.freeze([{ n: 1 }]);
  const withGetter = { get now() { return 7; } };
  const named = { constructor: 'not a function', ['__proto__']: null, plain: 1 };
  const cyclic = { list: [] }; cyclic.list.push(cyclic);
  const state = { lamps: [new Lamp(), new Lamp()], a: shared, b: shared, tagged, hidden, holey, extra, frozen, withGetter, named, cyclic,
    numbers: Array.from({ length: 1000 }, (_, i) => i / 3) };
  const s = new EffectStepper();
  s.get('x', () => state, 0);
  const copy = s.clone().get('x', () => null, 1);

  assert.notStrictEqual(copy, state);
  assert.ok(copy.lamps[0] instanceof Lamp && copy.lamps[0].brighter() === 1, 'class and methods');
  assert.notStrictEqual(copy.lamps[0].colour, state.lamps[0].colour);
  assert.strictEqual(copy.a, copy.b, 'one object reached twice is one copy');
  assert.notStrictEqual(copy.a, shared);
  assert.deepStrictEqual(Object.getOwnPropertySymbols(copy.tagged).map((k) => copy.tagged[k]), [{ index: 2 }], 'a symbol property kept');
  assert.deepStrictEqual(copy.hidden.secret, [1, 2]);
  assert.strictEqual(Object.getOwnPropertyDescriptor(copy.hidden, 'secret').enumerable, false, 'a hidden property stays hidden');
  assert.strictEqual(copy.holey.length, 3);
  assert.ok(!(1 in copy.holey), 'a hole stays a hole');
  assert.strictEqual(copy.extra.label, 'kept');
  assert.ok(Object.isFrozen(copy.frozen) && copy.frozen !== frozen, 'a frozen array is copied, frozen');
  assert.notStrictEqual(copy.frozen[0], frozen[0], 'shallow-frozen is not immutable: its items are copied too');
  assert.strictEqual(typeof Object.getOwnPropertyDescriptor(copy.withGetter, 'now').get, 'function', 'a getter stays a getter');
  assert.strictEqual(copy.named.constructor, 'not a function');
  assert.ok(Object.hasOwn(copy.named, '__proto__') && copy.named.__proto__ === null && Object.getPrototypeOf(copy.named) === Object.prototype,
    'an own __proto__ is a property, not the prototype');
  assert.strictEqual(copy.cyclic.list[0], copy.cyclic, 'a cycle closes on the copy');
  assert.deepStrictEqual(copy.numbers, state.numbers);
  copy.numbers[5] = -1; copy.lamps[1].level = 0;
  assert.strictEqual(state.numbers[5], 5 / 3);
  assert.strictEqual(state.lamps[1].level, 0.5);
});

test("constant tables expose bounded row and column access", () => {
  const table = new ConstantTable(3, 2, (row, column) => row * 10 + column);
  assert.deepStrictEqual([table.rows, table.columns, table.at(2, 1), table.at(3, 0), table.at(0, 2), table.at(-1, 0), table.at(0.5, 0)], [3, 2, 21, undefined, undefined, undefined, undefined]);
});

test("constant tables cannot be changed", () => {
  const table = new ConstantTable(3, 2, (row, column) => row * 10 + column);
  assert.ok(Object.isFrozen(table));
  assert.throws(() => { table.rows = 1; }, TypeError);
  assert.throws(() => { table.values = []; }, TypeError);
  assert.deepStrictEqual(Object.keys(table).sort(), ['columns', 'rows'], 'its values are not reachable');
});

test("constant tables require integral dimensions", () => {
  assert.throws(() => new ConstantTable(1.5, 1, () => 0), RangeError);
});

test("stepper clones share exact constant tables only", () => {
  const table = new ConstantTable(3, 2, (row, column) => row * 10 + column);
  const s = new EffectStepper();
  const state = s.get('x', () => ({ table, frozenRows: Object.freeze([Object.freeze([1, 2])]) }), 0);
  const copy = s.clone().get('x', () => null, 1);
  assert.strictEqual(copy.table, table, 'shared');
  assert.notStrictEqual(copy, state);
  assert.notStrictEqual(copy.frozenRows, state.frozenRows, 'a frozen array of its own is still copied');
  class Counting extends ConstantTable {}
  const sub = new Counting(1, 1, () => 4);
  s.get('y', () => ({ sub }), 0);
  assert.notStrictEqual(s.clone().get('y', () => null, 1).sub, sub);
});

test("palette caches share instance expiry and clone lifetime", () => {
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

// A colour or brightness edit to the preset on stage reaches the running
// instance without starting it again (the engine moves no revision for it),
// so every kind must take a palette that changes size under it: eight colours
// with a random one, then one, then two, its brightness down, and the
// override coming and going between.
test("preset palette and brightness edits reach the next frame", () => {
  const room = buildRoom(6, (i) => i / 5, (i) => (i < 3 ? 0 : 1), () => 0.5, null);
  const eight = ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF', '#FFFFFF', { random: true }];
  const look = ['#FF0000', '#00FF00', '#0000FF', '#FFFFFF'].map(parseHex);
  const failures = [];
  const silent = [];
  for (const row of CATALOGUE.filter((p) => !p.legacy)) {
    let drew = false;
    const edits = [{ ...row.spec, palette: eight }, { ...row.spec, palette: ['#FF8800'] },
      { ...row.spec, palette: eight, brightness: 0.3 }, { ...row.spec, palette: ['#123456', '#654321'] }];
    const stepper = new EffectStepper();
    try {
      for (let k = 0; k < 240 && failures.length < 5; k++) {
        const nowMs = (k + 1) * 1000 / 44;
        const out = new Array(room.n);
        renderEffect({ id: 'base:x:0', spec: edits[Math.floor(k / 60)], seed: seedFrom(row.id), anchorBeat: 0, startedAtMs: 0, targets: null },
          frame({ beatPos: nowMs / 500, nowMs, lookPalette: look, paletteOverride: k % 90 > 70 ? [parseHex('#00FF00')] : null }), room, stepper, out);
        const broken = out.find((slot) => slot && ![slot.level, slot.strength, slot.colour.r, slot.colour.g, slot.colour.b, slot.colour.w ?? 0].every(Number.isFinite));
        if (broken) { failures.push(`${row.id} at frame ${k}: ${JSON.stringify(broken)}`); break; }
        drew ||= out.some((slot) => slot && slot.strength > 0);
      }
    } catch (err) {
      failures.push(`${row.id}: ${err.message}`);
    }
    if (!drew) silent.push(row.id);
  }
  assert.deepStrictEqual(failures, []);
  assert.deepStrictEqual(silent, [], 'every preset drew through the edits');
});
