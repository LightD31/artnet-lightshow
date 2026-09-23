// A returning chorus kept its look — that is how the room recognises it — and
// was also rendered exactly as the first time through, so the biggest moment
// of the song looked like its first chorus. Measured across the analysis
// cache, the last return even got *fewer* accents than the first (10.3 a
// minute against 12.8). The last time a passage comes round now steps up a
// subdivision, and wins the accent budget when it competes for it.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { ShowDirector } from '../../src/show/director.js';
import { COLOR_PRESETS, PATTERNS } from '../../src/server/presets.js';

const TRACKS = path.join(import.meta.dirname, '..', 'fixtures', 'tracks');
const tracks = fs.readdirSync(TRACKS).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(TRACKS, f), 'utf8')));

const plan = (doc) => new ShowDirector({
  patterns: PATTERNS, colorPresets: COLOR_PRESETS, paletteSize: 4, intensity: 50,
}).plan(doc);

/** Each recurring non-resting passage's sections, in order: same identity, same role. */
function recurring(context) {
  const by = new Map();
  for (const s of context.sections) {
    if (s.resting || s.identity == null) continue;
    const key = `${s.identity}|${s.role}`;
    by.set(key, [...(by.get(key) || []), s]);
  }
  return [...by.values()].filter((list) => list.length > 1);
}

/**
 * The beat division a section's own look sets. Read from the section scene
 * rather than sampled at a moment: at a drop the impact scenes sit on top of
 * it for the first beats.
 */
function sectionDivision(intents, section) {
  const scene = intents.find((i) => i.kind === 'SCENE' && i.source === `section:${section.role}`
    && Math.abs(i.timeMs - section.start * 1000) < 1000);
  return scene ? scene.beatDivision : null;
}

test('the last return of a passage never runs slower than its first', () => {
  let lifted = 0;
  for (const doc of tracks) {
    const { intents, context } = plan(doc);
    for (const list of recurring(context)) {
      const first = list[0];
      const last = list[list.length - 1];
      const a = sectionDivision(intents, first);
      const b = sectionDivision(intents, last);
      // An unchanged look emits no new scene; nothing to compare there.
      if (a == null || b == null) continue;
      assert.ok(b >= a, `${doc.track.name}: ${a} the first time, ${b} the last`);
      if (b > a) lifted++;
    }
  }
  assert.ok(lifted >= 1, 'at least one committed track lifts its last chorus');
});

test('the last return of a passage is punctuated at least as often as its first', () => {
  let first = 0;
  let last = 0;
  for (const doc of tracks) {
    const { intents, context } = plan(doc);
    const accents = intents.filter((i) => i.kind === 'ACCENT' && !i.source.startsWith('drop:'));
    const rate = (s) => accents.filter((a) => a.timeMs >= s.start * 1000 && a.timeMs < s.end * 1000).length
      / ((s.end - s.start) / 60);
    for (const list of recurring(context)) {
      first += rate(list[0]);
      last += rate(list[list.length - 1]);
    }
  }
  assert.ok(last > first, `${last.toFixed(1)} a minute the last time, ${first.toFixed(1)} the first`);
});

test('an outro that repeats the intro is not treated as a climax', () => {
  for (const doc of tracks) {
    const { context } = plan(doc);
    for (const s of context.finalReturns) assert.ok(!s.resting, `${doc.track.name}: ${s.role}`);
  }
});
