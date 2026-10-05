// Hue lamps in pulse mode take Light DJ's hard flashes as the strobe's pulse:
// full at the flash, falling to 40/255 over 200 ms and held, a long matrix
// peak keeping its plateau and softening only its cut. Only the rows that
// flash hard on dark lamps are marked; every authored fade, blend, background
// and every non-Hue lamp renders exactly as before.

import test from 'node:test';
import assert from 'node:assert';

import '../../src/shared/effects/index.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { renderEffect } from '../../src/shared/effects/render.ts';
import { EffectStepper } from '../../src/shared/effects/stepper.ts';
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';
import { LDJ_FRAME_MS } from '../../src/shared/effects/ldj-engine.ts';
import { buildRoom } from '../../src/shared/room.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { parseHex } from '../../src/shared/effects/palette.ts';
import { huePulseLevel } from '../../src/shared/look-math.ts';

const RED = parseHex('#FF0000'), CYAN = parseHex('#00FFFF'), WHITE = parseHex('#FFFFFF');
const FLOOR = 40 / 255;
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} ≠ ${expected}`);
/** A row of `n` lamps; `hue` names which are Hue lamps (all, by default). */
const row = (n, hue = Array(n).fill(true)) => buildRoom(n, (i) => (n > 1 ? i / (n - 1) : 0.5), () => 0.5, () => 0.5, null, hue);
const corners = (hue = [true, true, true, true]) => buildRoom(4, (i) => [0, 1, 1, 0][i], (i) => [0, 0, 1, 1][i], () => 0.5, null, hue);

/** One instance drawn at wall times (120 BPM unless said), sharing state across draws; `mode` may change per draw. */
function instance(kind, room, { params = {}, palette = [RED], spec = {}, bpm = 120 } = {}) {
  const inst = { id: kind, spec: validateSpec({ kind, params, palette: palette.map((c) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`), ...spec }),
    seed: seedFrom('pulse'), anchorBeat: 0, startedAtMs: 0, targets: null };
  let stepper = new EffectStepper();
  let last = null;
  const draw = (nowMs, hueStrobe = 'pulse', using = stepper) => {
    const out = Array.from({ length: room.n }, () => ({ colour: { ...WHITE }, level: 0, strength: 0 }));
    renderEffect(inst, { beatPos: nowMs * bpm / 60000, bpm, nowMs, dtMs: last === null ? 0 : nowMs - last, anchorBeat: 0, lookPalette: [RED],
      paletteOverride: null, audio: null, audioMode: 'tempo', master: HD_MASTER_DEFAULTS, seed: inst.seed, acknowledged: true, hueStrobe }, room, using, out);
    last = nowMs;
    return out;
  };
  return { draw, inst, get stepper() { return stepper; }, set stepper(s) { stepper = s; } };
}

/** Every 44 Hz frame for `ms`, in both modes on separate instances: [pulse, flash] outputs per frame. */
function bothModes(kind, room, options, ms = 4000) {
  const pulse = instance(kind, room, options), flash = instance(kind, room, options);
  const frames = [];
  for (let t = 0; t <= ms; t += 1000 / 44) frames.push({ t, pulse: pulse.draw(t, 'pulse'), flash: flash.draw(t, 'flash') });
  return frames;
}

// Two callbacks of TrueStrobe: on at 0, off at 50 ms, then nothing.
const ONE_FLASH = { iterations: 2 };

