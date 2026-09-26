// The pictures drawn across every cell of every LED bar. Each is a function of
// where a cell is and where the music is, so the rehearsal preview draws
// exactly what the rig will — which these pin down as behaviour.

import test from 'node:test';
import assert from 'node:assert';
import { PATTERN_FUNCS, CELL_PATTERNS, gradientAt } from '../../src/shared/patterns.ts';
import { COLOR_PRESETS, PATTERNS } from '../../src/server/presets.ts';

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

// ── Panels: after LedFx's and WLED's matrix effects ─────────────────────────

/** A W × H panel laid out per bar: x across it, y down it (0 its top row). */
function panel(id, w, h, ctx = {}) {
  const n = w * h;
  const xs = []; const ys = [];
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) { xs.push(c / (w - 1)); ys.push(r / (h - 1)); }
  const out = draw(id, { n, xs, ys, ...ctx });
  return { at: (c, r) => out[r * w + c], out };
}

const PULSE = { mix: 0.8, drums: 0.7, bass: 0.9, vocals: 0.2, other: 0.5, kick: 1, snare: 0, hats: 0 };

test('bars: each band a column, filled from the bottom as high as it plays', () => {
  const { at } = panel('bars', 7, 10, { pulse: PULSE });
  const lit = (c) => [...Array(10).keys()].filter((r) => at(c, r)[1] >= 170).length;
  assert.ok(lit(0) >= 9, `the kick, hit, fills its column: ${lit(0)}`);
  assert.strictEqual(lit(3), 1, 'the snare, silent, only its bottom cell');
  assert.ok(lit(1) > lit(5), 'the bass stands taller than the voice');
  assert.ok(at(1, 9)[1] >= 170 && at(5, 0)[1] < 170, 'filled from the bottom, not the top');
  // On a strip there is no height: each band lights its stretch as it plays.
  const strip = dims(draw('bars', { n: 14, pulse: PULSE }));
  assert.ok(strip[0] > strip[6], `kick bright, snare dim: ${strip}`);
});

test('fire: hottest at the root, taller with the bass, and the same flames for the same moment', () => {
  const quiet = panel('fire', 8, 16, { stepPos: 3.2, pulse: { ...PULSE, bass: 0.1, kick: 0 } });
  const loud = panel('fire', 8, 16, { stepPos: 3.2, pulse: { ...PULSE, bass: 1, kick: 1 } });
  const row = (p, r) => [...Array(8).keys()].reduce((sum, c) => sum + p.at(c, r)[1], 0);
  assert.ok(row(loud, 15) > row(loud, 2), 'the bottom row burns brighter than the top');
  assert.ok(row(loud, 8) > row(quiet, 8), 'and the bass drives the flames higher');
  assert.deepStrictEqual(panel('fire', 8, 16, { stepPos: 3.2, pulse: PULSE }).out, panel('fire', 8, 16, { stepPos: 3.2, pulse: PULSE }).out);
});

test('rain: drops falling down each column in time, the head in the lift colour', () => {
  const heads = (pos) => {
    const { at } = panel('rain', 1, 40, { stepPos: pos, colors: [RED, BLUE, RED, BLUE] });
    let best = 0;
    for (let r = 1; r < 40; r++) if (at(0, r)[1] > at(0, best)[1]) best = r;
    return { row: best, colour: at(0, best)[0] };
  };
  const a = heads(0.4);
  const b = heads(0.8);
  assert.ok(b.row > a.row, `it falls: row ${a.row}, then ${b.row}`);
  assert.strictEqual(a.colour, BLUE, 'the head in the look\'s lift');
  const columns = panel('rain', 12, 20, { stepPos: 1.3 });
  const headRows = [...Array(12).keys()].map((c) => {
    let best = 0;
    for (let r = 0; r < 20; r++) if (columns.at(c, r)[1] > columns.at(c, best)[1]) best = r;
    return best;
  });
  assert.ok(new Set(headRows).size > 4, `each column its own drop: ${headRows}`);
});

test('the panel effects cost no more on a 64 × 32 WLED matrix than the pictures the engine already draws', () => {
  // Against Plasma, the costliest of those (see "How much" in the README),
  // timed alongside them: a machine busy with other tests slows both alike.
  const cost = (id) => {
    let best = Infinity;
    for (let round = 0; round < 5; round++) {
      const started = performance.now();
      for (let k = 0; k < 6; k++) panel(id, 64, 32, { stepPos: k * 0.1, pulse: PULSE });
      best = Math.min(best, (performance.now() - started) / 6);
    }
    return best;
  };
  const plasma = cost('plasma');
  for (const id of ['bars', 'fire', 'rain']) {
    const took = cost(id);
    assert.ok(took < plasma * 2.5 + 0.5, `${id}: ${took.toFixed(2)} ms a frame, plasma ${plasma.toFixed(2)} ms`);
  }
});

// ── Strobe effects ──────────────────────────────────────────────────────────
// After the hybrid strobes' programs: hard flashes on black, zone by zone,
// timed in milliseconds whatever the tempo.

