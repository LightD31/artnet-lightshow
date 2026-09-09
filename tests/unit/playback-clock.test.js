'use strict';

// The clock exists because every position source reports in coarse, jittery
// samples and the obvious interpolation re-anchors on each one. These tests are
// mostly about the two properties that follow from that: the position must
// never jump, and it must never run backwards — a reversing cursor re-crosses
// timeline events it has already fired.

const test = require('node:test');
const assert = require('node:assert');

const PlaybackClock = require('../../src/playback-clock');

test('the first observation is taken as ground truth', () => {
  const clock = new PlaybackClock();
  assert.strictEqual(clock.hasFix, false);
  assert.strictEqual(clock.observe(30000, { isPlaying: true, at: 1000 }), 'snap');
  assert.strictEqual(clock.positionMs(1000), 30000);
  assert.strictEqual(clock.hasFix, true);
});

test('with no observations at all it reports zero rather than NaN', () => {
  const clock = new PlaybackClock();
  assert.strictEqual(clock.positionMs(5000), 0);
});

test('between observations it advances at real time', () => {
  const clock = new PlaybackClock();
  clock.observe(0, { isPlaying: true, at: 0 });
  assert.strictEqual(clock.positionMs(500), 500);
  assert.strictEqual(clock.positionMs(2000), 2000);
});

test('a small error is absorbed by changing speed, not by jumping', () => {
  const clock = new PlaybackClock();
  clock.observe(0, { isPlaying: true, at: 0 });

  const before = clock.positionMs(1000);
  clock.observe(1200, { isPlaying: true, at: 1000 });   // 200 ms ahead of us
  const after = clock.positionMs(1000);

  assert.strictEqual(after, before, 'the correction must not move the position');
  assert.ok(clock.rate > 1, 'it goes into the rate instead');
  assert.ok(clock.positionMs(2000) > 2000, 'and catches up over the next second');
});

test('a large error snaps, because there is no absorbing a seek', () => {
  const clock = new PlaybackClock();
  clock.observe(0, { isPlaying: true, at: 0 });
  assert.strictEqual(clock.observe(90000, { isPlaying: true, at: 1000 }), 'snap');
  assert.strictEqual(clock.positionMs(1000), 90000);
  assert.strictEqual(clock.rate, 1, 'and starts again at real time');
  assert.strictEqual(clock.snaps, 1);
});

test('the rate is capped, so a correction can never run the show away', () => {
  const clock = new PlaybackClock({ maxSlew: 0.05, snapThresholdMs: 100000 });
  clock.observe(0, { isPlaying: true, at: 0 });
  clock.observe(50000, { isPlaying: true, at: 1000 });   // absurd, but under the snap
  assert.ok(clock.rate <= 1.05 + 1e-9, `rate ran to ${clock.rate}`);
});

test('the position never runs backwards under jitter', () => {
  // The property that matters most: a reversing cursor re-fires events.
  const clock = new PlaybackClock();
  let random = 12345;
  const jitter = () => {
    random = (random * 1103515245 + 12345) & 0x7fffffff;
    return (random / 0x7fffffff - 0.5) * 700;   // ±350 ms, Spotify-like
  };

  clock.observe(0, { isPlaying: true, at: 0 });
  let previous = 0;
  for (let t = 50; t <= 120000; t += 50) {
    if (t % 1000 === 0) clock.observe(t + jitter(), { isPlaying: true, at: t });
    const position = clock.positionMs(t);
    assert.ok(position >= previous,
      `went backwards at ${t}ms: ${previous} → ${position}`);
    previous = position;
  }
});

