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
