// How the lights follow a DJ into the next track (src/show/transition.ts):
// a cut after a cut, else a blend timed to the incoming track — onto its
// drop, or its next phrase.

import test from 'node:test';
import assert from 'node:assert';

import { transitionFor, MAX_FADE_MS } from '../../src/show/transition.ts';

const BPM = 128;
const BEAT = 60 / BPM;
const BAR = 4 * BEAT;
const at = (bar) => bar * BAR;

function track({ drops = [] } = {}) {
  const downbeats = Array.from({ length: 96 }, (_, i) => at(i));
  return {
    bpm: BPM, downbeats, drops: drops.map((bar) => ({ t: at(bar), confidence: 0.9 })),
    segments: [
      { start: at(0), end: at(16), role: 'intro' },
      { start: at(16), end: at(32), role: 'verse' },
      { start: at(32), end: at(48), role: 'chorus' },
      { start: at(48), end: at(96), role: 'verse' },
    ],
  };
}
const blend = { handoff: true, overlapMs: 16 * BEAT * 1000 };

test('a DJ who cuts gets a cut', () => {
  assert.deepStrictEqual(transitionFor({ analysis: track(), positionMs: 0, bpm: BPM, change: { handoff: true, overlapMs: 2 * BEAT * 1000 } }), { fadeMs: 0, reason: 'cut' });
  assert.deepStrictEqual(transitionFor({ analysis: track(), positionMs: 0, bpm: BPM, change: { handoff: false, overlapMs: 0 } }), { fadeMs: 0, reason: 'cut' });
});

test('a blend ends on the incoming track\'s next phrase', () => {
  // Four bars into the intro: the next eight-bar phrase is bar 8, 7.5 s on.
  const t = transitionFor({ analysis: track(), positionMs: at(4) * 1000, bpm: BPM, change: blend });
  assert.strictEqual(t.reason, 'phrase');
  assert.strictEqual(t.fadeMs, Math.round((at(8) - at(4)) * 1000));
  // Six bars from it is past the longest a look can fade: the plain blend.
  assert.strictEqual(transitionFor({ analysis: track(), positionMs: at(2) * 1000, bpm: BPM, change: blend }).reason, 'blend');
});

test('a phrase too close to blend into gives way to the one after', () => {
  // Seven bars in: bar 8 is a bar away, too soon; the verse at bar 16 is 17 s off, too far.
  const t = transitionFor({ analysis: track(), positionMs: at(7) * 1000, bpm: BPM, change: blend });
  assert.strictEqual(t.reason, 'blend', 'nothing within reach: the two-bar blend');
  assert.ok(t.fadeMs <= MAX_FADE_MS);
});

test('a drop within reach is what the blend runs to', () => {
  const t = transitionFor({ analysis: track({ drops: [16] }), positionMs: at(12) * 1000, bpm: BPM, change: blend });
  assert.deepStrictEqual(t, { fadeMs: Math.round((at(16) - at(12)) * 1000), reason: 'drop' });
});

test('the deck\'s tempo stretches the track\'s time', () => {
  // Played 5 % fast, the drop four bars away arrives 5 % sooner.
  const t = transitionFor({ analysis: track({ drops: [16] }), positionMs: at(12) * 1000, bpm: BPM * 1.05, change: blend });
  assert.strictEqual(t.fadeMs, Math.round(((at(16) - at(12)) * 1000) / 1.05));
});

test('brought in hot, a bar\'s blend and no more', () => {
  const t = transitionFor({ analysis: track(), positionMs: at(36) * 1000, bpm: BPM, change: blend });
  assert.deepStrictEqual(t, { fadeMs: Math.round(4 * BEAT * 1000), reason: 'hot' });
});

test('with no analysis yet, the two-bar blend it always was', () => {
  assert.deepStrictEqual(transitionFor({ analysis: null, positionMs: 0, bpm: BPM, change: blend }),
    { fadeMs: Math.round(8 * BEAT * 1000), reason: 'blend' });
});
