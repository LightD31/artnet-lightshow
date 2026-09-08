'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PATTERN_FUNCS } = require('../../src/server/patterns');
const { PATTERNS, COLOR_PRESETS } = require('../../src/server/presets');

test('every advertised pattern has an implementation, and vice versa', () => {
  const advertised = PATTERNS.map((p) => p.id).sort();
  const implemented = Object.keys(PATTERN_FUNCS).sort();
  assert.deepStrictEqual(implemented, advertised, 'the UI list and the engine must agree');
});

test('each pattern writes valid colours for every fixture count it is offered at', () => {
  const colors = [COLOR_PRESETS[0], COLOR_PRESETS[6], COLOR_PRESETS[4], COLOR_PRESETS[8]];

  for (const id of Object.keys(PATTERN_FUNCS)) {
    for (const fixtureCount of [1, 2, 4, 8]) {
      const written = new Map();
      for (let step = 0; step < 8; step++) {
        PATTERN_FUNCS[id]({
          colors,
          fixtureCount,
          step,
          hue: (step * 45) % 360,
          twinkle: new Array(fixtureCount).fill(0),
          write: (idx, color, dim, strobe) => written.set(idx, { color, dim, strobe }),
          resetHitPhase: () => {},
        });
      }

      for (const [idx, { color, dim }] of written) {
        assert.ok(idx >= 0 && idx < fixtureCount, `${id}: wrote fixture ${idx} of ${fixtureCount}`);
        for (const ch of ['r', 'g', 'b']) {
          assert.ok(Number.isFinite(color[ch]) && color[ch] >= 0 && color[ch] <= 255,
            `${id}: ${ch}=${color[ch]} out of range`);
        }
        assert.ok(Number.isFinite(dim) && dim >= 0 && dim <= 255, `${id}: dim=${dim} out of range`);
      }
    }
  }
});

// ── Colour-count awareness ──────────────────────────────────────────────────
//
// The old bank carried split / split-3 / split-4, chase / chase-3 / chase-4,
// alt-halves / alt-thirds / alt-quarters and pairs / pairs-4 — four patterns
// spelled eleven ways, where the suffix only ever said how many colours to
// reach for. Patterns now read that off the look, which is only a fold rather
// than a loss if a two-colour palette really does drive them with two colours
// and a four-colour one with four.

const { paletteOf } = require('../../src/server/patterns');

/** The four slots as a palette of `size` wraps them: a duo is A/B/A/B. */
function slotsOf(size) {
  const picks = [0, 6, 3, 8].slice(0, size);
  return [0, 1, 2, 3].map((i) => COLOR_PRESETS[picks[i % size]]);
}

/** Every distinct colour a pattern writes across a full cycle of steps. */
function coloursUsed(id, size, fixtureCount = 4) {
  const colors = slotsOf(size);
  const seen = new Set();
  const twinkle = new Array(fixtureCount).fill(0);
  for (let step = 0; step < 24; step++) {
    PATTERN_FUNCS[id]({
      colors,
      fixtureCount,
      step,
      hue: 0,
      twinkle,
      write: (_i, color, dim) => { if (dim > 0) seen.add(color); },
      resetHitPhase: () => {},
    });
  }
  return seen;
}

test('the slots a palette wrapped into collapse back to the size that was picked', () => {
  assert.strictEqual(paletteOf({ colors: slotsOf(2) }).length, 2, 'A/B/A/B is a duo');
  assert.strictEqual(paletteOf({ colors: slotsOf(3) }).length, 3, 'A/B/C/A is a triad');
  assert.strictEqual(paletteOf({ colors: slotsOf(4) }).length, 4, 'A/B/C/D is a tetrad');
  assert.strictEqual(paletteOf({ colors: slotsOf(1) }).length, 1, 'four of one colour is mono');
});

test('the folded patterns use exactly as many colours as the look holds', () => {
  // These are the ones that used to need a -3 / -4 twin.
  for (const id of ['split', 'sections', 'chase', 'chase-rev', 'ping-pong', 'pairs',
                    'stack-up', 'color-cycle']) {
    for (const size of [2, 3, 4]) {
      assert.strictEqual(
        coloursUsed(id, size).size, size,
        `${id} on a ${size}-colour palette should light ${size} colours`,
      );
    }
  }
});

test('a mono look drives every pattern without collapsing to darkness', () => {
  // The auto show deliberately narrows to one colour for tension sections, so
  // a pattern that divided by a colour count must not fall over on a length of
  // one — and must still put light on stage.
  for (const id of Object.keys(PATTERN_FUNCS)) {
    if (id === 'rainbow') continue; // generates its own hues by design
    const seen = coloursUsed(id, 1);
    assert.ok(seen.size <= 1, `${id} invented a colour the look does not hold`);
    assert.strictEqual(seen.size, 1, `${id} went fully dark on a mono look`);
  }
});

test('rainbow is the one pattern that ignores the look', () => {
  // Its whole job is a spectrum no palette of solid presets can supply, which
  // is also why the auto show never picks it.
  const seen = coloursUsed('rainbow', 4);
  assert.ok(seen.size > 4, 'rainbow should generate hues rather than reuse slots');
});
