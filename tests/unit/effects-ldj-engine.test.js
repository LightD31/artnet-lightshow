// tests/unit/effects-ldj-engine.test.js
import test from 'node:test';
import assert from 'node:assert';
import { LdjLamps, LDJ_FRAME_MS, stepClock, wallClock, roles, ldjChannels, makeLdjKind } from '../../src/shared/effects/ldj-engine.ts';
import { parseHex } from '../../src/shared/effects/palette.ts';
import { buildRoom } from '../../src/shared/room.ts';
import { EffectStepper } from '../../src/shared/effects/stepper.ts';
import { registerKind, validateSpec } from '../../src/shared/effects/registry.ts';
import { renderEffect } from '../../src/shared/effects/render.ts';
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';

const RED = parseHex('#FF0000'), BLUE = parseHex('#0000FF');

test('instant sets the lamp at once', () => {
  const l = new LdjLamps(2);
  l.set(0, RED, 1, { kind: 'instant' });
  assert.deepStrictEqual(l.read(0), { colour: RED, bri: 1 });
});

test("one-beat fades at 120 BPM step by 1/11 and snap at the end", () => {
  const l = new LdjLamps(1);
  l.set(0, RED, 1, { kind: 'fade', beats: 1 }, 0);
  assert.strictEqual(l.advance(LDJ_FRAME_MS * 5.5, 120), 5, 'five whole frames, the half carried');
  assert.strictEqual(l.read(0).bri, 0.5454543828964233, 'float32 updates');
  l.advance(LDJ_FRAME_MS * 6, 120);
  assert.strictEqual(l.read(0).bri, 0);
});

test('between whole frames the lamp holds its last frame', () => {
  const l = new LdjLamps(1);
  l.set(0, RED, 1, { kind: 'fade', beats: 1 }, 0);
  l.advance(LDJ_FRAME_MS * 0.9, 120);
  assert.strictEqual(l.read(0).bri, 1);
});

test("matrix envelopes follow whole-frame phases", () => {
  const l = new LdjLamps(1);
  l.set(0, RED, 1, { kind: 'matrix', fadeIn: 0, peak: 350, fadeOut: 0, baseline: 0 });
  assert.strictEqual(l.read(0).bri, 1, 'fadeIn 0 → full at once');
  l.advance(LDJ_FRAME_MS * 14, 120);                  // ⌊350/22⌋ = 15 peak frames
  assert.strictEqual(l.read(0).bri, 1);
  l.advance(LDJ_FRAME_MS, 120);
  assert.strictEqual(l.read(0).bri, 0, 'fadeOut 0 → baseline at once');
  const f = new LdjLamps(1);
  f.set(0, RED, 1, { kind: 'matrix', fadeIn: 0, peak: 10, fadeOut: 0, baseline: 0.05 });
  assert.strictEqual(f.read(0).bri, 1, 'peak 10 → one frame, as the app floors to at least one');
  f.advance(LDJ_FRAME_MS, 120);
  assert.ok(Math.abs(f.read(0).bri - 0.05) < 1e-8, 'then the baseline');
});

test('two-way reverses at the end', () => {
  const l = new LdjLamps(1);
  l.set(0, RED, 1, { kind: 'twoWay', beats: 1 });
  l.advance(250, 120);
  assert.ok(l.read(0).bri > 0 && l.read(0).bri < 1);
  l.advance(500, 120);
  assert.ok(l.read(0).bri > 0 && l.read(0).bri < 1, 'return leg');
  l.advance(500, 120);
  assert.strictEqual(l.read(0).bri, 0, 'one excursion, then rest');
});

test('blend interpolates colour linearly in RGB over (int)(durationSec·22) steps', () => {
  const l = new LdjLamps(1);
  l.set(0, RED, 1, { kind: 'instant' });
  l.set(0, BLUE, 1, { kind: 'blend', beats: 1 });
  l.advance(250, 120);
  const c = l.read(0).colour;
  assert.ok(c.r > 0 && c.b > 0 && Math.abs(c.r + c.b - 255) <= 2);
});

test('a delayed start waits its frames', () => {
  const l = new LdjLamps(1);
  l.set(0, RED, 1, { kind: 'instant' }, 5);
  l.advance(LDJ_FRAME_MS * 4, 120);
  assert.strictEqual(l.read(0).bri, 0);
  l.advance(LDJ_FRAME_MS * 2, 120);
  assert.strictEqual(l.read(0).bri, 1);
});

