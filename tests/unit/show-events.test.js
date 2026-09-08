'use strict';

// The boundary between the analyser and the show engine. Two things have to
// hold: the stream the analyser produced survives normalisation intact, and a
// cached document from before the event layer existed still produces a usable
// stream — a schema change should cost the cache its nuance, not its contents.

const test = require('node:test');
const assert = require('node:assert');

const { EVENT, deriveEvents, normalise, byType, inSpan, nearAny } =
  require('../../src/show/musical-events');

/** A pre-2.0 analysis document: no `events` array anywhere. */
function legacy(over = {}) {
  return {
    duration: 30,
    bpm: 120,
    meter: 4,
    beats: Array.from({ length: 60 }, (_, i) => i * 0.5),
    beatStrengths: Array.from({ length: 60 }, (_, i) => (i % 4 === 0 ? 0.9 : 0.4)),
    downbeats: Array.from({ length: 15 }, (_, i) => i * 2),
    downbeatConfidence: 0.8,
    segments: [
      { start: 0, end: 12, level: 'low', energy: 0.2, brightness: 0.3, bass: 0.2, label: 'A' },
      { start: 12, end: 30, level: 'high', energy: 0.9, brightness: 0.7, bass: 0.8, label: 'B' },
    ],
    drops: [{ t: 12, confidence: 0.9, breakdownScore: 0.7, sustainScore: 0.8 }],
    buildups: [{ start: 8, end: 12 }],
    kickOnsets: [1, 2, 3],
    ...over,
  };
}

test('an analyser-supplied stream is passed through, not regenerated', () => {
  const events = deriveEvents({
    events: [
      { t: 5, type: 'DROP', confidence: 0.9, intensity: 0.8, effect: 'blinder' },
      { t: 1, type: 'BEAT', confidence: 0.5, intensity: 0.5, effect: 'accent' },
    ],
    beats: [0, 1, 2, 3],   // would produce a completely different stream
  });
  assert.deepStrictEqual(events.map((e) => e.type), ['BEAT', 'DROP']);
});

test('a document from before the event layer still produces a full stream', () => {
  const types = new Set(deriveEvents(legacy()).map((e) => e.type));
  for (const required of [EVENT.BEAT, EVENT.BAR, EVENT.SECTION, EVENT.TRANSITION,
    EVENT.DROP, EVENT.BUILDUP, EVENT.BASS_HIT]) {
    assert.ok(types.has(required), `missing ${required}`);
  }
});

test('nothing is invented that the old document could not support', () => {
  // Vocal spans and melodic movement were never in a 1.x document. Guessing at
  // them would be a show confidently lighting the wrong moments.
  const types = new Set(deriveEvents(legacy()).map((e) => e.type));
  assert.ok(!types.has(EVENT.VOCAL_SECTION));
  assert.ok(!types.has(EVENT.MELODY_CHANGE));
});

test('a legacy section with no role is marked unknown rather than guessed at', () => {
  const sections = deriveEvents(legacy()).filter((e) => e.type === EVENT.SECTION);
  assert.deepStrictEqual(sections.map((e) => e.data.role), ['unknown', 'unknown']);
});

test('downbeats become bar events and beats know where they sit in the bar', () => {
  const events = deriveEvents(legacy());
  const bars = events.filter((e) => e.type === EVENT.BAR);
  assert.strictEqual(bars.length, 15);
  assert.deepStrictEqual(bars.slice(0, 5).map((e) => e.data.phraseStart),
    [true, false, false, false, true]);

  const beats = events.filter((e) => e.type === EVENT.BEAT);
  assert.deepStrictEqual(beats.slice(0, 5).map((e) => e.data.inBar), [0, 1, 2, 3, 0]);
});

test('a drop is classified from its breakdown and sustain scores', () => {
  const proper = deriveEvents(legacy()).find((e) => e.type === EVENT.DROP);
  assert.strictEqual(proper.data.kind, 'proper');

  const hype = deriveEvents(legacy({
    drops: [{ t: 12, confidence: 0.5, breakdownScore: 0.1, sustainScore: 0.2 }],
  })).find((e) => e.type === EVENT.DROP);
  assert.strictEqual(hype.data.kind, 'hype');
});

test('a drop written with `time` instead of `t` is still found', () => {
  // Both spellings exist in cached documents in the wild.
  const drop = deriveEvents(legacy({ drops: [{ time: 12, confidence: 0.9 }] }))
    .find((e) => e.type === EVENT.DROP);
  assert.strictEqual(drop.t, 12);
});

test('events sort by time, and a drop wins the instant it shares', () => {
  const events = deriveEvents(legacy());
  const times = events.map((e) => e.t);
  assert.deepStrictEqual(times, [...times].sort((a, b) => a - b));

  const atTwelve = events.filter((e) => e.t === 12).map((e) => e.type);
  assert.strictEqual(atTwelve[atTwelve.length - 1], EVENT.DROP,
    'the show engine takes the last event at an instant as the winner');
});

test('a malformed event is dropped rather than poisoning the stream', () => {
  assert.strictEqual(normalise(null), null);
  assert.strictEqual(normalise({ t: NaN, type: 'BEAT' }), null);
  assert.strictEqual(normalise({ t: -1, type: 'BEAT' }), null);
  const events = deriveEvents({ events: [{ t: 'oops', type: 'DROP' }, { t: 1, type: 'BEAT' }] });
  assert.deepStrictEqual(events.map((e) => e.type), ['BEAT']);
});

test('missing fields are filled in so the director never sees an undefined', () => {
  const event = normalise({ t: 3, type: 'drop' });
  assert.strictEqual(event.type, 'DROP');
  assert.strictEqual(event.confidence, 1);
  assert.strictEqual(event.intensity, 0.5);
  assert.strictEqual(event.duration, 0);
  assert.deepStrictEqual(event.data, {});
});

test('an empty or nonsense analysis produces an empty stream, not a throw', () => {
  assert.deepStrictEqual(deriveEvents(null), []);
  assert.deepStrictEqual(deriveEvents({}), []);
  assert.deepStrictEqual(deriveEvents({ beats: 'nope', segments: 7 }), []);
});

test('the lookup helpers answer the questions the director asks', () => {
  const events = deriveEvents(legacy());
  const grouped = byType(events);
  assert.ok(grouped.get(EVENT.BEAT).length > 0);

  const buildups = grouped.get(EVENT.BUILDUP);
  assert.ok(inSpan(buildups, 10), 'inside the build-up');
  assert.ok(!inSpan(buildups, 5), 'before it');
  assert.ok(inSpan(buildups, 7.9, 0.2), 'inside the margin');

  assert.ok(nearAny(grouped.get(EVENT.DROP), 12.4, 0.5));
  assert.ok(!nearAny(grouped.get(EVENT.DROP), 15, 0.5));
});
