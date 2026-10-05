// tests/unit/effects-macro.test.js
// The macro kind: Light DJ's composite Scene Maker rows as a looping score of effects.
import test from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import '../../src/shared/effects/macro.ts';
import { DISCO_PRESETS } from '../../src/shared/effects/disco.ts';
import { registerKind, requiresAcknowledgement, validateSpec } from '../../src/shared/effects/registry.ts';
import { renderEffect } from '../../src/shared/effects/render.ts';
import { EffectStepper } from '../../src/shared/effects/stepper.ts';
import { LDJ_RANDOM_HUES, hsbToColour, parseHex } from '../../src/shared/effects/palette.ts';
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { buildRoom } from '../../src/shared/room.ts';

const RED = parseHex('#FF0000'), GREEN = parseHex('#00FF00'), BLUE = parseHex('#0000FF'), YELLOW = parseHex('#FFFF00');
const SEED = seedFrom('macro-test');
const room = (n = 1) => buildRoom(n, (i) => n > 1 ? i / (n - 1) : 0.5, () => 0.5, () => 0.5, null);
const square = () => buildRoom(4, (i) => [0, 1, 1, 0][i], (i) => [0, 0, 1, 1][i], () => 0.5, null);

// Every probe render is logged with what its frame said.
const log = [];
test.before(() => {
  const probe = (kind, extra = {}) => registerKind({
    kind, app: 'own', schema: z.object({ level: z.number().min(0).max(1), clear: z.boolean() }).strict(),
    defaults: { params: { level: 1, clear: false } }, stateful: true, ...extra,
    init: () => ({ renders: 0 }),
    render(p, s, r, f, out) {
      s.renders++;
      log.push({ kind, id: f.instanceId, anchorBeat: f.anchorBeat, startedAtMs: f.startedAtMs, seed: f.seed, renders: s.renders, palette: f.palette });
      for (let i = 0; i < r.n; i++) out[i] = { colour: f.palette[0], level: p.level, strength: p.clear ? 0 : 1 };
    },
  });
  probe('test.probe');
  probe('test.tinted', { defaults: { params: { level: 1, clear: false }, palette: ['#00FF00'] } });
  probe('test.flashy', { rapidFlash: true });
});

const frame = (over = {}) => ({ beatPos: 0, bpm: 120, nowMs: 0, dtMs: 0, anchorBeat: 0, lookPalette: [RED, BLUE], paletteOverride: null,
  audio: null, audioMode: 'tempo', master: HD_MASTER_DEFAULTS, seed: seedFrom('caller'), acknowledged: true, hueStrobe: 'flash', ...over });
const step = (effect, beats, extra = {}) => ({ effect, beats, ...extra });
const macro = (steps, loopBeats, over = {}) => validateSpec({ kind: 'macro', params: { steps, loopBeats }, ...over });
const instance = (spec, over = {}) => ({ id: 'm', spec, seed: SEED, anchorBeat: 0, startedAtMs: 0, targets: null, ...over });
const draw = (inst, f, r, stepper) => { const out = []; renderEffect(inst, f, r, stepper, out); return out; };
/** Sample one instance at macro-relative beats, 500 ms a beat unless the call says otherwise. */
function sampler(inst, r = room()) {
  const stepper = new EffectStepper();
  const at = (beat, over = {}) => {
    log.length = 0;
    const out = draw(inst, frame({ beatPos: inst.anchorBeat + beat, nowMs: inst.startedAtMs + beat * 500, ...over }), r, stepper);
    return { out, child: log.at(-1) };
  };
  at.stepper = stepper;
  return at;
}
const TWO_STEPS = () => macro([step({ kind: 'test.probe', palette: ['#FF0000'] }, 2), step({ kind: 'test.probe', palette: ['#0000FF'] }, 2)], 4);

test('two steps of 2 beats each alternate, looping every 4; each step\'s effect anchors at the step start', () => {
  const at = sampler(instance(TWO_STEPS(), { anchorBeat: 10, startedAtMs: 5000 }));
  const rows = [[0, RED, 10, 'm:0', 5000, 1], [1, RED, 10, 'm:0', 5000, 2], [1.99, RED, 10, 'm:0', 5000, 3], [2, BLUE, 12, 'm:1', 6000, 1],
    [3, BLUE, 12, 'm:1', 6000, 2], [4, RED, 14, 'm:0', 7000, 1], [5, RED, 14, 'm:0', 7000, 2], [6, BLUE, 16, 'm:1', 8000, 1], [8, RED, 18, 'm:0', 9000, 1]];
  for (const [beat, colour, anchorBeat, id, startedAtMs, renders] of rows) {
    const { out, child } = at(beat);
    assert.deepStrictEqual(out[0].colour, colour, `colour at beat ${beat}`);
    assert.deepStrictEqual({ anchorBeat: child.anchorBeat, id: child.id, startedAtMs: child.startedAtMs, renders: child.renders },
      { anchorBeat, id, startedAtMs, renders }, `child at beat ${beat}`);
  }
});

