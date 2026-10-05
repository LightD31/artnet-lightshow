// Automatic tempo match, on or off. In 'auto' the clock follows the best
// source it hears, as it always has; in 'manual' it keeps the operator's tempo
// and lets only the running auto show's grid lead, and the switch between the
// two hands over without a lurch. The server half: the route, the token, the
// applier that puts the stored mode back at start.

import test from 'node:test';
import assert from 'node:assert';
import express from 'express';

import { Conductor, conductor } from '../../src/server/conductor.ts';
import { makeGrid } from '../../src/shared/beat-clock.ts';
import { createAuth } from '../../src/server/auth.ts';
import { createApplier } from '../../src/server/apply.ts';
import { setupIntegrations } from '../../src/server/integrations.ts';
import { attachRoutes } from '../../src/server/routes.ts';
import { applyPatch, setPersist } from '../../src/server/patch.ts';
import { settings } from '../../src/server/settings.ts';
import { state, getLiveState } from '../../src/server/state.ts';
import { showStore } from '../../src/server/show-store.ts';
import * as output from '../../src/server/output.ts';

showStore.scheduleSave = () => {};   // never the real show file

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** A conductor on a clock the test moves by hand. */
function rig({ bpm = 120 } = {}) {
  let t = 1000;
  const c = new Conductor({ now: () => t, bpm });
  return { c, advance: (ms) => { t += ms; }, get t() { return t; } };
}

const grid128 = () => makeGrid(Array.from({ length: 512 }, (_, i) => i * (60 / 128)));

/** The live input hearing 128 BPM, at `from` beats when it is set up. */
function hears128(r, from = 100) {
  const start = r.t;
  return () => ({ beatPos: from + ((r.t - start) / 60000) * 128, bpm: 128 });
}

// ── The Conductor ───────────────────────────────────────────────────────────

test('the default follows the music, as before', () => {
  const r = rig({ bpm: 120 });
  assert.strictEqual(r.c.tempoMode, 'auto');
  r.c.setLiveSource(hears128(r));
  const reading = r.c.now();
  assert.deepStrictEqual([reading.source, reading.bpm], ['live', 128]);
  assert.ok(close(reading.beatPos, 100));
});

test('\'manual\' ignores a live beat: the source reads tap at the operator\'s BPM', () => {
  const r = rig({ bpm: 120 });
  r.c.setTempoMode('manual');
  r.c.setLiveSource(hears128(r));
  r.c.now();
  r.advance(1500);
  const reading = r.c.now();
  assert.deepStrictEqual([reading.source, reading.bpm], ['tap', 120]);
  assert.ok(close(reading.beatPos, 3), `three beats in 1.5 s at 120: ${reading.beatPos}`);

  r.c.setBpm(100);
  assert.deepStrictEqual([r.c.now().source, r.c.now().bpm], ['tap', 100], 'a typed tempo is the tempo');
  r.advance(1300);
  r.c.tap();
  assert.strictEqual(r.c.now().source, 'tap', 'and a tap is a beat on it');
  assert.strictEqual(r.c.tempoMode, 'manual', 'neither flips the mode');
  assert.deepStrictEqual(r.c.status(), { source: 'tap', bpm: 100 });
});

test('\'manual\' ignores a playing deck and a locked track too', () => {
  const r = rig({ bpm: 120 });
  r.c.setTempoMode('manual');
  r.c.setProlinkSource(() => ({ beatPos: 42.5, bpm: 126 }));
  assert.strictEqual(r.c.now().source, 'tap');
  r.c.setProlinkSource(null);
  r.c.setTrack({ key: 'song', grid: grid128(), positionMs: () => 5000 });
  const reading = r.c.now();
  assert.deepStrictEqual([reading.source, reading.bpm], ['tap', 120]);
  assert.strictEqual(r.c.beatAtTrackMs(5000), null, 'no grid is driving');
});

