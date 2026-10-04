import test from 'node:test';
import assert from 'node:assert/strict';
import { LDJ_CHANNEL_ROWS, FRONT_BACK_SCORE } from '../../src/shared/effects/ldj-channel.ts';
import { kindOf, validateSpec } from '../../src/shared/effects/registry.ts';
import { LDJ_FRAME_MS } from '../../src/shared/effects/ldj-engine.ts';
import { parseHex } from '../../src/shared/effects/palette.ts';
import { run, harness, square, row, isCyan, RED, CYAN } from '../helpers/ldj-harness.js';

const names = `StrobeCycle GrowCycle FadeCycle SoftStrobe FillCycle Split Flip CrossFade Blur DoubleFill FrontBack RotatingHalfs TwoCorners DoubleDrip Glow Drip TriPulse Sketch DoSiDo Trance BeatPulse1 BeatPulse4 Cauldron America SMStudioN1Fill SMStudioN2Fill SMStudioN3Fill SMStudioN4Fill SMStudioN5Fill MatrixSolid QuickFlash SceneMakerFirework`.split(' ');
const lit = (out) => out.flatMap((s, i) => s.level > 0 ? [i] : []);
const levels = (out) => out.map((s) => s.level);
const colors = (out) => out.map((s) => s.level === 0 ? '-' : isCyan(s) ? 'p' : 's');
const atMs = (nowMs, bpm = 120) => ({ nowMs, beatPos: nowMs * bpm / 60000, bpm });
const approximate = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('all 32 channel rows register with valid complete defaults', () => {
  assert.deepEqual(Object.keys(LDJ_CHANNEL_ROWS).sort(), [...names].sort());
  for (const name of names) {
    const kind = kindOf(`ldj.${name}`), spec = validateSpec({ kind: kind.kind });
    assert.equal(spec.params.beats, 32);
    assert.deepEqual(validateSpec(spec), spec);
    assert.ok(kind.stateful);
  }
});

test('Strobe Cycle visits corner indices FL BL FR BR and owns every lamp', () => {
  const frames = run('ldj.StrobeCycle', square(), [0, 1, 2, 3]);
  assert.deepEqual(frames.map((out) => out.findIndex(isCyan)), [0, 3, 1, 2]);
  for (const out of frames) assert.ok(out.every((s) => s.level === 1 && s.strength === 1));
  assert.deepEqual(run('ldj.StrobeCycle', square(), [0], { palette: [RED] }).map(lit), [[0]]);
});

