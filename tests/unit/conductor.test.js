// The one clock every pattern keeps time by: which source it follows, how it
// hands over between them, and what the operator's tap and tempo do to it.

import test from 'node:test';
import assert from 'node:assert';
import { Conductor } from '../../src/server/conductor.ts';
import { makeGrid } from '../../src/shared/beat-clock.ts';

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
  r.c.onTempo((bpm) => { adopted = bpm; });

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
  r.c.onTempo((bpm) => { adopted = bpm; });
  r.c.setTrack({ key: 'song-2', grid, positionMs: () => pos });
  r.advance(25); pos += 25;
  assert.strictEqual(r.c.now().source, 'track');
  r.c.tap();
  const tapped = r.c.now();
  assert.strictEqual(tapped.source, 'tap');
  assert.strictEqual(tapped.beatPos, 17, 'the next whole beat');
  assert.ok(close(tapped.bpm, 128, 1e-6) && close(adopted, 128, 1e-6), 'at the song\'s tempo');
});

// The BPM read-out, and the ±1 nudges that start from it, follow the tempo the
// rig is running at — not a number left over from before the song.
test('the tempo is reported when it moves, not on every frame', () => {
  const r = rig({ bpm: 120 });
  const reported = [];
  r.c.onTempo((bpm) => reported.push(bpm));
  r.c.now();
  r.c.now();
  assert.deepStrictEqual(reported, [120], 'once, not per frame');

  let pos = 5000;
  r.c.setTrack({ key: 'song', grid: makeGrid(Array.from({ length: 256 }, (_, i) => i * (60 / 123.7))), positionMs: () => pos });
  for (let i = 0; i < 40; i++) { r.advance(25); pos += 25; r.c.now(); }
  assert.deepStrictEqual(reported, [120, 123.7], 'the song\'s tempo, to a hundredth');

  r.c.setBpm(123.72);
  r.c.now();
  assert.deepStrictEqual(reported, [120, 123.7], 'a change under a twentieth of a BPM is not news');
  r.c.setBpm(125);
  r.c.now();
  assert.deepStrictEqual(reported, [120, 123.7, 125]);
});

test('the auto show\'s reading says which beat its scene was scheduled on', () => {
  const r = rig();
  const grid = grid128();
  r.c.setAutoSource(() => ({ grid, positionMs: 60000 * 10.4 / 128, anchorMs: 60000 * 8 / 128 }));
  const reading = r.c.now();
  assert.ok(close(reading.anchorBeat, 8), 'for re-anchoring after a seek');
  r.c.setAutoSource(() => ({ grid, positionMs: 60000 * 10.4 / 128 }));
  assert.strictEqual(r.c.now().anchorBeat, undefined, 'and nothing when it does not know');
});

// ── The phase, for other screens ────────────────────────────────────────────
// Visuals that keep their own beat read where the clock's is, with its epoch,
// between the engine's frames: exactly where the next reading will find it,
// and without moving anything the engine reads next.

test('the phase is where the next reading will find the beat, and moves nothing', () => {
  const r = rig({ bpm: 90 });
  const grid = grid128();
  let showRunning = true;
  let pos = 60000 * 16 / 128;
  r.c.setAutoSource(() => (showRunning ? { grid, positionMs: pos } : null));
  const locked = r.c.now();

  r.advance(10); pos += 10;
  const between = r.c.phase();
  assert.ok(close(between.beatPos, 16 + 10 * 128 / 60000), `mid-frame: ${between.beatPos}`);
  assert.strictEqual(between.epoch, locked.epoch);

  // The show stops between frames: the next reading carries on from where it
  // was, and so does the phase, rather than reading the idle free clock.
  showRunning = false;
  r.advance(10);
  const handing = r.c.phase();
  r.c.phase();
  const next = r.c.now();
  assert.deepStrictEqual([handing.beatPos, handing.epoch], [next.beatPos, next.epoch]);
  assert.strictEqual(next.source, 'tap', 'the hand-over is the engine\'s to make');

  // A seek between frames: the jump and the epoch it will bring.
  r.advance(23);
  r.c.now();
  r.c.setTrack({ key: 'song', grid, positionMs: () => 60000 * 64 / 128 });
  const seeked = r.c.phase();
  assert.ok(close(seeked.beatPos, 64));
  assert.strictEqual(seeked.epoch, next.epoch + 1);
  assert.strictEqual(r.c.now().epoch, seeked.epoch);
});

