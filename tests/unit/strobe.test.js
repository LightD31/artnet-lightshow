// The manual strobe (src/server/strobe.ts): Hue Dynamics' hold strobe as one
// voice in the strobe tier — held from a pad or a page, latched with a cap,
// or burst for a moment — with its settings in settings.strobe. First on a
// manager with a clock of the test's own, then served: the routes, the live
// state, the energy endpoints' palette strobe, the pads and the socket.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';

import { Strobe, STROBE_VOICE_ID } from '../../src/server/strobe.ts';
import { VoiceManager, HOLD_TIMEOUT_MS } from '../../src/server/voices.ts';
import { STROBE_DEFAULTS } from '../../src/shared/effects/strobe.ts';
import { attachRoutes } from '../../src/server/routes.ts';
import { setupIntegrations } from '../../src/server/integrations.ts';
import { attachSockets } from '../../src/server/sockets.ts';
import { createApplier } from '../../src/server/apply.ts';
import { EffectLibrary } from '../../src/server/effect-library.ts';
import { PaletteStore } from '../../src/server/palette-store.ts';
import { PadStore } from '../../src/server/pads.ts';
import { stopEngine, renderInput, renderFrame } from '../../src/server/engine.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { captureLook, recallLook } from '../../src/server/cues.ts';
import { state, voices, strobe as liveStrobe, getLiveState } from '../../src/server/state.ts';
import { domainOf } from '../../src/server/protocol.ts';
import { settings } from '../../src/server/settings.ts';
import * as output from '../../src/server/output.ts';
import * as universes from '../../src/server/universes.ts';
import { showStore } from '../../src/server/show-store.ts';
import { getProfile } from '../../src/server/profiles.ts';

showStore.scheduleSave = () => {};   // never the real show file

test.after(() => stopEngine());

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const WHITE = ['#FFFFFF'];
const refusedWith = (status) => (err) => err.status === status;
const refused409 = (err) => err.status === 409;

/** Poll until `found()` answers, or fail saying what never came. */
async function until(found, what, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = found();
    if (hit) return hit;
    if (Date.now() > deadline) assert.fail(`no ${what}`);
    await wait(10);
  }
}

// ── On a manager of the test's own ──────────────────────────────────────────

/**
 * A Strobe over a manager on a clock of the test's own (`now` in ms, the beat
 * moving with it, setTimeout mocked to match), settings held in memory with
 * their listeners, and a safety that answers as `c` says.
 */
function bench(t, { acknowledged = false, capSec = 60, now = 1000 } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = { now, beat: 0, bpm: 120, acknowledged, running: false };
  const changes = [];
  let strobe = null;
  const voices = new VoiceManager({
    now: () => c.now, beatPos: () => c.beat, bpm: () => c.bpm, acknowledged: () => c.acknowledged, anyRunning: () => c.running,
    onChange: () => { changes.push(voices.list().map((v) => v.id)); strobe?.sync(); },
    strobeLatchMs: () => values.safety.strobeMaxLatchSec * 1000,
  });
  const values = {
    strobe: { ...STROBE_DEFAULTS, palette: [...WHITE] },
    safety: { flashLimit: false, hdFlashIntervalMs: 350, photosensitivityAcknowledged: acknowledged, strobeMaxLatchSec: capSec },
  };
  const listeners = [];
  const settings = {
    group: (name) => structuredClone(values[name]),
    get: (dotted) => { const [g, k] = dotted.split('.'); return values[g][k]; },
    update(patch) {
      const changed = [];
      for (const [g, group] of Object.entries(patch)) {
        for (const [k, v] of Object.entries(group)) {
          if (JSON.stringify(values[g][k]) === JSON.stringify(v)) continue;
          values[g][k] = structuredClone(v);
          changed.push(`${g}.${k}`);
        }
      }
      for (const fn of listeners) fn(changed, structuredClone(values));
      return changed;
    },
    onChange: (fn) => listeners.push(fn),
  };
  const safety = {
    acknowledged: () => c.acknowledged,
    status: () => ({ photosensitivityAcknowledged: c.acknowledged, hdFlashIntervalMs: 350, strobeMaxLatchSec: values.safety.strobeMaxLatchSec }),
  };
  strobe = new Strobe(voices, settings, safety);
  const advance = (ms) => {
    c.now += ms;
    c.beat += (ms / 60000) * c.bpm;
    t.mock.timers.tick(ms);
  };
  const playing = () => voices.frames(c.now).map((v) => v.id);
  return { c, voices, settings, safety, strobe, advance, changes, values, playing };
}

test("strobe on and off control its latched voice", (t) => {
  const { voices, strobe, c, values } = bench(t, { acknowledged: true });
  assert.deepEqual(strobe.status(), { active: null, mode: null, settings: { ...STROBE_DEFAULTS, palette: WHITE } });

  const v = strobe.on('latched');
  assert.deepEqual([v.id, v.key, v.tier, v.source, v.mode, v.label], [STROBE_VOICE_ID, 'strobe', 'strobe', 'strobe', 'latched', 'Strobe']);
  assert.equal(v.spec.kind, 'strobe');
  assert.deepEqual(v.spec.palette, WHITE, 'the settings\' palette is the effect\'s');
  const { palette: _p, ...params } = values.strobe;
  assert.deepEqual(v.spec.params, params, 'the settings\' parameters are the kind\'s');
  assert.equal(v.targets, null, 'the whole rig');
  assert.equal(v.untilMs, c.now + 60_000, 'a latch ends at the cap');
  const status = strobe.status();
  assert.deepEqual([status.active.id, status.active.mode, status.mode], [STROBE_VOICE_ID, 'latched', 'latched']);
  assert.equal(status.active.until - status.active.startedAt, 60_000);
  assert.deepEqual(voices.list().map((x) => x.id), [STROBE_VOICE_ID]);

  // On again: the latch stays as it is, not launched again.
  assert.equal(strobe.on('latched').launchSeq, v.launchSeq);
  assert.equal(voices.size, 1);

  strobe.off();
  assert.equal(voices.size, 0);
  assert.deepEqual(strobe.status().active, null);
  assert.equal(strobe.status().mode, null);
  // Off with nothing on, and off unacknowledged: never refused.
  strobe.off();
  c.acknowledged = false;
  strobe.off();
  strobe.release('tablet', 't');
});

