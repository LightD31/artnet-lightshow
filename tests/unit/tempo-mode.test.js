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
import { attachRoutes } from '../../src/server/routes.ts';
import { applyPatch, setPersist } from '../../src/server/patch.ts';
import { settings } from '../../src/server/settings.ts';
import { state } from '../../src/server/state.ts';
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

// In 'auto' a typed BPM or a tap sets the read-out (state.bpm) while the
// clock keeps the live tempo, which it has already reported. At the switch the
// tempo held is said again, so the read-out and the ± nudges start from it.
test('the switch reports the tempo it holds, even one already reported', () => {
  const r = rig({ bpm: 90 });
  const reported = [];
  r.c.onTempo((bpm) => reported.push(bpm));
  r.c.setLiveSource(hears128(r));
  r.c.now();
  r.c.setBpm(100);
  r.advance(23);
  r.c.now();
  assert.deepStrictEqual(reported, [128], 'following the music, the typed tempo is not the clock\'s');
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
