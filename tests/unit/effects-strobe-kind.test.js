// tests/unit/effects-strobe-kind.test.js
// The strobe kind (Hue Dynamics' manual strobe) and the six energy kinds.
import test from 'node:test';
import assert from 'node:assert';
import { STROBE_DEFAULTS, STROBE_FRAME_MS, hdAutoStrobeFlash } from '../../src/shared/effects/strobe.ts';
import { hdAutoStrobeFlash as discoPermit } from '../../src/shared/effects/disco.ts';
import { FRAME_MS } from '../../src/server/frame-clock.ts';
import { ENERGY_KIND_BY_ID } from '../../src/shared/effects/energy.ts';
import { kindOf, requiresAcknowledgement, validateSpec } from '../../src/shared/effects/registry.ts';
import { renderEffect, slotToWrite } from '../../src/shared/effects/render.ts';
import { EffectStepper } from '../../src/shared/effects/stepper.ts';
import { parseHex } from '../../src/shared/effects/palette.ts';
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';
import { hash01, seedFrom } from '../../src/shared/effects/hash.ts';
import { buildRoom } from '../../src/shared/room.ts';
import { HOLD_STROBE_MAX_HZ, holdStrobeFlash, huePulseLevel, resolveEnergyOverride } from '../../src/shared/look-math.ts';
import { MAX_LAMP_FLASH_HZ } from '../../src/shared/patterns.ts';

const RED = parseHex('#FF0000'), GREEN = parseHex('#00FF00'), BLUE = parseHex('#0000FF'), WHITE = parseHex('#FFFFFF');
const BLACK = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
const SEED = seedFrom('strobe-test');

const roomOf = (hue) => buildRoom(hue.length, (i) => hue.length > 1 ? i / (hue.length - 1) : 0.5, () => 0.5, () => 0.5, null, hue);
const PAR = roomOf([false]);
// A par and a Hue lamp in one room.
const MIXED = roomOf([false, true]);

const frame = (over = {}) => ({ beatPos: 0, bpm: 120, nowMs: 0, dtMs: 0, anchorBeat: 0, lookPalette: [RED, BLUE], paletteOverride: null,
  audio: null, audioMode: 'tempo', master: HD_MASTER_DEFAULTS, seed: seedFrom('caller'), acknowledged: true, hueStrobe: 'flash', ...over });
const strobe = (spec = {}, over = {}) => ({ id: 'strobe', spec: validateSpec({ kind: 'strobe', ...spec }), seed: SEED, anchorBeat: 0, startedAtMs: 0, targets: null, ...over });
const draw = (inst, f, room, stepper) => { const out = []; renderEffect(inst, f, room, stepper, out); return out; };

/** One running instance, sampled in time order: beatPos follows the instance's anchor at a steady tempo unless given. */
function sampler(inst, room, base = {}) {
  const stepper = new EffectStepper();
  const at = (nowMs, over = {}) => {
    const bpm = over.bpm ?? base.bpm ?? 120;
    const beatPos = inst.anchorBeat + (nowMs - inst.startedAtMs) * bpm / 60000;
    return draw(inst, frame({ nowMs, beatPos, bpm, ...base, ...over }), room, stepper);
  };
  at.stepper = stepper;
  return at;
}

const state = (slot) => !slot || slot.strength === 0 ? 'clear' : slot.level === 0 ? 'black' : 'lit';
const bytes = (slot) => slotToWrite(slot).dim;

// The permit's guarantees, in milliseconds.
const GAP_MS = 1000 / MAX_LAMP_FLASH_HZ - 1000 / 44;
const FLOOR = 40 / 255;
const levelOf = (slot) => slot && slot.strength > 0 ? slot.level : 0;
/**
 * Every lamp's rises: frames on which it is brighter than the frame before
 * and above the Hue floor (the most a held floor can be), so a flash counts
 * whatever its brightness, mode or colour, and so does any re-lighting.
 */