test('a latched strobe is cut after strobeMaxLatchSec, by its timer or by the frame', (t) => {
  const { voices, strobe, advance, changes, playing, c } = bench(t, { acknowledged: true, capSec: 2 });
  strobe.on('latched');
  advance(1999);
  assert.deepEqual(playing(), [STROBE_VOICE_ID], 'a millisecond before the cap it plays');
  advance(1);
  assert.equal(voices.size, 0, 'cut at the cap');
  assert.deepEqual(changes.at(-1), [], 'the end is told, so the state broadcast shows it off');
  assert.deepEqual(strobe.status().active, null);

  // No timer run yet: the frame is the second check.
  strobe.on('latched');
  c.now += 2000;
  assert.deepEqual(playing(), [], 'gone from the frame at the cap');
  assert.equal(voices.size, 0);
});

test("strobe bursts expire at the requested milliseconds", (t) => {
  const { voices, strobe, advance, c, playing } = bench(t, { acknowledged: true });
  const v = strobe.burst(400);
  assert.deepEqual([v.id, v.mode, v.tier, v.untilMs], [STROBE_VOICE_ID, 'once', 'strobe', c.now + 400]);
  assert.equal(strobe.status().mode, 'once');
  advance(399);
  assert.deepEqual(playing(), [STROBE_VOICE_ID]);
  advance(1);
  assert.equal(voices.size, 0, 'ended by itself');
  strobe.off();
});

test("strobe bursts accept only bounded millisecond lengths", (t) => {
  const { voices, strobe, c } = bench(t, { acknowledged: true });
  for (const ms of [50, 99, 30001, 60001, 0, -1, NaN, Infinity, '400', undefined]) {
    assert.throws(() => strobe.burst(ms), refusedWith(400), String(ms));
  }
  assert.equal(voices.size, 0, 'nothing launched by a refused burst');
  assert.equal(strobe.burst(100).untilMs, c.now + 100, 'the bounds are in');
  assert.equal(strobe.burst(30000).untilMs, c.now + 30000);
  assert.equal(voices.size, 1);
  strobe.off();
});

test("strobe holds require renewal by their owner", (t) => {
  const { voices, strobe, advance, playing } = bench(t, { acknowledged: true });
  const v = strobe.hold('tablet', 't');
  assert.deepEqual([v.id, v.mode, v.tier, v.source, v.owner, v.untilMs], [STROBE_VOICE_ID, 'hold', 'strobe', 'strobe', 'tablet', null]);
  assert.equal(strobe.status().mode, 'hold');
  advance(HOLD_TIMEOUT_MS - 1);
  assert.deepEqual(playing(), [STROBE_VOICE_ID]);
  // The same press again renews it, not launched again.
  assert.equal(strobe.hold('tablet', 't').launchSeq, v.launchSeq);
  advance(HOLD_TIMEOUT_MS - 1);
  assert.deepEqual(playing(), [STROBE_VOICE_ID], 'renewed past its first lease');
  advance(1);
  assert.equal(voices.size, 0, 'unrenewed, it dies at its lease');

  strobe.hold('tablet', 't');
  strobe.release('phone', 't');
  strobe.release('tablet', 'u');
  assert.equal(voices.size, 1, 'another owner\'s or token\'s release is not this hold\'s');
  strobe.release('tablet', 't');
  assert.equal(voices.size, 0);

  // One voice at a time: a latch pressed over a hold replaces it; the hold's release then finds nothing.
  strobe.hold('tablet', 't');
  const latched = strobe.on('latched');
  assert.deepEqual(voices.list().map((x) => [x.id, x.mode]), [[STROBE_VOICE_ID, 'latched']]);
  strobe.release('tablet', 't');
  assert.equal(voices.get(STROBE_VOICE_ID).launchSeq, latched.launchSeq, 'the latch plays on');
  strobe.off();
});

test("strobe off revokes a hold token until release or lease expiry", (t) => {
  const { voices, strobe, advance, playing } = bench(t, { acknowledged: true });
  strobe.hold('tablet', 't');
  strobe.off();
  assert.equal(voices.size, 0);
  // The renewal path and a press-again both: nothing relaunches.
  assert.equal(voices.renew('tablet', 't'), false);
  assert.throws(() => strobe.hold('tablet', 't'), (err) => err.status === 409);
  advance(HOLD_TIMEOUT_MS / 2);
  assert.throws(() => strobe.hold('tablet', 't'), (err) => err.status === 409, 'still refused while it keeps renewing');
  assert.deepEqual(playing(), []);
  // A fresh press (a new token) is a new hold.
  assert.equal(strobe.hold('tablet', 'u').mode, 'hold');
  strobe.release('tablet', 'u');
  // Let go: the old token is fresh again.
  strobe.release('tablet', 't');
  assert.equal(strobe.hold('tablet', 't').mode, 'hold');
  strobe.off();
  // Gone quiet for a lease: fresh again too.
  advance(HOLD_TIMEOUT_MS);
  assert.equal(strobe.hold('tablet', 't').mode, 'hold');
  // Stop-all is the same for any hold.
  voices.stopAll();
  assert.throws(() => strobe.hold('tablet', 't'), (err) => err.status === 409);
});

test("strobe holds preserve the hidden latch deadline", (t) => {
  const { voices, strobe, advance } = bench(t, { acknowledged: true, capSec: 60 });
  const latch = strobe.on('latched');
  const deadline = latch.untilMs;
  advance(10000);
  strobe.hold('tablet', 't');
  assert.deepEqual(voices.list().map((x) => [x.id, x.mode]), [[STROBE_VOICE_ID, 'hold']]);
  assert.equal(strobe.status().mode, 'hold');
  strobe.release('tablet', 't');
  const back = voices.get(STROBE_VOICE_ID);
  assert.deepEqual([back.mode, Math.abs(back.untilMs - deadline) < 1e-6], ['latched', true], 'the latch, to its first deadline');
  assert.equal(strobe.status().mode, 'latched');

  // A hold that dies at its lease hands back the latch too.
  strobe.hold('tablet', 'u');
  advance(HOLD_TIMEOUT_MS);
  assert.equal(voices.get(STROBE_VOICE_ID).mode, 'latched');
  // Past the latch's deadline under a hold: nothing comes back.
  strobe.hold('tablet', 'v');
  for (let i = 0; i < 60; i++) { advance(1000); voices.renew('tablet', 'v'); }
  strobe.release('tablet', 'v');
  assert.equal(voices.size, 0, 'the cap ran out underneath');

  // Off ends the latch underneath with the hold.
  strobe.on('latched');
  strobe.hold('tablet', 'w');
  strobe.off();
  assert.equal(voices.size, 0);
  strobe.release('tablet', 'w');
  assert.equal(voices.size, 0, 'off took the latch underneath too');
});