test('an isolated hard flash on a Hue lamp is full, then 148 and 40 of 255 at 100 and 200 ms, held there', () => {
  const h = instance('ldj.TrueStrobe', row(1), { params: ONE_FLASH, palette: [CYAN] });
  const levels = [0, 50, 100, 200, 600].map((t) => h.draw(t));
  assert.deepStrictEqual(levels.map((out) => Math.round(255 * out[0].level)), [255, huePulseLevel(50), 148, 40, 40]);
  for (const out of levels) assert.deepStrictEqual([out[0].colour.r, out[0].colour.g, out[0].colour.b], [0, 255, 255], 'the flash\'s colour');
  // The same lamp in flash mode is the hard flash Light DJ draws: on for 50 ms, then off.
  const hard = instance('ldj.TrueStrobe', row(1), { params: ONE_FLASH, palette: [CYAN] });
  assert.deepStrictEqual([0, 25, 50, 100].map((t) => hard.draw(t, 'flash')[0].level), [1, 1, 0, 0]);
});

test('TrueStrobe keeps ten flashes a second on every lamp in flash mode; a Hue lamp pulsing restarts on each real flash, never on a render', () => {
  const frames = bothModes('ldj.TrueStrobe', row(2, [false, true]), {}, 1000);
  // The par is untouched by the mode.
  for (const { pulse, flash } of frames) assert.deepStrictEqual(pulse[0], flash[0]);
  const rises = frames.filter(({ flash }, k) => flash[1].level > 0 && !(frames[k - 1]?.flash[1].level > 0)).length;
  assert.strictEqual(rises, 10, 'ten a second in flash mode');
  for (const { t, pulse } of frames) {
    // The last on step was at the last whole 100 ms; the pulse counts from there.
    const since = t - Math.floor(t / 100 + 1e-9) * 100;
    close(pulse[1].level, huePulseLevel(Math.round(since * 1000) / 1000) / 255, `the Hue lamp at ${t.toFixed(2)} ms`);
  }
});

test('Strobe Cycle pulses a Hue lamp only in its one-colour form; with a background colour it is a change of colour, drawn as is', () => {
  const one = bothModes('ldj.StrobeCycle', corners(), { palette: [RED] }, 3000);
  assert.ok(one.some(({ pulse, flash }) => pulse.some((s, i) => s.level !== flash[i].level)), 'one colour: the flashes are pulsed');
  // A lamp the cycle has not reached yet is dark, with no floor of a flash it never had.
  const first = instance('ldj.StrobeCycle', corners(), { palette: [RED] }).draw(10);
  assert.strictEqual(first.filter((s) => s.level > 0.9).length, 1, 'the step\'s lamp, 10 ms into its pulse');
  assert.strictEqual(first.filter((s) => s.level === 0).length, 3, 'never flashed: black');
  for (const { t, pulse } of one.filter(({ t }) => t > 2000)) {
    for (const s of pulse) assert.ok(s.level >= FLOOR - 1e-9, `every lamp has flashed by ${t.toFixed(0)} ms and holds its floor`);
  }
  const two = bothModes('ldj.StrobeCycle', corners(), { palette: [RED, CYAN] }, 3000);
  for (const { pulse, flash } of two) assert.deepStrictEqual(pulse, flash, 'two colours: identical in both modes');
});

test('a genre strobe\'s holds and offs never start a pulse again', () => {
  // Techno: p H O H s H O H …, a sixteenth each at 120 BPM (125 ms): p at 0, H 125, O 250, H 375, s 500.
  const h = instance('ldj.TechnoStrobe', row(1), { palette: [RED, CYAN] });
  const at = (t) => h.draw(t)[0];
  close(at(0).level, 1, 'p');
  close(at(100).level, 148 / 255, 'the pulse falling');
  close(at(125).level, huePulseLevel(125) / 255, 'H: it goes on falling');
  close(at(250).level, FLOOR, 'O: off is no new flash, the tail holds');
  close(at(375).level, FLOOR, 'H again');
  close(at(499).level, FLOOR);
  close(at(500).level, 1, 's: a real hit');
  assert.deepStrictEqual([at(520).colour.r, at(520).colour.g], [255, 0], 'in s\'s colour, the palette\'s first');
});