test('a tempo change keeps the phase moving forward, within its epoch', () => {
  const r = rig({ bpm: 120 });
  r.c.now();
  const seen = [];
  for (const [ms, change] of [[300, () => r.c.setBpm(60)], [200, () => r.c.setBpm(174)], [250, () => r.c.tap()],
    [120, () => r.c.setBpm(90)], [400, null]]) {
    for (let i = 0; i < 4; i++) {
      r.advance(ms / 8);
      seen.push(r.c.phase());
      if (i % 2) r.c.now();
    }
    if (change) change();
    seen.push(r.c.phase());
  }
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].beatPos >= seen[i - 1].beatPos, `step ${i}: ${seen[i - 1].beatPos} → ${seen[i].beatPos}`);
    assert.strictEqual(seen[i].epoch, seen[0].epoch, `step ${i}: same epoch`);
  }
});

test('a stopped free clock has a phase that stands still', () => {
  const r = rig({ bpm: 120 });
  r.c.now();
  r.advance(1000);
  r.c.setRunning(false);
  const stopped = r.c.phase();
  r.advance(5000);
  assert.deepStrictEqual(r.c.phase(), stopped);
  assert.ok(close(stopped.beatPos, 2));
});

// A source that stops answering hands over at the engine's next reading. A
// tempo, a tap or a stop that comes in before that reading starts from where
// the clock carries on, and the hand-over does not then undo it.
test('a tempo, a tap or a stop in the frame a source stops answering is kept', () => {
  for (const [what, act, want] of [
    ['a typed tempo', (c) => c.setBpm(100), (reading, held) => close(reading.bpm, 100) && close(reading.beatPos, held + 18 * 100 / 60000, 1e-9)],
    ['a tap', (c) => c.tap(), (reading, held) => close(reading.bpm, 128) && close(reading.beatPos, Math.floor(held) + 1 + 18 * 128 / 60000, 1e-9)],
    ['a stop', (c) => c.setRunning(false), (reading, held) => close(reading.beatPos, held, 1e-9)],
  ]) {
    const r = rig({ bpm: 90 });
    let on = true;
    const start = r.t;
    r.c.setLiveSource(() => (on ? { beatPos: 100 + ((r.t - start) / 60000) * 128, bpm: 128, key: 1 } : null));
    const reported = [];
    r.c.onTempo((bpm) => reported.push(bpm));
    r.c.now();
    r.advance(23);
    const before = r.c.now();
    on = false;
    r.advance(5);
    const held = before.beatPos + 5 * 128 / 60000;
    act(r.c);
    r.advance(18);
    const after = r.c.now();
    assert.strictEqual(after.source, 'tap', what);
    assert.ok(want(after, held), `${what}: ${after.beatPos} at ${after.bpm} BPM, the music was at ${held}`);
    assert.strictEqual(after.epoch, before.epoch, `${what}: no new epoch`);
    assert.strictEqual(reported.at(-1), after.bpm, `${what}: the read-out is the tempo the clock runs at`);
  }
});

// The MIDI clock reads between the engine's frames: in the frame a source
// stops, it must find the beat where the engine will, not on the idle free
// clock, or the pulses jump away and back.
test('a peek in the frame a source stops finds the beat where the next reading will', () => {
  const r = rig({ bpm: 120 });
  r.advance(100000);                       // the idle free clock wanders on
  let on = true;
  const start = r.t;
  r.c.setLiveSource(() => (on ? { beatPos: 7 + ((r.t - start) / 60000) * 128, bpm: 128, key: 1 } : null));
  r.c.now();
  r.advance(23);
  r.c.now();
  on = false;
  r.advance(4);
  const peeked = r.c.peek();
  assert.deepStrictEqual({ source: peeked.source, bpm: peeked.bpm }, { source: 'tap', bpm: 128 });
  assert.strictEqual(peeked.beatPos, r.c.phase().beatPos);
  assert.strictEqual(peeked.beatPos, r.c.now().beatPos, 'where the engine finds it');
});