// Its scenes are scheduled on that grid: held off it, the show would land its
// changes between the beats.
test('the running auto show still leads in \'manual\'', () => {
  const r = rig({ bpm: 90 });
  const grid = grid128();
  let showRunning = true;
  r.c.setTempoMode('manual');
  r.c.setAutoSource(() => (showRunning ? { grid, positionMs: 60000 * 10 / 128 } : null));
  const reading = r.c.now();
  assert.strictEqual(reading.source, 'auto');
  assert.ok(close(reading.beatPos, 10));
  assert.ok(close(r.c.beatAtTrackMs(60000 * 8 / 128), 8), 'scenes anchor on it');

  showRunning = false;
  r.advance(60000 / 128);
  const after = r.c.now();
  assert.strictEqual(after.source, 'tap', 'stopped, the operator\'s clock carries on');
  assert.ok(close(after.beatPos, 11), `from the beat the show had reached: ${after.beatPos}`);
  assert.strictEqual(after.epoch, reading.epoch);
});

test('switching to \'manual\' hands over where the clock had got to, without a step back or a new epoch', () => {
  const r = rig({ bpm: 90 });
  r.c.setLiveSource(hears128(r));
  const readings = [];
  for (let i = 0; i < 20; i++) { readings.push(r.c.now()); r.advance(23); }
  assert.strictEqual(readings.at(-1).source, 'live');

  r.c.setTempoMode('manual');
  for (let i = 0; i < 20; i++) { readings.push(r.c.now()); r.advance(23); }
  const held = readings.at(-1);
  assert.deepStrictEqual([held.source, held.bpm], ['tap', 128], 'at the tempo it had reached, not the old 90');
  for (let i = 1; i < readings.length; i++) {
    const step = readings[i].beatPos - readings[i - 1].beatPos;
    assert.ok(close(step, 23 * 128 / 60000, 1e-9), `frame ${i} moved ${step} beats`);
    assert.strictEqual(readings[i].epoch, readings[0].epoch, `frame ${i}: no new epoch`);
  }
  assert.deepStrictEqual(r.c.status(), { source: 'tap', bpm: 128 });
});

// The read-out (state.bpm) follows every tempo the clock reports. The switch
// says the tempo it holds again, so a read-out moved by anything else comes
// back to the clock's.
test('the switch reports the tempo it holds, even one already reported', () => {
  const r = rig({ bpm: 90 });
  const reported = [];
  r.c.onTempo((bpm) => reported.push(bpm));
  r.c.setLiveSource(hears128(r));
  r.c.now();
  assert.deepStrictEqual(reported, [128]);
  r.c.setTempoMode('manual');
  assert.deepStrictEqual(reported, [128, 128]);
  r.c.setTempoMode('auto');
  assert.deepStrictEqual(reported, [128, 128, 128]);
});

// A patch that switches and types a tempo at once, or a BPM sent straight
// after the switch, arrives before the next frame: the hand-over must not
// overwrite it then.
test('a tempo set straight after the switch is kept', () => {
  const r = rig({ bpm: 90 });
  r.c.setLiveSource(hears128(r));
  r.c.now();
  r.advance(23);
  const before = r.c.now();
  r.advance(5);
  r.c.setTempoMode('manual');
  r.c.setBpm(100);
  r.advance(18);
  const after = r.c.now();
  assert.deepStrictEqual([after.source, after.bpm], ['tap', 100]);
  assert.ok(close(after.beatPos, before.beatPos + 5 * 128 / 60000 + 18 * 100 / 60000, 1e-9), `${before.beatPos} → ${after.beatPos}`);
  assert.strictEqual(after.epoch, before.epoch);
});

test('switching back to \'auto\' lets the best source take over under the epoch rules', () => {
  // In step with the music: the live grid takes over with no restart.
  const agree = rig({ bpm: 128 });
  agree.c.setLiveSource(hears128(agree, 0));
  agree.c.setTempoMode('manual');
  const free = agree.c.now();
  agree.advance(500);
  agree.c.now();
  agree.c.setTempoMode('auto');
  const live = agree.c.now();
  assert.strictEqual(live.source, 'live');
  assert.ok(close(live.beatPos, 500 * 128 / 60000));
  assert.strictEqual(live.epoch, free.epoch, 'the same count, no restart');

  // Far from it: a new start, as any source that counts from elsewhere is.
  const apart = rig({ bpm: 120 });
  apart.c.setLiveSource(hears128(apart, 300));
  apart.c.setTempoMode('manual');
  const first = apart.c.now();
  apart.advance(23);
  apart.c.setTempoMode('auto');
  const jumped = apart.c.now();
  assert.strictEqual(jumped.source, 'live');
  assert.strictEqual(jumped.epoch, first.epoch + 1);
});