/** A latch with a hold over it, then `stop`: nothing comes back, nor at the holder's release. */
function stoppedForGood(t, stop) {
  const { voices, strobe, advance } = bench(t, { acknowledged: true, capSec: 60 });
  strobe.on('latched');
  strobe.hold('tablet', 't');
  stop(voices);
  assert.equal(voices.size, 0, 'nothing comes back');
  advance(HOLD_TIMEOUT_MS);
  strobe.release('tablet', 't');
  assert.equal(voices.size, 0, 'nor at the holder\'s release');
}

test('stop-all ends a latch kept under a hold for good', (t) => {
  stoppedForGood(t, (voices) => voices.stopAll());
});

test('a stop by id ends a latch kept under a hold for good', (t) => {
  stoppedForGood(t, (voices) => voices.stop(STROBE_VOICE_ID));
});

test('a stop picking the hold ends the latch under it for good', (t) => {
  stoppedForGood(t, (voices) => voices.stopWhere((v) => v.mode === 'hold'));
});

test('the holder\'s page going hands back the latch kept under its hold', (t) => {
  const { voices, strobe } = bench(t, { acknowledged: true, capSec: 60 });
  strobe.on('latched');
  strobe.hold('tablet', 'u');
  voices.disconnect('tablet');
  assert.equal(voices.get(STROBE_VOICE_ID)?.mode, 'latched');
});

test('a hold plays on the fixtures it is given', (t) => {
  const { c, voices, strobe } = bench(t, { acknowledged: true });
  const v = strobe.hold('tablet', 't', { targets: [1, 2] });
  assert.deepEqual([v.id, v.tier, v.targets], [STROBE_VOICE_ID, 'strobe', [1, 2]]);
  assert.deepEqual(voices.frames(c.now).map((f) => [f.id, f.targets]), [[STROBE_VOICE_ID, [1, 2]]]);
});

test('a hold waits for the grid line it is given while the look plays', (t) => {
  const { c, strobe, advance, playing } = bench(t, { acknowledged: true });
  c.running = true;
  c.beat = 0.5;
  const v = strobe.hold('tablet', 't', { quantise: 1 });
  assert.equal(v.startedAtMs, c.now + 250, 'half a beat at 120 BPM');
  assert.deepEqual(playing(), []);
  advance(250);
  assert.deepEqual(playing(), [STROBE_VOICE_ID]);
});

test('a targeted hold pressed again renews it', (t) => {
  const { strobe } = bench(t, { acknowledged: true });
  const v = strobe.hold('tablet', 't', { targets: [1, 2], quantise: 1 });
  assert.equal(strobe.hold('tablet', 't', { targets: [1, 2], quantise: 1 }).launchSeq, v.launchSeq);
});

test('a hold given no launch plays on the whole rig at once', (t) => {
  const { c, strobe } = bench(t, { acknowledged: true });
  c.running = true;
  c.beat = 0.5;
  const v = strobe.hold('tablet', 't');
  assert.deepEqual([v.targets, v.startedAtMs], [null, c.now]);
});

test('a quantised hold over a latch starts at once', (t) => {
  const { c, strobe, playing } = bench(t, { acknowledged: true });
  c.running = true;
  c.beat = 0.5;
  strobe.on('latched');
  const v = strobe.hold('tablet', 't', { quantise: 1 });
  assert.equal(v.startedAtMs, c.now);
  assert.deepEqual(playing(), [STROBE_VOICE_ID]);
});

test("strobe settings persist valid edits", (t) => {
  const { strobe, settings } = bench(t, { acknowledged: true });
  const next = strobe.update({ flashesPerSecond: 5, palette: ['#ff0000', '#0000FF'], clock: 'wall', continueBetween: false, brightness: 0.5 });
  assert.deepEqual(next, { ...STROBE_DEFAULTS, flashesPerSecond: 5, palette: ['#ff0000', '#0000FF'], clock: 'wall', continueBetween: false, brightness: 0.5 });
  assert.deepEqual(settings.group('strobe'), next, 'saved');
  assert.deepEqual(strobe.status().settings, next);
  assert.equal(strobe.update({ flashesPerSecond: 1 }).palette.length, 2);
  assert.equal(strobe.update({}).flashesPerSecond, 1, 'nothing to change is fine');
});

test("strobe settings reject invalid edits without mutation", (t) => {
  const { strobe, values } = bench(t, { acknowledged: true });
  const before = structuredClone(values.strobe);
  const bad = [
    { flashesPerSecond: 0 }, { flashesPerSecond: 6 }, { flashesPerSecond: 2.5 }, { flashesPerSecond: '2' },
    { palette: [] }, { palette: ['#000000', '#111111', '#222222', '#333333', '#444444', '#555555', '#666666'] }, { palette: ['red'] }, { palette: '#FFFFFF' },
    { clock: 'tempo' }, { continueBetween: 'yes' }, { brightness: 2 }, { brightness: -0.1 }, { onMs: 80 }, { blackMs: 50 },
    { colour: '#FFFFFF' }, { palette: ['#FFFFFF'], fps: 2 }, null, 'fast', 3,
  ];
  for (const params of bad) assert.throws(() => strobe.update(params), refusedWith(400), JSON.stringify(params));
  assert.deepEqual(values.strobe, before, 'a refused update changes nothing');
});

test("strobe setting edits preserve the latched launch", (t) => {
  const { voices, strobe, settings, values, advance } = bench(t, { acknowledged: true });
  const v = strobe.on('latched');
  advance(500);
  const edited = strobe.update({ flashesPerSecond: 3, palette: ['#00FF00'] });
  const now = voices.get(STROBE_VOICE_ID);
  assert.deepEqual([now.launchSeq, now.startedAtMs, now.seed, now.untilMs], [v.launchSeq, v.startedAtMs, v.seed, v.untilMs]);
  assert.equal(now.spec.params.flashesPerSecond, 3);
  assert.deepEqual(now.spec.palette, ['#00FF00']);
  assert.deepEqual(voices.frames(1500)[0].spec.palette, ['#00FF00'], 'the next frame flashes the new colour');
  assert.deepEqual(strobe.status().settings, edited);
  settings.update({ strobe: { ...values.strobe, palette: ['#0000FF'], flashesPerSecond: 4 } });
  assert.deepEqual([voices.get(STROBE_VOICE_ID).spec.palette, voices.get(STROBE_VOICE_ID).spec.params.flashesPerSecond], [['#0000FF'], 4]);
  assert.equal(voices.get(STROBE_VOICE_ID).launchSeq, v.launchSeq);
  strobe.off();
});

