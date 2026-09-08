'use strict';

// The sync offset shifts the whole generated show against the music, to cover
// the latency between the audio a room hears and the light that answers it.
// Two things have to hold for it to be usable live: the shift has to actually
// reach the playback cursor, and moving it must not replay the past — a nudge
// forward that re-fired every event since the start of the track would empty a
// song's worth of strobe bursts into the room at once.

const test = require('node:test');
const assert = require('node:assert');

const AutoShow = require('../../src/auto-show');
const { SYNC_OFFSET_LIMIT_MS } = require('../../src/server/presets');

const ev = (timeMs, id) => ({ timeMs, action: 'patch', data: { pattern: id } });

/**
 * An AutoShow with a hand-written timeline and a position we control, so the
 * offset can be tested without audio, a Python analyzer or a clock.
 */
function harness(timeline = []) {
  const fired = [];
  const show = new AutoShow((patch) => fired.push(patch), [{ name: 'Blackout' }], []);
  let position = 0;
  // start() refuses an empty timeline, so park a marker far past anything a
  // test seeks to. Tests that only care about the position use this alone.
  show.timeline = [...timeline, ev(60 * 60 * 1000, 'end-marker')];
  show.start(() => position);
  // Drive ticks by hand: start()'s 20 ms interval would otherwise fire events
  // between assertions and make the order of what played non-deterministic.
  clearInterval(show._loopTimer);
  show._loopTimer = null;
  fired.length = 0; // start() ticks once at 0; that is not what is under test
  return {
    show,
    fired,
    seek(ms) { position = ms; },
    tick() { show._tick(); },
    stop() {
      show.stop();
      // The constructor prewarms the Python analyzer so the first real analyze
      // does not pay its cold start. Nothing here analyses anything, but that
      // child process would hold the event loop open and hang the run.
      show._worker.shutdown();
    },
  };
}

test('the offset moves the position the show is played from', () => {
  const h = harness([]);
  try {
    h.seek(10000);
    assert.strictEqual(h.show.getPositionMs(), 10000, 'no offset, no shift');

    h.show.setSyncOffsetMs(250);
    assert.strictEqual(h.show.getPositionMs(), 10250, 'positive runs the show ahead');

    h.show.setSyncOffsetMs(-250);
    assert.strictEqual(h.show.getPositionMs(), 9750, 'negative holds it back');
  } finally { h.stop(); }
});

test('a positive offset fires an event before the track reaches it', () => {
  const h = harness([ev(5000, 'chase')]);
  try {
    h.show.setSyncOffsetMs(200);

    h.seek(4700);
    h.tick();
    assert.deepStrictEqual(h.fired, [], 'still 100 ms out even with the offset');

    // At 4900 the show is playing from 5100, so the 5 s event is due — a tenth
    // of a second before the track itself gets there.
    h.seek(4900);
    h.tick();
    assert.deepStrictEqual(h.fired, [{ pattern: 'chase' }], 'the offset brought it forward');
  } finally { h.stop(); }
});

// Deciding what a nudge does to events it steps over is the whole design of
// setSyncOffsetMs, so it is written down rather than left to whoever reads
// _reseek next. Skipping is the safe half of an asymmetry that cannot be
// avoided: a backwards nudge can never un-fire what already played, and a
// forwards one that replayed would dump a burst of energy overrides into the
// room in a single frame. A skipped pattern event costs a beat of the old look.
test('a nudge that steps over an event skips it rather than firing a burst', () => {
  const h = harness([ev(5000, 'chase')]);
  try {
    h.seek(4900);
    h.tick();
    assert.deepStrictEqual(h.fired, [], 'not due yet');

    h.show.setSyncOffsetMs(200); // now playing from 5100, past the event
    h.tick();
    assert.deepStrictEqual(h.fired, [], 'stepped over, not replayed');
  } finally { h.stop(); }
});

// The failure this guards against is loud and happens on stage: every energy
// burst between the old cursor and the new one going off in one frame.
test('nudging the offset forward does not replay the whole past', () => {
  const h = harness([ev(0, 'a'), ev(1000, 'b'), ev(2000, 'c'), ev(3000, 'd'), ev(9000, 'e')]);
  try {
    h.seek(4000);
    h.tick();
    // a fired on start()'s tick at position 0 and was cleared; b, c and d here.
    assert.strictEqual(h.fired.length, 3, 'everything up to 4 s has played');
    h.fired.length = 0;

    h.show.setSyncOffsetMs(500);
    h.tick();
    assert.deepStrictEqual(h.fired, [], 'a nudge must not re-fire what already played');

    // The cursor is still in the right place: the next event still lands.
    h.seek(8600);
    h.tick();
    assert.deepStrictEqual(h.fired, [{ pattern: 'e' }], 'and the show carries on from there');
  } finally { h.stop(); }
});

test('a large jump forward parks the cursor instead of emptying the timeline', () => {
  const h = harness([ev(0, 'a'), ev(1000, 'b'), ev(1500, 'c'), ev(1900, 'd'), ev(5000, 'e')]);
  try {
    h.seek(0);
    h.tick();
    h.fired.length = 0;

    // Two seconds ahead in one move: b, c and d are all now in the past.
    h.show.setSyncOffsetMs(SYNC_OFFSET_LIMIT_MS);
    h.tick();
    assert.deepStrictEqual(h.fired, [], 'skipped, not fired in a burst');

    h.seek(3100);
    h.tick();
    assert.deepStrictEqual(h.fired, [{ pattern: 'e' }], 'the next real event still fires');
  } finally { h.stop(); }
});

test('the offset is clamped to the range the settings store accepts', () => {
  const h = harness([]);
  try {
    h.show.setSyncOffsetMs(999999);
    assert.strictEqual(h.show.syncOffsetMs, SYNC_OFFSET_LIMIT_MS);

    h.show.setSyncOffsetMs(-999999);
    assert.strictEqual(h.show.syncOffsetMs, -SYNC_OFFSET_LIMIT_MS);

    // Junk from a REST caller must not turn the position into NaN, which would
    // compare false against every event time and silently stop the show.
    h.show.setSyncOffsetMs('not a number');
    assert.strictEqual(h.show.syncOffsetMs, -SYNC_OFFSET_LIMIT_MS, 'left alone');
    h.seek(1000);
    assert.ok(Number.isFinite(h.show.getPositionMs()));
  } finally { h.stop(); }
});

test('the offset reaches clients alongside the rest of the auto-show state', () => {
  const h = harness([]);
  try {
    h.show.setSyncOffsetMs(120);
    assert.strictEqual(h.show.getClientState().syncOffsetMs, 120);
  } finally { h.stop(); }
});