// In 'auto' a tap still takes the tempo from a locked track until the next
// one. A tap made while the tempo was held is not that: switching back means
// follow the music.
test('switching back to \'auto\' follows the track again, whatever was tapped', () => {
  const r = rig();
  r.c.setTrack({ key: 'song', grid: grid128(), positionMs: () => 5000 });
  assert.strictEqual(r.c.now().source, 'track');
  r.c.tap();
  assert.strictEqual(r.c.now().source, 'tap', 'in \'auto\' a tap takes over, as before');
  assert.strictEqual(r.c.tempoMode, 'auto', 'and leaves the mode alone');
  r.c.setTempoMode('manual');
  r.c.tap();
  r.c.setTempoMode('auto');
  assert.strictEqual(r.c.now().source, 'track');
});

test('an unknown mode is no mode', () => {
  const r = rig();
  r.c.setTempoMode('sometimes');
  assert.strictEqual(r.c.tempoMode, 'auto');
});

// ── Tempo by hand, in 'auto' ────────────────────────────────────────────────
// A tap, a typed BPM or a nudge while a deck, a track or the live input leads
// takes the tempo by hand: the clock reads tap at that tempo until the music it
// was taken from moves on — the next track, a new track or deck on the CDJs, a
// new lock of the live input — and then follows again.

/** A source on the test's clock: `{ beatPos, bpm, key }` while `on`, else null. */
function music(r, { bpm = 128, from = 100, key = 'a' } = {}) {
  const m = { bpm, key, on: true, from, at: r.t };
  m.read = () => (m.on ? { beatPos: m.from + ((r.t - m.at) / 60000) * m.bpm, bpm: m.bpm, key: m.key } : null);
  /** The music moves on: a new key, counting from `beatPos` now. */
  m.moveOn = (key, beatPos = 0) => { m.key = key; m.from = beatPos; m.at = r.t; m.on = true; };
  return m;
}

/** Frames 23 ms apart, each reading kept, and the read-out the clock reported last. */
function frames(r) {
  const seen = [];
  const reported = [];
  r.c.onTempo((bpm) => reported.push(bpm));
  return {
    seen,
    get readOut() { return reported.at(-1); },
    run(n = 1) { for (let i = 0; i < n; i++) { r.advance(23); seen.push(r.c.now()); } return seen.at(-1); },
  };
}

/** Never a step back, and one epoch, across `seen`. */
function steady(seen, what) {
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].beatPos >= seen[i - 1].beatPos, `${what}, frame ${i}: ${seen[i - 1].beatPos} → ${seen[i].beatPos}`);
    assert.strictEqual(seen[i].epoch, seen[0].epoch, `${what}, frame ${i}: one epoch`);
  }
}

test('a tap over the live input takes the tempo, and a new lock gives it back', () => {
  const r = rig({ bpm: 90 });
  const live = music(r);
  r.c.setLiveSource(live.read);
  const f = frames(r);
  f.run(3);
  assert.strictEqual(f.seen.at(-1).source, 'live');

  r.advance(10);
  const heard = live.read().beatPos;
  r.c.tap();
  assert.deepStrictEqual(r.c.status(), { source: 'tap', bpm: 128 }, 'at once, at the music\'s tempo until a second tap');
  assert.strictEqual(r.c.phase().beatPos, Math.floor(heard) + 1, 'the beat lands on the tap, ahead of the music');
  const tapped = f.run();
  assert.deepStrictEqual([tapped.source, tapped.bpm, f.readOut], ['tap', 128, 128]);

  r.c.setBpm(100);
  assert.deepStrictEqual(r.c.status(), { source: 'tap', bpm: 100 });
  const typed = f.run(4);
  assert.deepStrictEqual([typed.source, typed.bpm, f.readOut], ['tap', 100, 100]);

  // Held through the lock lapsing, and through the same lock coming back.
  live.on = false;
  f.run(4);
  live.on = true;
  assert.deepStrictEqual([f.run(4).source, f.readOut], ['tap', 100]);
  steady(f.seen, 'by hand');

  // A new lock: followed again, under the epoch rules — its count is far from
  // the hand's, so the patterns re-anchor.
  live.moveOn('b', 400);
  const back = f.run();
  assert.deepStrictEqual([back.source, back.bpm, f.readOut], ['live', 128, 128]);
  assert.strictEqual(back.epoch, typed.epoch + 1);
  assert.deepStrictEqual(r.c.status(), { source: 'live', bpm: 128 });
});