test('a step starts at its boundary in wall time: the known launch, a back-projection clamped to the launch, or between two samples', () => {
  // A late first sample in step 0 of lap 0 still starts at the launch, whatever the tempo now.
  assert.strictEqual(sampler(instance(TWO_STEPS(), { startedAtMs: 1000 }))(0.5).child.startedAtMs, 1000);
  assert.strictEqual(sampler(instance(TWO_STEPS(), { startedAtMs: 1000 }))(0.5, { bpm: 240 }).child.startedAtMs, 1000);
  // Cold in a later step: back-projected at the current tempo…
  const cold = instance(TWO_STEPS(), { startedAtMs: 0 });
  assert.strictEqual(sampler(cold)(3, { nowMs: 1500, bpm: 120 }).child.startedAtMs, 1000);
  assert.strictEqual(sampler(cold)(3, { nowMs: 1500, bpm: 60 }).child.startedAtMs, 500);
  // …but never before the macro was launched.
  assert.strictEqual(sampler({ ...cold, startedAtMs: 1300 })(3, { nowMs: 1500 }).child.startedAtMs, 1300);
  // Later crossings interpolate the two samples around the boundary, also across a tempo change.
  const at = sampler(cold);
  at(1.5, { nowMs: 750 });
  const crossed = at(2.6, { nowMs: 1350, bpm: 140 }).child.startedAtMs;
  assert.ok(Math.abs(crossed - (750 + (0.5 / 1.1) * 600)) < 1e-9, `${crossed}`);
  assert.strictEqual(at(3.5, { nowMs: 1750, bpm: 90 }).child.startedAtMs, crossed, 'an established start stays put');
  // A sparse sample that skips a whole step starts the step it lands in.
  const sparse = sampler(cold);
  sparse(1, { nowMs: 500 });
  const landed = sparse(4.5, { nowMs: 2250 });
  assert.deepStrictEqual([landed.child.id, landed.child.anchorBeat, landed.child.startedAtMs], ['m:0', 4, 2000]);
});

test('a macro re-anchored onto the step it plays (a voice after a jump in the music) moves the step\'s anchor and keeps its state', () => {
  // The renderer moves a playing voice's anchor to the beat the music jumped to; its wall times stay.
  const stepper = new EffectStepper();
  const inst = instance(TWO_STEPS(), { startedAtMs: 0 });
  const at = (anchorBeat, beatPos, nowMs) => { log.length = 0; const out = draw({ ...inst, anchorBeat }, frame({ beatPos, nowMs }), room(), stepper); return { out, child: log.at(-1) }; };
  at(0, 0.5, 250);
  const before = at(0, 0.6, 300).child;
  // A seek to beat 40.3: anchored on 40, the macro is 0.3 beats into lap 0's first step again.
  const after = at(40, 40.3, 325);
  assert.deepStrictEqual({ id: after.child.id, anchorBeat: after.child.anchorBeat, startedAtMs: after.child.startedAtMs, renders: after.child.renders, seed: after.child.seed },
    { id: before.id, anchorBeat: 40, startedAtMs: before.startedAtMs, renders: before.renders + 1, seed: before.seed },
    'the same step plays on from the new anchor: its state, wall start and seed kept, as a kind takes a position that went back');
  assert.deepStrictEqual(after.out[0].colour, RED);
  // Landing on another step is that step's activation, as playing through would have made it.
  const later = at(40, 42.5, 1425).child;
  assert.deepStrictEqual([later.id, later.anchorBeat, later.renders], ['m:1', 42, 1]);
});

