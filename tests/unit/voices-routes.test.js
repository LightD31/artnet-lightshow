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
import { PadStore } from '../../src/server/pads.ts';
import { startEngine, stopEngine, renderInput, renderFrame, engineStatus } from '../../src/server/engine.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { captureLook } from '../../src/server/cues.ts';
import { state, voices, freeClockRuns, matrix as liveMatrix } from '../../src/server/state.ts';
import { conductor } from '../../src/server/conductor.ts';
import { domainOf } from '../../src/server/protocol.ts';
import { settings } from '../../src/server/settings.ts';
import * as output from '../../src/server/output.ts';
import * as universes from '../../src/server/universes.ts';
import { showStore } from '../../src/server/show-store.ts';
import { HOLD_TIMEOUT_MS } from '../../src/server/voices.ts';
import { getProfile, profilesRevision } from '../../src/server/profiles.ts';
import { createRenderer } from '../../src/server/renderer.ts';

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
/** The first fixture's blue: dark under a red look, lit by the blinder. */
const blue = () => {
  const fixture = state.fixtures[0];
  return universes.getBuffer(fixture.universe ?? state.artnet.universe)[fixture.address - 1 + getProfile(fixture).channelMap.blue];
};

// ── The energy endpoints ────────────────────────────────────────────────────

test("energy endpoints manage the compatibility voice", async (t) => {
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

  // A page that goes takes its hold with it, at once, not when its lease runs out.
  socket.emit('energy-hold', { action: 'press', token: 'two', effect: 'glow' });
  await until(() => state.heldEnergy === 'glow', 'the second hold');
  socket.close();
  await until(() => state.heldEnergy === null, 'the hold gone with its page', HOLD_TIMEOUT_MS / 2);
  assert.deepEqual(ids(), ['energy:blinder']);
});

test("energy strobe requests require acknowledgement", async (t) => {
  const s = await serve(t);
  const { socket, heard } = await s.page();
  const refused = [409, false, 'string'];
  await s.call('POST', '/api/energy/glow');
  for (const id of ['white-strobe', 'color-strobe', 'palette-strobe']) {
    const res = await s.call('POST', `/api/energy/${id}`);
    assert.deepEqual([res.status, res.body.ok, typeof res.body.error], refused, id);
  }
  const master = state.masterDimmer;
  const res = await s.call('POST', '/api/set', { energyOverride: 'white-strobe', masterDimmer: (master + 1) % 256 });
  assert.deepEqual([res.status, res.body.ok, typeof res.body.error], refused);
  assert.equal(state.masterDimmer, master, 'refused whole, its master too');

  // A hold down, then the sockets' refusals: each told to the page that asked, the hold's with its token.
  socket.emit('energy-hold', { action: 'press', token: 'k', effect: 'kill' });
  await until(() => state.heldEnergy === 'kill', 'the hold');
  socket.emit('set', { energyOverride: 'color-strobe' });
  socket.emit('energy-hold', { action: 'press', token: 'x', effect: 'white-strobe' });
  await until(() => heard.errors.length === 2, 'two refusals');
  assert.deepEqual(heard.errors.map((e) => [e.source, e.token, typeof e.message]), [
    ['set', undefined, 'string'],
    ['energy-hold', 'x', 'string'],
  ]);
  assert.deepEqual([state.energyOverride, state.heldEnergy, ids().sort()], ['glow', 'kill', ['energy:glow', 'energy:kill:hold']],
    'the latch and the hold before them play on');
  const live = (await s.call('GET', '/api/state')).body;
  assert.deepEqual([live.energyOverride, live.safety.photosensitivityAcknowledged], ['kill', false],
    'the state shows what plays, and that the strobes wait for the acknowledgement');
  socket.emit('energy-hold', { action: 'release', token: 'k' });
  await until(() => state.heldEnergy === null, 'the release');

  // Acknowledged: the page hears it, and the same requests play.
  await s.call('POST', '/api/safety/acknowledge');
  await until(() => heard.patches.some((p) => p.d === 'look' && p.set.safety?.photosensitivityAcknowledged === true), 'the page hearing the acknowledgement');
  assert.deepEqual(await s.call('POST', '/api/energy/white-strobe'), { status: 200, body: { ok: true, energyOverride: 'white-strobe' } });
  socket.emit('energy-hold', { action: 'press', token: 'y', effect: 'palette-strobe' });
  await until(() => state.heldEnergy === 'palette-strobe', 'the strobe held');
  socket.emit('energy-hold', { action: 'release', token: 'y' });
  await until(() => state.heldEnergy === null, 'its release');
  assert.equal(heard.errors.length, 2, 'nothing more refused');
});