function risesOf(frames, outs) {
  const rises = outs[0].map(() => []), before = outs[0].map(() => 0);
  outs.forEach((out, j) => out.forEach((slot, i) => {
    const level = levelOf(slot);
    if (level > Math.max(before[i], FLOOR) + 1e-9) rises[i].push(frames[j].nowMs);
    before[i] = level;
  }));
  return rises;
}
/** (a) and (b) over one lamp's rises; (b) to the nanosecond of float rounding the permit allows. */
function assertCapped(label, times) {
  for (let k = 1; k < times.length; k++) assert.ok(times[k] - times[k - 1] >= GAP_MS, `${label}: rises ${times[k] - times[k - 1]} ms apart`);
  for (let k = MAX_LAMP_FLASH_HZ; k < times.length; k++) {
    assert.ok(times[k] - times[k - MAX_LAMP_FLASH_HZ] >= 1000 - 1e-6, `${label}: ${MAX_LAMP_FLASH_HZ + 1} rises within ${times[k] - times[k - MAX_LAMP_FLASH_HZ]} ms`);
  }
}

test('wall clock at 2/s: full for 100 ms, black for 100 ms, transparent until 500 ms; colours drawn from the palette', () => {
  const inst = strobe({ params: { clock: 'wall', flashesPerSecond: 2 }, palette: ['#FF0000', '#00FF00', '#0000FF'] }, { startedAtMs: 1000 });
  const colourOf = (index) => [RED, GREEN, BLUE][Math.floor(hash01(SEED, 0, index) * 3)];
  const at = sampler(inst, PAR);
  const expect = [[0, 'lit'], [99, 'lit'], [100, 'black'], [199, 'black'], [200, 'clear'], [499, 'clear'], [500, 'lit'], [599, 'lit'], [600, 'black']];
  for (const [t, want] of expect) {
    const slot = at(1000 + t)[0];
    assert.strictEqual(state(slot), want, `${t} ms`);
    if (want === 'lit') {
      assert.deepStrictEqual(slot.colour, colourOf(Math.floor(t / 500)), `the seeded colour at ${t} ms`);
      assert.strictEqual(slot.level, 1);
    }
    if (want === 'black') assert.deepStrictEqual(slot.colour, BLACK, 'black owns the slot');
  }
  // Every flash is one seeded draw from the palette, and every colour comes up.
  const seen = new Set();
  for (let k = 2; k < 62; k++) {
    const slot = at(1000 + 500 * k + 10)[0];
    assert.deepStrictEqual(slot.colour, colourOf(k), `flash ${k}`);
    seen.add(slot.colour.r ? 'r' : slot.colour.g ? 'g' : 'b');
  }
  assert.strictEqual(seen.size, 3);
  // A cold sample in the rest spends no permit: the real 500 ms flash still shows.
  const cold = sampler(inst, PAR);
  assert.strictEqual(state(cold(1350)[0]), 'clear');
  assert.strictEqual(state(cold(1500)[0]), 'lit');
});