test('a tempo typed over a CDJ holds until the master deck loads a new track', () => {
  const r = rig({ bpm: 90 });
  const deck = music(r, { bpm: 126, from: 40, key: '1/track-a' });
  r.c.setProlinkSource(deck.read);
  const f = frames(r);
  f.run(3);
  assert.strictEqual(f.seen.at(-1).source, 'cdj');

  r.advance(5);
  r.c.setBpm(127);                          // a ±1 nudge from the read-out
  const nudged = f.run(3);
  assert.deepStrictEqual([nudged.source, nudged.bpm, f.readOut], ['tap', 127, 127]);
  r.c.tap();
  f.run(3);

  // Paused and playing on: the same track, still by hand.
  deck.on = false;
  f.run(5);
  deck.on = true;
  assert.deepStrictEqual([f.run(3).source, f.readOut], ['tap', 127]);
  steady(f.seen, 'by hand');

  deck.moveOn('1/track-b', 0);
  const next = f.run();
  assert.deepStrictEqual([next.source, next.bpm, f.readOut], ['cdj', 126, 126]);
  assert.strictEqual(next.epoch, nudged.epoch + 1, 'a new track counts from its start');
});

test('a tempo taken from a CDJ gives way when the master changes to another deck', () => {
  const r = rig();
  const deck = music(r, { bpm: 124, from: 64, key: '1/track-a' });
  r.c.setProlinkSource(deck.read);
  const f = frames(r);
  f.run(2);
  r.c.tap();
  assert.strictEqual(f.run(2).source, 'tap');
  deck.moveOn('2/track-c', f.seen.at(-1).beatPos + 23 * 124 / 60000);
  deck.bpm = 125;
  const other = f.run();
  assert.deepStrictEqual([other.source, other.bpm, f.readOut], ['cdj', 125, 125]);
  assert.strictEqual(other.epoch, f.seen[0].epoch, 'a deck counting on in time: no restart');
});

// What was already true of a track stays true; the hand now also holds off
// the live input under it, so the clock reads what the operator set.
test('a tap over a locked track holds until the next track, the live input under it too', () => {
  const r = rig({ bpm: 90 });
  const live = music(r, { bpm: 131, from: 7 });
  r.c.setLiveSource(live.read);
  let pos = 60000 * 16 / 128;
  r.c.setTrack({ key: 'song', grid: grid128(), positionMs: () => pos });
  const f = frames(r);
  for (let i = 0; i < 3; i++) { pos += 23; f.run(); }
  assert.strictEqual(f.seen.at(-1).source, 'track');

  r.c.tap();
  for (let i = 0; i < 4; i++) { pos += 23; f.run(); }
  assert.deepStrictEqual([f.seen.at(-1).source, f.seen.at(-1).bpm, f.readOut], ['tap', 128, 128], 'not the live input\'s 131');
  steady(f.seen, 'by hand');

  live.moveOn('b', 3);
  pos += 23;
  assert.strictEqual(f.run().source, 'tap', 'a new lock of the live input is not the next track');
  r.c.setTrack({ key: 'song-2', grid: grid128(), positionMs: () => pos });
  pos += 23;
  assert.deepStrictEqual([f.run().source, f.readOut], ['track', 128]);
});

