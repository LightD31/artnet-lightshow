'use strict';

// The one clock every pattern keeps time by: which source it follows, how it
// hands over between them, and what the operator's tap and tempo do to it.

const test = require('node:test');
const assert = require('node:assert');
const { Conductor } = require('../../src/server/conductor');
const { makeGrid } = require('../../src/shared/beat-clock');

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** A conductor on a clock the test moves by hand. */
function rig({ bpm = 120 } = {}) {
  let t = 1000;
  const c = new Conductor({ now: () => t, bpm });
  return { c, advance: (ms) => { t += ms; }, get t() { return t; } };
}

const grid128 = () => makeGrid(Array.from({ length: 512 }, (_, i) => i * (60 / 128)));

test('with nothing else playing it free-runs at the operator\'s tempo', () => {
  const r = rig({ bpm: 120 });
  r.c.now();
  r.advance(1500);
  const reading = r.c.now();
  assert.strictEqual(reading.source, 'tap');
  assert.ok(close(reading.beatPos, 3), `three beats in 1.5 s at 120: ${reading.beatPos}`);
});

test('a tempo change keeps the phase: it speeds up from here, not from zero', () => {
  const r = rig({ bpm: 120 });
  r.c.now();
  r.advance(1000);                         // 2 beats in
  r.c.setBpm(60);
  r.advance(1000);                         // plus 1 beat at 60
  assert.ok(close(r.c.now().beatPos, 3));
});

test('a tap lands a beat on the tap', () => {
  const r = rig({ bpm: 120 });
  r.c.now();
  r.advance(1300);                         // 2.6 beats in
  r.c.tap();
  assert.strictEqual(r.c.now().beatPos, 3, 'jumps to the next whole beat');
  r.advance(500);
  assert.ok(close(r.c.now().beatPos, 4));
});

test('stopping the patterns freezes the free clock', () => {
  const r = rig({ bpm: 120 });
  r.c.now();
  r.advance(1000);
  r.c.setRunning(false);
  r.advance(5000);
  assert.ok(close(r.c.now().beatPos, 2));
  r.c.setRunning(true);
  r.advance(500);
  assert.ok(close(r.c.now().beatPos, 3));
});

test('the auto show\'s grid wins over everything, and a track over the free clock', () => {
  const r = rig();
  const grid = grid128();
  let autoPos = null;
  r.c.setAutoSource(() => (autoPos == null ? null : { grid, positionMs: autoPos }));
  r.c.setTrack({ key: 't', grid, positionMs: () => 60000 * 4 / 128 });   // beat 4
  assert.strictEqual(r.c.now().source, 'track');
  assert.ok(close(r.c.now().beatPos, 4));

  autoPos = 60000 * 10 / 128;                                              // beat 10
  const reading = r.c.now();
  assert.strictEqual(reading.source, 'auto');
  assert.ok(close(reading.beatPos, 10));
  assert.ok(close(reading.bpm, 128, 1e-6), 'tempo read off the grid');
});

test('a playing CDJ beats a cached track when the auto show is off', () => {
  const r = rig();
  r.c.setTrack({ key: 't', grid: grid128(), positionMs: () => 0 });
  r.c.setProlinkSource(() => ({ beatPos: 42.5, bpm: 126 }));
  const reading = r.c.now();
  assert.deepStrictEqual([reading.source, reading.beatPos, reading.bpm], ['cdj', 42.5, 126]);
});

// Stopping the auto show mid-song must not make the rig lurch: the free clock
// picks up the beat and the tempo it had reached.
test('when a source stops, the free clock carries on from where it was', () => {
  const r = rig({ bpm: 90 });
  const grid = grid128();
  let running = true;
  let pos = 0;
  r.c.setAutoSource(() => (running ? { grid, positionMs: pos } : null));
  let adopted = null;
  r.c.onAdoptBpm((bpm) => { adopted = bpm; });

  pos = 60000 * 16 / 128;
  const before = r.c.now();
  running = false;
  r.advance(60000 / 128);                   // one more beat of time
  const after = r.c.now();
  assert.strictEqual(after.source, 'tap');
  assert.ok(close(after.beatPos, before.beatPos + 1, 1e-6), `${before.beatPos} → ${after.beatPos}`);
  assert.strictEqual(after.epoch, before.epoch, 'a continuation, not a jump');
  assert.ok(close(adopted, 128, 1e-6), 'and at the tempo the music had');
});

test('a seek or a jump starts a new epoch; steady playback does not', () => {
  const r = rig();
  const grid = grid128();
  let pos = 0;
  r.c.setAutoSource(() => ({ grid, positionMs: pos }));
  const first = r.c.now().epoch;
  for (let i = 0; i < 100; i++) { r.advance(25); pos += 25; }
  assert.strictEqual(r.c.now().epoch, first, 'playing through');
  pos -= 10000;                             // seek back ten seconds
  assert.strictEqual(r.c.now().epoch, first + 1, 'a seek');
  r.advance(25); pos += 25;
  pos += 60000;                             // jump a minute ahead
  assert.strictEqual(r.c.now().epoch, first + 2, 'a jump forward');
});

