'use strict';

// Looks that change "n bars later" have to change on a bar line, and on a
// phrase boundary. Both used to fail for the same root cause: the director took
// a bar's length from the first two downbeats alone — the least trustworthy
// gap in the track, off by up to 6% on the committed tracks — and scheduled
// rotations by multiplying it. Eight bars in, a rotation could be half a bar
// adrift. Only 25 of 171 rotations across the five tracks landed on a bar line,
// and 10 on a phrase boundary.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { ShowDirector } = require('../../src/show/director');
const { COLOR_PRESETS, PATTERNS } = require('../../src/server/presets');

const TRACKS = path.join(__dirname, '..', 'fixtures', 'tracks');
const tracks = fs.readdirSync(TRACKS).filter((f) => f.endsWith('.json'))
  .map((f) => ({ name: f.replace(/\.json$/, ''), doc: JSON.parse(fs.readFileSync(path.join(TRACKS, f), 'utf8')) }));

const plan = (doc, intensity = 50) => new ShowDirector({
  patterns: PATTERNS, colorPresets: COLOR_PRESETS, paletteSize: 4, intensity,
}).plan(doc);

const TOLERANCE_MS = 1;

/** Index of the downbeat nearest `ms`. */
const nearest = (downbeats, ms) => downbeats.reduce((best, t, i) =>
  (Math.abs(t * 1000 - ms) < Math.abs(downbeats[best] * 1000 - ms) ? i : best), 0);

/** Every rotation: on a tracked downbeat, an even number of bars into its section. */
function assertOnPhraseGrid(doc, intents) {
  const db = doc.downbeats;
  const sectionScenes = intents.filter((i) => i.kind === 'SCENE'
    && String(i.source).startsWith('section:') && i.source !== 'section:solid-followup');
  const rotations = intents.filter((i) => i.source === 'rotation');
  for (const r of rotations) {
    const bar = nearest(db, r.timeMs);
    assert.ok(Math.abs(db[bar] * 1000 - r.timeMs) <= TOLERANCE_MS,
      `rotation at ${r.timeMs} ms is ${Math.round(r.timeMs - db[bar] * 1000)} ms off the nearest downbeat`);
    const owner = [...sectionScenes].reverse().find((s) => s.timeMs <= r.timeMs);
    if (owner) {
      const into = bar - nearest(db, owner.timeMs);
      assert.strictEqual(into % 2, 0, `rotation at ${r.timeMs} ms is ${into} bars into its section`);
    }
  }
  return rotations.length;
}

test('a bar is the median downbeat gap, not the first one', () => {
  const { doc } = tracks.find((t) => t.name === 'p-nk-try');
  const { barSec } = plan(doc).context;
  // Its first gap is 2.200 s; its bars run at 2.310 s.
  assert.ok(Math.abs(barSec - 2.31) < 0.01, `barSec ${barSec}`);
});

for (const { name, doc } of tracks) {
  test(`${name}: every rotation lands on a downbeat, on a phrase boundary of its section`, () => {
    let total = 0;
    for (const intensity of [30, 50, 80, 100]) total += assertOnPhraseGrid(doc, plan(doc, intensity).intents);
    assert.ok(total > 0, 'expected the track to rotate at some intensity');
  });
}

test('rotations follow a tempo that drifts across the track', () => {
  // The same arrangement with its bars stretched progressively: the last bar is
  // 8% longer than the first, which is what a live band or a DJ's pitch ride
  // does. Multiplying a fixed bar length cannot land on these; counting the
  // downbeats does.
  const { doc } = tracks.find((t) => t.name === 'p-nk-try');
  const db = doc.downbeats;
  const bar = 2.31;
  const drifted = [db[0]];
  for (let i = 1; i < db.length; i++) drifted.push(drifted[i - 1] + bar * (1 + 0.08 * i / db.length));
  const stretched = { ...doc, downbeats: drifted, duration: drifted[drifted.length - 1] + bar };
  const n = assertOnPhraseGrid(stretched, plan(stretched, 80).intents);
  assert.ok(n > 0, 'expected rotations on the drifting track');
});