test('each lap and step plays with fresh state and its own seed, and two macros never share a child', () => {
  const at = sampler(instance(TWO_STEPS()));
  const seeds = [0, 2, 4, 6].map((beat) => at(beat).child);
  assert.ok(seeds.every((child) => child.renders === 1), 'fresh state at every activation');
  const words = new Set(seeds.map((child) => child.seed.join(',')));
  assert.strictEqual(words.size, 4, 'step and lap both reach the seed');
  // Each parent seed word reaches the child.
  const base = sampler(instance(TWO_STEPS()))(0).child.seed.join(',');
  for (let w = 0; w < 4; w++) {
    const seed = [...SEED]; seed[w] = (seed[w] + 1) >>> 0;
    assert.notStrictEqual(sampler(instance(TWO_STEPS(), { seed }))(0).child.seed.join(','), base, `seed word ${w}`);
  }
  // A step whose kind is edited mid-step starts afresh rather than inheriting another kind's state.
  const edited = instance(TWO_STEPS());
  const live = sampler(edited);
  live(0); live(0.5);
  edited.spec = macro([step({ kind: 'test.tinted' }, 2), step({ kind: 'test.probe' }, 2)], 4);
  const after = live(1).child;
  assert.deepStrictEqual([after.kind, after.renders], ['test.tinted', 1]);
  // Two instances of one spec on one stepper keep separate children.
  const stepper = new EffectStepper();
  const a = instance(TWO_STEPS(), { id: 'a' }), b = instance(TWO_STEPS(), { id: 'b' });
  for (const beat of [0, 0.5, 1]) { draw(a, frame({ beatPos: beat, nowMs: beat * 500 }), room(), stepper); }
  log.length = 0;
  draw(b, frame({ beatPos: 1, nowMs: 500 }), room(), stepper);
  assert.deepStrictEqual([log[0].id, log[0].renders], ['b:0', 1]);
  // A cloned stepper continues exactly and independently.
  const clone = stepper.clone();
  const run = (s) => [1.5, 2, 2.5, 4].map((beat) => {
    log.length = 0;
    const out = draw(a, frame({ beatPos: beat, nowMs: beat * 500 }), room(), s);
    return { out, child: log[0] };
  });
  assert.deepStrictEqual(run(stepper), run(clone));
});

test('macros validate recursively: steps fill the loop, bounded nesting, no cycles, idempotent', () => {
  const probe = { kind: 'test.probe' };
  const spec = TWO_STEPS();
  assert.deepStrictEqual(spec.params.steps[0].effect, validateSpec({ kind: 'test.probe', palette: ['#FF0000'] }), 'children are validated specs');
  assert.deepStrictEqual(validateSpec(spec), spec, 'idempotent');
  assert.deepStrictEqual(validateSpec(JSON.parse(JSON.stringify(spec))), spec, 'plain data on the wire');
  // Decimal step tables that fill the loop pass; a real gap or overhang does not.
  assert.doesNotThrow(() => macro([step(probe, 4), step(probe, 3.6), step(probe, 3.6), step(probe, 4.8)], 16));
  for (const [beats, loop] of [[[4, 3.6, 3.6, 4.7], 16], [[4, 3.6, 3.6, 4.8001], 16], [[2, 2], 4.000001], [[2], 4]]) {
    assert.throws(() => macro(beats.map((b) => step(probe, b)), loop), /fill/, `${beats} in ${loop}`);
  }
  for (const params of [{ steps: [], loopBeats: 4 }, { steps: [step(probe, 0)], loopBeats: 0 }, { steps: [step(probe, -1)], loopBeats: -1 },
    { steps: [step(probe, Infinity)], loopBeats: Infinity }, { steps: [step(probe, NaN)], loopBeats: NaN }, { steps: [step({ kind: 'nope' }, 4)], loopBeats: 4 },
    { steps: [step(probe, 4, { paletteIndices: [] })], loopBeats: 4 }, { steps: [step(probe, 4, { paletteIndices: [8] })], loopBeats: 4 },
    { steps: [step(probe, 4, { paletteIndices: [0.5] })], loopBeats: 4 }, { steps: [step(probe, 4, { paletteIndices: Array(9).fill(0) })], loopBeats: 4 },
    { steps: [step({ kind: 'test.probe', params: { level: 2 } }, 4)], loopBeats: 4 }, { steps: [{ effect: probe, beats: 4, extra: 1 }], loopBeats: 4 }]) {
    assert.throws(() => validateSpec({ kind: 'macro', params }), JSON.stringify(params));
  }
  // 32 levels of nesting pass, the 33rd does not, and a far deeper chain fails the same way.
  const nest = (depth) => {
    let inner = probe;
    for (let d = 0; d < depth; d++) inner = { kind: 'macro', params: { steps: [step(inner, 1)], loopBeats: 1 } };
    return inner;
  };
  assert.doesNotThrow(() => validateSpec(nest(32)));
  assert.throws(() => validateSpec(nest(33)), /32/);
  assert.throws(() => validateSpec(nest(20000)), /32/);
  const deep = validateSpec(nest(32));
  assert.deepStrictEqual(draw(instance(deep), frame({ acknowledged: false }), room(), new EffectStepper())[0].colour, RED,
    'and render, not mistaken for rapid at the depth limit');
  // A macro that contains itself is refused; one child shared by siblings is not a cycle.
  const cyclic = { kind: 'macro', params: { steps: [step(null, 1)], loopBeats: 1 } };
  cyclic.params.steps[0].effect = cyclic;
  assert.throws(() => validateSpec(cyclic), /itself/);
  assert.strictEqual(requiresAcknowledgement(cyclic), true, 'unvalidated cycles assume the worst rather than overflow');
  const shared = { kind: 'macro', params: { steps: [step(probe, 1)], loopBeats: 1 } };
  assert.doesNotThrow(() => macro([step(shared, 1), step(shared, 1), step(probe, 1)], 3));
  // Shape keeps its defaults: one step that fills its loop.
  const fallback = validateSpec({ kind: 'macro' });
  assert.strictEqual(fallback.params.steps.length, 1);
  assert.strictEqual(fallback.params.steps[0].beats, fallback.params.loopBeats);
});