const STROBES = ['flash-chase', 'flash-scatter', 'flash-fill', 'flash-alternate', 'ramp', 'core'];
const WHITE = (c) => c.r === 255 && c.g === 255 && c.b === 255 && c.w === 255;
/** A moment `ms` into the music at `bpm`, `division` steps to the beat. */
const at = (ms, bpm = 128, division = 1) => {
  const stepMs = 60000 / bpm / division;
  const stepPos = ms / stepMs;
  return { step: Math.floor(stepPos), stepPos, stepPhase: stepPos - Math.floor(stepPos), stepMs };
};

test('the strobe effects run on every zone, say so in the picker, and draw the same moment the same way', () => {
  for (const id of STROBES) {
    assert.ok(CELL_PATTERNS.has(id), id);
    assert.strictEqual(PATTERNS.find((p) => p.id === id).pixel, true, id);
    assert.deepStrictEqual(draw(id, { n: 8, ...at(1234) }), draw(id, { n: 8, ...at(1234) }), id);
  }
});

test('a flash is hard, on black, and never shorter than two frames, however fast the music', () => {
  for (const id of ['flash-chase', 'flash-scatter', 'flash-alternate']) {
    for (const [bpm, division] of [[90, 1], [128, 2], [174, 4]]) {
      const runs = new Map();
      const shortest = new Map();
      for (let ms = 0; ms < 4000; ms++) {
        draw(id, { n: 8, ...at(ms, bpm, division) }).forEach(([, d], i) => {
          assert.ok(d === 0 || d === 255, `${id}: ${d} is neither a flash nor black`);
          if (d) runs.set(i, (runs.get(i) || 0) + 1);
          else if (runs.get(i)) {
            shortest.set(i, Math.min(shortest.get(i) ?? Infinity, runs.get(i)));
            runs.set(i, 0);
          }
        });
      }
      assert.ok(shortest.size, `${id} at ${bpm} BPM flashes`);
      for (const [i, ms] of shortest) assert.ok(ms >= 45, `${id} at ${bpm} BPM / ${division}: zone ${i} lit only ${ms} ms`);
    }
  }
});

test('a flash chase lights one zone at a time, out from the middle when mirrored', () => {
  const lit = (out) => out.flatMap(([, d], i) => (d ? [i] : []));
  assert.deepStrictEqual(lit(draw('flash-chase', { n: 8, ...at(0) })), [0]);
  assert.deepStrictEqual(lit(draw('flash-chase', { n: 8, ...at(469 * 3 / 8 + 1) })), [3], 'three eighths of the way round');
  const mirrored = [0.5, 0.25, 0, 0.25, 0.5].map((x) => Math.abs(2 * x - 1));
  assert.deepStrictEqual(lit(draw('flash-chase', { n: 5, xs: [1, 0.5, 0, 0.5, 1], ...at(0) })), [2], 'the middle first');
  assert.deepStrictEqual(lit(draw('flash-chase', { n: 5, xs: [1, 0.5, 0, 0.5, 1], ...at(160) })), [1, 3], 'then both sides at once');
  assert.strictEqual(mirrored.length, 5);
});

test('a fill flash grows from the middle, holds, and is cut to black before the next step', () => {
  const lit = (phase) => draw('flash-fill', { n: 8, step: 0, stepPos: phase, stepPhase: phase }).map(([, d]) => (d ? 1 : 0)).join('');
  assert.strictEqual(lit(0), '00011000', 'the two zones nearest the middle first');
  assert.strictEqual(lit(0.15), '00111100');
  assert.strictEqual(lit(0.4), '11111111');
  assert.strictEqual(lit(0.7), '00000000');
});

test('odd and even zones take turns, the step and the half-step between', () => {
  const lit = (ms) => draw('flash-alternate', { n: 6, ...at(ms) }).map(([, d]) => (d ? 1 : 0)).join('');
  assert.strictEqual(lit(10), '101010');
  assert.strictEqual(lit(100), '000000', 'dark between flashes');
  assert.strictEqual(lit(469 / 2 + 10), '010101');
});

test('a ramp swells from the middle and is cut on the beat', () => {
  const ramp = (phase) => dims(draw('ramp', { n: 9, step: 0, stepPos: phase, stepPhase: phase }));
  assert.ok(ramp(0.01).every((d) => d < 5), 'black on the beat');
  const mid = ramp(0.5);
  assert.ok(mid[4] > mid[0] && mid[4] > mid[8], 'the middle ahead of the edges');
  assert.ok(ramp(0.99).every((d) => d > 230), 'full just before the next beat');
});

test('the strobe core strikes white in the middle, over a wash in the look\'s colour', () => {
  const struck = draw('core', { n: 9, ...at(10) });
  assert.ok(WHITE(struck[4][0]) && struck[4][1] === 255, 'the core strikes');
  assert.ok(struck[0][0] === RED && struck[0][1] > 100, 'the edges hold the wash');
  const between = draw('core', { n: 9, ...at(250) });
  assert.ok(!WHITE(between[4][0]) && between[4][1] < between[0][1], 'between strikes the core only glows');
  // With the pulse, on the kick as it was hit, not on the grid.
  const off = draw('core', { n: 9, ...at(10), pulse: { mix: 0.8, kick: 0.1, snare: 0, hats: 0 } });
  const kick = draw('core', { n: 9, ...at(250), pulse: { mix: 0.8, kick: 0.95, snare: 0, hats: 0 } });
  assert.deepStrictEqual([WHITE(off[4][0]), WHITE(kick[4][0])], [false, true]);
});