test('a one-frame matrix flash pulses from the 22 Hz frame it first shows on, not from when it was asked for', () => {
  // Matrix Flash on four lamps asks every 330 ms; the second ask falls 10 ms into a lamp frame.
  const room = row(4);
  const hard = instance('ldj.MatrixFlash', room, { palette: [RED] });
  const soft = instance('ldj.MatrixFlash', room, { palette: [RED] });
  const frames = [];
  for (let t = 0; t <= 700; t += 5) frames.push({ t, flash: hard.draw(t, 'flash'), pulse: soft.draw(t, 'pulse') });
  // In flash mode the second flash shows for one lamp frame, from the boundary after its ask.
  const second = frames.find(({ t, flash }) => t > 300 && flash.some((s) => s.level === 1));
  const activation = Math.ceil(330 / LDJ_FRAME_MS) * LDJ_FRAME_MS;
  assert.ok(second.t >= activation && second.t < activation + 5, `shown first at ${second.t} ms, the frame from ${activation.toFixed(3)}`);
  const slot = second.flash.findIndex((s) => s.level === 1);
  const pulseAt = (t) => frames.find((f) => Math.abs(f.t - t) < 1e-9).pulse[slot].level;
  assert.strictEqual(pulseAt(330), frames.find((f) => f.t === 330).pulse[slot].level);
  for (const t of [365, 400, 465, 560]) {
    close(pulseAt(t), huePulseLevel(Math.round((t - activation) * 1000) / 1000) / 255, `${t} ms: counted from the frame it showed on`);
  }
});

test('Matrix Pulse keeps its fifteen-frame plateau and softens only its cut: full to 681.8 ms, then 148 and 40 of 255', () => {
  // One ask (iterations 1): on one lamp the next would come 300 ms on and start the plateau again.
  const h = instance('ldj.MatrixPulse', row(1), { palette: [RED], params: { iterations: 1 } });
  const plateau = 15 * LDJ_FRAME_MS;
  assert.strictEqual(h.draw(0)[0].level, 1);
  assert.strictEqual(h.draw(plateau - 1)[0].level, 1, 'the plateau as authored');
  close(h.draw(plateau)[0].level, 1, 'the cut softened: full at its start');
  close(h.draw(plateau + 100)[0].level, 148 / 255, '100 ms into the release');
  close(h.draw(plateau + 200)[0].level, FLOOR, 'the floor at 200 ms');
  const flash = instance('ldj.MatrixPulse', row(1), { palette: [RED], params: { iterations: 1 } });
  for (let t = 0; t < plateau; t += 1000 / 44) assert.strictEqual(flash.draw(t, 'flash')[0].level, 1, 'flash mode: the plateau');
  assert.strictEqual(flash.draw(plateau + 1, 'flash')[0].level, 0, 'and its hard cut');
});

test('Tri-Pulse\'s rest cuts its last plateau once: full at 750 ms, 148/255 at 850, 40/255 at 950, nothing renewed at 1000', () => {
  // 120 BPM: hits at 0, 250 and 500 ms (ten-frame peaks), rests from 750 ms every 250.
  const h = instance('ldj.TriPulse', row(1), { palette: [RED] });
  const times = [0, 250, 500, 600, 749, 750, 800, 850, 900, 950, 1000, 1100, 1250, 1400];
  const out = Object.fromEntries(times.map((t) => [t, h.draw(t)[0].level]));
  close(out[600], 1, 'the plateau of the hit at 500');
  close(out[749], 1);
  close(out[750], 1, 'the rest at 750 starts the release');
  close(out[850], 148 / 255, '100 ms on');
  close(out[950], FLOOR, 'at the floor, 40/255 of the peak above the rest\'s .1');
  close(out[1000], FLOOR, 'the next rest renews nothing');
  close(out[1250], FLOOR);
  // Flash mode keeps Light DJ's own: the rest's .1 from 750.
  const hard = instance('ldj.TriPulse', row(1), { palette: [RED] });
  for (const t of times.slice(0, 5)) hard.draw(t, 'flash');
  close(hard.draw(750, 'flash')[0].level, Math.fround(0.1), 'flash mode: the authored rest');
});