// The deck that went quiet may never come back — the DJ's set is over and
// another player takes the room. Its hand gives way when a source it holds
// off moves on: a new track, a new lock. While it still answers, or while
// nothing new answers, the hand holds.
test('a tempo taken from a deck that went quiet gives way when the music moves on below it', () => {
  for (const below of ['track', 'live']) {
    const r = rig({ bpm: 90 });
    const deck = music(r, { bpm: 126, from: 40, key: '1/track-a' });
    const live = music(r, { bpm: 131, from: 7, key: 1 });
    live.on = below === 'track';
    r.c.setProlinkSource(deck.read);
    r.c.setLiveSource(live.read);
    let pos = 60000 * 16 / 128;
    const f = frames(r);
    f.run(3);
    r.c.setBpm(127);
    f.run(3);
    assert.strictEqual(f.seen.at(-1).source, 'tap', below);

    deck.on = false;
    pos += 23;
    assert.deepStrictEqual([f.run(4).source, f.readOut], ['tap', 127], `${below}: a quiet deck alone ends nothing`);
    if (below === 'track') {
      r.c.setTrack({ key: 'song', grid: grid128(), positionMs: () => pos });
      for (let i = 0; i < 2; i++) { pos += 23; f.run(); }
      assert.deepStrictEqual([f.seen.at(-1).source, f.readOut], ['track', 128], 'the next song is followed');
    } else {
      live.moveOn(2, 3);
      assert.deepStrictEqual([f.run().source, f.readOut], ['live', 131], 'a new lock is followed');
    }
  }

  // The deck still playing: a new lock under it is not its next track.
  const r = rig({ bpm: 90 });
  const deck = music(r, { bpm: 126, from: 40, key: '1/track-a' });
  const live = music(r, { bpm: 126, from: 7, key: 1 });
  r.c.setProlinkSource(deck.read);
  r.c.setLiveSource(live.read);
  const f = frames(r);
  f.run(2);
  r.c.tap();
  live.moveOn(2, 3);
  assert.strictEqual(f.run(3).source, 'tap');
});

// A tempo a source reports (the deck's pitch, setBpm with manual: false) is
// the free clock's for when that source stops answering. It never replaces a
// tempo the operator holds, and is not the read-out's while the clock runs on
// another source.
test('a tempo a source reports leaves the operator\'s alone, and says whether the clock took it', () => {
  const held = rig({ bpm: 100 });
  held.c.setTempoMode('manual');
  held.c.now();
  assert.strictEqual(held.c.setBpm(128.3, { manual: false }), false, 'in manual');
  held.advance(23);
  assert.deepStrictEqual([held.c.now().source, held.c.now().bpm], ['tap', 100]);

  const r = rig({ bpm: 90 });
  const deck = music(r, { bpm: 126, from: 40, key: '1/track-a' });
  r.c.setProlinkSource(deck.read);
  const f = frames(r);
  f.run(2);
  assert.strictEqual(r.c.setBpm(126.5, { manual: false }), true, 'the deck the clock follows');
  r.c.setBpm(127);
  f.run();
  assert.strictEqual(r.c.setBpm(126.5, { manual: false }), false, 'a tempo held by hand');
  assert.deepStrictEqual([f.run(2).source, f.seen.at(-1).bpm, f.readOut], ['tap', 127, 127]);

  const quiet = rig({ bpm: 90 });
  const lock = music(quiet, { bpm: 131 });
  quiet.c.setLiveSource(lock.read);
  quiet.c.now();
  assert.strictEqual(quiet.c.setBpm(124, { manual: false }), false, 'the live input leads');
  lock.on = false;
  quiet.advance(23);
  assert.strictEqual(quiet.c.now().bpm, 131, 'stopped, it hands over at its own tempo');
  assert.strictEqual(quiet.c.setBpm(124, { manual: false }), true, 'the free clock leads');
  quiet.advance(23);
  assert.deepStrictEqual([quiet.c.now().source, quiet.c.now().bpm], ['tap', 124]);
});

test('switching to \'manual\' and back ends a tempo held by hand', () => {
  const r = rig();
  const live = music(r);
  r.c.setLiveSource(live.read);
  const f = frames(r);
  f.run();
  r.c.setBpm(100);
  assert.strictEqual(f.run().source, 'tap');
  r.c.setTempoMode('manual');
  r.c.setTempoMode('auto');
  assert.deepStrictEqual([f.run().source, f.readOut], ['live', 128]);
});