test("stepClock rebases tempo at the next iteration", () => {
  assert.strictEqual(stepClock(2.3, 0.25, 120, null).iter, 9);
  assert.strictEqual(stepClock(2.3, 0.25, 120, 8).changed, true);
  assert.strictEqual(stepClock(2.3, 0.25, 120, 9).changed, false);
  assert.strictEqual(stepClock(2.3, 0.25, 128, 9).stepMs, 60000 / 128 / 4);
  assert.strictEqual(stepClock(2.3, 0.25, 128, 9).iter, 9, 'the beat position decides the step, not the tempo');
});

test('wallClock: 100 ms period', () => {
  assert.strictEqual(wallClock(250, 100, null).iter, 2);
});

test('musical clocks reject unsupported cadences and unsafe iterations before replay', () => {
  registerKind(makeLdjKind('ClockBounds', { cadence: 1, step() { throw new Error('invalid clocks must not emit'); } }));
  for (const cadence of [Number.MIN_VALUE, 0.124, 0, -1, NaN, Infinity]) {
    assert.throws(() => validateSpec({ kind: 'ldj.ClockBounds', params: { cadence } }));
    assert.throws(() => stepClock(1, cadence, 120, 0), RangeError);
  }
  assert.strictEqual(validateSpec({ kind: 'ldj.ClockBounds', params: { cadence: 0.125 } }).params.cadence, 0.125);
  for (const pos of [NaN, Infinity, -Infinity, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => stepClock(pos, 1, 120, null), RangeError);
    assert.throws(() => wallClock(pos, 1, null), RangeError);
  }
  for (const period of [0, -1, NaN, Infinity]) assert.throws(() => wallClock(0, period, null), RangeError);
  const room = roomAt([[0.5, 0.5]]);
  assert.throws(() => draw(instance('ldj.ClockBounds'), frame({ beatPos: Number.MAX_VALUE }), room, new EffectStepper()), RangeError);
  const raw = instance('ldj.ClockBounds');
  raw.spec.params.cadence = Number.MIN_VALUE;
  assert.throws(() => draw(raw, frame({ beatPos: 1 }), room, new EffectStepper()), RangeError);
});

test("palette roles use primary second and secondary first", () => {
  assert.deepStrictEqual(roles([RED, BLUE]).p, BLUE);
  assert.deepStrictEqual(roles([RED, BLUE]).s, RED);
  assert.deepStrictEqual(roles([RED]).p, RED);
});

test("delayed changes activate after the old fade runs its delay", () => {
  const l = new LdjLamps(1);
  l.set(0, RED, 1, { kind: 'fade', beats: 1 });
  l.set(0, BLUE, 1, { kind: 'instant' }, 5);
  l.advance(5 * LDJ_FRAME_MS, 120);
  assert.deepStrictEqual(l.read(0).colour, RED);
  assert.strictEqual(l.read(0).bri, 0.5454543828964233);
  l.advance(LDJ_FRAME_MS, 120);
  assert.deepStrictEqual(l.read(0), { colour: BLUE, bri: 1 });
});

test('active and pending fades retain scheduling tempo', () => {
  const active = new LdjLamps(1), pending = new LdjLamps(1);
  active.set(0, RED, 1, { kind: 'fade', beats: 1 });
  pending.set(0, RED, 1, { kind: 'fade', beats: 1 }, 5);
  active.advance(LDJ_FRAME_MS, 120); pending.advance(LDJ_FRAME_MS, 120);
  active.advance(4 * LDJ_FRAME_MS, 240); pending.advance(4 * LDJ_FRAME_MS, 240);
  assert.strictEqual(active.read(0).bri, 0.5454543828964233);
  pending.advance(LDJ_FRAME_MS, 240);
  assert.strictEqual(pending.read(0).bri, Math.fround(1 - Math.fround(1 / 11)));
  active.set(0, BLUE, 1, { kind: 'fade', beats: 1 });
  active.advance(LDJ_FRAME_MS, 240);
  assert.strictEqual(active.read(0).bri, Math.fround(1 - Math.fround(1 / 5.5)), 'new fades use new tempo');
});

test('a delayed single-frame matrix peak is visible on frame six, then gone on seven', () => {
  const l = new LdjLamps(1);
  l.set(0, RED, 1, { kind: 'matrix', fadeIn: 0, peak: 10, fadeOut: 0 }, 5);
  l.advance(5 * LDJ_FRAME_MS, 120);
  assert.strictEqual(l.read(0).bri, 0);
  l.advance(LDJ_FRAME_MS, 120);
  assert.strictEqual(l.read(0).bri, 1);
  l.advance(LDJ_FRAME_MS, 120);
  assert.strictEqual(l.read(0).bri, 0);
});