test('Grow Cycle spends one beat at half then full before changing corner', () => {
  const frames = run('ldj.GrowCycle', square(), [0, .5, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(frames.map(lit), [[0], [0], [0], [3], [3], [1], [1], [2], [2]]);
  assert.deepEqual(frames.map((out) => Math.max(...levels(out))), [.5, .5, 1, .5, 1, .5, 1, .5, 1]);
});

test('Fade Cycle and Soft Strobe preserve the specified fade duration and other lamps', () => {
  const [a, b, c] = run('ldj.FadeCycle', square(), [0, .5, 1]);
  assert.deepEqual(lit(a), [0]); approximate(b[0].level, .5454543828964233);
  assert.deepEqual(lit(c), [3]); assert.equal(c[3].level, 1);
  const [soft, half] = run('ldj.SoftStrobe', square(), [0, 1]);
  assert.deepEqual(levels(soft), [1, 1, 1, 1]); approximate(half[0].level, .5);
  assert.deepEqual(levels(half).slice(1), [1, 1, 1]);
});

test('Fill Cycle and Double Fill follow their entire colour and blackout scores', () => {
  assert.deepEqual(run('ldj.FillCycle', square(), Array.from({ length: 8 }, (_, i) => i / 2)).map(colors), [
    ['p', 's', 's', 's'], ['p', 's', 's', 'p'], ['p', 'p', 's', 'p'], ['p', 'p', 'p', 'p'],
    ['s', 'p', 'p', 'p'], ['s', 'p', 'p', 's'], ['s', 's', 'p', 's'], ['s', 's', 's', 's'],
  ]);
  assert.deepEqual(run('ldj.DoubleFill', square(), [0, .5, 1, 1.5, 2]).map(colors), [
    ['s', '-', '-', 's'], ['s', 's', 's', 's'], ['-', 's', 's', '-'], ['-', '-', '-', '-'], ['p', '-', '-', 'p'],
  ]);
});

test('Split and Flip keep the channel colour rules including the unwrapped Flip sum', () => {
  assert.deepEqual(run('ldj.Split', square(), [0, 1]).map(colors), [['s', 'p', 'p', 's'], ['p', 's', 's', 'p']]);
  assert.deepEqual(run('ldj.Flip', square(), [0, 2, 4, 6]).map(colors), [
    ['s', 'p', 's', 'p'], ['p', 's', 'p', 'p'], ['p', 'p', 'p', 's'], ['s', 'p', 'p', 'p'],
  ]);
});

test('Front Back uses the complete sixteen-step back/front score', () => {
  assert.deepEqual(FRONT_BACK_SCORE, [0, 0, 0, 0, 1, 3, 2, 0, 0, 0, 0, 0, 2, 3, 1, 0]);
  const frames = run('ldj.FrontBack', square(), Array.from({ length: 16 }, (_, i) => i / 2));
  assert.deepEqual(frames.map(lit), [[], [], [], [], [2, 3], [0, 1, 2, 3], [0, 1], [], [], [], [], [], [0, 1], [0, 1, 2, 3], [2, 3], []]);
  assert.ok(frames[4].filter((s) => s.level).every(isCyan));
  assert.ok(frames[12].filter((s) => s.level).every((s) => !isCyan(s)));
});

test('Rotating Halfs rotates depth and width with the correct colours', () => {
  assert.deepEqual(run('ldj.RotatingHalfs', square(), [0, 1, 2, 3]).map(colors), [
    ['p', 'p', 's', 's'], ['p', 's', 's', 'p'], ['s', 's', 'p', 'p'], ['s', 'p', 'p', 's'],
  ]);
});

test('CrossFade and Blur blend from explicit colours over four beats', () => {
  const cross = run('ldj.CrossFade', square(), [0, 2, 4, 6, 8]);
  assert.deepEqual(cross[0][0].colour, RED); assert.deepEqual(cross[2][0].colour, CYAN); assert.deepEqual(cross[4][0].colour, RED);
  assert.deepEqual(cross[1][0].colour, parseHex('#808080'));
  const blur = run('ldj.Blur', square(), [0, 2, 4, 8, 12]);
  assert.deepEqual(colors(blur[0]), ['s', 'p', 's', 'p']);
  assert.ok(blur[1].every((s) => s.colour.r === 128 && s.colour.g === 128));
  assert.deepEqual(colors(blur[2]), ['p', 's', 'p', 's']);
  assert.deepEqual(colors(blur[3]), colors(blur[0])); assert.deepEqual(colors(blur[4]), colors(blur[2]));
});

test('random CrossFade endpoints stay continuous and clones keep their own blend state', () => {
  const h = harness('ldj.CrossFade', square(), { spec: { palette: [{ random: true }, { random: true }] } });
  h.draw(0); h.draw(3.99);
  const previousTarget = h.state().scratch.crossTarget;
  const cloned = h.stepper.clone();
  const next = h.draw(4);
  assert.deepEqual(next[0].colour, previousTarget);
  assert.deepEqual(h.draw(4, cloned), next);
});

test('Two Corners uses distinct channels, avoids the prior pair and is reproducible', () => {
  const frames = run('ldj.TwoCorners', square(), Array.from({ length: 12 }, (_, i) => i));
  for (let i = 0; i < frames.length; i++) {
    assert.equal(lit(frames[i]).length, 2);
    if (i) assert.notDeepEqual(lit(frames[i]), lit(frames[i - 1]));
    assert.equal(frames[i].filter((s) => s.level && isCyan(s)).length, 1);
  }
  assert.deepEqual(frames, run('ldj.TwoCorners', square(), Array.from({ length: 12 }, (_, i) => i)));
});

test('Double Drip leaves the previous half fading and alternates its four colours', () => {
  const frames = run('ldj.DoubleDrip', square(), [0, 1, 2, 3]);
  assert.deepEqual(lit(frames[0]), [0, 3]); assert.ok(isCyan(frames[0][0]));
  approximate(frames[1][0].level, .5); assert.equal(frames[1][1].level, 1); assert.ok(!isCyan(frames[1][1]));
  assert.ok(!isCyan(frames[2][0])); assert.ok(isCyan(frames[3][1]));
});

test('Glow rises and returns once; Drip changes colour every two beats', () => {
  const frames = run('ldj.Glow', row(1), [0, 1, 2, 3, 3.99]);
  assert.equal(frames[0][0].level, 0); approximate(frames[1][0].level, .5); approximate(frames[2][0].level, 1);
  approximate(frames[3][0].level, .5); assert.ok(frames[4][0].level < .1);
  const drip = run('ldj.Drip', row(1), [0, 1, 2]);
  assert.deepEqual(drip[0][0].colour, RED); approximate(drip[1][0].level, .5); assert.deepEqual(drip[2][0].colour, CYAN);
});

test('Tri-Pulse exposes three whole-frame pulses and rests near .1 for the rest of three beats', () => {
  const frames = run('ldj.TriPulse', square(), [0, .56, 1.02, 1.6, 2.4, 3.02]);
  for (const i of [0, 1, 2, 5]) assert.ok(frames[i][0].level > .9, String(i));
  for (const i of [3, 4]) approximate(frames[i][0].level, .1, .02);
});

test('Sketch has four brightness steps per corner and Do Si Do swaps both roles', () => {
  const sketch = run('ldj.Sketch', square(), Array.from({ length: 16 }, (_, i) => i / 4));
  assert.deepEqual(sketch.map((out) => Math.max(...levels(out))), Array(4).fill([0, .25, .5, .75]).flat());
  assert.deepEqual([3, 7, 11, 15].map((i) => lit(sketch[i])[0]), [0, 3, 1, 2]);
  assert.deepEqual(run('ldj.DoSiDo', square(), [0, .5]).map(colors), [['s', 'p', 'p', 'p'], ['p', 'p', 'p', 's']]);
});

test('Trance and America slow to four beats above twenty lamps', () => {
  for (const name of ['Trance', 'America']) {
    const small = run(`ldj.${name}`, row(20), [0, 2, 4]);
    const large = run(`ldj.${name}`, row(21), [0, 2, 4]);
    assert.notDeepEqual(small[0][0].colour, small[1][0].colour);
    assert.deepEqual(large[0][0].colour, large[1][0].colour);
    assert.deepEqual(large[2][0].colour, small[1][0].colour);
  }
  const america = run('ldj.America', row(1), [0, 2, 4]);
  assert.deepEqual(america.map((out) => out[0].colour), [RED, parseHex('#FFFFFF'), parseHex('#2A00FF')]);
});

test('Beat Pulse durations use their fixed matrix literals and gate rapid rows', () => {
  const short = run('ldj.BeatPulse1', row(1), [0, atMs(LDJ_FRAME_MS * 4)], { params: { cadence: 4 } });
  const long = run('ldj.BeatPulse4', row(1), [0, atMs(LDJ_FRAME_MS * 4)], { params: { cadence: 4 } });
  assert.equal(short[1][0].level, 0); assert.equal(long[1][0].level, 1);
  for (const name of names.filter((name) => LDJ_CHANNEL_ROWS[name].rapidFlash)) {
    assert.ok(run(`ldj.${name}`, square(), [0], { acknowledged: false })[0].every((s) => s.strength === 0), name);
  }
});

test('Cauldron picks different lamps, uses primary and keeps older tails', () => {
  const h = harness('ldj.Cauldron', square()); const picks = [];
  for (const b of [0, .5, 1, 1.5]) { h.draw(b); picks.push(h.state().lastPick); }
  for (let i = 1; i < picks.length; i++) assert.notEqual(picks[i], picks[i - 1]);
  const out = h.draw(1.6); assert.ok(lit(out).length > 1); assert.ok(out.filter((s) => s.level).every(isCyan));
});

test('all five Studio Fill durations are musical and independent of row lifetime', () => {
  for (const [i, beats] of [1, 2, 4, 6, 8].entries()) {
    const frames = run(`ldj.SMStudioN${i + 1}Fill`, row(1), [0, beats / 2, beats], { params: { beats: 100 } });
    assert.equal(frames[0][0].level, 1); approximate(frames[1][0].level, .5, .06); assert.equal(frames[2][0].level, 1);
  }
});

test('Matrix Solid retains six and eight palette channels on nine lamps', () => {
  const palette = ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#00FFFF', '#FF00FF', '#FFFFFF', '#808080'].map(parseHex);
  for (const [n, map] of [[6, [0, 0, 1, 1, 2, 2, 3, 4, 5]], [8, [0, 0, 1, 2, 3, 4, 5, 6, 7]]]) {
    assert.deepEqual(run('ldj.MatrixSolid', row(9), [0], { palette: palette.slice(0, n) })[0].map((s) => s.colour), map.map((i) => palette[i]));
  }
});

test('Quick Flash rises in secondary, holds primary, and releases secondary', () => {
  const frames = run('ldj.QuickFlash', square(), [0, atMs(LDJ_FRAME_MS * 19), atMs(LDJ_FRAME_MS * 20), atMs(LDJ_FRAME_MS * 23), atMs(LDJ_FRAME_MS * 24)]);
  assert.equal(frames[0][0].level, 0); assert.deepEqual(frames[1][0].colour, RED);
  assert.deepEqual(frames[2][0].colour, CYAN); assert.equal(frames[2][0].level, 1);
  assert.deepEqual(frames[3][0].colour, CYAN); assert.deepEqual(frames[4][0].colour, RED);
});

test('Scene Maker Firework uses bounded seeded wall delays and ignores musical tempo', () => {
  const times = Array.from({ length: 41 }, (_, i) => i * 50);
  const a = harness('ldj.SceneMakerFirework', square()); const b = harness('ldj.SceneMakerFirework', square(), { bpm: 80 });
  assert.deepEqual(times.map((t) => a.draw(atMs(t))), times.map((t) => b.draw(atMs(t, 80))));
  for (const count of [1, 4]) {
    const h = harness('ldj.SceneMakerFirework', row(count)); h.draw(atMs(0)); let previous = null;
    for (let i = 0; i < 8; i++) {
      const state = h.state(), timing = state.timing;
      if (previous !== null && count > 1) assert.notEqual(state.lastPick, previous);
      previous = state.lastPick;
      const gap = timing.nextDueMs - timing.lastMs;
      assert.ok(gap >= (count === 1 ? 210 : 160) && gap <= (count === 1 ? 810 : 560));
      h.draw(atMs(timing.nextDueMs));
    }
  }
});

test('wall fireworks replay a delayed first render and survive cloned continuation', () => {
  const dense = harness('ldj.SceneMakerFirework', square()), sparse = harness('ldj.SceneMakerFirework', square());
  for (let t = 0; t < 2000; t += 25) dense.draw(atMs(t));
  assert.deepEqual(sparse.draw(atMs(2000)), dense.draw(atMs(2000)));
  const cloned = sparse.stepper.clone();
  assert.deepEqual(sparse.draw(atMs(2500)), sparse.draw(atMs(2500), cloned));
});

test('every channel row handles empty, one-lamp and one-colour rigs with finite owned output', () => {
  for (const name of names) for (const count of [0, 1, 5]) {
    const frames = run(`ldj.${name}`, row(count), [0, .6, 1.3, 2.7, 8.1], { palette: [RED] });
    for (const out of frames) for (const s of out) {
      assert.ok(Number.isFinite(s.level) && s.level >= 0 && s.level <= 1, name);
      assert.equal(s.strength, 1); assert.ok(Object.values(s.colour).every(Number.isFinite), name);
    }
  }
});