test('switching modes shows the tail an existing flash has, and starts none', () => {
  const h = instance('ldj.TrueStrobe', row(1), { params: ONE_FLASH });
  h.draw(0, 'flash');
  assert.strictEqual(h.draw(60, 'flash')[0].level, 0, 'off in flash mode');
  close(h.draw(100, 'pulse')[0].level, 148 / 255, 'pulse mode now: the same flash, 100 ms on');
  assert.strictEqual(h.draw(150, 'flash')[0].level, 0, 'and back');
  close(h.draw(300, 'pulse')[0].level, FLOOR, 'no new onset from the switches');
});

test('the tail keeps the flash\'s colour as last drawn: a per-frame colour while lit, frozen once out', () => {
  // TrueStrobe draws a fresh colour per lamp frame while lit, uncached; with a random palette it changes.
  const h = instance('ldj.TrueStrobe', row(1), { params: ONE_FLASH, spec: { palette: [{ random: true }, { random: true }] } });
  const lit = [0, 22.7, 45.5].map((t) => ({ ...h.draw(t)[0].colour }));
  const after = [60, 120, 400].map((t) => ({ ...h.draw(t)[0].colour }));
  assert.deepStrictEqual(after[0], lit[lit.length - 1], 'the last lit colour');
  assert.deepStrictEqual(after[1], after[0], 'frozen');
  assert.deepStrictEqual(after[2], after[0]);
});

test('a clone in the tail plays on as the original does', () => {
  const h = instance('ldj.BeatPulse4', row(2), { palette: [RED] });
  for (let t = 0; t <= 900; t += 1000 / 44) h.draw(t);
  const clone = h.stepper.clone();
  const a = [950, 1000, 1100, 1400].map((t) => h.draw(t)[0].level);
  const b = instance('ldj.BeatPulse4', row(2), { palette: [RED] });
  b.stepper = clone;
  // The clone's own clock picks up where the original's was.
  assert.deepStrictEqual([950, 1000, 1100, 1400].map((t) => b.draw(t)[0].level), a);
});

test('a macro\'s pulsed step is pulsed once, not again by the macro', () => {
  const step = { effect: { kind: 'ldj.TrueStrobe', params: ONE_FLASH }, beats: 4 };
  const macro = instance('macro', row(1), { params: { steps: [step], loopBeats: 4 }, palette: [CYAN] });
  const direct = instance('ldj.TrueStrobe', row(1), { params: ONE_FLASH, palette: [CYAN] });
  for (const t of [0, 50, 100, 200, 400]) assert.deepStrictEqual(macro.draw(t)[0].level, direct.draw(t)[0].level, `at ${t} ms`);
});