test("strobe setting edits preserve the hold lease", (t) => {
  const { voices, strobe, advance, c } = bench(t, { acknowledged: true });
  const held = strobe.hold('tablet', 't');
  advance(600);
  strobe.update({ flashesPerSecond: 2 });
  assert.equal(voices.frames(c.now)[0].untilMs, held.startedAtMs + HOLD_TIMEOUT_MS, 'its lease from the press, untouched by the edit');
  assert.equal(strobe.hold('tablet', 't').launchSeq, held.launchSeq, 'renewed, not launched again');
  advance(HOLD_TIMEOUT_MS);
  assert.equal(voices.size, 0);
});

test("strobe latch caps can shorten a running lifetime", (t) => {
  const { voices, strobe, settings, advance, c } = bench(t, { acknowledged: true, capSec: 60 });
  const own = strobe.on('latched');
  // An API or pad latch of the strobe kind names no cap of its own and gets the configured one; another kind does not.
  const api = voices.start({ spec: { kind: 'strobe' }, targets: 'shared', mode: 'latched', tier: 'voice', source: 'api' });
  const fade = voices.start({ spec: { kind: 'ldj.FadeCycle', params: { cadence: 2 } }, targets: 'shared', mode: 'latched', tier: 'voice', source: 'api' });
  assert.deepEqual([own.untilMs, api.untilMs, fade.untilMs], [c.now + 60_000, c.now + 60_000, null]);

  settings.update({ safety: { strobeMaxLatchSec: 10 } });
  assert.deepEqual([voices.get(own.id).untilMs, voices.get(api.id).untilMs, voices.get(fade.id).untilMs], [c.now + 10_000, c.now + 10_000, null], 'clipped');
  assert.equal(voices.get(own.id).launchSeq, own.launchSeq, 'the same launch');
  settings.update({ safety: { strobeMaxLatchSec: 100 } });
  assert.equal(voices.get(own.id).untilMs, c.now + 10_000, 'raised: the deadline stands');
  advance(9_999);
  assert.equal(voices.size, 3);
  advance(1);
  assert.deepEqual(voices.list().map((v) => v.id), [fade.id], 'both strobes cut at the clipped cap');

  // Lowered below what has already run: ends now.
  const again = strobe.on('latched');
  advance(5_000);
  settings.update({ safety: { strobeMaxLatchSec: 2 } });
  assert.equal(voices.get(again.id), null, 'past the new cap already: ended at once');
  assert.deepEqual(strobe.status().active, null);
  voices.stopAll();
});

test("strobe launches require acknowledgement", (t) => {
  const { voices, strobe, c } = bench(t, { acknowledged: false });
  assert.throws(() => strobe.on('latched'), refused409);
  assert.throws(() => strobe.burst(400), refused409);
  assert.throws(() => strobe.hold('tablet', 't'), refused409);
  assert.equal(voices.size, 0, 'nothing launched');
  assert.deepEqual(strobe.status().active, null);
  strobe.off();
  strobe.release('tablet', 't');

  c.acknowledged = true;
  assert.equal(strobe.on('latched').mode, 'latched');
  assert.equal(strobe.burst(400).mode, 'once');
  assert.equal(strobe.hold('tablet', 't').mode, 'hold');
  assert.equal(voices.size, 1, 'one voice at a time');
  strobe.off();
});

test("strobe off stops all strobe-kind voices", (t) => {
  const { voices, strobe } = bench(t, { acknowledged: true });
  strobe.on('latched');
  const api = voices.start({ spec: { kind: 'strobe' }, targets: 'shared', mode: 'latched', tier: 'voice', source: 'api' });
  const hidden = voices.start({ spec: { kind: 'strobe', palette: null }, targets: 'shared', mode: 'latched', tier: 'strobe', source: 'energy', id: 'energy:palette-strobe', hidden: true });
  const fast = voices.start({ spec: { kind: 'ldj.StrobeCycle', params: { cadence: 0.25 } }, targets: 'shared', mode: 'latched', tier: 'voice', source: 'api' });
  assert.equal(voices.size, 4);
  assert.ok(api.id && hidden.hidden);
  strobe.off();
  assert.deepEqual(voices.list().map((v) => v.id), [fast.id]);
  voices.stopAll();
});

// ── Served ──────────────────────────────────────────────────────────────────

/**
 * The routes and the sockets on stand-in sources, a library of their own in
 * a throwaway directory, the real applier, and settings in memory,
 * unacknowledged: nothing written to the operator's config/.
 */