// ── POST /api/voices ────────────────────────────────────────────────────────

test("voice POST returns an id for a timed lifetime", async (t) => {
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

test("voice routes use preset or explicit beat lifetimes", async (t) => {
  const s = await serve(t);
  const bpm = conductor.status().bpm;
  let res = await s.call('POST', '/api/voices', { preset: 'ldj.FadeCycle' });
  const fade = voices.get(res.body.id);
  assert.ok(Math.abs(fade.untilMs - fade.startedAtMs - 32 * 60000 / bpm) < 1, 'Light DJ\'s 32 beats');
  res = await s.call('POST', '/api/voices', { preset: 'ldj.StudioN1' });
  const studio = voices.get(res.body.id);
  assert.ok(Math.abs(studio.untilMs - studio.startedAtMs - 32 * 60000 / bpm) < 1, 'the preset\'s length, not its kind\'s');
  res = await s.call('POST', '/api/voices', { effect: FADE, beats: 2, targets: [] });
  const two = voices.get(res.body.id);
  assert.deepEqual(two.targets, [], 'an empty list stays empty');
  assert.ok(Math.abs(two.untilMs - two.startedAtMs - 2 * 60000 / bpm) < 1);
});

test("latched voice routes stop only on explicit deletion", async (t) => {
  const s = await serve(t);
  const res = await s.call('POST', '/api/voices', { effect: { kind: 'energy.glow' }, mode: 'latched' });
  const latched = res.body.id;
  assert.equal(voices.get(latched).untilMs, null);
  assert.deepEqual(await s.call('DELETE', `/api/voices/${encodeURIComponent(latched)}`), { status: 200, body: { ok: true } });
  const missing = await s.call('DELETE', `/api/voices/${encodeURIComponent(latched)}`);
  assert.deepEqual([missing.status, missing.body.ok, typeof missing.body.error], [404, false, 'string']);
});

test("voice DELETE stops all remaining voices", async (t) => {
  const s = await serve(t);
  await s.call('POST', '/api/voices', { preset: 'ldj.FadeCycle' });
  await s.call('POST', '/api/voices', { preset: 'ldj.StudioN1' });
  await s.call('POST', '/api/voices', { effect: FADE, beats: 2, targets: [] });
  assert.deepEqual(await s.call('DELETE', '/api/voices'), { status: 200, body: { ok: true, stopped: 3 } });
  assert.deepEqual(ids(), []);
});

test("invalid voice requests launch nothing", async (t) => {
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
    assert.deepEqual([res.status, res.body.ok, typeof res.body.error], [409, false, 'string'], JSON.stringify(body));
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

test("voice holds are leased to their owning socket", async (t) => {
  const s = await serve(t);
  const a = await s.page();
  const b = await s.page();
  a.socket.emit('voice-hold', { action: 'press', token: 'h1', effect: FADE, targets: [state.fixtures[1].id] });
  await until(() => ids().length === 1, 'the held voice');
  const [held] = voices.list();
  assert.deepEqual([held.source, held.mode, held.tier, held.kind, held.targets], ['api', 'hold', 'voice', 'ldj.FadeCycle', [state.fixtures[1].id]]);
  // The other page's press and release, with the same token and this page's id named as owner, are not this hold's.
  b.socket.emit('voice-hold', { action: 'press', token: 'h1', owner: a.socket.id, effect: { kind: 'energy.glow' } });
  await until(() => ids().length === 2, 'the other page\'s own hold');
  b.socket.emit('voice-hold', { action: 'release', token: 'h1', owner: a.socket.id });
  await until(() => ids().length === 1, 'the other page\'s release');
  for (let i = 0; i < 5; i++) {
    await wait(300);
    a.socket.emit('voice-hold', { action: 'renew', token: 'h1' });
  }
  assert.deepEqual(ids(), [held.id], 'renewed past the lease, and not the other page\'s to replace or release');
  a.socket.emit('voice-hold', { action: 'release', token: 'h1' });
  await until(() => !ids().length, 'the release');

  // A preset by id; then one the acknowledgement keeps back, a pad (the default 0/0, the white strobe, keeps back too) and a bad effect, each told.
  a.socket.emit('voice-hold', { action: 'press', token: 'h2', effect: { preset: 'glow' } });
  await until(() => voices.list()[0]?.kind === 'energy.glow', 'the preset held');
  a.socket.emit('voice-hold', { action: 'press', token: 'h3', effect: { preset: 'white-strobe' } });
  a.socket.emit('voice-hold', { action: 'press', token: 'h4', pad: { bank: 0, slot: 0 } });
  a.socket.emit('voice-hold', { action: 'press', token: 'h5', effect: { kind: 'no.such' } });
  a.socket.emit('voice-hold', { action: 'press', token: 'h6', effect: { preset: 'glow', kind: 'energy.kill' } });
  await until(() => a.heard.errors.length === 4, 'four refusals');
  assert.deepEqual(a.heard.errors.map((e) => e.source), ['voice-hold', 'voice-hold', 'voice-hold', 'voice-hold']);
  assert.equal(typeof a.heard.errors[0].message, 'string');
  assert.equal(typeof a.heard.errors[1].message, 'string');
  assert.deepEqual(voices.list().map((v) => v.kind), ['energy.glow'], 'nothing else launched');

  // Left unrenewed, it dies within the lease, and the page that held it going takes the rest.
  await until(() => !ids().length, 'the lease running out', HOLD_TIMEOUT_MS + 1000);
  // One token names one hold, whichever event pressed it: the energy hold takes the voice hold's place, and either event lets it go.
  a.socket.emit('voice-hold', { action: 'press', token: 'both', effect: FADE });
  await until(() => voices.list()[0]?.kind === 'ldj.FadeCycle', 'the voice hold');
  a.socket.emit('energy-hold', { action: 'press', token: 'both', effect: 'kill' });
  await until(() => state.heldEnergy === 'kill', 'the energy hold');
  assert.deepEqual(ids(), ['energy:kill:hold'], 'the one hold, replaced');
  a.socket.emit('voice-hold', { action: 'release', token: 'both' });
  await until(() => state.heldEnergy === null && !ids().length, 'released by the other event');
  a.socket.emit('voice-hold', { action: 'press', token: 'h7', effect: FADE });
  await until(() => ids().length === 1, 'another hold');
  a.socket.close();
  await until(() => !ids().length, 'the hold gone with its page, before its lease could end', HOLD_TIMEOUT_MS / 2);
});

test("dropped sockets lose their voice at lease expiry", async (t) => {
  const s = await serve(t);
  applyPatch({ pattern: 'solid', colorA: 0, running: false, masterDimmer: 255, masterBlackout: false });
  renderFrame();
  assert.equal(blue(), 0, 'the look: red, no blue');
  // The engine's clock moved on by hand, so a lease can run out before its timer fires; the timers keep real time.
  const real = performance.now.bind(performance);
  let ahead = 0;
  let still = null;
  t.mock.method(performance, 'now', () => still ?? real() + ahead);
  const skipTo = (ms) => { ahead += Math.max(0, ms - performance.now()); };
  // The clock standing at `ms` for one reading, then running on from there: a busy machine cannot slip past the moment asked about.
  const standingAt = (ms, read) => {
    still = Math.max(ms, performance.now());
    try { return read(); } finally { ahead = still - real(); still = null; }
  };
  const press = async (socket, event, token, effect) => {
    socket.emit(event, { action: 'press', token, effect });
    await until(() => ids().length === 1, `${event}: the hold`);
    const [held] = renderInput().voices;
    assert.ok(held.untilMs > performance.now() && held.untilMs - performance.now() <= HOLD_TIMEOUT_MS, 'its lease: 1.2 s from the press');
    return held;
  };
  for (const [event, effect] of [['voice-hold', { kind: 'energy.blinder' }], ['energy-hold', 'blinder']]) {
    const { socket, heard } = await s.page();

    // The page goes quiet, the socket still open: at its lease the frame drops it, its timer still to come.
    const held = await press(socket, event, 'tab', effect);
    const pressed = Date.now();
    renderFrame();
    assert.ok(blue() > 0, `${event}: held, the blinder on the rig`);
    standingAt(held.untilMs - 1, () => assert.deepEqual(playing(), [held.id], 'a millisecond before its lease ends it still plays'));
    skipTo(held.untilMs);
    assert.deepEqual(playing(), [], 'gone from the frame at its lease');
    renderFrame();
    assert.equal(blue(), 0, 'and the look is back');
    assert.deepEqual(ids(), [], 'ended');
    assert.ok(Date.now() - pressed < HOLD_TIMEOUT_MS, 'before its timer could have');
    assert.equal(state.heldEnergy, null);
    await until(() => heard.patches.some((p) => p.d === 'voices' && Array.isArray(p.set.voices) && !p.set.voices.length), 'every page told');
    // The Wi-Fi back: its renewal finds nothing to keep alive.
    socket.emit(event, { action: 'renew', token: 'tab' });
    await wait(50);
    assert.deepEqual(ids(), [], 'a renewal brings nothing back');

    // A renewal that arrives just after the lease ran out, before its timer: it ends the hold rather than keeping it.
    const late = await press(socket, event, 'tab2', effect);
    const pressedLate = Date.now();
    skipTo(late.untilMs + 5);
    socket.emit(event, { action: 'renew', token: 'tab2' });
    await until(() => !ids().length, 'the late renewal ending it');
    assert.ok(Date.now() - pressedLate < HOLD_TIMEOUT_MS, 'not its timer');
    renderFrame();
    assert.equal(blue(), 0);

    // No frame at all: its own timer ends it at its lease, and every page hears.
    const alone = await press(socket, event, 'tab3', effect);
    const told = heard.patches.length;
    await until(() => !ids().length, 'the lease running out by itself', HOLD_TIMEOUT_MS + 1000);
    const overdue = performance.now() - alone.untilMs;
    assert.ok(overdue >= 0 && overdue < 250, `ended by its timer at its lease (${overdue.toFixed(1)} ms after)`);
    await until(() => heard.patches.slice(told).some((p) => p.d === 'voices' && !p.set.voices?.length), 'the end heard');
    socket.close();
  }
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

test("disarm leaves sequence transport running", async (t) => {
  const s = await serve(t);
  const sequencer = s.integrations.sequence.sequencer;
  t.after(() => sequencer.unload());
  const frame = () => sequencer.frame(conductor.now());
  const beat = () => sequencer.status().beat;
  await s.call('POST', '/api/outputs/arm');
  assert.equal((await s.call('POST', '/api/outputs/disarm')).body.armed, false);
  assert.deepEqual([state.running, ids()], [false, []]);
  const glow = { id: 'set-1', name: 'Set one', lanes: [{ id: 'a', kind: 'shared', name: 'a', mute: false, solo: false }],
    clips: [{ id: 'A', laneId: 'a', startBeat: 0, lengthBeats: 1e6, effect: { kind: 'energy.glow', params: {} }, targets: 'lane', mute: false }] };
  assert.equal((await s.call('PUT', '/api/sequence', glow)).status, 200);
  assert.equal((await s.call('POST', '/api/sequence/play')).body.status.playing, true, 'play with the outputs disarmed just runs');
  frame();
  await wait(120);
  frame();
  assert.equal(state.running, false);
  assert.ok(beat() > 0.1, `after a disarm: the sequence counts its beats (beat ${beat()})`);
  // Disarmed again while it plays: the patterns stop, the sequence plays on.
  await s.call('POST', '/api/outputs/arm');
  assert.equal((await s.call('POST', '/api/outputs/disarm')).body.armed, false);
  assert.equal(freeClockRuns(), true);
  const from = beat();
  await wait(120);
  frame();
  assert.equal(sequencer.status().playing, true);
  assert.ok(beat() > from + 0.1, `a disarm under it: the sequence counts on (beat ${from} → ${beat()})`);
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

/**
 * The first 48 channels of universe 0, frame by frame, on a renderer of its
 * own from the engine's clock now: a second at beat 0 on, then the music
 * jumps (a new epoch) to beat 37.3 for another second.
 */
function renderAcrossJump(input) {
  const t0 = performance.now();
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: t0 });
  const store = universes.createUniverseStore(universes.allocateShared());
  const out = [];
  for (let ms = 0; ms < 2000; ms += 1000 / 44) {
    const reading = ms < 1000 ? { beatPos: ms / 500, bpm: 120, epoch: 0 } : { beatPos: 37.3 + (ms - 1000) / 500, bpm: 120, epoch: 1 };
    renderer.frame(input, reading, t0 + ms, store, t0);
    out.push(Array.from(store.getBuffer(0).subarray(0, 48)).join(','));
  }
  return out;
}

test("energy strobe voices retain the global beat grid through jumps", async (t) => {
  const s = await serve(t);
  await s.call('POST', '/api/safety/acknowledge');
  applyPatch({ pattern: 'solid', colorA: 0, colorB: 3, colorC: 5, colorD: 7, running: true, masterDimmer: 255, masterBlackout: false });
  await s.call('POST', '/api/energy/palette-strobe');
  const managed = renderInput();
  assert.deepEqual(managed.voices.map((v) => v.id), ['energy:palette-strobe']);
  // The same input without its voices: the renderer plays the burst by itself, as before voices.
  const { voices: _, ...legacy } = managed;
  const played = renderAcrossJump(managed);
  assert.ok(new Set(played.slice(44)).size > 2, 'it flashes in several colours after the jump');
  assert.deepEqual(played, renderAcrossJump(legacy));
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

test("worker voices retain lifetime through a busy main thread", async (t) => {
  const s = await serve(t);
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

  // A blue strobe on the beat over the stopped look. The main thread then busy for most of a
  // second, no snapshot posted: the worker carries the beat on, as the voice runs the free clock.
  await s.call('POST', '/api/safety/acknowledge');
  const strobe = voices.start({ spec: { kind: 'strobe', palette: ['#0000FF'], params: { clock: 'beat', flashesPerSecond: 5 } },
    targets: 'shared', mode: 'latched', tier: 'strobe', source: 'api' });
  await until(lit, 'the strobe flashing', 3000);
  let rises = 0;
  let was = lit();
  for (const stall = performance.now() + 900; performance.now() < stall;) {
    const now = lit();
    if (now && !was) rises++;
    was = now;
  }
  assert.ok(rises >= 2, `${rises} flashes while the main thread was busy`);

  // A launch due on a grid line before the worker's next frame rides in this snapshot, so it starts on time.
  let soon = null;
  while (!soon || !(soon.startedAtMs > performance.now())) {
    if (soon) voices.stop(soon.id);
    soon = voices.start({ spec: { kind: 'energy.glow' }, targets: 'shared', mode: 'once', tier: 'voice', source: 'api', quantise: 0.01, lengthMs: 500 });
  }
  assert.ok(renderInput().voices.some((v) => v.id === soon.id), 'carried ahead of its start');
  voices.stop(strobe.id);
});

// ── The matrix board ────────────────────────────────────────────────────────

test("matrix routes expose guarded initial state", async (t) => {
  const s = await serve(t);
  t.after(() => { liveMatrix.clear(); liveMatrix.setMode('pulses'); });
  let res = await s.call('GET', '/api/matrix');
  assert.deepEqual(res, { status: 200, body: { ok: true, mode: 'pulses', colours: [], voice: null } });
  res = await s.call('POST', '/api/matrix/press', { colour: '#ff0000' });
  assert.deepEqual([res.status, res.body.ok], [409, false]);
  assert.deepEqual((await s.call('GET', '/api/matrix')).body.colours, []);
  for (const body of [{ mode: 'disco' }, {}, { mode: 7 }]) assert.equal((await s.call('PUT', '/api/matrix', body)).status, 400, JSON.stringify(body));
});

test("matrix routes publish held-cell state", async (t) => {
  const s = await serve(t);
  const { heard } = await s.page();
  const heardMatrix = (found) => heard.patches.some((p) => p.d === 'look' && p.set.matrix && found(p.set.matrix));
  t.after(() => { liveMatrix.clear(); liveMatrix.setMode('pulses'); });
  let res;
  res = await s.call('PUT', '/api/matrix', { mode: 'cycle' });
  assert.deepEqual([res.status, res.body.mode, res.body.voice], [200, 'cycle', null]);
  await until(() => heardMatrix((m) => m.mode === 'cycle'), 'the page hearing the mode');
  for (const body of [{}, { colour: 'red' }, { colour: '#12345' }, { colour: '#FF0000', extra: 1 }]) {
    assert.equal((await s.call('POST', '/api/matrix/press', body)).status, 400, JSON.stringify(body));
  }
  res = await s.call('POST', '/api/matrix/press', { colour: '#ff0000' });
  assert.deepEqual([res.status, res.body.colours], [200, ['#FF0000']]);
  const first = res.body.voice;
  assert.ok(first && ids().includes(first), 'one voice plays the board');
  res = await s.call('POST', '/api/matrix/press', { colour: '#FF0000' });
  assert.deepEqual([res.body.colours, res.body.voice], [['#FF0000'], first], 'renewed, not launched again');
  res = await s.call('POST', '/api/matrix/press', { colour: '#00FF00', token: 'finger-2' });
  assert.deepEqual(res.body.colours, ['#FF0000', '#00FF00']);
  const live = (await s.call('GET', '/api/state')).body.matrix;
  assert.deepEqual(live, { mode: 'cycle', colours: ['#FF0000', '#00FF00'], voice: res.body.voice });
  await until(() => heardMatrix((m) => m.colours.length === 2), 'the page hearing both cells');
  assert.equal((await s.call('POST', '/api/matrix/release', {})).status, 400);
  res = await s.call('POST', '/api/matrix/release', { token: 'finger-2' });
  assert.deepEqual(res.body.colours, ['#FF0000']);
  res = await s.call('POST', '/api/matrix/release', { colour: '#ff0000' });
  assert.deepEqual([res.status, res.body.colours, res.body.voice], [200, [], null]);
  assert.ok(!voices.list().some((v) => v.source === 'matrix'), 'no matrix voice left');
  await until(() => heardMatrix((m) => m.colours.length === 0 && m.voice === null), 'the page hearing the board empty');
});

test("matrix flash routes play after acknowledgement", async (t) => {
  const s = await serve(t);
  t.after(() => { liveMatrix.clear(); liveMatrix.setMode('pulses'); });
  await s.call('POST', '/api/safety/acknowledge');
  await s.call('PUT', '/api/matrix', { mode: 'flashes' });
  const res = await s.call('POST', '/api/matrix/press', { colour: '#0000FF' });
  assert.deepEqual([res.status, res.body.mode, res.body.colours], [200, 'flashes', ['#0000FF']]);
});

test("voice POST rejects internal bundle specs", async (t) => {
  const s = await serve(t);
  const params = { patternId: 'p', lengthBeats: 4, once: false, table: { revision: 0, lanes: [], clips: [] } };
  const res = await s.call('POST', '/api/voices', { effect: { kind: 'pattern.bundle', params }, beats: 4 });
  assert.equal(res.status, 400);
  assert.equal(typeof res.body.error, 'string');
  assert.deepEqual(playing(), []);
});
