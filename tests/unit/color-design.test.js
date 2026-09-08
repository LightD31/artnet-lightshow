'use strict';

// The colour table and the palette banks are hand-written, and the failure mode
// when they drift is quiet: a new preset lands three degrees from an existing
// one, a look picks up two colours from the same family, and from the floor
// half the buttons start doing the same thing. Nothing throws, nothing looks
// wrong in code review, the rig just gets duller.
//
// These tests are the design rules from presets.js and palettes.js written down
// so an edit has to argue with them.

const test = require('node:test');
const assert = require('node:assert');

const { COLOR_PRESETS } = require('../../src/server/presets');
const { TETRADS, TRIADS, DUOS, PALETTE_IDS } = require('../../src/server/palettes');

/**
 * What a preset looks like once the emitters mix, rather than what its r/g/b
 * triple says on its own. Amber is mostly the amber emitter and Warm White is
 * mostly white + amber, so judging either on r/g/b alone gets the wrong answer
 * about whether it clashes with its neighbours.
 *
 * Mirrors colorToCss in public-src/utils.js, scale-back included.
 */
function mixed(i) {
  const c = COLOR_PRESETS[i];
  const w = c.w || 0, a = c.a || 0, uv = c.uv || 0;
  let r = c.r + w + a + uv * 0.2;
  let g = c.g + w + a * 0.5;
  let b = c.b + w + uv * 0.9;
  const peak = Math.max(r, g, b);
  if (peak > 255) { const k = 255 / peak; r *= k; g *= k; b *= k; }

  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;

  return {
    name: c.name,
    hue: Math.round(h),
    sat: max ? d / max : 0,
    // UV has no visible RGBW component at all; blackout has nothing.
    isUv: uv > 0 && c.r + c.g + c.b + w === 0,
    isBlack: max === 0 && uv === 0,
  };
}

/** Shortest way round the wheel between two hues. */
function hueGap(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

const all = COLOR_PRESETS.map((_, i) => ({ index: i, ...mixed(i) }));
const isHue = (c) => !c.isUv && !c.isBlack && c.sat >= 0.55;
const isPale = (c) => !c.isUv && !c.isBlack && c.sat < 0.55;

const saturated = all.filter(isHue);
const pale = all.filter(isPale);

test('the saturated presets are spread around the wheel, not clustered', () => {
  // 30° is roughly where two washes stop being "the same colour, a bit off" at
  // the back of a dark room. The old table had five entries inside a 35° arc of
  // violet alone.
  for (let i = 0; i < saturated.length; i++) {
    for (let j = i + 1; j < saturated.length; j++) {
      const gap = hueGap(saturated[i].hue, saturated[j].hue);
      assert.ok(
        gap >= 30,
        `${saturated[i].name} (${saturated[i].hue}°) and ${saturated[j].name} ` +
        `(${saturated[j].hue}°) are only ${gap}° apart — one of them is redundant`,
      );
    }
  }
  assert.ok(saturated.length >= 8, 'the wheel should still cover every hue family');
});

test('the pale and white presets are told apart by hue or by saturation', () => {
  // Cool White and Moonlight sit on the same hue on purpose: one reads as white
  // and one as a blue wash, which is a difference in saturation, not in hue.
  for (let i = 0; i < pale.length; i++) {
    for (let j = i + 1; j < pale.length; j++) {
      const gap = hueGap(pale[i].hue, pale[j].hue);
      const satGap = Math.abs(pale[i].sat - pale[j].sat);
      assert.ok(
        gap >= 40 || satGap >= 0.2,
        `${pale[i].name} and ${pale[j].name} are ${gap}° apart with a ` +
        `saturation difference of ${satGap.toFixed(2)} — too alike to be two buttons`,
      );
    }
  }
});

test('every preset swatch is distinguishable from every other', () => {
  // The UI and the Companion buttons both draw a preset by mixing it down to
  // one RGB colour. Two presets that mix to the same swatch are two buttons the
  // operator cannot tell apart, whatever the underlying channels say.
  const seen = new Map();
  for (const c of all) {
    const key = `${c.hue}|${c.sat.toFixed(2)}|${c.isUv}|${c.isBlack}`;
    assert.ok(!seen.has(key), `${c.name} draws the same swatch as ${seen.get(key)}`);
    seen.set(key, c.name);
  }
});

test('no look holds two saturated colours from the same family', () => {
  // A tetrad is meant to be four distinguishable things. Two hues within 30° of
  // each other read as one colour plus noise, which is how `violetDream` used
  // to spend three of its four slots on purple.
  for (const [id, colors] of Object.entries(TETRADS)) {
    const hues = colors.map(mixed).filter(isHue);
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        const gap = hueGap(hues[i].hue, hues[j].hue);
        assert.ok(
          gap >= 30,
          `${id} pairs ${hues[i].name} with ${hues[j].name}, only ${gap}° apart`,
        );
      }
    }
  }
});

test('every duo is a real split rather than two shades of one colour', () => {
  // Two lamps means the pair *is* the look — there is no third colour to carry
  // the contrast, so the two have to be opposite each other or, failing that,
  // on clearly different saturation tiers (white against a deep blue).
  for (const id of PALETTE_IDS) {
    const [a, b] = DUOS[id].map(mixed);
    const gap = hueGap(a.hue, b.hue);
    const tiers = isHue(a) !== isHue(b) || a.isUv !== b.isUv;
    assert.ok(
      gap >= 70 || tiers,
      `${id} duo is ${a.name} + ${b.name}: ${gap}° apart and on the same tier`,
    );
  }
});

test('the fourth slot of every look is a lift, not a fourth hue', () => {
  // Slot D exists to break up the brightness of a four-colour chase. If it is
  // another saturated hue the pattern reads as a rainbow instead of as a look.
  for (const [id, colors] of Object.entries(TETRADS)) {
    const lift = mixed(colors[3]);
    assert.ok(
      !isHue(lift),
      `${id} ends on ${lift.name}, a saturated hue — slot D should be a white, a pale wash or UV`,
    );
  }
});

test('no two looks resolve to the same colours at any size', () => {
  // Two buttons that write identical slots are one button and a lie.
  const key = (a) => a.slice().sort((x, y) => x - y).join(',');
  for (const [label, bank] of [['duo', DUOS], ['triad', TRIADS], ['tetrad', TETRADS]]) {
    const seen = new Map();
    for (const [id, colors] of Object.entries(bank)) {
      const k = key(colors);
      assert.ok(!seen.has(k), `${label}s ${id} and ${seen.get(k)} are the same colours`);
      seen.set(k, id);
    }
  }
});