async function serve(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strobe-routes-'));
  const effectLibrary = new EffectLibrary(path.join(dir, 'effects.json')).load();
  const paletteStore = new PaletteStore(path.join(dir, 'palettes.json')).load();
  const padStore = new PadStore(path.join(dir, 'pads.json')).load();
  const idle = { onPlaybackUpdate() {}, onTrackChange() {}, getStatus: () => ({}), authenticated: false };
  const autoShow = {
    running: false, track: null, syncOffsetMs: 0, autoSyncMs: 0, analysis: null,
    getPositionMs: () => 0, getClientState: () => ({}), start() {}, stop() {},
    isCached: () => false, gridFor: () => null, isPrefetching: () => false,
    applyQueueOrder() {}, setPaletteSize() {}, setIntensity() {}, setSyncOffsetMs() {}, adjustAutoSync() {},
  };
  const prolink = {
    connected: false, stale: false, lastError: null, getNumPeers: () => 0, getFollowed: () => null, getTrack: () => null,
    getLoadedTracks: () => [], getTempo: () => 0, getPositionMs: () => 0,
    onTempoChange() {}, onPeersChange() {}, onFollowChange() {}, onTrackChange() {}, onLoadedTracksChange() {}, onAnyTrackLoaded() {},
  };
  const midi = { enabled: false, sendFeedback() {}, listPorts: () => [], onLearn() {}, close() {}, connect() { return true; }, setControlFeedback() {} };
  const values = settings._values;
  const ownSave = Object.hasOwn(settings, 'save') ? settings.save : null;
  settings._values = {
    ...values,
    safety: { ...values.safety, photosensitivityAcknowledged: false, strobeMaxLatchSec: 60 },
    strobe: { ...STROBE_DEFAULTS, palette: [...WHITE] },
    outputs: { ...values.outputs, armed: false },
  };
  settings.save = () => {};
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  const io = new Server(server);
  const integrations = setupIntegrations({
    io, midi,
    spotify: { ...idle, startPolling() {}, async getQueue() { return []; } },
    nowPlaying: idle,
    deezerSource: { ...idle, getQueue: () => [], updatePlayback() {}, updateQueue() {}, disconnect() {} },
    prolink, autoShow, effectLibrary, paletteStore, padStore,
  });
  const applier = createApplier({
    midi, spotify: { localCallbackUrl: '', setLoopbackPort() {}, configure() {} }, smtc: { start() {}, stop() {} },
    deezer: { init: async () => {} }, applyPatch, broadcast: () => integrations.broadcast(),
  });
  attachRoutes(app, { integrations, applier });
  attachSockets(io, { midi, integrations });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const look = { pattern: state.pattern, running: state.running };
  t.after(async () => {
    voices.stopAll();
    applyPatch({ ...look, energyOverride: null, masterBlackout: false });
    output.setArmed(false);
    settings._values = values;
    if (ownSave) settings.save = ownSave;
    else delete settings.save;
    io.close();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = (method, route, body) => fetch(`${url}${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  /** A page on protocol 2, with what it hears. */
  const page = async () => {
    const socket = connect(url, { auth: { protocol: 2 }, transports: ['websocket'], reconnection: false });
    t.after(() => socket.close());
    const heard = { patches: [], errors: [] };
    socket.on('patch', (p) => heard.patches.push(p));
    socket.on('error-msg', (e) => heard.errors.push(e));
    heard.snapshot = await new Promise((resolve) => socket.once('snapshot', resolve));
    return { socket, heard };
  };
  return { call, page, integrations, applier, url };
}

const ids = () => voices.list().map((v) => v.id);
const playing = () => renderInput().voices.map((v) => v.id);
/** A fixture's colour channels and dimmer on the rig, the first one's by default. */
const lamp = (i = 0) => {
  const fixture = state.fixtures[i];
  const dmx = universes.getBuffer(fixture.universe ?? state.artnet.universe);
  const { channelMap: ch } = getProfile(fixture);
  const base = fixture.address - 1;
  return { r: dmx[base + ch.red], g: dmx[base + ch.green], b: dmx[base + ch.blue], dim: dmx[base + ch.dimmer] };
};
/** Render frames for up to `ms`, until the rig shows what `found` asks for. */
async function flashes(found, what, ms = 2000) {
  const deadline = Date.now() + ms;
  for (;;) {
    renderFrame();
    if (found(lamp())) return;
    if (Date.now() > deadline) assert.fail(`no ${what}`);
    await wait(10);
  }
}
// A voice's length on the engine's own clock, whose times are fractions of a millisecond: to the microsecond.
const capOf = (v) => Math.round((v.untilMs - v.startedAtMs) * 1000) / 1000;

test("strobe defaults are published in live state", async (t) => {
  const s = await serve(t);
  const defaults = { ...STROBE_DEFAULTS, palette: WHITE };
  assert.deepEqual(await s.call('GET', '/api/strobe'), { status: 200, body: { ok: true, active: null, mode: null, settings: defaults } });
  assert.equal(domainOf('strobe'), 'look');
  assert.deepEqual(getLiveState().strobe, { active: null, mode: null, settings: defaults });
  const { heard } = await s.page();
  assert.deepEqual(heard.snapshot.state.strobe, { active: null, mode: null, settings: defaults });
});

test("strobe routes reject unacknowledged launches", async (t) => {
  const s = await serve(t);
  const defaults = { ...STROBE_DEFAULTS, palette: WHITE };
  for (const route of ['/api/strobe/on', '/api/strobe/burst/400']) {
    const res = await s.call('POST', route);
    assert.deepEqual([res.status, res.body.ok, typeof res.body.error], [409, false, 'string'], route);
  }
  assert.deepEqual(await s.call('POST', '/api/strobe/off'), { status: 200, body: { ok: true, active: null, mode: null, settings: defaults } });
  assert.deepEqual(ids(), []);
});

test("strobe latch routes publish on and off", async (t) => {
  const s = await serve(t);
  const { heard } = await s.page();
  await s.call('POST', '/api/safety/acknowledge');
  let res = await s.call('POST', '/api/strobe/on');
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.ok, res.body.active.id, res.body.active.mode, res.body.mode], [true, STROBE_VOICE_ID, 'latched', 'latched']);
  assert.equal(res.body.active.until - res.body.active.startedAt, 60_000, 'the cap');
  const [listed] = (await s.call('GET', '/api/voices')).body.voices;
  assert.deepEqual([listed.id, listed.source, listed.tier, listed.mode, listed.kind, listed.label], [STROBE_VOICE_ID, 'strobe', 'strobe', 'latched', 'strobe', 'Strobe']);
  assert.deepEqual(playing(), [STROBE_VOICE_ID]);
  const live = (await s.call('GET', '/api/state')).body;
  const { ok: _ok, ...status } = (await s.call('GET', '/api/strobe')).body;
  assert.deepEqual(live.strobe, status, 'GET /api/state carries what GET /api/strobe answers');
  await until(() => heard.patches.some((p) => p.d === 'look' && p.set.strobe?.active?.id === STROBE_VOICE_ID), 'the page hearing the strobe on');
  res = await s.call('POST', '/api/strobe/off');
  assert.deepEqual([res.status, res.body.active, res.body.mode], [200, null, null]);
  assert.deepEqual(ids(), []);
  await until(() => heard.patches.some((p) => p.d === 'look' && p.set.strobe && p.set.strobe.active === null), 'the page hearing it off');
});

test("strobe burst routes enforce bounded lifetimes", async (t) => {
  const s = await serve(t);
  await s.call('POST', '/api/safety/acknowledge');
  let res;
  for (const ms of ['50', '60001', '0', 'abc', '1e9', '-400']) {
    res = await s.call('POST', `/api/strobe/burst/${ms}`);
    assert.equal(res.status, 400, ms);
    assert.equal(res.body.ok, false);
  }
  assert.deepEqual(ids(), []);
  res = await s.call('POST', '/api/strobe/burst/150');
  assert.deepEqual([res.status, res.body.mode, res.body.active.until - res.body.active.startedAt], [200, 'once', 150]);
  await until(() => !ids().length, 'the burst ending by itself', 2000);
});

test("strobe setting routes validate and publish edits", async (t) => {
  const s = await serve(t);
  const defaults = { ...STROBE_DEFAULTS, palette: WHITE };
  const { heard } = await s.page();
  await s.call('POST', '/api/safety/acknowledge');
  let res;
  for (const body of [{ flashesPerSecond: 6 }, { palette: ['bad'] }, { palette: [] }, { clock: 'tempo' }, { brightness: 2 }, { onMs: 80 }, { fps: 2 }]) {
    res = await s.call('PUT', '/api/strobe', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.ok, false);
  }
  assert.deepEqual(settings.group('strobe'), defaults, 'refused: nothing saved');
  res = await s.call('PUT', '/api/strobe', { flashesPerSecond: 4, palette: ['#ff0000', '#00FF00'] });
  const wanted = { ...defaults, flashesPerSecond: 4, palette: ['#ff0000', '#00FF00'] };
  assert.deepEqual(res, { status: 200, body: { ok: true, active: null, mode: null, settings: wanted } });
  assert.deepEqual(settings.group('strobe'), wanted, 'saved');
  assert.deepEqual((await s.call('GET', '/api/state')).body.strobe.settings, wanted);
  await until(() => heard.patches.some((p) => p.d === 'look' && p.set.strobe?.settings?.flashesPerSecond === 4), 'the page hearing the settings');
  await s.call('POST', '/api/strobe/on');
  assert.deepEqual([voices.get(STROBE_VOICE_ID).spec.palette, voices.get(STROBE_VOICE_ID).spec.params.flashesPerSecond], [['#ff0000', '#00FF00'], 4]);
  await s.call('POST', '/api/strobe/off');
});

test("palette edits reach the next latched strobe flash", async (t) => {
  const s = await serve(t);
  await s.call('POST', '/api/safety/acknowledge');
  applyPatch({ pattern: 'solid', colorA: 0, running: true, masterDimmer: 255, masterBlackout: false, paletteOverride: null });
  renderFrame();
  assert.deepEqual([lamp().r, lamp().b], [255, 0], 'the look: red');
  await s.call('POST', '/api/strobe/on');
  await flashes((l) => l.r === 255 && l.g === 255 && l.b === 255, 'a white flash');
  const { launchSeq } = voices.get(STROBE_VOICE_ID);
  assert.equal((await s.call('PUT', '/api/strobe', { palette: ['#0000FF'] })).status, 200);
  assert.equal(voices.get(STROBE_VOICE_ID).launchSeq, launchSeq, 'the same launch');
  await flashes((l) => l.r === 0 && l.g === 0 && l.b === 255 && l.dim === 255, 'a blue flash');
  await s.call('POST', '/api/strobe/off');
});

test("energy strobe routes require acknowledgement", async (t) => {
  const s = await serve(t);
  const res = await s.call('POST', '/api/energy/palette-strobe');
  assert.deepEqual([res.status, res.body.ok, typeof res.body.error], [409, false, 'string']);
  assert.deepEqual([ids(), state.energyOverride], [[], null]);
});

test("energy strobe endpoints share the manual off control", async (t) => {
  const s = await serve(t);
  await s.call('POST', '/api/safety/acknowledge');
  let res;
  res = await s.call('POST', '/api/energy/palette-strobe');
  assert.deepEqual([res.status, res.body], [200, { ok: true, energyOverride: 'palette-strobe' }]);
  const [legacy] = (await s.call('GET', '/api/voices')).body.voices;
  assert.deepEqual([legacy.id, legacy.source, legacy.tier, legacy.mode, legacy.kind], ['energy:palette-strobe', 'energy', 'strobe', 'latched', 'strobe']);
  assert.equal(legacy.until - legacy.startedAt, 60_000, 'the cap applies to the energy endpoints\' strobe too');
  res = await s.call('GET', '/api/strobe');
  assert.deepEqual([res.body.active?.id, res.body.mode], ['energy:palette-strobe', 'latched'], 'it is the strobe, in its beat clock');
  assert.equal(state.energyOverride, 'palette-strobe');
  assert.deepEqual(await s.call('POST', '/api/energy/off'), { status: 200, body: { ok: true, energyOverride: null } });
  assert.deepEqual([ids(), state.energyOverride, (await s.call('GET', '/api/strobe')).body.active], [[], null, null]);
  await s.call('POST', '/api/energy/palette-strobe');
  assert.deepEqual(ids(), ['energy:palette-strobe']);
  assert.equal((await s.call('POST', '/api/strobe/off')).status, 200);
  assert.deepEqual([ids(), state.energyOverride], [[], null], 'the strobe\'s off ends the energy endpoints\' strobe as well');
});

test("energy and manual strobes replace each other", async (t) => {
  const s = await serve(t);
  await s.call('POST', '/api/safety/acknowledge');
  await s.call('POST', '/api/energy/palette-strobe');
  const res = await s.call('POST', '/api/strobe/burst/5000');
  assert.deepEqual([ids(), state.energyOverride, res.body.active.id], [[STROBE_VOICE_ID], null, STROBE_VOICE_ID]);
  await s.call('POST', '/api/energy/palette-strobe');
  assert.deepEqual([ids(), state.energyOverride], [['energy:palette-strobe'], 'palette-strobe']);
  await s.call('POST', '/api/strobe/on');
  assert.deepEqual([ids(), state.energyOverride], [[STROBE_VOICE_ID], null]);
  await s.call('POST', '/api/energy/off');
});

test("energy clears distinguish operator off from automatic patches", async (t) => {
  const s = await serve(t);
  await s.call('POST', '/api/safety/acknowledge');
  await s.call('POST', '/api/strobe/on');
  await s.call('POST', '/api/energy/blinder');
  assert.deepEqual(ids().sort(), ['energy:blinder', STROBE_VOICE_ID], 'an energy effect latched under the strobe leaves it');
  applyPatch({ pattern: 'chase', colorA: 2, energyOverride: null, showDynamics: null });
  assert.deepEqual([ids(), state.energyOverride], [[STROBE_VOICE_ID], null], 'a scene clearing the energy: the blinder goes, the strobe stays');
  const { socket } = await s.page();
  await s.call('POST', '/api/energy/blinder');
  socket.emit('set', { energyOverride: null });
  await until(() => state.energyOverride === null, 'the page\'s patch');
  assert.deepEqual(ids(), [STROBE_VOICE_ID], 'a page or a controller clearing the energy leaves it too');
  await s.call('POST', '/api/energy/blinder');
  await s.call('POST', '/api/energy/off');
  assert.deepEqual(ids(), []);
});

test("energy off preserves a held manual strobe", async (t) => {
  const s = await serve(t);
  await s.call('POST', '/api/safety/acknowledge');
  liveStrobe.hold('tablet', 't');
  await s.call('POST', '/api/energy/off');
  assert.deepEqual(ids(), [STROBE_VOICE_ID], 'held: not the latch\'s off to end');
  liveStrobe.release('tablet', 't');
  assert.deepEqual(ids(), []);
});

test("cue recall preserves the current strobe state", async (t) => {
  const s = await serve(t);
  await s.call('POST', '/api/safety/acknowledge');
  applyPatch({ pattern: 'solid', colorA: 0, running: true, masterDimmer: 255, masterBlackout: false });
  await s.call('POST', '/api/strobe/on');
  const look = captureLook();
  assert.equal(look.energyOverride, null, 'the strobe is not part of a look');
  assert.deepEqual(look.strobe, settings.group('strobe'), 'its settings are');
  assert.deepEqual(ids(), [STROBE_VOICE_ID], 'capturing changes nothing');

  // Recalled with no strobe running: a cue saved with palette-strobe starts none.
  await s.call('POST', '/api/strobe/off');
  recallLook({ ...look, pattern: 'chase', energyOverride: 'palette-strobe' });
  assert.deepEqual([state.pattern, ids(), state.energyOverride], ['chase', [], null], 'recalled: no strobe starts');
  // Recalled over the operator's latch: it plays on under every shape of cue, its launch untouched.
  await s.call('POST', '/api/strobe/on');
  const { launchSeq } = voices.get(STROBE_VOICE_ID);
  recallLook({ ...look, pattern: 'solid' });
  assert.deepEqual([ids(), state.energyOverride], [[STROBE_VOICE_ID], null], 'a cue with no energy');
  recallLook({ ...look, pattern: 'chase', energyOverride: 'palette-strobe' });
  assert.deepEqual([ids(), state.energyOverride], [[STROBE_VOICE_ID], null], 'a cue saved with the strobe latched');
  recallLook({ ...look, pattern: 'solid', energyOverride: 'blinder' });
  assert.deepEqual([ids().sort(), state.energyOverride], [['energy:blinder', STROBE_VOICE_ID], 'blinder'], 'a cue with an energy effect');
  recallLook({ ...look, pattern: 'chase' });
  assert.deepEqual([ids(), state.energyOverride], [[STROBE_VOICE_ID], null], 'and the next cue takes that energy off, not the strobe');
  assert.equal(voices.get(STROBE_VOICE_ID).launchSeq, launchSeq, 'the same launch throughout');
  await s.call('POST', '/api/strobe/off');
  // A hold is the hand's, not the look's.
  liveStrobe.hold('tablet', 't');
  recallLook({ ...look, pattern: 'solid' });
  assert.deepEqual(ids(), [STROBE_VOICE_ID]);
  liveStrobe.release('tablet', 't');
});

test("strobe pads and voice holds use the strobe lifecycle", async (t) => {
  const s = await serve(t);
  const { socket, heard } = await s.page();
  socket.emit('voice-hold', { action: 'press', token: 'p', pad: { bank: 0, slot: 6 } });
  socket.emit('voice-hold', { action: 'press', token: 'q', effect: { preset: 'strobe' } });
  await until(() => heard.errors.length === 2, 'both refused');
  assert.ok(heard.errors.every((e) => typeof e.message === 'string' && e.message.length > 0));
  assert.deepEqual(heard.errors.map((e) => [e.source, e.token]).sort(), [['voice-hold', 'p'], ['voice-hold', 'q']], 'each refusal names its press');
  assert.deepEqual(ids(), []);

  await s.call('POST', '/api/safety/acknowledge');
  socket.emit('voice-hold', { action: 'press', token: 'p', pad: { bank: 0, slot: 6 } });
  await until(() => ids().length === 1, 'the pad held');
  let [held] = voices.list();
  assert.deepEqual([held.id, held.source, held.tier, held.mode, held.kind], [STROBE_VOICE_ID, 'strobe', 'strobe', 'hold', 'strobe']);
  assert.equal(voices.get(STROBE_VOICE_ID).owner, socket.id, 'leased to the page');
  assert.equal(s.integrations.pads.lit()[6], STROBE_VOICE_ID, 'the pad lights');
  assert.deepEqual([(await s.call('GET', '/api/strobe')).body.mode, (await s.call('GET', '/api/state')).body.pads.lit[6]], ['hold', STROBE_VOICE_ID]);
  socket.emit('voice-hold', { action: 'release', token: 'p', pad: { bank: 0, slot: 6 } });
  await until(() => !ids().length, 'the pad released');
  assert.equal(s.integrations.pads.lit()[6], null);

  socket.emit('voice-hold', { action: 'press', token: 'q', effect: { preset: 'strobe' } });
  await until(() => ids().length === 1, 'the preset held');
  [held] = voices.list();
  assert.deepEqual([held.id, held.source, held.mode], [STROBE_VOICE_ID, 'strobe', 'hold']);
  for (let i = 0; i < 5; i++) {
    await wait(300);
    socket.emit('voice-hold', { action: 'renew', token: 'q' });
  }
  assert.deepEqual(ids(), [STROBE_VOICE_ID], `renewed past ${HOLD_TIMEOUT_MS} ms`);
  socket.emit('voice-hold', { action: 'release', token: 'q' });
  await until(() => !ids().length, 'the release with no pad named');

  // Over REST: the pad's own owner and token.
  let res = await s.call('POST', '/api/pads/0/6/press');
  assert.deepEqual([res.status, res.body.id], [200, STROBE_VOICE_ID]);
  assert.equal((await s.call('GET', '/api/strobe')).body.mode, 'hold');
  res = await s.call('POST', '/api/pads/0/6/release');
  assert.deepEqual([res.status, res.body.released, ids()], [200, true, []]);

  // A page that goes takes its hold with it, before its lease could end.
  socket.emit('voice-hold', { action: 'press', token: 'r', pad: { bank: 0, slot: 6 } });
  await until(() => ids().length === 1, 'held again');
  socket.close();
  await until(() => !ids().length, 'the hold gone with its page', HOLD_TIMEOUT_MS / 2);
});

test("API and pad strobe latches use the configured cap", async (t) => {
  const s = await serve(t);
  await s.call('POST', '/api/safety/acknowledge');
  let res = await s.call('POST', '/api/voices', { preset: 'palette-strobe', mode: 'latched' });
  assert.equal(res.status, 200);
  const api = voices.get(res.body.id);
  assert.equal(capOf(api), 60_000);
  res = await s.call('POST', '/api/voices', { effect: { kind: 'ldj.FadeCycle', params: { cadence: 2 } }, mode: 'latched' });
  assert.equal(voices.get(res.body.id).untilMs, null, 'another kind: no cap of the strobe\'s');
  const pad = { label: 'Loop', accent: '#A855F7', content: { kind: 'preset', id: 'palette-strobe' }, launch: 'loop', quantise: 0, targets: 'shared' };
  assert.equal((await s.call('PUT', '/api/pads/1/3', pad)).status, 200);
  res = await s.call('POST', '/api/pads/1/3/toggle');
  const loop = voices.get(res.body.id);
  assert.equal(capOf(loop), 60_000);
  assert.equal((await s.call('POST', '/api/strobe/off')).status, 200);
  assert.deepEqual(voices.list().map((v) => v.kind), ['ldj.FadeCycle'], 'the strobe\'s off took every strobe-kind voice');
  await s.call('DELETE', '/api/voices');
});

test("strobe pads reject once and toggle launches", async (t) => {
  const s = await serve(t);
  await s.call('POST', '/api/safety/acknowledge');
  for (const route of ['/api/pads/0/6/once', '/api/pads/0/6/toggle']) {
    const res = await s.call('POST', route);
    assert.deepEqual([res.status, res.body.ok], [409, false], route);
  }
});

async function acknowledged(t) {
  const s = await serve(t);
  await s.call('POST', '/api/safety/acknowledge');
  return s;
}

/** The strobe latched and the strobe pad held over it. */
async function holdOverLatch(s) {
  await s.call('POST', '/api/strobe/on');
  const res = await s.call('POST', '/api/pads/0/6/press');
  assert.deepEqual([res.status, voices.get(STROBE_VOICE_ID)?.mode], [200, 'hold']);
  return s;
}

/** Nothing plays, nor once the pad is let go. */
async function gone(s) {
  assert.deepEqual([ids(), playing()], [[], []]);
  await s.call('POST', '/api/pads/0/6/release');
  assert.deepEqual(ids(), [], 'nor after the pad\'s release');
  assert.equal((await s.call('GET', '/api/strobe')).body.active, null);
}

test('DELETE /api/voices ends a latch kept under a strobe hold', async (t) => {
  const s = await holdOverLatch(await acknowledged(t));
  assert.deepEqual((await s.call('DELETE', '/api/voices')).body, { ok: true, stopped: 1 });
  await gone(s);
});

test('DELETE /api/voices/strobe ends a latch kept under a strobe hold', async (t) => {
  const s = await holdOverLatch(await acknowledged(t));
  assert.equal((await s.call('DELETE', '/api/voices/strobe')).status, 200);
  await gone(s);
});

test('a disarm with the outputs off ends a latch kept under a strobe hold', async (t) => {
  const s = await holdOverLatch(await acknowledged(t));
  assert.deepEqual((await s.call('POST', '/api/outputs/disarm')).body, { ok: true, armed: false });
  await gone(s);
});

test('a disarm saved from armed ends a latch kept under a strobe hold', async (t) => {
  const s = await acknowledged(t);
  await s.call('POST', '/api/outputs/arm');
  await holdOverLatch(s);
  s.applier.applyChanged(settings.update({ outputs: { armed: false } }));
  await gone(s);
});

test('POST /api/outputs/disarm from armed ends a latch kept under a strobe hold', async (t) => {
  const s = await acknowledged(t);
  await s.call('POST', '/api/outputs/arm');
  await holdOverLatch(s);
  await s.call('POST', '/api/outputs/disarm');
  await gone(s);
});

test('a latched palette strobe replaces a latch kept under a strobe hold', async (t) => {
  const s = await holdOverLatch(await acknowledged(t));
  await s.call('POST', '/api/energy/palette-strobe');
  await s.call('POST', '/api/pads/0/6/release');
  assert.deepEqual([ids(), state.energyOverride], [['energy:palette-strobe'], 'palette-strobe']);
  await s.call('POST', '/api/energy/off');
});

test('the strobe pad plays on its own fixtures and leaves the rest to the look', async (t) => {
  const s = await acknowledged(t);
  const [first] = state.fixtures.map((f) => f.id);
  applyPatch({ pattern: 'solid', colorA: 0, running: true, masterDimmer: 255, masterBlackout: false, paletteOverride: null });
  await s.call('PUT', '/api/strobe', { palette: ['#0000FF'], flashesPerSecond: 5 });
  renderFrame();
  assert.deepEqual([lamp(0).r, lamp(1).r], [255, 255], 'the look: red');
  const entry = { label: 'Strobe', accent: '#E2E8F0', content: { kind: 'strobe', id: 'strobe' }, launch: 'hold', quantise: 0, targets: [first] };
  assert.equal((await s.call('PUT', '/api/pads/0/6', entry)).status, 200);
  await s.call('POST', '/api/pads/0/6/press');
  assert.deepEqual(renderInput().voices.map((v) => [v.id, v.targets]), [[STROBE_VOICE_ID, [first]]]);
  let elsewhere = false;
  await flashes((l) => {
    if (lamp(1).b !== 0) elsewhere = true;
    return l.r === 0 && l.b === 255;
  }, 'a blue flash on the pad\'s fixture');
  assert.equal(elsewhere, false, 'the other fixtures keep the look');
  await s.call('POST', '/api/pads/0/6/release');
});

test('voice-hold { preset: "strobe" } plays on the fixtures it names', async (t) => {
  const s = await acknowledged(t);
  const [, second, third] = state.fixtures.map((f) => f.id);
  const { socket } = await s.page();
  socket.emit('voice-hold', { action: 'press', token: 'q', effect: { preset: 'strobe' }, targets: [second, third] });
  await until(() => ids().length === 1, 'the preset held');
  assert.deepEqual(voices.get(STROBE_VOICE_ID).targets, [second, third]);
  socket.emit('voice-hold', { action: 'release', token: 'q' });
  await until(() => !ids().length, 'released');
});

test('voice-hold { preset: "strobe" } on an unknown fixture is refused', async (t) => {
  const s = await acknowledged(t);
  const { socket, heard } = await s.page();
  socket.emit('voice-hold', { action: 'press', token: 'r', effect: { preset: 'strobe' }, targets: [9999] });
  await until(() => heard.errors.length === 1, 'an unknown fixture refused');
  assert.deepEqual([heard.errors[0].token, ids()], ['r', []]);
});