test("matrix requests retain a full peak after the next frame boundary", () => {
  const stepper = new EffectStepper(), l = stepper.get('fractional-peak', () => new LdjLamps(2), 0);
  l.set(0, BLUE, 0.5, { kind: 'instant' });
  l.set(1, RED, 1, { kind: 'fade', beats: 1 });
  l.advance(LDJ_FRAME_MS / 2, 120);
  l.set(0, RED, 1, { kind: 'matrix', fadeIn: 0, peak: 10, fadeOut: 0 });
  assert.deepStrictEqual(l.read(0), { colour: BLUE, bri: 0.5 }, 'keep the previous output until a whole frame');
  const clone = stepper.clone().get('fractional-peak', () => null, 0);
  for (const lamps of [l, clone]) {
    lamps.advance(LDJ_FRAME_MS / 2, 120);
    assert.deepStrictEqual(lamps.read(0), { colour: RED, bri: 1 }, 'activation exposes frame zero');
    assert.strictEqual(lamps.read(1).bri, Math.fround(1 - Math.fround(1 / 11)), 'other lamps retain their frame timing');
    lamps.advance(LDJ_FRAME_MS / 2, 120);
    assert.strictEqual(lamps.read(0).bri, 1, 'the peak lasts a full frame from activation');
    lamps.advance(LDJ_FRAME_MS / 2, 120);
    assert.strictEqual(lamps.read(0).bri, 0);
    assert.ok(lamps.read(1).bri < 0.82 && lamps.read(1).bri > 0.81);
  }
  assert.deepStrictEqual(clone.read(0), l.read(0));
});

test('matrix fade-in and fade-out use literal integer frame counts and a baseline', () => {
  const l = new LdjLamps(1);
  l.set(0, RED, 1, { kind: 'matrix', fadeIn: 44, peak: 44, fadeOut: 44, baseline: 0.1 });
  l.advance(LDJ_FRAME_MS, 120);
  assert.strictEqual(l.read(0).bri, Math.fround(Math.fround(0.1) + 0.5));
  l.advance(LDJ_FRAME_MS, 120);
  assert.strictEqual(l.read(0).bri, 1);
  l.advance(LDJ_FRAME_MS, 120);
  assert.strictEqual(l.read(0).bri, 1);
  l.advance(LDJ_FRAME_MS, 120);
  assert.strictEqual(l.read(0).bri, 0.5);
  l.advance(LDJ_FRAME_MS, 120);
  assert.strictEqual(l.read(0).bri, Math.fround(0.1));
});

test("flare and blend reach their targets after integer durations", () => {
  const l = new LdjLamps(1);
  l.set(0, RED, 1, { kind: 'flare', beats: 1 });
  assert.strictEqual(l.read(0).bri, 0);
  l.advance(6 * LDJ_FRAME_MS, 120);
  assert.ok(l.read(0).bri > 0.5 && l.read(0).bri < 0.6);
  l.advance(6 * LDJ_FRAME_MS, 120);
  assert.strictEqual(l.read(0).bri, 1);
  l.set(0, BLUE, 1, { kind: 'blend', beats: 1 });
  l.advance(5 * LDJ_FRAME_MS, 120);
  assert.deepStrictEqual(l.read(0).colour, { r: 139, g: 0, b: 116, w: 0, a: 0, uv: 0 });
  l.advance(6 * LDJ_FRAME_MS, 120);
  assert.deepStrictEqual(l.read(0).colour, BLUE);
});

test("lamp clones retain independent transitions and fractional time", () => {
  const stepper = new EffectStepper();
  const l = stepper.get('lamps', () => new LdjLamps(1), 0);
  l.set(0, RED, 1, { kind: 'fade', beats: 1 });
  l.advance(LDJ_FRAME_MS / 2, 120);
  const copy = stepper.clone().get('lamps', () => null, 0);
  assert.ok(copy instanceof LdjLamps);
  assert.strictEqual(copy.advance(LDJ_FRAME_MS / 2, 120), 1);
  assert.strictEqual(l.read(0).bri, 1);
  assert.strictEqual(copy.read(0).bri, Math.fround(1 - Math.fround(1 / 11)));
});

test("lamp off cancels pending changes", () => {
  const stepper = new EffectStepper();
  const l = stepper.get('lamps', () => new LdjLamps(1), 0);
  l.set(0, RED, 1, { kind: 'fade', beats: 1 });
  l.advance(LDJ_FRAME_MS / 2, 120);
  l.set(0, BLUE, 1, { kind: 'instant' }, 2);
  l.off(0);
  l.advance(4 * LDJ_FRAME_MS, 120);
  assert.strictEqual(l.read(0).bri, 0);
});