test('beat clock at 128 BPM flashes on half beats in the palette\'s order', () => {
  // Five a second allows half beats at 128 BPM (4.3 a second).
  // A quarter-beat anchor: the grid counts from the instance's own anchor, not the conductor's beat.
  const inst = strobe({ params: { clock: 'beat', flashesPerSecond: 5 }, palette: ['#FF0000', '#00FF00', '#0000FF'] }, { anchorBeat: 3.25, startedAtMs: 0 });
  const half = 60000 / 128 / 2;
  const at = sampler(inst, PAR, { bpm: 128 });
  for (let k = 0; k < 9; k++) {
    const t = k * half;
    for (const [dt, want] of [[0, 'lit'], [50, 'lit'], [150, 'black'], [210, 'clear']]) {
      const slot = at(t + dt)[0];
      assert.strictEqual(state(slot), want, `flash ${k} + ${dt} ms`);
      if (want === 'lit') assert.deepStrictEqual(slot.colour, [RED, GREEN, BLUE][k % 3], `flash ${k} in turn`);
    }
  }
  // At a steady render rate every half beat still flashes, in turn.
  const dense = sampler(inst, PAR, { bpm: 128 });
  const rises = [];
  let before = 'clear';
  for (let t = 0; t < 2000; t += 1000 / 44) {
    const slot = dense(t)[0];
    if (state(slot) === 'lit' && before !== 'lit') rises.push([t, slot.colour]);
    before = state(slot);
  }
  assert.strictEqual(rises.length, Math.ceil(2000 / half));
  rises.forEach(([t, colour], k) => {
    assert.ok(t >= k * half && t < k * half + 1000 / 44, `rise ${k} at ${t} ms`);
    assert.deepStrictEqual(colour, [RED, GREEN, BLUE][k % 3]);
  });
  // The grid is the finest division within the configured rate; the old callers keep five.
  assert.strictEqual(holdStrobeFlash(0, 128, 2).periodMs, 937.5, 'two beats at 128 for 2 a second');
  assert.strictEqual(holdStrobeFlash(0, 120, 2).periodMs, 500, 'one beat at 120 for 2 a second');
  assert.strictEqual(holdStrobeFlash(0, 128).periodMs, half, 'five a second by default');
  assert.strictEqual(holdStrobeFlash(0, 300, 10).periodMs, 200, 'and never more than five');
  const slow = sampler(strobe({ params: { clock: 'beat', flashesPerSecond: 2 } }), PAR, { bpm: 128 });
  assert.deepStrictEqual([0, half, 2 * half, 3 * half, 900, 937.5].map((t) => state(slow(t)[0])), ['lit', 'clear', 'clear', 'clear', 'clear', 'lit'],
    'flashes on every second beat, none between');
});

test('continueBetween false holds black between flashes', () => {
  const wall = sampler(strobe({ params: { clock: 'wall', flashesPerSecond: 2, continueBetween: false } }), PAR);
  assert.deepStrictEqual([0, 150, 200, 499, 500].map((t) => state(wall(t)[0])), ['lit', 'black', 'black', 'black', 'lit']);
  assert.deepStrictEqual(wall(700)[0], { colour: BLACK, level: 0, strength: 1 });
  const beat = sampler(strobe({ params: { clock: 'beat', flashesPerSecond: 5, continueBetween: false } }), PAR);
  assert.deepStrictEqual([0, 220, 250].map((t) => state(beat(t)[0])), ['lit', 'black', 'lit']);
  // A cold first sample in the rest is black too.
  assert.strictEqual(state(sampler(strobe({ params: { clock: 'wall', flashesPerSecond: 2, continueBetween: false } }), PAR)(350)[0]), 'black');
});