// The auto show's grid leads in either mode, and a tempo typed under it does
// not move the clock: the read-out goes back to the tempo the rig runs at.
test('a tempo typed while the auto show leads leaves the read-out on the show\'s tempo', () => {
  for (const mode of ['auto', 'manual']) {
    const r = rig({ bpm: 90 });
    let pos = 60000 * 8 / 128;
    r.c.setTempoMode(mode);
    r.c.setAutoSource(() => ({ grid: grid128(), positionMs: pos }));
    const reported = [];
    r.c.onTempo((bpm) => reported.push(Math.round(bpm)));
    r.c.now();
    r.c.setBpm(100);
    pos += 23;
    r.advance(23);
    const after = r.c.now();
    assert.deepStrictEqual([after.source, Math.round(after.bpm)], ['auto', 128], mode);
    assert.deepStrictEqual(reported, [128, 128], `${mode}: said again, for the read-out the patch moved`);
  }
});

// ── The server ──────────────────────────────────────────────────────────────

/** The routes on the settings defaults, file writes stubbed, behind `token` when given. */
async function withApp({ token = '' } = {}, fn) {
  const saved = settings.all();
  settings.save = () => {};
  settings.useDefaults();
  setPersist((patch) => settings.update(patch));
  const app = express();
  app.use('/api', createAuth({ token }).httpMiddleware);
  app.use(express.json());
  attachRoutes(app, { integrations: { broadcast() {} }, applier: { applyChanged() {}, pendingRestart: () => [] } });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = (method, path, { body, headers = {} } = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  try {
    await fn({ call });
  } finally {
    await new Promise((r) => server.close(r));
    applyPatch({ tempoMode: 'auto' });
    setPersist(() => {});
    settings._values = saved;
    delete settings.save;
  }
}

test('POST /api/tempo/:mode switches, answers with the clock, and is stored', () => withApp({}, async ({ call }) => {
  const manual = await call('POST', '/api/tempo/manual');
  assert.strictEqual(manual.status, 200);
  const { clock, ...rest } = manual.body;
  assert.deepStrictEqual(rest, { ok: true, tempoMode: 'manual' });
  assert.deepStrictEqual({ source: clock.source, bpm: clock.bpm }, conductor.status(), 'the clock as the live state has it');
  assert.strictEqual(clock.source, 'tap');
  assert.ok([clock.beatPos, clock.epoch, clock.at].every(Number.isFinite));
  assert.strictEqual(state.tempoMode, 'manual');
  assert.strictEqual(conductor.tempoMode, 'manual');
  assert.strictEqual(settings.get('clock.tempoMode'), 'manual', 'survives a restart');
  assert.strictEqual((await call('GET', '/api/state')).body.tempoMode, 'manual');

  const auto = await call('POST', '/api/tempo/auto');
  assert.deepStrictEqual([auto.body.ok, auto.body.tempoMode], [true, 'auto']);
  assert.strictEqual(settings.get('clock.tempoMode'), 'auto');
}));

test('an unknown mode is a 400 and changes nothing, by route or by /api/set', () => withApp({}, async ({ call }) => {
  await call('POST', '/api/tempo/manual');
  const dimmer = state.masterDimmer;
  for (const [path, body] of [['/api/tempo/off', undefined], ['/api/tempo/AUTO', undefined],
    ['/api/set', { tempoMode: 'sometimes', masterDimmer: 3 }], ['/api/set', { tempoMode: null }]]) {
    const res = await call('POST', path, { body });
    assert.strictEqual(res.status, 400, path);
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.error, /tempoMode/);
  }
  assert.deepStrictEqual([state.tempoMode, conductor.tempoMode, settings.get('clock.tempoMode')], ['manual', 'manual', 'manual']);
  assert.strictEqual(state.masterDimmer, dimmer, 'the rest of a refused patch is not applied either');

  const set = await call('POST', '/api/set', { body: { tempoMode: 'auto' } });
  assert.deepStrictEqual([set.status, set.body.state.tempoMode], [200, 'auto']);
}));