const roomAt = (points) => buildRoom(points.length, (i) => points[i][0], (i) => points[i][1], (i) => points[i][2] ?? 0.5, null);
const square = () => roomAt([[0, 0], [1, 0], [1, 1], [0, 1]]);

test("LDJ channels follow their assigned geometry", () => {
  const room = square();
  assert.deepStrictEqual(ldjChannels(room, 4), [0, 2, 3, 1]);
  assert.deepStrictEqual(ldjChannels(room, 'width'), [0, 1, 1, 0]);
  assert.deepStrictEqual(ldjChannels(room, 'depth'), [1, 1, 0, 0]);
  assert.deepStrictEqual(ldjChannels(room, 1), [0, 0, 0, 0]);
  assert.deepStrictEqual(ldjChannels(room, 'lights'), [0, 1, 2, 3]);
  assert.deepStrictEqual(ldjChannels(room, 'colours', 4), [0, 1, 2, 3]);
  assert.deepStrictEqual(ldjChannels(roomAt([[0.5, 0.5]]), 4), [0]);
});

test("LDJ assignment balances nearest channels with stable ties", () => {
  const ties = roomAt(Array.from({ length: 5 }, (_, i) => [0.5, 0.5, i / 4]));
  assert.deepStrictEqual(ldjChannels(ties, 2), [0, 1, 0, 1, 0]);
  const room = roomAt([[0, 0], [0.1, 0], [0.2, 0], [0.3, 0], [1, 1]]);
  assert.deepStrictEqual(ldjChannels(room, 2), [0, 0, 0, 1, 1]);
  assert.deepStrictEqual(ldjChannels(ties, 4), [0, 1, 2, 3, 0]);
});

test("six and eight colour channels retain balanced contiguous groups", () => {
  const room = roomAt(Array.from({ length: 9 }, (_, i) => [i / 8, 0.5]));
  assert.deepStrictEqual(ldjChannels(room, 'colours', 6), [0, 0, 1, 1, 2, 2, 3, 4, 5]);
  assert.deepStrictEqual(ldjChannels(room, 'colours', 8), [0, 0, 1, 2, 3, 4, 5, 6, 7]);
});

const frame = (over = {}) => ({ beatPos: 0, bpm: 120, nowMs: 0, dtMs: 0, anchorBeat: 0, lookPalette: [RED, BLUE], paletteOverride: null,
  audio: null, audioMode: 'tempo', master: HD_MASTER_DEFAULTS, seed: seedFrom('caller'), acknowledged: true, hueStrobe: 'pulse', ...over });
const instance = (kind, over = {}) => ({ id: kind, spec: validateSpec({ kind }), seed: seedFrom('instance'), anchorBeat: 0, startedAtMs: 0, targets: null, ...over });
const draw = (inst, f, room, stepper) => { const out = []; renderEffect(inst, f, room, stepper, out); return out; };

test("row factories run once per beat step", () => {
  const calls = [];
  registerKind(makeLdjKind('EngineTest', { cadence: 0.5, channels: 4, step: (ctx) => {
    calls.push({ iter: ctx.iter, channels: ctx.channelOf, seed: ctx.seed });
    ctx.lamps.set(0, ctx.p, 1, { kind: 'instant' });
  } }));
  const inst = instance('ldj.EngineTest'), s = new EffectStepper(), room = square();
  const first = draw(inst, frame(), room, s);
  assert.deepStrictEqual(first.map((slot) => slot.level), [1, 0, 0, 0]);
  assert.ok(first.every((slot) => slot.strength === 1));
  draw(inst, frame({ beatPos: 0.49, nowMs: 245, dtMs: 245 }), room, s);
  draw(inst, frame({ beatPos: 0.5, nowMs: 250, dtMs: 5, bpm: 128 }), room, s);
  assert.deepStrictEqual(calls.map((c) => c.iter), [0, 1]);
  assert.deepStrictEqual(calls[0].channels, [0, 2, 3, 1]);
  assert.deepStrictEqual(calls[0].seed, inst.seed);
  assert.deepStrictEqual(roles([RED]).at(17), RED);
  assert.deepStrictEqual(roles([RED, BLUE]).at(-1), BLUE);
});

