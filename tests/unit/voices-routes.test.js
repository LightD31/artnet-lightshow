// The voices from outside (src/server/routes/voices.ts, sockets.ts): the
// energy endpoints and the energy hold as they have always been asked for,
// POST /api/voices, the voice hold over a socket, a disarm. Then the voices
// at work: the live state, the renderer's input on either thread, the free
// clock and the audio detectors.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';

import { attachRoutes } from '../../src/server/routes.ts';
import { setupIntegrations } from '../../src/server/integrations.ts';
import { attachSockets } from '../../src/server/sockets.ts';
import { createApplier } from '../../src/server/apply.ts';
import { EffectLibrary } from '../../src/server/effect-library.ts';
import { PaletteStore } from '../../src/server/palette-store.ts';
import { startEngine, stopEngine, renderInput, renderFrame, engineStatus } from '../../src/server/engine.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { captureLook } from '../../src/server/cues.ts';
import { state, voices, freeClockRuns } from '../../src/server/state.ts';
import { conductor } from '../../src/server/conductor.ts';
import { domainOf } from '../../src/server/protocol.ts';
import { settings } from '../../src/server/settings.ts';
import * as output from '../../src/server/output.ts';
import * as universes from '../../src/server/universes.ts';
import { showStore } from '../../src/server/show-store.ts';
import { HOLD_TIMEOUT_MS } from '../../src/server/voices.ts';
import { getProfile } from '../../src/server/profiles.ts';

showStore.scheduleSave = () => {};   // never the real show file

test.after(() => stopEngine());

