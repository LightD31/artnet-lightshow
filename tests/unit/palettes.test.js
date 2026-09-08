'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  PALETTES, PALETTE_IDS, TETRADS, TRIADS, DUOS, paletteColors, paletteSlots,
} = require('../../src/server/palettes');
const { COLOR_PRESETS } = require('../../src/server/presets');
const { applyPatch } = require('../../src/server/patch');
const { state } = require('../../src/server/state');

test('every look exists at all three sizes with the right number of colours', () => {
  for (const id of PALETTE_IDS) {
    assert.strictEqual(DUOS[id].length, 2, `${id} duo`);
    assert.strictEqual(TRIADS[id].length, 3, `${id} triad`);
    assert.strictEqual(TETRADS[id].length, 4, `${id} tetrad`);
  }
});

// An index past the preset table reaches COLOR_PRESETS[i] as undefined and the
// engine reads .r off it — a bank typo would take the render loop down.
test('no bank entry points past the colour preset table', () => {
  for (const bank of [DUOS, TRIADS, TETRADS]) {
    for (const [id, colors] of Object.entries(bank)) {
      for (const i of colors) {
        assert.ok(
          Number.isInteger(i) && i >= 0 && i < COLOR_PRESETS.length,
          `${id} has an out-of-range index ${i}`,
        );
      }
    }
  }
});

test('the catalogue carries a name and swatches for every size', () => {
  assert.ok(PALETTES.length > 0);
  for (const p of PALETTES) {
    assert.ok(p.name && p.name !== p.id, `${p.id} should have a display name`);
    assert.deepStrictEqual(Object.keys(p.colors).sort(), ['2', '3', '4']);
  }
});

test('an unknown look resolves to nothing rather than throwing', () => {
  assert.strictEqual(paletteColors('no-such-look'), null);
  assert.strictEqual(paletteSlots('no-such-look'), null);
});

// Four slots always get a colour: the four-colour patterns read all of them,
// and an undefined slot would render as black rather than as the look.
test('a palette smaller than four slots wraps to fill them all', () => {
  const duo = paletteSlots('arctic', 2);
  assert.deepStrictEqual(duo, {
    colorA: DUOS.arctic[0], colorB: DUOS.arctic[1],
    colorC: DUOS.arctic[0], colorD: DUOS.arctic[1],
  });

  const triad = paletteSlots('arctic', 3);
  assert.deepStrictEqual(triad, {
    colorA: TRIADS.arctic[0], colorB: TRIADS.arctic[1],
    colorC: TRIADS.arctic[2], colorD: TRIADS.arctic[0],
  });
});

test('applying a palette writes all four slots and names the look', () => {
  applyPatch({ palette: 'volcanic', paletteSize: 4 });
  assert.strictEqual(state.palette, 'volcanic');
  assert.deepStrictEqual(
    [state.colorA, state.colorB, state.colorC, state.colorD],
    TETRADS.volcanic,
  );
});

// The label is only true while the four slots are the look. Editing one by hand
// makes it a lie, and a lit palette button that is not what is on stage is worse
// than no button at all.
test('editing a colour slot by hand drops the palette name', () => {
  applyPatch({ palette: 'deepOcean' });
  assert.strictEqual(state.palette, 'deepOcean');

  applyPatch({ colorC: 0 });
  assert.strictEqual(state.palette, null, 'a hand-edited slot is no longer the named look');
  assert.strictEqual(state.colorC, 0);
});

test('re-selecting the colour a slot already holds is not an edit', () => {
  applyPatch({ palette: 'royal' });
  applyPatch({ colorA: state.colorA });
  assert.strictEqual(state.palette, 'royal', 'clicking the lit swatch changes nothing');
});

// "This look, but slot A in red" is one patch, and it should land that way
// round rather than depending on key order.
test('a palette and an explicit slot in one patch let the slot win', () => {
  applyPatch({ palette: 'candyPop', colorA: 0 });
  assert.strictEqual(state.colorA, 0, 'the explicit slot wins');
  assert.strictEqual(state.colorB, TETRADS.candyPop[1], 'the rest come from the look');
});

test('an unknown palette id is refused rather than silently ignored', () => {
  assert.throws(() => applyPatch({ palette: 'not-a-look' }), /palette/);
});

test('a null palette clears the label without touching the slots', () => {
  applyPatch({ palette: 'lunar' });
  const before = [state.colorA, state.colorB, state.colorC, state.colorD];
  applyPatch({ palette: null });
  assert.strictEqual(state.palette, null);
  assert.deepStrictEqual([state.colorA, state.colorB, state.colorC, state.colorD], before);
});

// "Same look, two colours" is the obvious reading of a size change with no
// palette named, and the only alternative was a silent no-op.
test('a size change on its own re-resolves the look on stage', () => {
  applyPatch({ palette: 'arctic', paletteSize: 4 });
  assert.deepStrictEqual(
    [state.colorA, state.colorB, state.colorC, state.colorD], TETRADS.arctic,
  );

  applyPatch({ paletteSize: 2 });
  assert.strictEqual(state.palette, 'arctic', 'still the same look');
  assert.deepStrictEqual(
    [state.colorA, state.colorB, state.colorC, state.colorD],
    [DUOS.arctic[0], DUOS.arctic[1], DUOS.arctic[0], DUOS.arctic[1]],
  );

  applyPatch({ paletteSize: 3 });
  assert.deepStrictEqual(
    [state.colorA, state.colorB, state.colorC, state.colorD],
    [...TRIADS.arctic, TRIADS.arctic[0]],
  );
});

test('a size change with no look on stage leaves the slots alone', () => {
  applyPatch({ palette: null });
  const before = [state.colorA, state.colorB, state.colorC, state.colorD];
  applyPatch({ paletteSize: 4 });
  assert.strictEqual(state.palette, null);
  assert.deepStrictEqual([state.colorA, state.colorB, state.colorC, state.colorD], before);
});