test("wall rows start at launch independently of tempo", () => {
  const calls = [];
  registerKind(makeLdjKind('WallTest', { cadence: 'wall:50', rapidFlash: true, step: (ctx) => {
    calls.push(ctx.iter); ctx.lamps.set(0, RED, ctx.iter % 2 === 0 ? 1 : 0, { kind: 'instant' });
  } }));
  const room = roomAt([[0.5, 0.5]]), s = new EffectStepper(), inst = instance('ldj.WallTest', { startedAtMs: 100 });
  assert.strictEqual(draw(inst, frame({ nowMs: 160, startedAtMs: 160 }), room, s)[0].level, 0);
  assert.strictEqual(draw(inst, frame({ nowMs: 210, dtMs: 50, bpm: 200 }), room, s)[0].level, 1);
  assert.deepStrictEqual(calls, [1, 2]);
  assert.strictEqual(draw({ ...inst, id: 'wall-zero', startedAtMs: 0 }, frame({ nowMs: 60 }), room, new EffectStepper())[0].level, 0);
  assert.deepStrictEqual(draw({ ...inst, id: 'unack' }, frame({ acknowledged: false }), room, new EffectStepper()), []);
});

test("matrix peak colour lasts its exact whole frames", () => {
  const stepper = new EffectStepper(), l = stepper.get('peak', () => new LdjLamps(1), 0);
  l.set(0, RED, 1, { kind: 'matrix', fadeIn: 450, peak: 100, fadeOut: 450, peakColour: BLUE });
  l.advance(19 * LDJ_FRAME_MS, 120);
  assert.deepStrictEqual(l.read(0).colour, RED);
  l.advance(LDJ_FRAME_MS, 120);
  assert.deepStrictEqual(l.read(0).colour, BLUE);
  const clone = stepper.clone().get('peak', () => null, 0);
  l.advance(3 * LDJ_FRAME_MS, 120);
  assert.deepStrictEqual(l.read(0).colour, BLUE);
  l.advance(LDJ_FRAME_MS, 120);
  assert.deepStrictEqual(l.read(0).colour, RED);
  clone.advance(4 * LDJ_FRAME_MS, 120);
  assert.deepStrictEqual(clone.read(0), l.read(0));
  l.set(0, RED, 1, { kind: 'matrix', fadeIn: 0, peak: 10, fadeOut: 0, peakColour: BLUE });
  assert.deepStrictEqual(l.read(0).colour, BLUE);
  l.advance(0, 120);
  assert.strictEqual(l.read(0).bri, 1);
  l.advance(LDJ_FRAME_MS, 120);
  assert.deepStrictEqual(l.read(0), { colour: RED, bri: 0 });
});

test("new fades start aging at their deadline", () => {
  registerKind(makeLdjKind('FreshFade', { cadence: 1, step: (ctx) => {
    ctx.lamps.set(ctx.iter % 2, ctx.p, 1, { kind: 'fade', beats: 2 });
  } }));
  const room = square(), s = new EffectStepper(), inst = instance('ldj.FreshFade');
  draw(inst, frame(), room, s);
  const boundary = draw(inst, frame({ beatPos: 1, nowMs: 500, dtMs: 500 }), room, s);
  assert.strictEqual(boundary[1].level, 1);
  assert.ok(boundary[0].level > 0.49 && boundary[0].level < 0.51);
  const after = draw(inst, frame({ beatPos: 1.2, nowMs: 600, dtMs: 100 }), room, s);
  assert.ok(after[1].level > 0.90 && after[1].level < 0.92);
  assert.ok(after[0].level < boundary[0].level);
});

test("variable wall callbacks replay their event-time context", () => {
  const events = [];
  registerKind(makeLdjKind('Variable', { cadence: 1, beats: 32, nextDelayMs: (ctx) => ctx.iter % 2 ? 150 : 100,
    step: (ctx) => { events.push([ctx.iter, ctx.nowMs, ctx.elapsedMs, ctx.params.beats]); ctx.lamps.set(0, ctx.p, 1, { kind: 'fade', beats: 1 }); } }));
  const room = roomAt([[0.5, 0.5]]), s = new EffectStepper(), inst = instance('ldj.Variable', { startedAtMs: 1000 });
  const out = draw(inst, frame({ nowMs: 1380, bpm: 120 }), room, s);
  assert.deepStrictEqual(events, [[0, 1000, 0, 32], [1, 1100, 100, 32], [2, 1250, 250, 32], [3, 1350, 350, 32]]);
  assert.ok(out[0].level > 0.90 && out[0].level <= 1, 'only the trailing30ms ages the current pulse');
  const clone = s.clone();
  events.length = 0;
  const a = draw(inst, frame({ nowMs: 1530, dtMs: 150, bpm: 240 }), room, s);
  assert.deepStrictEqual(events, [[4, 1500, 500, 32]], 'new BPM never moves wall deadlines');
  const b = draw(inst, frame({ nowMs: 1530, dtMs: 150, bpm: 240 }), room, clone);
  assert.deepStrictEqual(a, b);
});