test('a Hue slot is flashed black with hueStrobe flash, and falls to 40/255 over 200 ms with pulse', () => {
  const inst = strobe({ params: { clock: 'wall', flashesPerSecond: 2 } });
  const flash = sampler(inst, MIXED, { hueStrobe: 'flash' });
  assert.deepStrictEqual(flash(0).map(state), ['lit', 'lit']);
  assert.deepStrictEqual(flash(100).map(state), ['black', 'black'], 'the Hue lamp goes black as any lamp');
  assert.deepStrictEqual(flash(200).map(state), ['clear', 'clear']);

  const pulse = sampler(inst, MIXED, { hueStrobe: 'pulse' });
  const zero = pulse(0);
  assert.deepStrictEqual(zero[1], { colour: WHITE, level: 1, strength: 1 });
  const hundred = pulse(100);
  assert.strictEqual(state(hundred[0]), 'black', 'the par still flashes');
  assert.strictEqual(bytes(hundred[1]), 148);
  assert.deepStrictEqual(hundred[1].colour, WHITE);
  assert.strictEqual(bytes(pulse(200)[1]), 40);
  const held = pulse(400);
  assert.deepStrictEqual([state(held[0]), bytes(held[1]), held[1].strength], ['clear', 40, 1], 'the floor is held and owned');
  assert.strictEqual(bytes(pulse(500)[1]), 255);

  // Params brightness and spec brightness each apply once.
  const dim = sampler(strobe({ params: { clock: 'wall', flashesPerSecond: 2, brightness: 0.5 }, brightness: 0.5 }), MIXED, { hueStrobe: 'pulse' });
  assert.deepStrictEqual(dim(0).map((slot) => slot.level), [0.25, 0.25]);
  assert.ok(Math.abs(dim(100)[1].level - 148 / 255 * 0.25) < 1e-12);

  // A cold pulse inside its fall is admitted and spends the permit…
  const five = { params: { clock: 'wall', flashesPerSecond: 5 } };
  const late = sampler(strobe(five), MIXED, { hueStrobe: 'pulse' });
  const first = late(150);
  assert.deepStrictEqual([state(first[0]), bytes(first[1])], ['black', 94]);
  const denied = late(200);
  assert.deepStrictEqual([state(denied[0]), bytes(denied[1])], ['clear', 40], 'too soon: the earlier pulse reaches its floor');
  assert.deepStrictEqual(late(400).map(bytes), [255, 255]);
  // …while a hard flash missed by a cold sample is not.
  const hard = sampler(strobe(five), PAR);
  assert.strictEqual(state(hard(190)[0]), 'black');
  assert.strictEqual(state(hard(200)[0]), 'lit');
  // A beat nudged back into a missed flash does not light it.
  const nudged = sampler(strobe({ params: { clock: 'beat', flashesPerSecond: 5 } }), PAR);
  assert.strictEqual(state(nudged(1000, { beatPos: 0.2 })[0]), 'black');
  assert.strictEqual(state(nudged(1020, { beatPos: 0.05 })[0]), 'black');
  // A cold Hue sample in the rest shows the floor and spends nothing.
  const rest = sampler(inst, MIXED, { hueStrobe: 'pulse' });
  const floor = rest(350);
  assert.deepStrictEqual([state(floor[0]), bytes(floor[1])], ['clear', 40]);
  assert.deepStrictEqual(rest(500).map(bytes), [255, 255]);
  // A flash missed under flash mode stays missed when the mode turns to pulse: the floor, not a part-way pulse.
  const flip = sampler(inst, MIXED, { hueStrobe: 'flash' });
  assert.deepStrictEqual(flip(150).map(state), ['black', 'black']);
  assert.deepStrictEqual(flip(160, { hueStrobe: 'pulse' }).map(bytes), [0, 40]);
});

test('a tempo change never lets a flash through early, and a denied flash is never replayed', () => {
  const inst = strobe({ params: { clock: 'beat', flashesPerSecond: 5 }, palette: ['#FF0000', '#0000FF'] });
  for (const [room, hueStrobe] of [[PAR, 'flash'], [MIXED, 'pulse']]) {
    const stepper = new EffectStepper();
    const at = (nowMs, beatPos, bpm, s = stepper) => draw(inst, frame({ nowMs, beatPos, bpm, hueStrobe }), room, s);
    const first = at(250, 0.5, 120);
    assert.deepStrictEqual(first[0], { colour: BLUE, level: 1, strength: 1 }, 'half beat 1 at 120 BPM');
    assert.deepStrictEqual(at(250, 0.5, 120), first, 'a repeated sample is the same flash');
    const clone = stepper.clone();
    const sequence = [[275, 0.55, 300], [365, 1, 300], [450, 1.425, 300], [565, 2, 300]];
    const outputs = sequence.map(([t, b, bpm]) => at(t, b, bpm));
    // 300 BPM: beats are 200 ms. The flash admitted at 250 ms runs on.
    assert.deepStrictEqual(outputs[0][0], { colour: BLUE, level: 1, strength: 1 }, '25 ms into the admitted flash');
    assert.strictEqual(state(outputs[1][0]), 'black', 'the beat at 365 ms is too soon: denied');
    assert.strictEqual(state(outputs[2][0]), 'clear', 'and not replayed later in its interval');
    assert.deepStrictEqual(outputs[3][0], { colour: RED, level: 1, strength: 1 }, '565 ms: the next beat is admitted');
    if (room === MIXED) {
      assert.deepStrictEqual(outputs.map((out) => bytes(out[1])), [huePulseLevel(25), huePulseLevel(115), 40, 255]);
      assert.deepStrictEqual(outputs[1][1].colour, BLUE, 'the pulse keeps its colour');
    }
    assert.deepStrictEqual(sequence.map(([t, b, bpm]) => at(t, b, bpm, clone)), outputs, 'a cloned state continues identically');
  }
  // Below the cap the configured rate holds on the grid: two a second, and a beat nudged ahead brings the next flash 300 ms after the last was due.
  const two = sampler(strobe({ params: { clock: 'beat', flashesPerSecond: 2 } }), PAR);
  assert.strictEqual(state(two(0)[0]), 'lit');
  assert.strictEqual(state(two(300, { beatPos: 1 })[0]), 'clear', 'too soon for two a second, though past the cap\'s gap');
  assert.strictEqual(state(two(800, { beatPos: 2 })[0]), 'lit');
});

