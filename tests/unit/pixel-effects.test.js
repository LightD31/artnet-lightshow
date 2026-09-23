// The pictures drawn across every cell of every LED bar. Each is a function of
// where a cell is and where the music is, so the rehearsal preview draws
// exactly what the rig will — which these pin down as behaviour.

import test from 'node:test';
import assert from 'node:assert';
import { PATTERN_FUNCS, CELL_PATTERNS, gradientAt } from '../../src/shared/patterns.ts';
import { COLOR_PRESETS, PATTERNS } from '../../src/server/presets.js';

const RED = COLOR_PRESETS[0];
const BLUE = COLOR_PRESETS[5];
const DUO = [RED, BLUE, RED, BLUE];

/** Run a pattern over `n` evenly spaced cells and return [colour, dim] per cell. */
function draw(id, { n = 17, colors = DUO, ...ctx } = {}) {
  const out = [];
  PATTERN_FUNCS[id]({
    colors, fixtureCount: n, step: 0, hue: 0, twinkle: new Array(n).fill(0),
    write: (i, c, d) => { out[i] = [c, d]; }, ...ctx,
  });
  return out;
}
const dims = (out) => out.map(([, d]) => d);
const brightest = (out) => dims(out).indexOf(Math.max(...dims(out)));

test('the pixel effects run on every cell, and say so in the picker', () => {
  for (const id of ['gradient', 'comet', 'burst', 'plasma', 'meter']) {
    assert.ok(CELL_PATTERNS.has(id), id);
    assert.strictEqual(PATTERNS.find((p) => p.id === id).pixel, true, id);
  }
});

test('the same moment draws the same picture', () => {
  for (const id of ['gradient', 'comet', 'burst', 'plasma', 'meter']) {
    const ctx = { step: 5, stepPos: 5.3, stepPhase: 0.3, phase: 0.4, dynamics: { level: 0.7, bass: 0.6, air: 0.4, width: 0.5, motion: 0.4, decay: 0.3 } };
    assert.deepStrictEqual(draw(id, ctx), draw(id, ctx), id);
  }
});

test('a comet\'s head crosses the rig once every four steps', () => {
  const start = dims(draw('comet', { stepPos: 0 }));
  assert.strictEqual(brightest(draw('comet', { stepPos: 0 })), 0, 'starts at stage left');
  assert.strictEqual(start[16], start[8], 'and only there: the far end is not lit at the seam');
  let last = -1;
  for (let pos = 0; pos <= 3.25; pos += 0.25) {
    const at = brightest(draw('comet', { stepPos: pos }));
    assert.ok(at >= last, `it only moves forward: ${at} after ${last} at step ${pos}`);
    last = at;
  }
  assert.strictEqual(last, 16, 'reaching the far side within the lap');
  const trail = dims(draw('comet', { stepPos: 2 }));
  const head = brightest(draw('comet', { stepPos: 2 }));
  assert.ok(trail[head - 1] > trail[head - 2] && trail[head - 2] > trail[0], `a tail behind it, fading: ${trail}`);
  assert.strictEqual(draw('comet', { stepPos: 2 })[head][0], RED, 'lap 0 in colour A');
  assert.strictEqual(draw('comet', { stepPos: 6 })[head][0], BLUE, 'lap 1 in colour B');
  assert.ok(dims(draw('comet', { stepPos: 3.99 })).every((d) => d === 45), 'and the lap ends dark');
});

test('a burst is thrown out from the centre of the stage over each step', () => {
  assert.strictEqual(brightest(draw('burst', { stepPhase: 0 })), 8, 'starts in the middle');
  const later = draw('burst', { stepPhase: 0.6 });
  const peak = brightest(later);
  assert.ok(Math.abs(peak - 8) >= 4, `and moves outward: brightest at ${peak}`);
  assert.deepStrictEqual(dims(later).slice(0, 8), dims(later).slice(9).reverse(), 'symmetrically');
});

test('a gradient runs through the look\'s colours and scrolls', () => {
  const at0 = draw('gradient', { stepPos: 0, dynamics: { width: 0.5 } });
  assert.strictEqual(at0[0][0], RED, 'colour A at stage left, as the preset itself');
  assert.notStrictEqual(at0[8][0], RED, 'and blending on from there');
  const later = draw('gradient', { stepPos: 4, dynamics: { width: 0.5 } });
  assert.notDeepStrictEqual(later.map(([c]) => c), at0.map(([c]) => c), 'it moves with the music');
  assert.strictEqual(gradientAt([RED, BLUE], 0.5), BLUE, 'halfway round a duo is colour B');
  assert.strictEqual(gradientAt([BLUE], 0.3), BLUE, 'a mono look is its one colour');
});

test('a meter fills further with more low end, and from the middle when mirrored', () => {
  const lit = (out) => out.filter(([, d]) => d === 255).length;
  const quiet = draw('meter', { stepPhase: 0.9, dynamics: { level: 1, bass: 0.1 } });
  const loud = draw('meter', { stepPhase: 0.9, dynamics: { level: 1, bass: 0.9 } });
  assert.ok(lit(loud) > lit(quiet), `${lit(quiet)} → ${lit(loud)}`);
  assert.strictEqual(quiet[0][1], 255, 'filling from stage left');
  const xs = Array.from({ length: 17 }, (_, i) => Math.abs(2 * (i / 16) - 1));
  const mirrored = draw('meter', { stepPhase: 0.9, dynamics: { level: 1, bass: 0.5 }, xs });
  assert.strictEqual(mirrored[8][1], 255, 'mirrored, the middle fills first');
  assert.ok(mirrored[0][1] < 255 && mirrored[16][1] < 255, 'and the edges last');
});

test('plasma moves and stays inside the look\'s colours', () => {
  const a = draw('plasma', { stepPos: 0 });
  const b = draw('plasma', { stepPos: 3 });
  assert.notDeepStrictEqual(dims(a), dims(b));
  assert.ok(dims(a).every((d) => d >= 20 && d <= 255));
  const mono = draw('plasma', { stepPos: 1, colors: [BLUE, BLUE, BLUE, BLUE] });
  assert.ok(mono.every(([c]) => c === BLUE), 'one colour in, one colour out');
});