test('variable wall schedules reject invalid or non-progressing deadlines', () => {
  const room = roomAt([[0.5, 0.5]]);
  for (const [i, delay] of [0, -1, NaN, Infinity].entries()) {
    registerKind(makeLdjKind(`BadDelay${i}`, { cadence: 1, nextDelayMs: () => delay, step() {} }));
    assert.throws(() => draw(instance(`ldj.BadDelay${i}`), frame(), room, new EffectStepper()), RangeError);
  }
  registerKind(makeLdjKind('NoProgress', { cadence: 1, nextDelayMs: () => 1, step() {} }));
  assert.throws(() => draw(instance('ldj.NoProgress', { startedAtMs: 1e20 }), frame({ nowMs: 1e20 }), room, new EffectStepper()), RangeError);
});

test("cloned schedules preserve queued random rerolls", () => {
  const seen = [];
  registerKind(makeLdjKind('Reroll', { cadence: 1, nextDelayMs: () => 100, step: (ctx) => {
    seen.push(ctx.p); ctx.lamps.set(0, ctx.p, 1, { kind: 'instant' }); ctx.reroll();
  } }));
  const room = roomAt([[0.5, 0.5]]), s = new EffectStepper();
  const inst = instance('ldj.Reroll'); inst.spec.palette = [{ random: true }];
  draw(inst, frame({ nowMs: 250 }), room, s);
  assert.strictEqual(seen.length, 3);
  assert.deepStrictEqual(seen[0], seen[1]);
  assert.deepStrictEqual(seen[1], seen[2]);
  assert.strictEqual(s.get(inst.id, () => null, 250).roll, 3);
  const clone = s.clone();
  const a = draw(inst, frame({ nowMs: 350, dtMs: 100 }), room, s);
  const b = draw(inst, frame({ nowMs: 350, dtMs: 100 }), room, clone);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(s.get(inst.id, () => null, 350).roll, 4);
});

test("fades retain full-scale increments above a nonzero baseline", () => {
  const stepper = new EffectStepper(), l = stepper.get('baseline', () => new LdjLamps(1), 0);
  l.set(0, RED, 1, { kind: 'fade', beats: 1, baseline: 0.05 });
  l.advance(LDJ_FRAME_MS, 120);
  assert.strictEqual(l.read(0).bri, Math.fround(1 - Math.fround(1 / 11)));
  l.advance(4 * LDJ_FRAME_MS, 120);
  assert.strictEqual(l.read(0).bri, 0.5454543828964233);
  const clone = stepper.clone().get('baseline', () => null, 0);
  l.advance(6 * LDJ_FRAME_MS, 240);
  clone.advance(6 * LDJ_FRAME_MS, 240);
  assert.strictEqual(l.read(0).bri, Math.fround(0.05));
  assert.deepStrictEqual(clone.read(0), l.read(0));
  l.advance(10 * LDJ_FRAME_MS, 120);
  assert.strictEqual(l.read(0).bri, Math.fround(0.05));
});

test("fixed-palette cold replay matches dense rendering", () => {
  registerKind(makeLdjKind('Replay', { cadence: 1, nextDelayMs: (ctx) => [110, 175, 90][ctx.iter % 3], step: (ctx) => {
    const i = ctx.iter % ctx.n;
    ctx.lamps.set(i, RED, 1, { kind: 'instant' });
    ctx.lamps.set(i, BLUE, 1, { kind: 'blend', beats: 0.5 });
  } }));
  const room = square(), inst = instance('ldj.Replay'), sparse = new EffectStepper(), dense = new EffectStepper();
  const a = draw(inst, frame({ nowMs: 637 }), room, sparse);
  for (let nowMs = 0; nowMs < 637; nowMs += 13) draw(inst, frame({ nowMs, dtMs: 13 }), room, dense);
  const b = draw(inst, frame({ nowMs: 637, dtMs: 0 }), room, dense);
  assert.deepStrictEqual(a, b);
  assert.ok(a.some((slot) => slot.colour.r > 0 && slot.colour.b > 0));
});