test('palettes: an override wins, then the child\'s own (its kind\'s default too), then the parent\'s, then the look; indices map roles', () => {
  const colourAt = (spec, over = {}) => draw(instance(spec), frame(over), room(), new EffectStepper())[0].colour;
  const one = (effect, extra = {}, parent = {}) => macro([step(effect, 4, extra)], 4, parent);
  assert.deepStrictEqual(colourAt(one({ kind: 'test.probe' })), RED, 'the look');
  assert.deepStrictEqual(colourAt(one({ kind: 'test.probe' }, {}, { palette: ['#FFFF00'] })), YELLOW, 'the parent\'s palette');
  assert.deepStrictEqual(colourAt(one({ kind: 'test.probe', palette: ['#0000FF'] }, {}, { palette: ['#FFFF00'] })), BLUE, 'the child\'s own');
  assert.deepStrictEqual(colourAt(one({ kind: 'test.tinted' }, {}, { palette: ['#FFFF00'] })), GREEN, 'the child kind\'s recommendation');
  assert.deepStrictEqual(colourAt(one({ kind: 'test.tinted', palette: null }, {}, { palette: ['#FFFF00'] })), YELLOW, 'explicit null inherits');
  assert.deepStrictEqual(colourAt(one({ kind: 'test.tinted' }), { paletteOverride: [BLUE, RED] }), BLUE, 'the override over all');
  // Indices take roles from the override, else the parent's palette, else the look — never the child's own.
  const mapped = (indices, parent) => one({ kind: 'test.tinted' }, { paletteIndices: indices }, parent);
  assert.deepStrictEqual(colourAt(mapped([1]), { paletteOverride: [BLUE, RED] }), RED, 'the secondary role of the override, not all of it');
  log.length = 0;
  colourAt(mapped([1]), { paletteOverride: [BLUE, RED] });
  assert.deepStrictEqual(log[0].palette, [RED]);
  assert.deepStrictEqual(colourAt(mapped([1, 0], { palette: ['#FFFF00', '#0000FF'] })), BLUE);
  assert.deepStrictEqual(colourAt(mapped([1])), BLUE, 'the look\'s second slot');
  // A colour no random roll can produce, so a wrapped role cannot pass by luck.
  log.length = 0;
  colourAt(mapped([1, 0], { palette: ['#123456'] }));
  assert.deepStrictEqual(log[0].palette, [parseHex('#123456'), parseHex('#123456')], 'one colour wraps into both roles');
  // A random entry stays random until the child rolls it, in the child's own cache.
  log.length = 0;
  colourAt(mapped([1, 0], { palette: [{ random: true }, '#0000FF'] }));
  const hues = LDJ_RANDOM_HUES.map((h) => hsbToColour(h / 360, 1, 1));
  assert.deepStrictEqual(log[0].palette[0], BLUE);
  assert.ok(hues.some((c) => JSON.stringify(c) === JSON.stringify(log[0].palette[1])), 'a Light DJ random hue');
  const spec = mapped([1, 0], { palette: [{ random: true }, '#0000FF'] });
  assert.deepStrictEqual(spec.params.steps[0], { effect: validateSpec({ kind: 'test.tinted' }), beats: 4, paletteIndices: [1, 0] }, 'the wire spec is untouched');
  assert.deepStrictEqual(spec.palette, [{ random: true }, '#0000FF']);
});

