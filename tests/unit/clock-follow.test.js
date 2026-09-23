import test from 'node:test';
import assert from 'node:assert';

import { createClockFollower } from '../../src/server/clock-follow.js';
import { BACKWARD_JUMP_BEATS } from '../../src/server/conductor.js';

const reading = (beatPos, extra = {}) => ({ beatPos, bpm: 120, source: 'tap', epoch: 0, ...extra });

test('nothing to say before the first reading', () => {
  assert.strictEqual(createClockFollower().at(1000), null);
});

test('a reading is carried forward at its tempo', () => {
  const follow = createClockFollower();
  follow.push(reading(10), 1000);
  assert.strictEqual(follow.at(1000).beatPos, 10);
  // 120 BPM is two beats a second.
  assert.ok(Math.abs(follow.at(1250).beatPos - 10.5) < 1e-9);
  assert.ok(Math.abs(follow.at(2000).beatPos - 12) < 1e-9);
});

test('a stopped clock is not carried forward', () => {
  const follow = createClockFollower();
  follow.push(reading(4, { moving: false }), 1000);
  assert.strictEqual(follow.at(1500).beatPos, 4);
});

test('a reading that lands a hair behind what was shown holds instead of stepping back', () => {
  const follow = createClockFollower();
  follow.push(reading(10), 1000);
  const shown = follow.at(1100).beatPos;                    // 10.2
  // The next real reading says the music was slightly behind the carry.
  follow.push(reading(10.19), 1100);
  assert.strictEqual(follow.at(1100).beatPos, shown, 'no step backwards within an epoch');
  assert.ok(follow.at(1200).beatPos > shown, 'and it moves on once the music catches up');
});

test('a real jump back, or a new epoch, is taken as it comes', () => {
  const follow = createClockFollower();
  follow.push(reading(10), 1000);
  follow.at(1000);
  follow.push(reading(10 - BACKWARD_JUMP_BEATS - 0.5), 1000);
  assert.strictEqual(follow.at(1000).beatPos, 10 - BACKWARD_JUMP_BEATS - 0.5, 'past the jump threshold');

  follow.push(reading(0.5, { epoch: 1 }), 1000);
  assert.strictEqual(follow.at(1000).beatPos, 0.5, 'a new epoch');
  assert.strictEqual(follow.at(1000).epoch, 1);
});

test('the anchor beat, tempo and source ride along', () => {
  const follow = createClockFollower();
  follow.push(reading(3, { anchorBeat: 2, source: 'auto', bpm: 128 }), 0);
  const r = follow.at(0);
  assert.deepStrictEqual(r, { beatPos: 3, bpm: 128, source: 'auto', epoch: 0, anchorBeat: 2 });
});

test('unusable readings are ignored', () => {
  const follow = createClockFollower();
  follow.push(reading(1), 0);
  follow.push({ beatPos: NaN, bpm: 120 }, 10);
  follow.push(reading(9), NaN);
  assert.strictEqual(follow.at(0).beatPos, 1);
});