const FADE = { kind: 'ldj.FadeCycle', params: { cadence: 2 } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * The routes and the sockets on stand-in sources, a library of their own in
 * a throwaway directory, the real applier, and settings in memory,
 * unacknowledged: nothing written to the operator's config/.
 */
async function serve(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voices-routes-'));
  const effectLibrary = new EffectLibrary(path.join(dir, 'effects.json')).load();
  const paletteStore = new PaletteStore(path.join(dir, 'palettes.json')).load();
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
  settings._values = { ...values, safety: { ...values.safety, photosensitivityAcknowledged: false }, outputs: { ...values.outputs, armed: false } };
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
    prolink, autoShow, effectLibrary, paletteStore,
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
/** The first fixture's blue: dark under a red look, lit by the blinder. */
const blue = () => {
  const fixture = state.fixtures[0];
  return universes.getBuffer(fixture.universe ?? state.artnet.universe)[fixture.address - 1 + getProfile(fixture).channelMap.blue];
};

// ── The energy endpoints ────────────────────────────────────────────────────

test('POST /api/energy/blinder latches an energy voice; energyOverride in state reads blinder; /api/energy/off stops it', async (t) => {
  const s = await serve(t);
  assert.deepEqual(renderInput().voices, [], 'no voices is an empty list: the renderer plays nothing of its own');
  let res = await s.call('POST', '/api/energy/blinder');
  assert.deepEqual([res.status, res.body], [200, { ok: true, energyOverride: 'blinder' }]);
  res = await s.call('GET', '/api/voices');
  assert.equal(res.body.voices.length, 1);
  assert.deepEqual(
    (({ id, source, mode, tier, kind, targets, label, until, hidden }) => ({ id, source, mode, tier, kind, targets, label, until, hidden }))(res.body.voices[0]),
    { id: 'energy:blinder', source: 'energy', mode: 'latched', tier: 'voice', kind: 'energy.blinder', targets: 'shared', label: 'Blinder', until: null, hidden: false },
  );
  const live = (await s.call('GET', '/api/state')).body;
  assert.equal(live.energyOverride, 'blinder');
  assert.deepEqual(live.voices, res.body.voices);
  assert.deepEqual(playing(), ['energy:blinder']);
  assert.equal(captureLook().energyOverride, 'blinder', 'a cue takes the latch');

  // Again: the same voice plays on, not launched again.
  const { launchSeq } = voices.get('energy:blinder');
  await s.call('POST', '/api/energy/blinder');
  assert.equal(voices.get('energy:blinder').launchSeq, launchSeq);
  // Another replaces it; an id that is no energy effect takes it off, as it always did.
  await s.call('POST', '/api/energy/glow');
  assert.deepEqual(ids(), ['energy:glow']);

  res = await s.call('POST', '/api/energy/off');
  assert.deepEqual([res.status, res.body], [200, { ok: true, energyOverride: null }]);
  assert.deepEqual(ids(), []);
  assert.equal(state.energyOverride, null);
  assert.deepEqual(renderInput().voices, []);
  await s.call('POST', '/api/energy/kill');
  await s.call('POST', '/api/energy/no-such-effect');
  assert.deepEqual([ids(), state.energyOverride], [[], null]);
});

test('socket energy-hold press/release still works through the shim', async (t) => {
  const s = await serve(t);
  const { socket, heard } = await s.page();
  await s.call('POST', '/api/energy/blinder');
  socket.emit('energy-hold', { action: 'press', token: 'one', effect: 'kill' });
  await until(() => state.heldEnergy === 'kill', 'the hold');
  assert.equal(state.energyOverride, 'blinder', 'the latch is kept underneath');
  assert.deepEqual(playing(), ['energy:kill:hold'], 'and only the hold plays');
  await until(() => heard.patches.some((p) => p.d === 'look' && p.set.energyOverride === 'kill'), 'the page hearing the held effect');
  await until(() => heard.patches.some((p) => p.d === 'voices' && p.set.voices?.some((v) => v.id === 'energy:kill:hold')), 'a voices patch');
  assert.equal(captureLook().energyOverride, 'blinder', 'a cue takes the latch, not the hold');

  // Renewed past the lease, it stays.
  for (let i = 0; i < 5; i++) {
    await wait(300);
    socket.emit('energy-hold', { action: 'renew', token: 'one' });
  }
  assert.equal(state.heldEnergy, 'kill', `kept alive past ${HOLD_TIMEOUT_MS} ms`);
  socket.emit('energy-hold', { action: 'release', token: 'wrong' });
  await wait(50);
  assert.equal(state.heldEnergy, 'kill', 'another token lets nothing go');

  socket.emit('energy-hold', { action: 'release', token: 'one' });
  await until(() => state.heldEnergy === null, 'the release');
  assert.deepEqual(playing(), ['energy:blinder'], 'the latch comes back');
  await until(() => heard.patches.some((p) => p.d === 'look' && p.set.energyOverride === 'blinder'), 'the latch heard again');

  // A page that goes takes its hold with it.
  socket.emit('energy-hold', { action: 'press', token: 'two', effect: 'glow' });
  await until(() => state.heldEnergy === 'glow', 'the second hold');
  socket.close();
  await until(() => state.heldEnergy === null, 'the hold gone with its page');
  assert.deepEqual(ids(), ['energy:blinder']);
});

// ── POST /api/voices ────────────────────────────────────────────────────────

test('POST /api/voices with a preset and ms returns an id and the voice ends by itself', async (t) => {
  const s = await serve(t);
  const res = await s.call('POST', '/api/voices', { preset: 'blinder', ms: 150, targets: [state.fixtures[0].id] });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const { id } = res.body;
  const [listed] = (await s.call('GET', '/api/voices')).body.voices;
  assert.deepEqual([listed.id, listed.source, listed.mode, listed.tier, listed.label, listed.targets],
    [id, 'api', 'once', 'voice', 'Blinder', [state.fixtures[0].id]]);
  assert.equal(listed.until - listed.startedAt, 150);
  assert.deepEqual(playing(), [id]);
  await until(() => !ids().length, 'the end, by itself', 2000);
  assert.deepEqual((await s.call('GET', '/api/voices')).body.voices, []);
});

test('POST /api/voices: a once with no length plays the preset\'s; latched plays until stopped; DELETE stops one or all', async (t) => {
  const s = await serve(t);
  const bpm = conductor.status().bpm;
  let res = await s.call('POST', '/api/voices', { preset: 'ldj.FadeCycle' });
  const fade = voices.get(res.body.id);
  assert.ok(Math.abs(fade.untilMs - fade.startedAtMs - 32 * 60000 / bpm) < 1, 'Light DJ\'s 32 beats');
  res = await s.call('POST', '/api/voices', { effect: FADE, beats: 2, targets: [] });
  const two = voices.get(res.body.id);
  assert.deepEqual(two.targets, [], 'an empty list stays empty');
  assert.ok(Math.abs(two.untilMs - two.startedAtMs - 2 * 60000 / bpm) < 1);
  res = await s.call('POST', '/api/voices', { effect: { kind: 'energy.glow' }, mode: 'latched' });
  const latched = res.body.id;
  assert.equal(voices.get(latched).untilMs, null);

  assert.deepEqual(await s.call('DELETE', `/api/voices/${encodeURIComponent(latched)}`), { status: 200, body: { ok: true } });
  assert.deepEqual(await s.call('DELETE', `/api/voices/${encodeURIComponent(latched)}`), { status: 404, body: { ok: false, error: 'No such voice' } });
  assert.deepEqual(await s.call('DELETE', '/api/voices'), { status: 200, body: { ok: true, stopped: 2 } });
  assert.deepEqual(ids(), []);
});

test('POST /api/voices refuses what is malformed (400), an effect that waits for the acknowledgement (409), and launches nothing', async (t) => {
  const s = await serve(t);
  await s.call('POST', '/api/energy/glow');
  const bad = [
    {}, { effect: FADE, preset: 'blinder' }, { preset: 'blinder', ms: 100, beats: 1 }, { preset: 'blinder', mode: 'latched', ms: 100 },
    { preset: 'blinder', mode: 'hold' }, { preset: 'blinder', ms: 0 }, { preset: 'blinder', ms: -5 }, { preset: 'blinder', targets: 'all' },
    { preset: 'blinder', targets: [999999] }, { preset: 'blinder', targets: [0.5] },
    { preset: 'no-such-preset' }, { preset: 'chase' }, { effect: { kind: 'no.such' } }, { spec: FADE },
    ...['tier', 'source', 'owner', 'token', 'key', 'seed', 'maxLatchMs', 'quantise', 'sequence', 'id'].map((field) => ({ preset: 'blinder', [field]: 'x' })),
  ];
  for (const body of bad) {
    const res = await s.call('POST', '/api/voices', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.ok, false);
  }
  for (const body of [{ preset: 'white-strobe' }, { effect: { kind: 'ldj.StrobeCycle', params: { cadence: 0.25 }, rapidFlash: false } }]) {
    const res = await s.call('POST', '/api/voices', body);
    assert.deepEqual([res.status, res.body], [409, { ok: false, error: 'photosensitivity acknowledgement required' }], JSON.stringify(body));
  }
  assert.deepEqual(ids(), ['energy:glow'], 'nothing launched, nothing replaced');
  // A stop needs nothing.
  assert.equal((await s.call('DELETE', '/api/voices')).body.stopped, 1);

  await s.call('POST', '/api/safety/acknowledge');
  const res = await s.call('POST', '/api/voices', { preset: 'white-strobe', mode: 'latched' });
  assert.equal(res.status, 200);
  assert.equal(voices.get(res.body.id).tier, 'voice', 'launched from outside: the voice tier, under the strobe');
});

// ── The voice hold ──────────────────────────────────────────────────────────

test('voice-hold: a page holds any effect down, renews it, lets it go; only its own socket can', async (t) => {
  const s = await serve(t);
  const a = await s.page();
  const b = await s.page();
  a.socket.emit('voice-hold', { action: 'press', token: 'h1', effect: FADE, targets: [state.fixtures[1].id] });
  await until(() => ids().length === 1, 'the held voice');
  const [held] = voices.list();
  assert.deepEqual([held.source, held.mode, held.tier, held.kind, held.targets], ['api', 'hold', 'voice', 'ldj.FadeCycle', [state.fixtures[1].id]]);
  // The other page's release, with the same token, is not this hold's.
  b.socket.emit('voice-hold', { action: 'release', token: 'h1' });
  for (let i = 0; i < 5; i++) {
    await wait(300);
    a.socket.emit('voice-hold', { action: 'renew', token: 'h1' });
  }
  assert.deepEqual(ids(), [held.id], 'renewed past the lease, and not the other page\'s to release');
  a.socket.emit('voice-hold', { action: 'release', token: 'h1' });
  await until(() => !ids().length, 'the release');

  // A preset by id; then one the acknowledgement keeps back, a pad and a bad effect, each told.
  a.socket.emit('voice-hold', { action: 'press', token: 'h2', effect: { preset: 'glow' } });
  await until(() => voices.list()[0]?.kind === 'energy.glow', 'the preset held');
  a.socket.emit('voice-hold', { action: 'press', token: 'h3', effect: { preset: 'white-strobe' } });
  a.socket.emit('voice-hold', { action: 'press', token: 'h4', pad: { bank: 0, slot: 0 } });
  a.socket.emit('voice-hold', { action: 'press', token: 'h5', effect: { kind: 'no.such' } });
  a.socket.emit('voice-hold', { action: 'press', token: 'h6', effect: { preset: 'glow', kind: 'energy.kill' } });
  await until(() => a.heard.errors.length === 4, 'four refusals');
  assert.deepEqual(a.heard.errors.map((e) => e.source), ['voice-hold', 'voice-hold', 'voice-hold', 'voice-hold']);
  assert.match(a.heard.errors[0].message, /photosensitivity acknowledgement required/);
  assert.match(a.heard.errors[1].message, /pads/);
  assert.deepEqual(voices.list().map((v) => v.kind), ['energy.glow'], 'nothing else launched');

  // Left unrenewed, it dies within the lease, and the page that held it going takes the rest.
  await until(() => !ids().length, 'the lease running out', HOLD_TIMEOUT_MS + 1000);
  a.socket.emit('voice-hold', { action: 'press', token: 'h7', effect: FADE });
  await until(() => ids().length === 1, 'another hold');
  a.socket.close();
  await until(() => !ids().length, 'the hold gone with its page');
});

// ── A disarm ────────────────────────────────────────────────────────────────

test('a disarm asked for stops every voice, even with the outputs disarmed already', async (t) => {
  const s = await serve(t);
  await s.call('POST', '/api/outputs/arm');
  await s.call('POST', '/api/energy/blinder');
  await s.call('POST', '/api/voices', { effect: FADE, mode: 'latched' });
  assert.equal((await s.call('POST', '/api/outputs/disarm')).body.armed, false);
  assert.deepEqual([ids(), state.energyOverride], [[], null]);
  // A rehearsal with the outputs off: voices play, and a disarm stops them.
  await s.call('POST', '/api/voices', { effect: FADE, mode: 'latched' });
  await s.call('POST', '/api/energy/glow');
  assert.equal(ids().length, 2);
  assert.equal((await s.call('POST', '/api/outputs/disarm')).body.armed, false);
  assert.deepEqual(ids(), []);
});

// ── The voices at work ──────────────────────────────────────────────────────

test('the live state carries the voices as a domain of their own', async (t) => {
  const s = await serve(t);
  assert.equal(domainOf('voices'), 'voices');
  const { heard } = await s.page();
  assert.deepEqual(heard.snapshot.state.voices, []);
  assert.equal(heard.snapshot.versions.voices, 0);
  await s.call('POST', '/api/voices', { effect: FADE, mode: 'latched' });
  const patch = await until(() => heard.patches.find((p) => p.d === 'voices'), 'a voices patch');
  assert.deepEqual(Object.keys(patch.set), ['voices'], 'only the voices');
  assert.equal(patch.set.voices[0].kind, 'ldj.FadeCycle');
});

test('a voice plays with the patterns stopped, and runs the free clock while it does', async (t) => {
  await serve(t);
  applyPatch({ pattern: 'solid', colorA: 0, running: false, masterDimmer: 255, masterBlackout: false });
  assert.equal(freeClockRuns(), false);
  const still = conductor.phase().beatPos;
  await wait(60);
  assert.equal(conductor.phase().beatPos, still, 'stopped: the free clock stands');
  renderFrame();
  assert.equal(blue(), 0);
  applyPatch({ energyOverride: 'blinder' });
  assert.equal(state.running, false, 'a voice starts nothing else');
  assert.equal(freeClockRuns(), true);
  const from = conductor.phase().beatPos;
  await wait(60);
  assert.ok(conductor.phase().beatPos > from, 'the free clock counts the voice\'s beats');
  renderFrame();
  assert.ok(blue() > 0, 'the blinder over the stopped look');
  applyPatch({ energyOverride: null });
  assert.equal(freeClockRuns(), false, 'the last voice gone, the clock stops again');
  const end = conductor.phase().beatPos;
  await wait(60);
  assert.equal(conductor.phase().beatPos, end);
});

test('a Disco voice runs the audio detectors on its own bands', async (t) => {
  const s = await serve(t);
  await s.call('POST', '/api/safety/acknowledge');
  applyPatch({ pattern: 'ldj.FadeCycle' });
  assert.equal(s.integrations.audio.detectors().disco.owner.from, 'fallback');
  const { id } = (await s.call('POST', '/api/voices', { preset: 'hd.disco.rock', mode: 'latched' })).body;
  assert.deepEqual(s.integrations.audio.detectors().disco.owner, { from: 'voice', id, kind: 'hd.disco' });
  voices.setHidden(id, true);
  assert.equal(s.integrations.audio.detectors().disco.owner.from, 'fallback', 'hidden, it hears nothing');
});

test('on the worker thread a voice plays on the worker\'s clock, from its start to its end', async (t) => {
  await serve(t);
  state.artnet.enabled = false;
  applyPatch({ pattern: 'solid', colorA: 0, running: false, masterDimmer: 255, masterBlackout: false });
  const lit = () => blue() > 0;
  startEngine({ thread: 'worker' });
  t.after(() => stopEngine());
  assert.equal(engineStatus().thread, 'worker');
  // The worker compiles its modules before its first frame: seconds on a slow runner.
  await until(() => !lit(), 'the stopped look, dark, from the worker');
  await wait(100);
  assert.equal(lit(), false);
  // A once voice: on a clock it did not render by, its end would already be past.
  voices.start({ spec: { kind: 'energy.blinder' }, targets: 'shared', mode: 'once', tier: 'voice', source: 'api', lengthMs: 1500 });
  await until(lit, 'the voice on the rig', 3000);
  await until(() => !lit(), 'its end on the rig', 4000);
  assert.deepEqual(ids(), []);
});