// Every marked family pulses its Hue lamps; every other family is drawn as is,
// on any lamp, in either mode. Rates and lifetimes follow the rows' own clocks.
const MARKED = [
  ['ldj.StrobeCycle', { palette: [RED] }], ['ldj.DoSiDo', { palette: [RED] }], ['ldj.DoubleFill', {}], ['ldj.FrontBack', {}],
  // The beat pulses outlast their own cadence: alone they hold full. A score plays them once (iterations 1).
  ['ldj.TriPulse', {}], ['ldj.BeatPulse1', { params: { iterations: 1 } }], ['ldj.BeatPulse4', { params: { iterations: 1 } }],
  ['ldj.ScatterStrobe', {}], ['ldj.Circuit', {}], ['ldj.MatrixCycle', {}], ['ldj.DoubleStrobeCycle', {}], ['ldj.DoubleScatterStrobe', {}],
  ['ldj.ThreeStageStrobe', {}], ['ldj.FiveStageStrobe', {}], ['ldj.ThreeStageStrobeMod', {}],
  ['ldj.DubstepStrobe', {}], ['ldj.DAndBStrobe', {}], ['ldj.HouseStrobe', {}], ['ldj.ElectroStrobe', {}], ['ldj.TechnoStrobe', {}],
  ['ldj.TrueStrobe', {}], ['ldj.PaletteTrueStrobe', {}], ['ldj.PaletteStrobe', {}],
  // A held matrix peak (682 ms) outlasts its rotation round four lamps: one ask, or a room where the round is longer.
  ['ldj.MatrixFlash', {}], ['ldj.PartyStrobe', { params: { iterations: 1 } }], ['ldj.MatrixPulse', { params: { iterations: 1 } }],
  ['ldj.matrixBoard', { params: { colours: ['#FF0000'], mode: 'flashes' } }],
  ['ldj.matrixBoard', { params: { colours: ['#FF0000'], mode: 'pulses' } }, 16],
];
const AS_DRAWN = [
  'ldj.QuickFlash', 'ldj.SceneMakerFirework', 'ldj.Cauldron', 'ldj.GrowCycle', 'ldj.FadeCycle', 'ldj.Sketch', 'ldj.Glow', 'ldj.CrossFade',
  'ldj.BLStrobeCycle', 'ldj.BLScatterStrobe', 'ldj.BrtSinStrobe', 'ldj.PalettePartyStrobe', 'ldj.DoubleFillStrobe', 'ldj.ThreeStrobeAndFade',
  'ldj.ThreeStageFill', 'ldj.ScatterFill', 'ldj.PaletteFill', 'ldj.PaletteTrail', 'ldj.Split', 'ldj.Flip', 'ldj.Trance', 'ldj.America',
  'ldj.MatrixFirework', 'ldj.MatrixSplotch', 'ldj.StudioFlashes', 'ldj.StudioN1', 'ldj.SMStudioN1Pulse', 'ldj.Swirl', 'ldj.GrooveWave',
  'ldj.bitmap', 'hd.frequencyBurst', 'hd.twinkle',
];

test('every hard-flash family pulses its Hue lamps and leaves the others as they were', () => {
  for (const [kind, options, n = 4] of MARKED) {
    // Every other lamp a Hue lamp.
    const room = n === 4 ? corners([true, false, true, false]) : row(n, Array.from({ length: n }, (_, i) => i % 2 === 0));
    const hue = Array.from({ length: n }, (_, i) => i).filter((i) => i % 2 === 0), pars = hue.map((i) => i + 1);
    const frames = bothModes(kind, room, { palette: [RED, CYAN], ...options }, 8000);
    for (const { pulse, flash } of frames) {
      assert.deepStrictEqual(pars.map((i) => pulse[i]), pars.map((i) => flash[i]), `${kind}: the pars as drawn`);
    }
    assert.ok(frames.some(({ pulse, flash }) => hue.some((i) => pulse[i].level !== flash[i].level)), `${kind}: its Hue lamps pulse`);
    // Once a Hue lamp has flashed it never goes black under the effect.
    for (const slot of hue) {
      const first = frames.findIndex(({ pulse }) => pulse[slot].level > 0);
      if (first < 0) continue;
      for (const { t, pulse } of frames.slice(first)) assert.ok(pulse[slot].level > 0, `${kind}: lamp ${slot} dark at ${t.toFixed(0)} ms`);
    }
  }
});

test('every authored fade, blend, background, sine, fill and continuous family is drawn the same in both modes', () => {
  const room = corners();
  for (const kind of AS_DRAWN) {
    const frames = bothModes(kind, room, { palette: [RED, CYAN] }, 4000);
    for (const { t, pulse, flash } of frames) assert.deepStrictEqual(pulse, flash, `${kind} at ${t.toFixed(0)} ms`);
  }
});

