'use strict';

// Every four-colour bank in palettes.js gives its slots jobs: A dominant, B its
// contrast, C an accent, D a *lift* — a white, a pale wash or UV — "not a
// fourth hue: without a brightness break, a four-colour chase reads as a
// rainbow rather than as a look".
//
// The director used to break that in two places. Section and drop looks rotated
// all four slots, walking the lift into A, B or C; and a minor key swapped C
// and D before either ran. Across the five committed tracks only 45 of 139 full
// looks kept the lift in D. These tests hold it there.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { ShowDirector, coloursFor } = require('../../src/show/director');
const { buildPalette } = require('../../src/show/look');
const { deriveEvents, EVENT } = require('../../src/show/musical-events');
const { INTENT } = require('../../src/show/intents');
const { COLOR_PRESETS, PATTERNS } = require('../../src/server/presets');
const { TETRADS } = require('../../src/server/palettes');

const TRACKS = path.join(__dirname, '..', 'fixtures', 'tracks');
const tracks = fs.readdirSync(TRACKS).filter((f) => f.endsWith('.json'))
  .map((f) => ({ name: f.replace(/\.json$/, ''), doc: JSON.parse(fs.readFileSync(path.join(TRACKS, f), 'utf8')) }));

const plan = (doc) => new ShowDirector({
  patterns: PATTERNS, colorPresets: COLOR_PRESETS, paletteSize: 4, intensity: 50,
}).plan(doc);

// A full look: three or more distinct colours. The build-up's tension (one
// colour) and rise (two) are deliberate narrowings with no lift to protect.
const fullLooks = (intents) => intents.filter((i) =>
  Array.isArray(i.colors) && i.colors.length === 4 && new Set(i.colors).size >= 3);

test('the committed tracks include both modes, so both palette paths are covered', () => {
  const scales = new Set(tracks.map((t) => t.doc.scale));
  assert.ok(scales.has('minor') && scales.has('major'), `scales seen: ${[...scales]}`);
});

for (const { name, doc } of tracks) {
  test(`${name}: every full look keeps the bank's lift in slot D`, () => {
    const p = plan(doc);
    const lift = TETRADS[p.paletteName][3];
    const looks = fullLooks(p.intents);
    assert.ok(looks.length > 0, 'the track should put up at least one full look');
    const stray = looks.filter((i) => i.colors[3] !== lift);
    assert.deepStrictEqual(stray.map((i) => `${i.source}@${i.timeMs}`), []);
  });
}

test('a minor key swaps dominant and contrast but leaves the lift last', () => {
  // Mood is held fixed: without it buildPalette reads valence off the scale, and
  // major and minor would land in different circumplex quadrants — a different
  // bank, which is a different question from how one bank is rotated.
  const mood = { valence: 0.6, arousal: 0.7 };
  const keys = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  for (const key of keys) {
    const major = buildPalette({ key, scale: 'major', mood, paletteSize: 4, colorPresets: COLOR_PRESETS });
    const minor = buildPalette({ key, scale: 'minor', mood, paletteSize: 4, colorPresets: COLOR_PRESETS });
    assert.strictEqual(minor.name, major.name, `${key}: same mood and key centre, same bank`);
    assert.deepStrictEqual(minor.palette,
      [major.palette[1], major.palette[0], major.palette[2], major.palette[3]], key);
    assert.strictEqual(minor.palette[3], TETRADS[minor.name][3], `${key}: lift in D`);
  }
});

test('colour moves write a whole look, lift in D, never the look already on stage', () => {
  const { doc } = tracks.find((t) => t.name === 'p-nk-try');
  const melodies = [];
  for (let t = 20; t < doc.duration - 20; t += 9) {
    melodies.push({ t, type: EVENT.MELODY_CHANGE, confidence: 0.8, intensity: 0.6, duration: 0, data: {} });
  }
  const p = plan({ ...doc, events: [...deriveEvents(doc), ...melodies] });
  const lift = TETRADS[p.paletteName][3];
  const moves = p.intents.filter((i) => i.kind === INTENT.COLOR);
  assert.ok(moves.length >= 5, `expected colour moves, got ${moves.length}`);

  for (const move of moves) {
    assert.strictEqual(move.colors.length, 4, 'a move sets every slot, not just A');
    assert.strictEqual(move.colors[3], lift, 'the lift stays in D');
    const section = p.context.sectionAt(move.timeMs / 1000);
    const onStage = coloursFor(section ? section.identity : 0, p.palette);
    assert.notDeepStrictEqual(move.colors, onStage,
      `move at ${move.timeMs} ms repeats the section's own look`);
  }
});