test('brightness applies once at each level, transparency survives, targets mask, and a rapid child needs the acknowledgement', () => {
  const dim = macro([step({ kind: 'test.probe', brightness: 0.5 }, 4)], 4, { brightness: 0.5 });
  assert.strictEqual(draw(instance(dim), frame(), room(), new EffectStepper())[0].level, 0.25);
  const clear = macro([step({ kind: 'test.probe', params: { clear: true } }, 4)], 4);
  assert.strictEqual(draw(instance(clear), frame(), room(2), new EffectStepper())[0].strength, 0);
  const masked = draw(instance(TWO_STEPS(), { targets: [1] }), frame(), room(3), new EffectStepper());
  assert.deepStrictEqual(Object.keys(masked), ['1']);
  // A macro with a rapid step is a rapid effect: refused and dark until acknowledged.
  const rapid = macro([step({ kind: 'test.probe' }, 2), step({ kind: 'test.flashy' }, 2)], 4);
  assert.strictEqual(requiresAcknowledgement(rapid), true);
  assert.strictEqual(requiresAcknowledgement(TWO_STEPS()), false);
  assert.strictEqual(requiresAcknowledgement(macro([step(rapid, 4)], 4)), true, 'nested');
  assert.deepStrictEqual(draw(instance(rapid), frame({ acknowledged: false }), room(), new EffectStepper()), []);
  assert.strictEqual(draw(instance(rapid), frame(), room(), new EffectStepper()).length, 1);
});

test('finite Light DJ children: a single pulse never retriggers, and Flip\'s four updates hold to the end of the loop', () => {
  // BeatPulse1 once over a one-beat step: one pulse, then dark — no quarter-beat retrigger.
  const pulse = macro([step({ kind: 'ldj.BeatPulse1', params: { cadence: 0.25, iterations: 1 } }, 1)], 1);
  const at = sampler(instance(pulse));
  const levels = [];
  for (let ms = 0; ms < 500; ms += 1000 / 44) levels.push(at(ms / 500).out[0].level);
  const rises = levels.filter((level, i) => level > 0.5 && !(levels[i - 1] > 0.5)).length;
  assert.strictEqual(rises, 1);
  assert.ok(levels.slice(-8).every((level) => level === 0), 'it fades and stays dark');
  // Flip at .9 beats, four times from 11.2: updates at 11.2, 12.1, 13 and 13.9, the last held through 16.
  const bigRoom = macro([step({ kind: 'test.probe' }, 11.2), step({ kind: 'ldj.Flip', params: { cadence: 0.9, iterations: 4 } }, 4.8)], 16);
  const flip = sampler(instance(bigRoom), square());
  const changes = [];
  let last = null, dense = null;
  for (let ms = 0; ms < 8000; ms += 1000 / 44) {
    const beat = ms / 500;
    if (!dense && beat >= 15.5) dense = flip(15.5).out;
    const key = JSON.stringify(flip(beat).out.map((slot) => slot.colour));
    if (beat >= 11.2 && key !== last) changes.push(beat);
    last = key;
  }
  assert.strictEqual(changes.length, 4, `changes at ${changes}`);
  [11.2, 12.1, 13, 13.9].forEach((due, k) => assert.ok(changes[k] >= due - 1e-9 && changes[k] < due + 0.05, `update ${k} at ${changes[k]}`));
  // A cold sample at 15.5 shows the last update, as dense rendering does.
  const cold = sampler(instance(bigRoom), square())(15.5).out;
  assert.deepStrictEqual(cold, dense);
  assert.deepStrictEqual(cold.map((slot) => slot.colour), [RED, BLUE, BLUE, BLUE], 'iteration 3, not a fifth update');
  // The next lap starts the step table again, with a fresh Flip.
  assert.deepStrictEqual(flip(16).out.map((slot) => slot.colour), [RED, RED, RED, RED]);
  assert.deepStrictEqual(sampler(instance(bigRoom), square())(16 + 15.5).out, cold);
});

