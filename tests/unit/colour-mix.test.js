'use strict';

// `ribbon` crossfades slot A into slot B across the rig. A and B are opposites
// by design, and averaging them per channel washed the middle of the rig out
// to grey — on ten of the twenty-four coloured banks it kept under half the
// saturation of either end. The blend now goes round the colour wheel.

const test = require('node:test');
const assert = require('node:assert');

const { colourMixer, chromaOf } = require('../../src/shared/color');
const { PATTERN_FUNCS } = require('../../src/shared/patterns');
const { COLOR_PRESETS } = require('../../src/server/presets');
const { TETRADS } = require('../../src/server/palettes');

const P = Object.fromEntries(COLOR_PRESETS.map((c) => [c.name, c]));
const KEYS = ['r', 'g', 'b', 'w', 'a', 'uv'];
const pick = (c) => Object.fromEntries(KEYS.map((k) => [k, c[k] || 0]));

// The banks whose A and B are both genuinely coloured: a white end has no
// saturation to lose.
const pairs = Object.entries(TETRADS)
  .map(([name, [a, b]]) => ({ name, A: COLOR_PRESETS[a], B: COLOR_PRESETS[b] }))
  .filter(({ A, B }) => chromaOf(A) >= 0.1 && chromaOf(B) >= 0.1);

test('the ends of a blend are exactly the two colours', () => {
  for (const { A, B } of pairs) {
    const mix = colourMixer(A, B);
    assert.deepStrictEqual(mix(0), pick(A));
    assert.deepStrictEqual(mix(1), pick(B));
  }
});

/** The least saturated point along a blend, as a fraction of the weaker end. */
function worstAlong(A, B, blend) {
  const ends = Math.min(chromaOf(A), chromaOf(B));
  let worst = Infinity;
  for (let i = 0; i <= 100; i++) worst = Math.min(worst, chromaOf(blend(i / 100)) / ends);
  return worst;
}
const average = (A, B) => (t) => Object.fromEntries(['r', 'g', 'b'].map((k) => [k, A[k] + (B[k] - A[k]) * t]));

test('no bank\'s blend loses more colour than the per-channel average did', () => {
  assert.ok(pairs.length >= 10, `expected many coloured pairs, got ${pairs.length}`);
  for (const { name, A, B } of pairs) {
    const before = worstAlong(A, B, average(A, B));
    const after = worstAlong(A, B, colourMixer(A, B));
    // A hair of slack for integer DMX rounding; nothing more.
    assert.ok(after >= before - 0.02, `${name}: ${after.toFixed(2)} against ${before.toFixed(2)} before`);
  }
});

test('the greyest point of any bank\'s blend keeps at least half its colour', () => {
  // Measured: the average bottomed out at 0.04 (Green into Magenta). Where the
  // blend still dips, the short way round the wheel passes colours the RGB dies
  // cannot make at that brightness, and saturation is given up to keep the hue.
  const worst = Math.min(...pairs.map(({ A, B }) => worstAlong(A, B, colourMixer(A, B))));
  assert.ok(worst >= 0.5, `worst ${worst.toFixed(2)}`);
});

test('the old per-channel average greyed the worst pair to almost nothing', () => {
  // Kept as a record of the failure, measured the same way.
  const avg = Object.fromEntries(['r', 'g', 'b'].map((k) => [k, (P.Green[k] + P.Magenta[k]) / 2]));
  assert.ok(chromaOf(avg) / Math.min(chromaOf(P.Green), chromaOf(P.Magenta)) < 0.1);
  const mid = colourMixer(P.Green, P.Magenta)(0.5);
  assert.ok(chromaOf(mid) / Math.min(chromaOf(P.Green), chromaOf(P.Magenta)) >= 0.8);
});

test('every blended value is a DMX integer the emitters can make', () => {
  for (const { A, B } of pairs) {
    const mix = colourMixer(A, B);
    for (let i = 0; i <= 50; i++) {
      for (const [k, v] of Object.entries(mix(i / 50))) {
        assert.ok(Number.isInteger(v) && v >= 0 && v <= 255, `${k}=${v}`);
      }
    }
  }
});

test('the blend moves smoothly: no jump where the gamut mapping engages', () => {
  for (const { name, A, B } of pairs) {
    const mix = colourMixer(A, B);
    let prev = mix(0);
    for (let i = 1; i <= 200; i++) {
      const next = mix(i / 200);
      const jump = Math.max(...KEYS.map((k) => Math.abs(next[k] - prev[k])));
      assert.ok(jump <= 24, `${name}: a ${jump}-step jump at t=${i / 200}`);
      prev = next;
    }
  }
});

test('fading a colour into a neutral white die keeps the colour\'s hue', () => {
  const white = { r: 0, g: 0, b: 0, w: 255 };
  const mid = colourMixer(P.Red, white)(0.5);
  assert.ok(mid.r > 0 && mid.g === 0 && mid.b === 0, `stays red on the way: ${JSON.stringify(mid)}`);
  assert.strictEqual(mid.w, 128);
});

test('ribbon on a rig: the middle lamp is as coloured as the ends', () => {
  const [a, b] = TETRADS.emeraldCity;
  const colors = [COLOR_PRESETS[a], COLOR_PRESETS[b], COLOR_PRESETS[a], COLOR_PRESETS[b]];
  const ends = Math.min(chromaOf(COLOR_PRESETS[a]), chromaOf(COLOR_PRESETS[b]));
  let worst = Infinity;
  for (let phase = 0; phase < 1; phase += 0.05) {
    PATTERN_FUNCS.ribbon({
      colors, fixtureCount: 5, phase, dynamics: { width: 0.5, motion: 0.3, air: 0.5 },
      write: (_i, c) => { worst = Math.min(worst, chromaOf(c) / ends); },
    });
  }
  // The per-channel average left this pair's middle lamp at 4%.
  assert.ok(worst >= 0.5, `the greyest lamp keeps ${(worst * 100).toFixed(0)}%`);
});
