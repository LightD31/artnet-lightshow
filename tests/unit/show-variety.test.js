// A night of different songs should not look like one song. Choices were seeded
// by a passage's identity alone — small integers from zero — so tracks of the
// same shape got the same patterns in the same order, and every intro, build-up
// tension and break in every track was `ribbon`. Each track now has its own
// seed; each track's show stays exactly repeatable.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { ShowDirector } from '../../src/show/director.js';
import { COLOR_PRESETS, PATTERNS } from '../../src/server/presets.js';

const TRACKS = path.join(import.meta.dirname, '..', 'fixtures', 'tracks');
const tracks = fs.readdirSync(TRACKS).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(TRACKS, f), 'utf8')));

const plan = (doc, intensity = 50) => new ShowDirector({
  patterns: PATTERNS, colorPresets: COLOR_PRESETS, paletteSize: 4, intensity,
}).plan(doc);

const RESTING_LOOKS = new Set(['ribbon', 'fade', 'wave', 'solid']);
const RESTING_SOURCES = new Set(['section:intro', 'section:outro', 'section:breakdown', 'buildup:tension']);

test('a track\'s show is exactly the same every time it is planned', () => {
  for (const doc of tracks) {
    assert.deepStrictEqual(plan(doc).intents, plan(doc).intents, doc.track.name);
  }
});

test('resting passages use more than one look across a set', () => {
  const used = new Set();
  for (const doc of tracks) {
    for (const i of plan(doc).intents) {
      // Only resting looks count: an outro stuck on a chasing pattern is the
      // other bug, not variety.
      if (RESTING_SOURCES.has(i.source) && RESTING_LOOKS.has(i.pattern)) used.add(i.pattern);
    }
  }
  assert.ok(used.size >= 2, `resting looks used: ${[...used]}`);
});

test('a resting section rests even when it shares a cluster with a chorus', () => {
  // The labeller often puts a fading outro in the chorus's cluster. The cached
  // chorus pattern used to win, so the outro drove on.
  for (const doc of tracks) {
    const segments = doc.segments.map((s) => ({ ...s }));
    const chorus = segments.find((s) => !['intro', 'outro', 'breakdown'].includes(s.role));
    const last = segments[segments.length - 1];
    last.role = 'outro';
    last.label = chorus.label;
    for (const i of plan({ ...doc, segments }).intents) {
      if (i.source === 'section:outro') {
        assert.ok(RESTING_LOOKS.has(i.pattern), `${doc.track.name}: outro on ${i.pattern}`);
      }
    }
  }
});

test('the same arrangement under a different title gets a different show', () => {
  // Identical measurements; only what identifies the recording differs.
  const doc = tracks[0];
  const shows = new Set();
  for (const name of ['One', 'Two', 'Three', 'Four', 'Five', 'Six']) {
    const renamed = { ...doc, track: { ...doc.track, name } };
    shows.add(plan(renamed).intents.filter((i) => i.pattern).map((i) => i.pattern).join(','));
  }
  assert.ok(shows.size >= 3, `only ${shows.size} distinct pattern sequences over six titles`);
});

test('colour-cycle is reachable again', () => {
  // Dropped from every pool by a rewrite of pickPattern while RHYTHMIC still
  // listed it. Asked of the committed tracks rather than of a hand-built
  // passage, so the test follows the show's real branches.
  const used = new Set();
  for (const doc of tracks) {
    for (const intensity of [30, 50, 80]) {
      for (const i of plan(doc, intensity).intents) if (i.pattern) used.add(i.pattern);
    }
  }
  assert.ok(used.has('color-cycle'), `patterns used: ${[...used]}`);
});