// The operator can always take the tempo back by hand — until the music moves
// on to the next track, which locks again.
test('a tap takes over from a locked track until the next track', () => {
  const r = rig();
  const grid = grid128();
  r.c.setTrack({ key: 'song-1', grid, positionMs: () => 5000 });
  assert.strictEqual(r.c.now().source, 'track');
  r.c.tap();
  assert.strictEqual(r.c.now().source, 'tap', 'the tap wins');
  r.c.setTrack({ key: 'song-1', grid, positionMs: () => 6000 });
  assert.strictEqual(r.c.now().source, 'tap', 'the same track stays overridden');
  r.c.setTrack({ key: 'song-2', grid, positionMs: () => 0 });
  assert.strictEqual(r.c.now().source, 'track', 'a new track locks again');

  r.c.setBpm(100);
  assert.strictEqual(r.c.now().source, 'tap', 'a typed tempo is an override too');
  r.c.clearTrack({ key: 'song-3' });
  r.c.setBpm(101, { manual: false });
  r.c.setTrack({ key: 'song-4', grid, positionMs: () => 0 });
  assert.strictEqual(r.c.now().source, 'track', 'a CDJ-reported tempo is not an override');
});

test('a scene can be anchored at the moment it was scheduled', () => {
  const r = rig();
  const grid = grid128();
  r.c.setAutoSource(() => ({ grid, positionMs: 30000 }));
  assert.ok(close(r.c.beatAtTrackMs(60000 * 8 / 128), 8));
  r.c.setAutoSource(() => null);
  assert.strictEqual(r.c.beatAtTrackMs(1000), null, 'no grid, no anchor time');
});

// A paused track's position stands still. Locking to it would freeze the rig on
// one step for the length of the pause, which looks like a crash; the chase
// carries on at the song's tempo instead, and locks again when it resumes.
test('a paused track hands over to the free clock, and locks again on resume', () => {
  const r = rig({ bpm: 90 });
  const grid = grid128();
  let pos = 60000 * 8 / 128;
  r.c.setAutoSource(() => ({ grid, positionMs: pos }));
  for (let i = 0; i < 10; i++) { r.advance(25); pos += 25; r.c.now(); }
  assert.strictEqual(r.c.now().source, 'auto');

  const pausedAt = r.c.now().beatPos;
  for (let i = 0; i < 4; i++) { r.advance(25); r.c.now(); }
  assert.strictEqual(r.c.now().source, 'auto', 'a frame or two without movement is not a pause');
  for (let i = 0; i < 8; i++) { r.advance(25); r.c.now(); }
  const paused = r.c.now();
  assert.strictEqual(paused.source, 'tap', 'the pause is noticed');
  r.advance(500);
  assert.ok(r.c.now().beatPos > pausedAt + 1, 'and the chase keeps moving');
  assert.ok(close(r.c.now().bpm, 128, 1e-6), 'at the song\'s tempo');
  assert.strictEqual(r.c.beatAtTrackMs(pos), null, 'no grid to anchor to while paused');

  r.advance(25); pos += 25;
  assert.strictEqual(r.c.now().source, 'auto', 'playing again, locked again');
});

// Stopping the auto show on a song the clock then follows by itself is the
// same beats read off the same grid: the chase must not restart for it. A
// source that counts from somewhere else entirely is a new start.
test('a hand-over between sources that agree keeps the count going', () => {
  const r = rig({ bpm: 90 });
  const grid = grid128();
  let pos = 60000 * 20 / 128;
  let showRunning = true;
  r.c.setAutoSource(() => (showRunning ? { grid, positionMs: pos } : null));
  r.c.setTrack({ key: 'song', grid, positionMs: () => pos });
  const first = r.c.now();
  assert.strictEqual(first.source, 'auto');

  showRunning = false;
  r.advance(25); pos += 25;
  const after = r.c.now();
  assert.strictEqual(after.source, 'track');
  assert.strictEqual(after.epoch, first.epoch, 'the same beats, no restart');

  // Free-running far from the song's count, then locking to it: a new start.
  r.c.clearTrack({ key: 'other' });
  for (let i = 0; i < 400; i++) { r.advance(25); r.c.now(); }
  const free = r.c.now();
  r.c.setTrack({ key: 'song-2', grid, positionMs: () => 1000 });
  assert.strictEqual(r.c.now().epoch, free.epoch + 1);
});

// A typed tempo or a tap takes the clock back from a locked track in time with
// it: from the beat the music is on, at the tempo the operator asked for.
test('taking the tempo back from a locked track keeps the beat', () => {
  const r = rig({ bpm: 90 });
  const grid = grid128();
  let pos = 60000 * 16.5 / 128;
  r.c.setTrack({ key: 'song', grid, positionMs: () => pos });
  const locked = r.c.now();
  assert.strictEqual(locked.source, 'track');

  r.c.setBpm(100);
  const typed = r.c.now();
  assert.deepStrictEqual([typed.source, typed.bpm], ['tap', 100], 'the typed tempo, not the song\'s');
  assert.ok(close(typed.beatPos, 16.5), `from the beat the song was on: ${typed.beatPos}`);
  assert.strictEqual(typed.epoch, locked.epoch, 'no restart');

  // A single tap on a fresh song: the beat snaps to the tap, the song's tempo
  // carries on until a second tap measures a new one.
  let adopted = null;
  r.c.onAdoptBpm((bpm) => { adopted = bpm; });
  r.c.setTrack({ key: 'song-2', grid, positionMs: () => pos });
  r.advance(25); pos += 25;
  assert.strictEqual(r.c.now().source, 'track');
  r.c.tap();
  const tapped = r.c.now();
  assert.strictEqual(tapped.source, 'tap');
  assert.strictEqual(tapped.beatPos, 17, 'the next whole beat');
  assert.ok(close(tapped.bpm, 128, 1e-6) && close(adopted, 128, 1e-6), 'at the song\'s tempo');
});