test('a pulsed lamp takes the very lamps and colours the flash would: no selection or colour is drawn again', () => {
  // Palette Strobe lights a seeded subset in a seeded order on every beat; on each beat the pulsed
  // lamps that light are exactly the flash's, in its colours, at full.
  const room = row(6);
  const palette = [RED, CYAN, WHITE];
  const pulse = instance('ldj.PaletteStrobe', room, { palette }), flash = instance('ldj.PaletteStrobe', room, { palette });
  for (let beat = 0; beat < 12; beat++) {
    for (const t of [beat * 500, beat * 500 + 200]) {
      const p = pulse.draw(t, 'pulse'), f = flash.draw(t, 'flash');
      if (t % 500 !== 0) continue;
      const litF = f.flatMap((s, i) => (s.level === 1 ? [i] : []));
      const litP = p.flatMap((s, i) => (s.level === 1 ? [i] : []));
      assert.deepStrictEqual(litP, litF, `beat ${beat}: the same lamps`);
      for (const i of litF) assert.deepStrictEqual(p[i].colour, f[i].colour, `beat ${beat}, lamp ${i}: the same colour`);
    }
  }
});

test('an off step keeps a lamp\'s flash tail, a plain set replaces it, a rest only cuts a plateau once', async () => {
  const { LdjLamps } = await import('../../src/shared/effects/ldj-engine.ts');
  const lamps = new LdjLamps(2);
  assert.strictEqual(lamps.pulse(0), null, 'a lamp that never flashed: no floor');
  lamps.set(0, RED, 1, { kind: 'instant' }, 0, 'flash');
  lamps.advance(100, 120);
  lamps.off(0);
  close(lamps.pulse(0).bri, 148 / 255, 'off: the tail plays on');
  lamps.set(0, CYAN, 1, { kind: 'fade', beats: 1 });
  assert.strictEqual(lamps.pulse(0), null, 'a fade set on the lamp is no flash: drawn as authored');
  // A plateau cut by a rest, then rested again.
  lamps.set(1, RED, 1, { kind: 'matrix', fadeIn: 0, peak: 350, fadeOut: 0 }, 0, 'flash');
  lamps.advance(100, 120);
  close(lamps.pulse(1).bri, 1, 'inside the plateau');
  lamps.set(1, RED, 0.1, { kind: 'instant' }, 0, 'rest');
  lamps.advance(100, 120);
  close(lamps.pulse(1).bri, 148 / 255, 'the rest started the release 100 ms ago');
  lamps.set(1, RED, 0.1, { kind: 'instant' }, 0, 'rest');
  lamps.advance(100, 120);
  close(lamps.pulse(1).bri, FLOOR, 'a second rest renews nothing');
});

test('a row whose fast cadence needs the acknowledgement renders nothing without it, whatever its spec says', () => {
  const room = row(2);
  const draw = (params, spec, acknowledged) => {
    const inst = { id: 'x', spec: validateSpec({ kind: 'ldj.FadeCycle', params, ...spec }), seed: seedFrom('x'), anchorBeat: 0, startedAtMs: 0, targets: null };
    const out = Array.from({ length: 2 }, () => ({ colour: { ...WHITE }, level: 0, strength: 0 }));
    renderEffect(inst, { beatPos: 0, bpm: 120, nowMs: 0, dtMs: 0, anchorBeat: 0, lookPalette: [RED], paletteOverride: null, audio: null, audioMode: 'tempo',
      master: HD_MASTER_DEFAULTS, seed: inst.seed, acknowledged, hueStrobe: 'flash' }, room, new EffectStepper(), out);
    return out.some((s) => s.strength > 0);
  };
  assert.strictEqual(draw({ cadence: 1 }, {}, false), true, 'its own cadence needs nothing');
  assert.strictEqual(draw({ cadence: 0.25 }, {}, false), false, 'a quarter beat does');
  assert.strictEqual(draw({ cadence: 0.25 }, { rapidFlash: false }, false), false, 'and rapidFlash false cannot waive it');
  assert.strictEqual(draw({ cadence: 0.25 }, {}, true), true);
});