test('never faster than five a second at any setting', () => {
  assert.strictEqual(MAX_LAMP_FLASH_HZ, HOLD_STROBE_MAX_HZ, 'one cap');
  assert.strictEqual(hdAutoStrobeFlash, discoPermit, 'the Disco\'s permit, re-exported');
  assert.strictEqual(STROBE_FRAME_MS, FRAME_MS, 'the grace is one engine frame');
  const check = (label, inst, room, frames) => {
    const stepper = new EffectStepper();
    const rises = risesOf(frames, frames.map((f) => draw(inst(f), frame(f), room, stepper)));
    return rises.map((times) => { assertCapped(label, times); return times.length; });
  };
  const steady = (bpm, hueStrobe, ms = 3000) => Array.from({ length: Math.floor(ms * 44 / 1000) }, (_, j) => {
    const nowMs = j * 1000 / 44;
    return { nowMs, beatPos: nowMs * bpm / 60000, bpm, hueStrobe };
  });
  for (const fps of [1, 2, 3, 4, 5]) for (const clock of ['wall', 'beat']) for (const hueStrobe of ['flash', 'pulse']) {
    for (const bpm of [20, 60, 90, 120, 128, 150, 174, 180, 200, 250, 300]) {
      const inst = strobe({ params: { clock, flashesPerSecond: fps } });
      const counts = check(`${fps}/s ${clock} ${hueStrobe} ${bpm} BPM`, () => inst, MIXED, steady(bpm, hueStrobe));
      for (const count of counts) assert.ok(count <= 3 * fps + 1, `${fps}/s ${clock} ${bpm} BPM: ${count} rises in 3 s`);
      assert.ok(counts[0] >= 1, 'it does flash');
    }
  }
  // Jittered renders through tempo changes, the clock switched and the rate raised mid-run.
  let rng = 7;
  const random = () => (rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const jittered = [];
  let nowMs = 0, beatPos = 0, bpm = 120;
  for (let j = 0; j < 2000; j++) {
    const dt = 5 + random() * 40;
    if (random() < 0.05) bpm = 40 + random() * 260;
    nowMs += dt; beatPos += dt * bpm / 60000;
    jittered.push({ nowMs, beatPos, bpm, hueStrobe: j % 400 < 200 ? 'pulse' : 'flash' });
  }
  const specs = [strobe({ params: { clock: 'beat', flashesPerSecond: 5 } }), strobe({ params: { clock: 'wall', flashesPerSecond: 2 } }),
    strobe({ params: { clock: 'wall', flashesPerSecond: 5 } })];
  check('jittered', (f) => specs[Math.floor(f.nowMs / 1500) % 3], MIXED, jittered);
});

/** A seeded uniform 0..1, so every run sees the same clock. */
const lcg = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
/** Ten seconds of 44 Hz renders, each moved by up to ±jitterMs. */
const tenSeconds = (bpm, hueStrobe, jitterMs = 0, seed = 1) => {
  const random = lcg(seed);
  return Array.from({ length: 440 }, (_, j) => {
    const nowMs = Math.max(0, j * 1000 / 44 + (random() * 2 - 1) * jitterMs);
    return { j, nowMs, beatPos: nowMs * bpm / 60000, bpm, hueStrobe };
  });
};
const runOf = (params, frames, room = MIXED) => {
  const inst = strobe({ params });
  const stepper = new EffectStepper();
  return risesOf(frames, frames.map((f) => draw(inst, frame(f), room, stepper)));
};
// Grids at the configured rate, as the operator sets them: the cap itself on both clocks, and three a second.
const AT_RATE = [
  ['five a second, wall', { clock: 'wall', flashesPerSecond: 5 }, 120, 200, 50],
  ['five a second, 150 BPM', { clock: 'beat', flashesPerSecond: 5 }, 150, 200, 50],
  ['five a second, 75 BPM', { clock: 'beat', flashesPerSecond: 5 }, 75, 200, 50],
  ['five a second, 300 BPM', { clock: 'beat', flashesPerSecond: 5 }, 300, 200, 50],
  ['three a second, wall', { clock: 'wall', flashesPerSecond: 3 }, 120, 334, 30],
  ['three a second, 180 BPM', { clock: 'beat', flashesPerSecond: 3 }, 180, 1000 / 3, 30],
];

test('on an ideal 44 Hz clock a grid at the rate shows every flash: 50 of 50 at five a second, 30 of 30 at three', () => {
  for (const [label, params, bpm, periodMs, flashes] of AT_RATE) {
    for (const hueStrobe of ['flash', 'pulse']) {
      const frames = tenSeconds(bpm, hueStrobe);
      for (const times of runOf(params, frames)) {
        assert.strictEqual(times.length, flashes, `${label} ${hueStrobe}`);
        // Each rises on the first frame at or after it was due.
        times.forEach((t, k) => assert.ok(t >= k * periodMs - 1e-9 && t < k * periodMs + 1000 / 44, `${label} ${hueStrobe}: flash ${k} at ${t} ms`));
        assertCapped(`${label} ${hueStrobe}`, times);
        // On the frame grid itself: rises at least eight frames apart, never six in 44 frames.
        const frameOf = times.map((t) => Math.round(t * 44 / 1000));
        for (let k = 1; k < frameOf.length; k++) assert.ok(frameOf[k] - frameOf[k - 1] >= 8, `${label}: frames ${frameOf[k - 1]}, ${frameOf[k]}`);
        for (let k = 5; k < frameOf.length; k++) assert.ok(frameOf[k] - frameOf[k - 5] >= 44, `${label}: six rises in frames ${frameOf[k - 5]}..${frameOf[k]}`);
      }
    }
  }
});

test('±2 ms of frame jitter keeps (a) and (b); at exactly five a second it costs at most 8 of 50 flashes, none below it', () => {
  for (let seed = 1; seed <= 20; seed++) {
    for (const [label, params, bpm, periodMs, flashes] of [...AT_RATE,
      ['four a second, wall', { clock: 'wall', flashesPerSecond: 4 }, 120, 250, 40], ['five a second, 128 BPM', { clock: 'beat', flashesPerSecond: 5 }, 128, 60000 / 256, 43]]) {
      const frames = tenSeconds(bpm, 'flash', 2, seed);
      const [times] = runOf(params, frames, PAR);
      assertCapped(`${label} seed ${seed}`, times);
      const lost = flashes - times.length;
      if (periodMs > 200) assert.strictEqual(lost, 0, `${label} seed ${seed}: below the cap nothing is lost`);
      else {
        assert.ok(lost <= 8, `${label} seed ${seed}: ${lost} lost`);
        // The cost is (b)'s own: showing every flash on this clock would have put six in under a second.
        const all = Array.from({ length: flashes }, (_, k) => frames.find((f) => f.nowMs >= k * periodMs).nowMs);
        assert.ok(all.some((t, k) => k >= 5 && t - all[k - 5] < 1000), `${label} seed ${seed}: every flash would break (b)`);
      }
    }
  }
});

test('a burst of relaunches, renders and hostile edits never breaks (a) or (b)', () => {
  const random = lcg(11);
  const pick = (list) => list[Math.floor(random() * list.length)];
  // Every valid setting, and the stray values only a hand-built spec could carry.
  const specs = [];
  for (const flashesPerSecond of [1, 2, 3, 4, 5]) for (const clock of ['wall', 'beat']) for (const continueBetween of [true, false]) {
    for (const brightness of [0.2, 0.6, 1]) specs.push(validateSpec({ kind: 'strobe', params: { flashesPerSecond, clock, continueBetween, brightness } }));
  }
  for (const flashesPerSecond of [50, NaN, 0, -2, 2.5, Infinity]) specs.push({ ...specs[0], params: { ...specs[0].params, flashesPerSecond } });
  const stepper = new EffectStepper();
  const frames = [], outs = [];
  let nowMs = 0, beatPos = 0, bpm = 128, startedAtMs = 0, anchorBeat = 0;
  for (let j = 0; j < 6000; j++) {
    // Bursts of renders inside a millisecond among ordinary and late frames.
    const dt = pick([0, 0, 0.5, 3, 10, 1000 / 44, 1000 / 44, 1000 / 44, 45]);
    if (random() < 0.05) bpm = 20 + random() * 280;
    nowMs += dt; beatPos += dt * bpm / 60000;
    if (random() < 0.03) beatPos += (random() - 0.5) * 0.6;
    // The same voice launched again, its grid restarted.
    if (random() < 0.02) { startedAtMs = nowMs; anchorBeat = beatPos; }
    const f = { nowMs, beatPos, bpm, hueStrobe: pick(['flash', 'pulse']) };
    frames.push(f);
    outs.push(draw({ id: 'strobe', spec: pick(specs), seed: SEED, anchorBeat, startedAtMs, targets: null }, frame(f), MIXED, stepper));
  }
  const rises = risesOf(frames, outs);
  rises.forEach((times, i) => {
    assertCapped(`lamp ${i}`, times);
    assert.ok(times.length >= 100, `lamp ${i} still flashes: ${times.length}`);
  });
});

test('a relaunch on the same instance starts a new grid under the same permit', () => {
  for (const clock of ['wall', 'beat']) {
    const stepper = new EffectStepper();
    const at = (nowMs, launchMs) => draw(strobe({ params: { clock, flashesPerSecond: 2 } }, { startedAtMs: launchMs, anchorBeat: launchMs / 500 }),
      frame({ nowMs, beatPos: nowMs / 500 }), PAR, stepper)[0];
    assert.strictEqual(state(at(0, 0)), 'lit');
    assert.strictEqual(state(at(50, 0)), 'lit');
    // Its first flash shows, though the last grid was also at its first.
    assert.strictEqual(state(at(1000, 1000)), 'lit', `${clock}: relaunched`);
    // Launched again 50 ms on: too soon, and the flash showing runs its course.
    assert.strictEqual(state(at(1050, 1050)), 'lit', `${clock}: the earlier flash`);
    assert.strictEqual(state(at(1150, 1050)), 'black');
    assert.strictEqual(state(at(1300, 1050)), 'clear', `${clock}: the refused one is not shown late`);
    assert.strictEqual(state(at(1550, 1050)), 'lit', `${clock}: the next on the new grid`);
  }
});

test('renders nothing unacknowledged', () => {
  const inst = strobe();
  assert.strictEqual(requiresAcknowledgement(inst.spec), true);
  assert.deepStrictEqual(draw(inst, frame({ acknowledged: false }), MIXED, new EffectStepper()), []);
  assert.strictEqual(draw(inst, frame(), MIXED, new EffectStepper()).length, 2);
});

test('the strobe flashes frame.palette: white by default, the look\'s colours with palette null, an override over both', () => {
  const spec = validateSpec({ kind: 'strobe' });
  assert.deepStrictEqual(spec.palette, ['#FFFFFF']);
  assert.deepStrictEqual(spec.params, STROBE_DEFAULTS);
  assert.ok(!('palette' in spec.params), 'no palette among the params');
  assert.deepStrictEqual(validateSpec(spec), spec, 'idempotent');
  assert.deepStrictEqual(draw(strobe(), frame(), PAR, new EffectStepper())[0].colour, WHITE);
  const look = sampler(strobe({ params: { flashesPerSecond: 5 }, palette: null }), PAR);
  assert.deepStrictEqual([0, 250, 500].map((t) => look(t)[0].colour), [RED, BLUE, RED], 'the look\'s colours in turn');
  assert.deepStrictEqual(draw(strobe(), frame({ paletteOverride: [GREEN] }), PAR, new EffectStepper())[0].colour, GREEN);
  assert.strictEqual(validateSpec({ kind: 'strobe', palette: Array(8).fill('#123456') }).palette.length, 8, 'specs keep up to eight colours');
  for (const params of [{ palette: ['#FFFFFF'] }, { onMs: 80 }, { blackMs: 120 }, { flashesPerSecond: 6 }, { flashesPerSecond: 0 },
    { flashesPerSecond: 2.5 }, { brightness: 1.5 }, { clock: 'bar' }]) {
    assert.throws(() => validateSpec({ kind: 'strobe', params }), JSON.stringify(params));
  }
});

test('each energy kind matches resolveEnergyOverride\'s colour, level and strobe', () => {
  const A = { r: 10, g: 20, b: 30, w: 40, a: 50, uv: 60 };
  assert.deepStrictEqual(ENERGY_KIND_BY_ID, { 'white-strobe': 'energy.whiteStrobe', 'color-strobe': 'energy.colorStrobe', blinder: 'energy.blinder',
    'uv-wash': 'energy.uvWash', kill: 'energy.kill', glow: 'energy.glow' });
  for (const [id, kind] of Object.entries(ENERGY_KIND_BY_ID)) {
    for (const expressionLevel of [undefined, 0, 0.5, 1]) {
      // Neither the effect's palette nor an override moves colour A.
      const inst = { id: kind, spec: validateSpec({ kind, palette: ['#FF00FF'] }), seed: SEED, anchorBeat: 0, startedAtMs: 0, targets: null };
      const out = draw(inst, frame({ lookPalette: [A, BLUE], paletteOverride: [GREEN], expressionLevel }), MIXED, new EffectStepper());
      const legacy = resolveEnergyOverride(id, A, expressionLevel ?? 1);
      assert.strictEqual(out.length, 2);
      for (const slot of out) {
        assert.deepStrictEqual(slotToWrite(slot), { colour: legacy.col, dim: legacy.dim, strobe: legacy.strobe }, `${kind} at ${expressionLevel}`);
        assert.strictEqual(slot.strength, 1, 'owned, kill\'s black included');
      }
    }
  }
  const glow = (expressionLevel) => slotToWrite(draw({ id: 'g', spec: validateSpec({ kind: 'energy.glow' }), seed: SEED, anchorBeat: 0, startedAtMs: 0, targets: null },
    frame({ expressionLevel }), PAR, new EffectStepper())[0]).dim;
  assert.deepStrictEqual([0, 0.5, 1].map(glow), [150, 203, 255], 'glow rides the expression level on its own curve');
  assert.strictEqual(kindOf('energy.glow').rideLevel, true);
  for (const [kind, rapid] of [['energy.whiteStrobe', true], ['energy.colorStrobe', true], ['energy.blinder', false], ['energy.uvWash', false],
    ['energy.kill', false], ['energy.glow', false]]) {
    assert.strictEqual(requiresAcknowledgement(validateSpec({ kind })), rapid, kind);
    const out = draw({ id: kind, spec: validateSpec({ kind }), seed: SEED, anchorBeat: 0, startedAtMs: 0, targets: null }, frame({ acknowledged: false }), PAR, new EffectStepper());
    assert.strictEqual(out.length, rapid ? 0 : 1, `${kind} unacknowledged`);
  }
  assert.throws(() => validateSpec({ kind: 'energy.blinder', params: { level: 1 } }), 'no params');
});