test('a macro may not hold the strobe, which would restart its five-a-second permit at every step', () => {
  const strobe = { kind: 'strobe', params: { clock: 'wall', flashesPerSecond: 5 } };
  assert.throws(() => macro([step(strobe, 0.25)], 0.25), /strobe/);
  assert.throws(() => macro([step({ kind: 'test.probe' }, 1), step({ kind: 'macro', params: { steps: [step(strobe, 1)], loopBeats: 1 } }, 1)], 2), /strobe/, 'nested');
  // A hand-built spec that skipped validation renders the step dark: no quarter-beat laps of fresh strobes.
  const raw = { kind: 'macro', params: { steps: [{ effect: validateSpec(strobe), beats: 0.25 }], loopBeats: 0.25 }, palette: null, brightness: 1 };
  const at = sampler(instance(raw));
  for (let ms = 0; ms < 1000; ms += 1000 / 44) assert.strictEqual(at(ms / 500).out[0].strength, 0, `${ms} ms`);
});

test('nor Disco with its automatic strobe on, whose five-a-second limit each step would start again', () => {
  const disco = (id, over = {}) => ({ kind: 'hd.disco', params: { ...DISCO_PRESETS.find((p) => p.id === id).params, ...over } });
  assert.throws(() => macro([step(disco('hd.disco.drumAndBass'), 0.75)], 0.75),
    (err) => err.issues.some((i) => i.path.join('.') === 'params.steps.0.effect.params' && i.message === 'a macro may not hold an automatic strobe'));
  const peak = DISCO_PRESETS.find((p) => p.id === 'hd.disco.pop').params;
  assert.throws(() => macro([step(disco('hd.disco.pop', { style: 'peak', channels: peak.channels.map((c, i) => (i === 3 ? { ...c, strobeOn: true } : c)) }), 1)], 1),
    /a macro may not hold an automatic strobe/);
  // Without it, Disco is a step like any other.
  assert.strictEqual(macro([step(disco('hd.disco.pop'), 1)], 1).params.steps[0].effect.kind, 'hd.disco');
  // A hand-built spec that skipped validation renders that step dark, where Disco without the strobe lights on a hit.
  const raw = (id) => ({ kind: 'macro', params: { steps: [{ effect: validateSpec(disco(id)), beats: 1 }], loopBeats: 1 }, palette: null, brightness: 1 });
  const hits = { t: 0.25, rms: 1, power: 1, dominantHz: 100, party: { full: 1, bass: 1, mid: 1, high: 1 },
    disco: { hit: [true, true, true], gate: [0, 0, 0], level: [1, 1, 1], peakHit: true, neural: { mainFrequency: 0.5, amplitude: 1 } },
    spl: { db: 0, level: 0, beat: null, section: null } };
  const heard = (id) => sampler(instance(raw(id)))(0.5, { audio: hits, audioMode: 'reactive' }).out[0].strength;
  assert.strictEqual(heard('hd.disco.pop'), 1);
  assert.strictEqual(heard('hd.disco.drumAndBass'), 0);
});

test('a macro\'s slots name the step kind that drew them, through nested macros, so a guard for one family still finds it', () => {
  const hd = macro([step({ kind: 'hd.simpleAdsr' }, 2), step({ kind: 'test.probe' }, 2)], 4);
  const at = sampler(instance(hd), room(2));
  assert.deepStrictEqual(at(0.5).out.map((slot) => [slot.strength, slot.kind]), [[1, 'hd.simpleAdsr'], [1, 'hd.simpleAdsr']]);
  assert.deepStrictEqual(at(2.5).out.map((slot) => slot.kind), ['test.probe', 'test.probe']);
  const nested = macro([step(hd, 4)], 4);
  assert.deepStrictEqual(sampler(instance(nested), room(2))(0.5).out.map((slot) => slot.kind), ['hd.simpleAdsr', 'hd.simpleAdsr'], 'the innermost kind');
  // A transparent slot names nobody, and an instance's own kind is never written on its slots.
  const clear = macro([step({ kind: 'test.probe', params: { clear: true } }, 4)], 4);
  assert.strictEqual(sampler(instance(clear))(0).out[0].kind, undefined);
  const own = draw(instance(validateSpec({ kind: 'test.probe' })), frame(), room(), new EffectStepper());
  assert.ok(!('kind' in own[0]));
});