test('both sit behind the access token', () => withApp({ token: 'sesame' }, async ({ call }) => {
  assert.strictEqual((await call('POST', '/api/tempo/manual')).status, 401);
  assert.strictEqual((await call('POST', '/api/set', { body: { tempoMode: 'manual' } })).status, 401);
  assert.strictEqual(state.tempoMode, 'auto', 'refused before anything ran');
  const ok = await call('POST', '/api/tempo/manual', { headers: { 'X-Lightshow-Token': 'sesame' } });
  assert.deepStrictEqual([ok.status, ok.body.tempoMode], [200, 'manual']);
}));

// The switch is applied before the tempo, or the hand-over to the free clock
// would put the music's tempo back over the one typed beside it.
test('a patch that switches to \'manual\' and sets a tempo keeps that tempo', () => {
  const started = performance.now();
  conductor.setLiveSource(() => ({ beatPos: 50 + ((performance.now() - started) / 60000) * 128, bpm: 128 }));
  try {
    conductor.now();
    assert.strictEqual(conductor.now().source, 'live');
    applyPatch({ tempoMode: 'manual', bpm: 100 });
    const held = conductor.now();
    assert.deepStrictEqual([held.source, held.bpm, state.bpm], ['tap', 100, 100]);
    assert.ok(held.beatPos >= 50, `carried on from the music: ${held.beatPos}`);
  } finally {
    conductor.setLiveSource(null);
    applyPatch({ tempoMode: 'auto' });
  }
});

// The read-out is state.bpm, which the server keeps on the clock's reported
// tempo (main.ts) and a typed tempo or a nudge writes directly. The two agree
// whatever the clock follows.
test('the read-out and the clock agree through a nudge, a typed tempo and a new lock', () => {
  const started = performance.now();
  let key = 'a';
  let from = 50;
  let at = started;
  conductor.setLiveSource(() => ({ beatPos: from + ((performance.now() - at) / 60000) * 128, bpm: 128, key }));
  conductor.onTempo((bpm) => { state.bpm = bpm; });
  const bpm = state.bpm;
  const agree = (what) => {
    const live = getLiveState();
    assert.ok(Math.abs(live.bpm - live.clock.bpm) < 0.05, `${what}: read-out ${live.bpm}, clock ${live.clock.bpm} (${live.clock.source})`);
    return live.clock;
  };
  try {
    conductor.now();
    assert.strictEqual(agree('following').source, 'live');
    applyPatch({ bpm: Math.round((state.bpm + 1) * 100) / 100 });
    assert.strictEqual(agree('nudged, before a frame').source, 'tap');
    conductor.now();
    assert.strictEqual(agree('nudged, a frame on').bpm, 129);
    applyPatch({ bpm: 97.5 });
    conductor.now();
    assert.strictEqual(agree('typed').bpm, 97.5);
    key = 'b'; from = 10; at = performance.now();
    conductor.now();
    assert.deepStrictEqual([agree('a new lock').source, state.bpm], ['live', 128]);
  } finally {
    conductor.setLiveSource(null);
    conductor.onTempo(null);
    applyPatch({ bpm });
  }
});

