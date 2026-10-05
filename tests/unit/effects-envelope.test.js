// tests/unit/effects-envelope.test.js
import test from 'node:test';
import assert from 'node:assert';
import { curveApply, sampleEnvelope, eventInterval, activeEvents, composeEvents, isReversed, staggerOffset, EventAdmission } from '../../src/shared/effects/envelope.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';

const hd = (over = {}) => ({ curve: 'easeInOut', attack: 0.125, hold: 0.25, release: 0.5, stagger: 0.125, direction: 'forward', order: 'position',
  probability: 1, repetitions: 1, trail: 0.5, spatial: { x: .5, y: .5, z: .5, radius: .5, angle: 0 },
  trigger: { mode: 'timeline', band: 'full', beatInterval: 1, threshold: .2, reactiveDepth: 1 }, loopLength: 4, ...over });

test('curves match Hue Dynamics, Cut included', () => {
  assert.strictEqual(curveApply(0.5, 'linear'), 0.5);
  assert.strictEqual(curveApply(0.5, 'easeIn'), 0.25);
  assert.strictEqual(curveApply(0.5, 'easeOut'), 0.75);
  assert.strictEqual(curveApply(0.25, 'easeInOut'), 4 * 0.25 ** 3);
  assert.strictEqual(curveApply(0.75, 'easeInOut'), 1 - (-2 * 0.75 + 2) ** 3 / 2);
  assert.strictEqual(curveApply(0, 'cut'), 0);
  assert.strictEqual(curveApply(0.01, 'cut'), 1);
});

test('the envelope: attack by the curve, hold at one, release by the inverse curve, zero after', () => {
  const p = hd({ curve: 'linear' });
  assert.strictEqual(sampleEnvelope(-0.01, p), 0);
  assert.ok(Math.abs(sampleEnvelope(0.0625, p) - 0.5) < 1e-12);
  assert.strictEqual(sampleEnvelope(0.2, p), 1);
  assert.ok(Math.abs(sampleEnvelope(0.375 + 0.25, p) - 0.5) < 1e-12);
  assert.strictEqual(sampleEnvelope(0.875, p), 0);
  assert.strictEqual(sampleEnvelope(0.3, hd({ curve: 'cut' })), 1);
  assert.strictEqual(sampleEnvelope(0.4, hd({ curve: 'cut' })), 0);
});

test('event interval: loop over repetitions, or the beat interval when the music is on and the trigger is a beat accent', () => {
  assert.strictEqual(eventInterval(hd({ repetitions: 2 }), 4, 'off'), 2);
  const accent = hd({ trigger: { mode: 'beatAccent', band: 'bass', beatInterval: 1, threshold: .2, reactiveDepth: 1 } });
  assert.strictEqual(eventInterval(accent, 4, 'off'), 4);
  assert.strictEqual(eventInterval(accent, 4, 'tempo'), 1);
});

test('active events: one ahead with a negative age, then every event whose envelope plus stagger span still covers the position', () => {
  // Interval 1, envelope 1.5, stagger span 0.375: at 2.6 the bound is 1.875 → events 2 (age 0.6) and 1 (age 1.6) are in, 0 (age 2.6) is out.
  const ev = activeEvents(2.6, 1, 1.5, 0.375);
  assert.deepStrictEqual(ev.map((e) => e.index), [3, 2, 1]);
  assert.ok(ev[0].age < 0, 'the lookahead');
  assert.ok(Math.abs(ev[1].age - 0.6) < 1e-12);
  assert.deepStrictEqual(activeEvents(2.6, 1, 0.875, 0.375).map((e) => e.index), [3, 2], 'a shorter envelope drops event 1');
});

test('composition: skipped events are ignored; the strongest event wins, a later one on a tie', () => {
  const events = [{ index: 4, start: 4, age: -0.2 }, { index: 3, start: 3, age: 0.1 }, { index: 2, start: 2, age: 1.1 }];
  const out = composeEvents(events, (e, age) => (age < 0 ? null : { strength: 0.5, palettePos: e.index }));
  assert.strictEqual(out.index, 3);
  assert.strictEqual(out.palettePos, 3);
});

test('direction and stagger', () => {
  const s = seedFrom('d');
  assert.strictEqual(isReversed('reverse', 0, s), true);
  assert.strictEqual(isReversed('alternate', 1, s), true);
  assert.strictEqual(isReversed('alternate', 2, s), false);
  assert.strictEqual(isReversed('alternate', -1, s), true, '|event % 2| == 1 as HD writes it');
  assert.strictEqual(staggerOffset(0.125, 2, 4, false), 0.25);
  assert.strictEqual(staggerOffset(0.125, 2, 4, true), 0.125);
});

test('event admission holds rapid flashes apart and answers the same index the same way', () => {
  const a = new EventAdmission(400);
  assert.strictEqual(a.admit(0, 0), true);
  assert.strictEqual(a.admit(1, 300), false);
  assert.strictEqual(a.admit(1, 300), false, 'asked again: the same answer');
  assert.strictEqual(a.admit(2, 401), true);
});