test('it tracks the truth more closely than plain interpolation does', () => {
  // Not a micro-benchmark for its own sake: this ratio is the whole reason the
  // class exists, and a change that quietly loses it would otherwise look fine.
  const clock = new PlaybackClock();
  let random = 999;
  const jitter = () => {
    random = (random * 1103515245 + 12345) & 0x7fffffff;
    return (random / 0x7fffffff - 0.5) * 700;
  };

  let naiveBase = 0;
  let naiveAt = 0;
  clock.observe(0, { isPlaying: true, at: 0 });

  let clockError = 0;
  let naiveError = 0;
  let samples = 0;
  for (let t = 50; t <= 120000; t += 50) {
    if (t % 1000 === 0) {
      const reported = t + jitter();
      clock.observe(reported, { isPlaying: true, at: t });
      naiveBase = reported;
      naiveAt = t;
    }
    clockError += Math.abs(clock.positionMs(t) - t);
    naiveError += Math.abs(naiveBase + (t - naiveAt) - t);
    samples++;
  }
  const clockMean = clockError / samples;
  const naiveMean = naiveError / samples;
  assert.ok(clockMean < naiveMean * 0.6,
    `clock ${clockMean.toFixed(0)}ms vs naive ${naiveMean.toFixed(0)}ms`);
});

test('pausing freezes the position and resuming snaps to where it resumed', () => {
  const clock = new PlaybackClock();
  clock.observe(10000, { isPlaying: true, at: 0 });
  clock.observe(11000, { isPlaying: false, at: 1000 });
  assert.strictEqual(clock.positionMs(1000), 11000);
  assert.strictEqual(clock.positionMs(9000), 11000, 'paused time does not advance');

  clock.observe(11000, { isPlaying: true, at: 9000 });
  assert.strictEqual(clock.positionMs(10000), 12000);
});

test('a paused source that reports a new position is believed immediately', () => {
  // Scrubbing while paused: there is nothing to absorb gradually, because the
  // position is not supposed to be moving in the first place.
  const clock = new PlaybackClock();
  clock.observe(10000, { isPlaying: false, at: 0 });
  assert.strictEqual(clock.observe(60000, { isPlaying: false, at: 500 }), 'hold');
  assert.strictEqual(clock.positionMs(500), 60000);
});

test('pause() without a position freezes where the clock had got to', () => {
  const clock = new PlaybackClock();
  clock.observe(0, { isPlaying: true, at: 0 });
  clock.pause(4000);
  assert.strictEqual(clock.positionMs(4000), 4000);
  assert.strictEqual(clock.positionMs(20000), 4000);
});

test('a correction expires when the source goes quiet', () => {
  // Otherwise a source that stops reporting leaves the clock running fast
  // indefinitely on the strength of its last sample.
  const clock = new PlaybackClock({ staleMs: 5000 });
  clock.observe(0, { isPlaying: true, at: 0 });
  clock.observe(1300, { isPlaying: true, at: 1000 });   // 300 ms ahead of us
  assert.ok(clock.rate > 1);

  // Real time again past the cutoff, and continuous across it.
  const atCutoff = clock.positionMs(6000);
  assert.strictEqual(clock.positionMs(7000) - atCutoff, 1000);
  assert.strictEqual(clock.positionMs(6001) - atCutoff, 1);
});

test('reset forgets everything', () => {
  const clock = new PlaybackClock();
  clock.observe(45000, { isPlaying: true, at: 0 });
  clock.reset();
  assert.strictEqual(clock.hasFix, false);
  assert.strictEqual(clock.positionMs(1000), 0);
});

test('the status snapshot reports what the clock is doing', () => {
  const clock = new PlaybackClock();
  clock.observe(0, { isPlaying: true, at: 0 });
  clock.observe(1200, { isPlaying: true, at: 1000 });   // 200 ms ahead of us
  const status = clock.getStatus();
  assert.strictEqual(status.hasFix, true);
  assert.strictEqual(status.isPlaying, true);
  assert.strictEqual(status.driftMs, 200);
  assert.ok(status.rate > 1);
  assert.strictEqual(status.snaps, 0);
});

test('a negative or nonsense observation is clamped rather than trusted', () => {
  const clock = new PlaybackClock();
  clock.observe(-500, { isPlaying: true, at: 0 });
  assert.strictEqual(clock.positionMs(0), 0);
  clock.observe(NaN, { isPlaying: true, at: 1000 });
  assert.ok(Number.isFinite(clock.positionMs(1000)));
});