// The deck reports its pitched tempo whenever it moves (integrations.ts). In
// 'manual', or under a tempo taken by hand, that is not the rig's tempo, and
// the read-out does not show it either.
test('a deck\'s tempo report moves neither the clock nor the read-out while the operator holds the tempo', () => {
  const idle = { onPlaybackUpdate() {}, onTrackChange() {}, getStatus: () => ({}), authenticated: false };
  let reportTempo = null;
  const prolink = {
    connected: true, stale: false, lastError: null,
    getNumPeers: () => 1, getTrack: () => null, getLoadedTracks: () => [], getFollowed: () => ({ deviceId: 1 }),
    getTempo: () => 126, getPositionMs: () => 0, getDeckPositionMs: () => 0,
    onTempoChange(fn) { reportTempo = fn; }, onPeersChange() {}, onFollowChange() {}, onLoadedTracksChange() {},
    onAnyTrackLoaded() {}, onTrackChange() {}, canFetchAudio: () => false,
  };
  const autoShow = {
    running: false, syncOffsetMs: 0, getClientState: () => ({}), getPositionMs: () => 0, isCached: () => false,
    gridFor: () => null, isPrefetching: () => false, applyQueueOrder() {}, setPaletteSize() {}, setIntensity() {},
    setSyncOffsetMs() {}, setExactAudio() {},
  };
  setupIntegrations({
    io: { emit() {} }, midi: { enabled: false, sendFeedback() {}, listPorts: () => [] },
    spotify: { ...idle, startPolling() {}, async getQueue() { return []; } }, nowPlaying: idle,
    deezerSource: { ...idle, getQueue: () => [], updatePlayback() {}, updateQueue() {}, disconnect() {} },
    prolink, autoShow,
  });
  const was = { bpm: state.bpm, prolinkEnabled: state.prolinkEnabled };
  const started = performance.now();
  let playing = true;
  conductor.setProlinkSource(() => (playing ? { beatPos: 40 + ((performance.now() - started) / 60000) * 126, bpm: 126, key: '1/a' } : null));
  conductor.onTempo((bpm) => { state.bpm = bpm; });
  state.prolinkEnabled = true;
  try {
    applyPatch({ tempoMode: 'manual', bpm: 100 });
    reportTempo(128.3);
    assert.deepStrictEqual([state.bpm, conductor.now().source, conductor.now().bpm], [100, 'tap', 100], 'in manual');

    applyPatch({ tempoMode: 'auto' });
    assert.strictEqual(conductor.now().source, 'cdj');
    applyPatch({ bpm: 127 });
    conductor.now();
    reportTempo(126.5);
    assert.deepStrictEqual([state.bpm, conductor.now().source, conductor.now().bpm], [127, 'tap', 127], 'held by hand');

    // Nobody holds it, and the deck has stopped: the free clock keeps the
    // tempo it reports, and the read-out shows it, as it always has.
    applyPatch({ tempoMode: 'manual' });
    applyPatch({ tempoMode: 'auto' });
    playing = false;
    conductor.now();
    reportTempo(124);
    assert.deepStrictEqual([state.bpm, conductor.now().source, conductor.now().bpm], [124, 'tap', 124]);
  } finally {
    conductor.setProlinkSource(null);
    conductor.onTempo(null);
    state.prolinkEnabled = was.prolinkEnabled;
    applyPatch({ tempoMode: 'auto', bpm: was.bpm });
  }
});

/** The subsystems the applier pushes into, as far as the clock needs them. */
const subsystems = (applied) => ({
  midi: { close() {}, connect() { return true; }, setControlFeedback() {} },
  spotify: { localCallbackUrl: '', setLoopbackPort() {}, configure() {} },
  smtc: { start() {}, stop() {} },
  deezer: { init: async () => {} },
  applyPatch: (patch) => { applied.push(patch); return applyPatch(patch); },
  broadcast() {},
});

test('the stored mode is put back at start, and a settings save applies it', () => {
  const saved = settings.all();
  const was = { artnet: { ...state.artnet }, hue: output.getHueConfig() };
  settings.save = () => {};
  settings.useDefaults();
  const applied = [];
  try {
    createApplier(subsystems(applied)).applyAll();
    assert.deepStrictEqual(applied.filter((p) => 'tempoMode' in p), [], 'the default needs nothing');

    settings._values.clock.tempoMode = 'manual';
    const applier = createApplier(subsystems(applied));
    applier.applyAll();
    assert.deepStrictEqual(applied.filter((p) => 'tempoMode' in p), [{ tempoMode: 'manual' }]);
    assert.deepStrictEqual([state.tempoMode, conductor.tempoMode], ['manual', 'manual']);

    applier.applyChanged(settings.update({ clock: { tempoMode: 'auto' } }));
    assert.deepStrictEqual([state.tempoMode, conductor.tempoMode], ['auto', 'auto']);
  } finally {
    applyPatch({ tempoMode: 'auto' });
    output.setArmed(false);
    settings._values = saved;
    delete settings.save;
    Object.assign(state.artnet, was.artnet);
    output.configureHue(was.hue);
  }
});