test("finite rows stop callbacks at their count", () => {
  const calls = [];
  registerKind(makeLdjKind('Finite', { cadence: 0.25, step: (ctx) => {
    calls.push([ctx.iter, ctx.nowMs]);
    ctx.lamps.set(0, ctx.p, 1, { kind: 'fade', beats: 0.5 });
    ctx.refresh(0);
  } }));
  const room = roomAt([[0.5, 0.5]]), s = new EffectStepper();
  const inst = { ...instance('ldj.Finite'), spec: validateSpec({ kind: 'ldj.Finite', params: { cadence: 0.25, iterations: 2 } }) };
  const levels = [];
  for (let ms = 0; ms <= 1000; ms += 1000 / 44) levels.push(draw(inst, frame({ beatPos: ms / 500, nowMs: ms }), room, s)[0].level);
  assert.deepStrictEqual(calls.map(([iter]) => iter), [0, 1]);
  assert.ok(calls[1][1] >= 125 && calls[1][1] < 125 + 1000 / 44);
  assert.ok(levels.at(-1) === 0 && levels.slice(10, 14).some((level) => level > 0 && level < 1), 'the last fade still runs out');
  // Unlimited rows keep their first-floor start: a cold render calls back the current step only.
  calls.length = 0;
  draw(instance('ldj.Finite'), frame({ beatPos: 2.3, nowMs: 1150 }), room, new EffectStepper());
  assert.deepStrictEqual(calls, [[9, 1125]]);
});

test("finite row cold replay matches dense rendering", () => {
  const calls = [];
  registerKind(makeLdjKind('FiniteFlip', { cadence: 0.9, channels: 1, step: (ctx) => {
    calls.push([ctx.iter, ctx.nowMs]);
    ctx.lamps.set(0, ctx.colour(ctx.iter % 2), 1, { kind: 'instant' });
    ctx.lamps.set(1, ctx.p, 1, { kind: 'fade', beats: 1 });
  } }));
  const room = roomAt([[0, 0.5], [1, 0.5]]);
  const spec = validateSpec({ kind: 'ldj.FiniteFlip', params: { cadence: 0.9, iterations: 4 } });
  const inst = { ...instance('ldj.FiniteFlip'), spec, anchorBeat: 1, startedAtMs: 500 };
  for (const beat of [2.5, 3.3, 4.5, 5.3, 9]) {
    calls.length = 0;
    const cold = draw(inst, frame({ beatPos: beat, nowMs: beat * 500 }), room, new EffectStepper());
    const count = Math.min(4, Math.floor((beat - 1) / 0.9) + 1);
    assert.deepStrictEqual(calls.map(([iter]) => iter), Array.from({ length: count }, (_, i) => i), `cold at ${beat}`);
    calls.forEach(([iter, at]) => assert.ok(Math.abs(at - (1 + iter * 0.9) * 500) < 1e-6, `callback ${iter} at ${at}`));
    const dense = new EffectStepper();
    for (let ms = 500; ms < beat * 500; ms += 1000 / 44) draw(inst, frame({ beatPos: ms / 500, nowMs: ms }), room, dense);
    assert.deepStrictEqual(cold, draw(inst, frame({ beatPos: beat, nowMs: beat * 500 }), room, dense), `dense at ${beat}`);
  }
  // Before its anchor nothing is called; the first callback lands between the samples around it.
  calls.length = 0;
  const s = new EffectStepper();
  draw(inst, frame({ beatPos: 0.5, nowMs: 250 }), room, s);
  draw(inst, frame({ beatPos: 0.8, nowMs: 400 }), room, s);
  assert.deepStrictEqual(calls, []);
  draw(inst, frame({ beatPos: 1.2, nowMs: 600 }), room, s);
  assert.deepStrictEqual(calls.map(([iter]) => iter), [0]);
  assert.ok(Math.abs(calls[0][1] - 500) < 1e-9);
  // After the count a clone holds the same tail.
  for (const beat of [5, 6, 7]) draw(inst, frame({ beatPos: beat, nowMs: beat * 500 }), room, s);
  const clone = s.clone();
  assert.deepStrictEqual(draw(inst, frame({ beatPos: 8, nowMs: 4000 }), room, s), draw(inst, frame({ beatPos: 8, nowMs: 4000 }), room, clone));
  assert.deepStrictEqual(calls.map(([iter]) => iter), [0, 1, 2, 3]);
});

test("finite wall rows stop replay at their count", () => {
  const calls = [];
  registerKind(makeLdjKind('FiniteWall', { cadence: 1, nextDelayMs: () => 100, step: (ctx) => { calls.push(ctx.iter); } }));
  const inst = { ...instance('ldj.FiniteWall'), spec: validateSpec({ kind: 'ldj.FiniteWall', params: { cadence: 1, iterations: 3 } }) };
  const s = new EffectStepper();
  draw(inst, frame({ nowMs: 250 }), roomAt([[0.5, 0.5]]), s);
  draw(inst, frame({ nowMs: 60000 }), roomAt([[0.5, 0.5]]), s);
  assert.deepStrictEqual(calls, [0, 1, 2]);
});

