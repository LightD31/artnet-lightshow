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
    assert.deepStrictEqual(h.fired, [{ pattern: 'chase', anchorMs: 5000 }], 'the offset brought it forward');
  } finally { h.stop(); }
});

// Deciding what a nudge does to events it steps over is the whole design of
// setSyncOffsetMs, so it is written down rather than left to whoever reads
// _reseek next. Skipping is the safe half of an asymmetry that cannot be
// avoided: a backwards nudge can never un-fire what already played, and a
// forwards one that replayed would dump a burst of energy overrides into the
// room in a single frame. A skipped pattern event costs a beat of the old look.
test('a nudge that steps over an event restores the look rather than firing a burst', () => {
  const h = harness([ev(5000, 'chase')]);
  try {
    h.seek(4900);
    h.tick();
    assert.deepStrictEqual(h.fired, [], 'not due yet');

    h.show.setSyncOffsetMs(200); // now playing from 5100, past the event
    h.tick();
    assert.deepStrictEqual(h.fired, [{ pattern: 'chase', energyOverride: null, showDynamics: null, anchorMs: 5000 }], 'stepped over, current look restored once');
  } finally { h.stop(); }
});

// The failure this guards against is loud and happens on stage: every energy
// burst between the old cursor and the new one going off in one frame.
test('nudging the offset forward does not replay the whole past', () => {
  const h = harness([ev(0, 'a'), ev(1000, 'b'), ev(2000, 'c'), ev(3000, 'd'), ev(9000, 'e')]);
  try {
    h.seek(4000);
    h.tick();
    // The cursor jumped over b/c/d, so the current look is restored once rather
    // than replaying every historical patch in one timer tick.
    assert.deepStrictEqual(h.fired, [{ pattern: 'd', energyOverride: null, showDynamics: null, anchorMs: 3000 }]);
    h.fired.length = 0;

    h.show.setSyncOffsetMs(500);
    h.tick();
    assert.deepStrictEqual(h.fired, [{ pattern: 'd', energyOverride: null, showDynamics: null, anchorMs: 3000 }], 'a nudge restores the current look without replaying the past');

    // The cursor is still in the right place: the next event still lands.
    h.fired.length = 0;
    h.seek(9000);
    h.tick();
    assert.deepStrictEqual(h.fired, [{ pattern: 'e', energyOverride: null, showDynamics: null, anchorMs: 9000 }], 'and the show carries on from there');
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
    assert.deepStrictEqual(h.fired, [{ pattern: 'd', energyOverride: null, showDynamics: null, anchorMs: 1900 }], 'current look restored, not fired in a burst');

    h.seek(3100);
    h.tick();
    assert.deepStrictEqual(h.fired, [
      { pattern: 'd', energyOverride: null, showDynamics: null, anchorMs: 1900 },
      { pattern: 'e', energyOverride: null, showDynamics: null, anchorMs: 5000 },
    ], 'the next real event still fires after restoring the skipped scene');
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

test('expressive seeks restore current targets without replaying missed bursts', () => {
  const h = harness([
    { timeMs: 0, action: 'patch', data: { pattern: 'ensemble', showDynamics: { level: .5, bass: .8 } } },
    { timeMs: 1000, action: 'energy', data: { id: 'blinder', durationMs: 350 } },
    { timeMs: 2000, action: 'patch', data: { showDynamics: { level: .2, vocal: .9 } } },
  ]);
  try {
    h.seek(4000); h.tick();
    assert.strictEqual(h.fired.length, 1);
    assert.strictEqual(h.fired[0].energyOverride, null);
    assert.deepStrictEqual(h.fired[0].showDynamics, { level: .2, bass: .8, vocal: .9 });
    h.fired.length = 0;
    h.seek(100); h.tick();
    assert.strictEqual(h.fired[0].showDynamics.level, .5);
    h.show.stop();
    assert.strictEqual(h.fired.at(-1).showDynamics, null);
  } finally { h.stop(); }
});

// ── Driven by the render loop ─────────────────────────────────────────────────
// On the server the auto show has no timer: the engine calls tick() at the top
// of every frame, so a cue fires in the very frame it falls due instead of up
// to a 20 ms poll later — and a different amount later every time.

const fs = require('node:fs');
const path = require('node:path');
const { beatPositionAt } = require('../../src/shared/beat-clock');

/** A frame-driven show over a real analysed track, at a position we control. */
function frameHarness() {
  const fired = [];
  const show = new AutoShow((patch) => fired.push(patch), [{ name: 'Blackout' }], []);
  show.useFrameClock();
  let position = 0;
  return {
    show,
    fired,
    seek(ms) { position = ms; },
    start() { show.start(() => position); },
    stop() { show.stop(); show._worker.shutdown(); },
  };
}

test('with the render loop driving it, a cue fires in the frame it falls due', () => {
  const h = frameHarness();
  try {
    h.show.timeline = [ev(1000, 'chase'), ev(60 * 60 * 1000, 'end-marker')];
    h.start();
    assert.strictEqual(h.show._loopTimer, null, 'no timer of its own');
    h.fired.length = 0;

    h.seek(999);
    h.show.tick();
    assert.deepStrictEqual(h.fired, [], 'a millisecond early');
    h.seek(1000);
    h.show.tick();
    assert.deepStrictEqual(h.fired, [{ pattern: 'chase', anchorMs: 1000 }], 'and on the frame it is due');
  } finally { h.stop(); }
});

// The anchor is what makes a scene's chase land on the same step whether the
// show played into it or was seeked into it (see server/patch.js).
test('a scene carries the time it was scheduled for, played through or seeked into', () => {
  const h = frameHarness();
  try {
    h.show.timeline = [
      { timeMs: 2000, action: 'patch', data: { pattern: 'chase', beatDivision: 2 } },
      { timeMs: 3000, action: 'patch', data: { colors: ['#ff0000'] } },
      ev(60 * 60 * 1000, 'end-marker'),
    ];
    h.start();
    h.fired.length = 0;
    h.seek(2010);
    h.show.tick();
    assert.strictEqual(h.fired.at(-1).anchorMs, 2000, 'fired 10 ms late, anchored on time');
    h.seek(3010);
    h.show.tick();
    assert.strictEqual(h.fired.at(-1).anchorMs, 3000, 'every change from the show says when it was due');

    h.fired.length = 0;
    h.seek(9000);                           // seek well past both
    h.show.tick();
    assert.strictEqual(h.fired.length, 1);
    assert.strictEqual(h.fired[0].pattern, 'chase');
    assert.strictEqual(h.fired[0].anchorMs, 2000, 'the restored chase counts from its own scene');
  } finally { h.stop(); }
});

test('while it runs, the pattern clock reads the track\'s beat grid at the show\'s position', () => {
  const h = frameHarness();
  try {
    const file = path.join(__dirname, '..', 'fixtures', 'tracks', 'orelsan-boss.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    h.show.analysis = doc.analysis || doc;
    h.show.buildTimeline();
    assert.strictEqual(h.show.beatSource(), null, 'nothing while stopped');

    h.start();
    h.show.setSyncOffsetMs(100);
    h.seek(30000);
    const source = h.show.beatSource();
    assert.ok(source && source.grid, 'the analysed grid');
    assert.strictEqual(source.positionMs, 30100, 'at the show\'s position, offset and all');
    // The fixtures keep only their downbeats: the clock spreads the beats
    // across each bar, so the tenth downbeat is beat 40 of a 4/4 track.
    const { downbeats, meter } = doc.analysis || doc;
    assert.strictEqual(meter, 4);
    const beat = beatPositionAt(source.grid, downbeats[10] * 1000);
    assert.ok(Math.abs(beat - 40) < 1e-6, `downbeat 10 is beat 40 of the clock: ${beat}`);

    h.show.stop();
    assert.strictEqual(h.show.beatSource(), null, 'and nothing once stopped');
  } finally { h.stop(); }
});

// A prefetch that finishes for the song already playing is how a manual set
// gets its patterns locked to the music without waiting for the next track.
test('every analysis written to the cache is announced', async () => {
  const saved = [];
  const cache = { has: () => false, save: async (key) => { saved.push(key); } };
  const show = new AutoShow(() => {}, [{ name: 'Blackout' }], [], cache);
  try {
    show._downloadAudio = async () => null;
    show._runAnalyzer = async () => ({ beats: [0, 0.5, 1] });
    const announced = [];
    show.onAnalysisCached = (key) => announced.push(key);
    const r = await show.prefetch('artist - song', 180, 'spotify:abc');
    assert.deepStrictEqual(r, { skipped: false });
    assert.deepStrictEqual(saved, ['spotify:abc']);
    assert.deepStrictEqual(announced, ['spotify:abc'], 'after it is saved, not before');

    show.onAnalysisCached = () => { throw new Error('listener bug'); };
    const again = await show.prefetch('artist - other', 180, 'spotify:def');
    assert.deepStrictEqual(again, { skipped: false }, 'a failing listener does not fail the analysis');
  } finally { show._worker.shutdown(); }
});