test('iterations are a positive safe integer', () => {
  registerKind(makeLdjKind('FiniteBounds', { cadence: 1, step() {} }));
  for (const iterations of [0, -1, 1.5, NaN, Infinity, 2 ** 53, '2']) {
    assert.throws(() => validateSpec({ kind: 'ldj.FiniteBounds', params: { cadence: 1, iterations } }), String(iterations));
  }
  assert.strictEqual(validateSpec({ kind: 'ldj.FiniteBounds', params: { cadence: 1, iterations: 1 } }).params.iterations, 1);
  assert.ok(!('iterations' in validateSpec({ kind: 'ldj.FiniteBounds' }).params), 'unlimited by default');
  assert.strictEqual(validateSpec({ kind: 'ldj.MatrixFlash', params: { cadence: 1, iterations: 5 } }).params.iterations, 5, 'the matrix rows too');
  const raw = instance('ldj.FiniteBounds');
  raw.spec.params.iterations = 0.5;
  assert.throws(() => draw(raw, frame(), roomAt([[0.5, 0.5]]), new EffectStepper()), RangeError);
});

// The channel assignment as first written: every pick scans every lamp for the
// nearest free one. The renderer's is kept per room and sorted per anchor; it
// must pick exactly the same lamps, ties included, on any rig.
function scanChannels(room, selector, paletteCount = 1) {
  const ANCHORS = { 1: [[0, 0]], 2: [[-1, 0], [1, 0]], 3: [[-1, 0], [0, 1], [1, 0]], 4: [[-1, 1], [-1, -1], [1, 1], [1, -1]], 5: [[-1, 1], [-1, -1], [1, 1], [1, -1], [0, 0]] };
  const n = room.n;
  if (n === 0) return [];
  if (selector === 'lights') return Array.from({ length: n }, (_, i) => i);
  const count = selector === 'depth' || selector === 'width' ? 2 : Math.min(n, selector === 'colours' ? Math.max(1, paletteCount) : selector);
  if (selector === 'colours' && count === n) return Array.from({ length: n }, (_, i) => i);
  const capacity = Array.from({ length: count }, (_, i) => Math.floor(n / count) + Number(i < n % count));
  if (count > 5) return capacity.flatMap((size, channel) => Array(size).fill(channel));
  const anchors = selector === 'depth' ? [[0, -1], [0, 1]] : ANCHORS[count];
  const assigned = Array(n).fill(-1), sizes = Array(count).fill(0);
  let remaining = n;
  while (remaining) {
    for (let channel = 0; channel < count; channel++) {
      if (sizes[channel] >= capacity[channel]) continue;
      let best = Infinity, pick = -1;
      for (let i = 0; i < n; i++) {
        if (assigned[i] !== -1) continue;
        const d = Math.hypot(room.u[i] - anchors[channel][0], room.v[i] - anchors[channel][1]);
        if (d < best) { best = d; pick = i; }
      }
      assigned[pick] = channel; sizes[channel]++; remaining--;
    }
  }
  return assigned;
}

test("channel assignment follows the nearest-free scan", () => {
  let seed = 3;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let trial = 0; trial < 60; trial++) {
    const n = 1 + Math.floor(rand() * 40);
    // Some rigs on a coarse grid, so equal distances (ties) are common.
    const coarse = trial % 2 === 0;
    const xs = Array.from({ length: n }, () => (coarse ? Math.floor(rand() * 4) / 3 : rand()));
    const ys = Array.from({ length: n }, () => (coarse ? Math.floor(rand() * 3) / 2 : rand()));
    const room = buildRoom(n, (i) => xs[i] * 100, (i) => ys[i] * 100, () => 0.5, null);
    for (const selector of [1, 2, 3, 4, 5, 'lights', 'colours', 'depth', 'width']) {
      for (const colours of selector === 'colours' ? [1, 2, 3, 5, 6, 8] : [1]) {
        assert.deepStrictEqual(ldjChannels(room, selector, colours), scanChannels(room, selector, colours), `trial ${trial}, n ${n}, ${selector}/${colours}`);
      }
    }
  }
});

test("channel assignments are cached and immutable", () => {
  const room = buildRoom(6, (i) => i * 10, () => 50, () => 0.5, null);
  assert.strictEqual(ldjChannels(room, 4), ldjChannels(room, 4), 'kept with the room');
  assert.throws(() => { ldjChannels(room, 4)[0] = 3; }, TypeError, 'frozen');
});
