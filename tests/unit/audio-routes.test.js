// The audio settings, what the party effects hear, and how it reaches the rig
// and the pages: the route, the engine's input, the subscribe-only feed, the
// live state's summary, and the live input started with the bands it needs
// whoever starts it.

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import express from 'express';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';

import { attachRoutes } from '../../src/server/routes.ts';
import { attachSockets } from '../../src/server/sockets.ts';
import { setupIntegrations } from '../../src/server/integrations.ts';
import { createApplier } from '../../src/server/apply.ts';
import { renderInput, setEffectSource } from '../../src/server/engine.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { settings, DEFAULTS } from '../../src/server/settings.ts';
import { state, getLiveState } from '../../src/server/state.ts';
import { showStore } from '../../src/server/show-store.ts';
import { domainOf } from '../../src/server/protocol.ts';
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';
import { createRenderer, withInputDefaults } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile, profilesRevision, BUILTIN_PROFILE_ID } from '../../src/server/profiles.ts';
import LiveInput from '../../src/live-input.ts';

showStore.scheduleSave = () => {};   // never the real show file

// The defaults' band list: Hue Dynamics Party's three, then Disco's bass and voice (its treble is the party high).
const BANDS = [[20, 250], [250, 3000], [3000, 9000], [0, 160], [750, 2000]];
const KEY = BANDS.map(([lo, hi]) => `${lo}-${hi}`).join(',');

function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = () => { proc.killed = true; proc.emit('close', null); };
  return proc;
}

/** A line of the live input's, with a spectrum over the defaults' five bands. */
const line = (t, { rms = 0.1, bands = [1, 1, 1, 1, 1], type = 'state' } = {}) => JSON.stringify({
  type, t, captured: t + 0.035, beat: t * 2, bpm: 120, phase: 0, locked: true, energy: rms, onset: 0, flux: 0, rms, tension: 0,
  bands: { bass: rms }, spectrum: { power: 2, rms, dominantHz: 990.52734375, bands, fftPower: 10 },
});

/**
 * The integrations on stand-in sources and a real live input whose process
 * is a stand-in, the routes and sockets on one server, and the settings store
 * with its file write stubbed out, put back after.
 */
async function serve({ now } = {}) {
  const saved = settings.all();
  settings.save = () => {};
  settings._values = { ...settings.all(), audio: JSON.parse(JSON.stringify(DEFAULTS.audio)), live: { ...DEFAULTS.live } };
  const spawned = [];
  const live = new LiveInput({ now, spawner: (exe, args) => { spawned.push(args); return fakeProcess(); } });
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
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  const io = new Server(server);
  const integrations = setupIntegrations({
    io, midi,
    spotify: { ...idle, startPolling() {}, async getQueue() { return []; } },
    nowPlaying: idle,
    deezerSource: { ...idle, getQueue: () => [], updatePlayback() {}, updateQueue() {}, disconnect() {} },
    prolink, autoShow, liveInput: live,
  });
  const applier = createApplier({
    midi, spotify: { localCallbackUrl: '', setLoopbackPort() {}, configure() {} }, smtc: { start() {}, stop() {} },
    live, deezer: { init: async () => {} }, applyPatch() {}, broadcast: () => integrations.broadcast(),
  });
  attachRoutes(app, { integrations, applier });
  attachSockets(io, { midi, integrations });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body) => fetch(`${url}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  const clients = [];
  return {
    live, spawned, integrations, applier, call,
    client() {
      const socket = connect(url, { transports: ['websocket'], auth: { protocol: 2 }, forceNew: true });
      clients.push(socket);
      return new Promise((resolve) => socket.once('snapshot', () => resolve(socket)));
    },
    /** A few hops heard now, as the service writes them. */
    hear(from = 1, n = 5) { for (let i = 0; i < n; i++) live.handleLine(line(from + i * 0.0116)); },
    async close() {
      live.stop();
      for (const c of clients) c.close();
      io.close();
      await new Promise((r) => server.close(r));
      settings._values = saved;
      delete settings.save;
    },
  };
}

const until = async (done, what, ms = 2000) => {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('GET /api/audio returns the mode, master and listening state', async () => {
  const s = await serve();
  try {
    let res = await s.call('GET', '/api/audio');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(
      [res.body.mode, res.body.master, res.body.ldjTrigger, res.body.listening, res.body.levels],
      ['tempo', HD_MASTER_DEFAULTS, 0.3, false, null],
    );
    assert.deepStrictEqual(res.body.detectors.spl, { owner: { from: 'fallback', id: null, kind: null }, trigger: 0.3 });
    assert.deepStrictEqual(res.body.detectors.disco.owner, { from: 'fallback', id: null, kind: null });

    s.live.start({ source: 'loopback' });
    s.hear();
    res = await s.call('GET', '/api/audio');
    assert.strictEqual(res.body.listening, true);
    assert.deepStrictEqual(Object.keys(res.body.levels), ['full', 'bass', 'mid', 'high']);
    assert.ok(res.body.levels.full > 0);
    assert.deepStrictEqual(Object.keys(res.body.spl), ['db', 'level', 'beat', 'section']);
  } finally {
    await s.close();
  }
});

test('PUT /api/audio { mode: "reactive" } persists to settings and the engine input carries it', async () => {
  const s = await serve();
  try {
    assert.deepStrictEqual([renderInput().audioMode, renderInput().audio], ['tempo', null]);
    const res = await s.call('PUT', '/api/audio', { mode: 'reactive' });
    assert.strictEqual(res.status, 200, res.body.error);
    assert.deepStrictEqual(res.body.changed, ['audio.mode']);
    assert.strictEqual(res.body.settings.mode, 'reactive');
    assert.strictEqual(res.body.detectors.spl.trigger, 0.3, 'the trigger in force comes back, whoever owns it');
    assert.strictEqual(settings.get('audio.mode'), 'reactive');
    assert.strictEqual(renderInput().audioMode, 'reactive');

    // The master by field: the rest of it stays. Hue Dynamics' release runs to five seconds.
    await s.call('PUT', '/api/audio', { master: { threshold: 0.2 }, ldjTrigger: 0.1 });
    assert.deepStrictEqual(settings.get('audio.master'), { ...HD_MASTER_DEFAULTS, threshold: 0.2 });
    assert.deepStrictEqual(renderInput().master, { ...HD_MASTER_DEFAULTS, threshold: 0.2 });
    assert.strictEqual((await s.call('PUT', '/api/audio', { master: { releaseMs: 5000, attackMs: 2000 } })).status, 200);
    assert.deepStrictEqual(renderInput().master, { ...HD_MASTER_DEFAULTS, threshold: 0.2, releaseMs: 5000, attackMs: 2000 });
    assert.strictEqual(settings.get('audio.ldjTrigger'), 0.1);

    // And what is heard rides along with them.
    s.live.start({ source: 'loopback' });
    s.hear();
    const input = renderInput();
    assert.strictEqual(input.audio.t, 1 + 4 * 0.0116);
    assert.ok(input.audio.party.full > 0);
    assert.strictEqual(getLiveState().audio.mode, 'reactive', 'and the live state says so');
    assert.strictEqual(domainOf('audio'), 'audio');
  } finally {
    await s.close();
  }
});

test('PUT /api/audio with threshold 2 is 400', async () => {
  const s = await serve();
  try {
    for (const body of [{ master: { threshold: 2 } }, { mode: 'loud' }, { ldjTrigger: -0.1 }, { master: { attackMs: 2001 } },
      { master: { releaseMs: 5001 } }, { master: { releaseMs: 10.5 } }, { volume: 1 }]) {
      const res = await s.call('PUT', '/api/audio', body);
      assert.strictEqual(res.status, 400, JSON.stringify(body));
      assert.strictEqual(res.body.ok, false);
    }
    assert.deepStrictEqual(settings.group('audio'), DEFAULTS.audio, 'nothing was stored');
  } finally {
    await s.close();
  }
});

test('a socket subscribed to the audio topic receives frames; one that is not does not', async () => {
  const s = await serve();
  try {
    const watching = await s.client();
    const other = await s.client();
    const got = [];
    let otherGot = 0;
    watching.on('audio', (feed) => got.push(feed));
    other.on('audio', () => otherGot++);
    watching.emit('subscribe', ['audio']);
    await until(() => s.integrations.publisher.wants('feed:audio'), 'the subscription');
    await until(() => got.length >= 1, 'the first message');
    assert.strictEqual(got[0], null, 'nothing heard yet: no audio');

    s.live.start({ source: 'loopback' });
    s.hear();
    await until(() => got.some(Boolean), 'a frame');
    const feed = got.find(Boolean);
    assert.deepStrictEqual(Object.keys(feed), ['t', 'party', 'disco', 'spl']);
    assert.deepStrictEqual(Object.keys(feed.disco), ['gate', 'level', 'hit']);
    assert.strictEqual(feed.disco.hit.length, 3);

    // A page subscribing later gets what the others have, without waiting
    // for news: nothing new is heard after this, so the feed sends no more
    // until the audio goes stale.
    s.hear(3);
    await until(() => got.length && got[got.length - 1] && got[got.length - 1].t >= 3, 'the newest frame');
    const newest = got[got.length - 1];
    const late = [];
    other.on('audio', (f) => late.push(f));
    other.emit('subscribe', 'audio');
    await until(() => late.length >= 1, 'the late subscriber\'s copy');
    assert.deepStrictEqual(late[0], newest);
    other.emit('unsubscribe', ['audio']);
    await new Promise((r) => setTimeout(r, 50));
    const before = otherGot;
    const sent = got.length;
    s.hear(4);
    await until(() => got.length > sent, 'the next frame for the subscriber');
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(otherGot, before, 'not after unsubscribing');
  } finally {
    await s.close();
  }
});

test('the live state\'s audio is heard once a second; its settings and owners at once', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const s = await serve();
  try {
    s.live.start({ source: 'loopback' });
    t.mock.timers.tick(1000);
    s.hear();
    const first = getLiveState().audio;
    assert.strictEqual(first.listening, true);
    s.live.handleLine(line(1.06, { rms: 0.3 }));
    t.mock.timers.tick(500);
    s.applier.applyChanged(settings.update({ audio: { ldjTrigger: 0.2 } }));
    const between = getLiveState().audio;
    assert.deepStrictEqual([between.levels, between.ldjTrigger, between.detectors.spl.trigger], [first.levels, 0.2, 0.2],
      'a broadcast in between: the same levels, the new trigger');
    t.mock.timers.tick(500);
    assert.notDeepStrictEqual(getLiveState().audio.levels, first.levels, 'the next sweep hears the louder hop');
    assert.strictEqual(domainOf('audio'), 'audio');
  } finally {
    await s.close();
  }
});

test('the engine reads the hop the room hears now: the live input\'s latency, once', async () => {
  let liveNow = 10000;
  const s = await serve({ now: () => liveNow });
  try {
    s.live.start({ source: 'loopback', latencyMs: 300 });
    // Each hop written 35 ms of capture after its frame time, as it is captured.
    for (let i = 0; i < 60; i++) { s.live.handleLine(line(1 + i * 0.0116)); liveNow += 11.6; }
    liveNow -= 11.6;
    // The room hears stream time (last capture − 300 ms): 23 hops back from the newest.
    const want = 1 + (59 - 23) * 0.0116;
    assert.ok(Math.abs(renderInput().audio.t - want) < 1e-9, `${renderInput().audio.t} ≠ ${want}`);
    s.live.start({ source: 'loopback', latencyMs: 0 });
    assert.ok(Math.abs(renderInput().audio.t - (1 + 59 * 0.0116)) < 1e-9, 'none: the newest');
  } finally {
    await s.close();
  }
});

test('a latency raised while listening holds the hop the rig has until the room catches up: none is handed out twice', async () => {
  let liveNow = 10000;
  const s = await serve({ now: () => liveNow });
  try {
    s.live.start({ source: 'loopback', latencyMs: 0 });
    const seen = [];
    const hop = (i) => { s.live.handleLine(line(1 + i * 0.0116)); seen.push(renderInput().audio.t); liveNow += 11.6; };
    for (let i = 0; i < 40; i++) hop(i);
    const before = seen[seen.length - 1];
    s.applier.applyChanged(settings.update({ live: { enabled: true, latencyMs: 300 } }));
    assert.strictEqual(s.spawned.length, 1, 'a latency is no restart');
    for (let i = 40; i < 80; i++) hop(i);
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], `hop ${i}: ${seen[i]} after ${seen[i - 1]}`);
    assert.strictEqual(seen[41], before, 'held');
    assert.ok(seen[seen.length - 1] > before, 'and on again once the room hears past it');
    assert.ok(Math.abs(seen[seen.length - 1] - (1 + (79 - 23) * 0.0116)) < 1e-9, '300 ms behind, as before the raise');
  } finally {
    await s.close();
  }
});

// The detectors run on the settings of the Visualizer or Disco that plays: the
// base look's own effect counts, once the room may see what the Visualizer flashes.
test('the detectors take the base look\'s effect, validated, when the photosensitivity acknowledgement admits it', async () => {
  const s = await serve();
  const pattern = state.pattern;
  try {
    const visualizer = { kind: 'ldj.visualizer', params: { trigger: 0.1 } };
    setEffectSource((id) => (id === 'vis' ? visualizer : id === 'broken' ? { kind: 'ldj.visualizer', params: { trigger: 7 } } : null));
    state.pattern = 'vis';
    assert.deepStrictEqual(renderInput().effect, visualizer, 'the engine plays it as the base');
    assert.deepStrictEqual(renderInput().safety, { hdFlashIntervalMs: 350, acknowledged: false }, 'with the settings\' safety, always');
    let res = await s.call('GET', '/api/audio');
    assert.strictEqual(res.body.detectors.spl.owner.from, 'fallback', 'a Visualizer nobody may see owns nothing');
    settings._values = { ...settings._values, safety: { ...settings._values.safety, photosensitivityAcknowledged: true } };
    res = await s.call('GET', '/api/audio');
    assert.deepStrictEqual(res.body.detectors.spl.owner, { from: 'base', id: 'base:vis', kind: 'ldj.visualizer' });
    assert.strictEqual(res.body.detectors.spl.trigger, 0.1, 'its trigger, as validated');
    state.pattern = 'broken';
    res = await s.call('GET', '/api/audio');
    assert.strictEqual(res.body.detectors.spl.owner.from, 'fallback', 'an effect that does not validate owns no detector');
    assert.throws(() => validateSpec({ kind: 'ldj.visualizer', params: { trigger: 7 } }));
  } finally {
    setEffectSource(null);
    state.pattern = pattern;
    await s.close();
  }
});

test('a hand-built render input reads as no audio, tempo and the master\'s defaults; what the engine passes stands', () => {
  const PAR = { id: 0, address: 1, universe: 0, profileId: BUILTIN_PROFILE_ID, maxBrightness: 255, override: null,
    position: null, group: null, geometry: null, hue: false };
  const hand = {
    running: true, pattern: 'solid', colorA: 0, colorB: 5, colorC: 0, colorD: 5, beatDivision: 1, split: null, pixelMap: 'stage',
    strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false, energy: null, showDynamics: null,
    patternAnchor: null, fade: null, syncTest: null, universes: [0], fixtures: [PAR],
  };
  const filled = withInputDefaults(hand);
  assert.deepStrictEqual([filled.audio, filled.audioMode, filled.master], [null, 'tempo', HD_MASTER_DEFAULTS]);
  assert.notStrictEqual(filled.master, HD_MASTER_DEFAULTS, 'a copy: nothing downstream can edit the defaults');
  assert.strictEqual(filled.fixtures, hand.fixtures);
  assert.ok(!('audio' in hand) && !('audioMode' in hand) && !('master' in hand), 'the caller\'s input is left as it was');
  const audio = { t: 1 };
  const master = { ...HD_MASTER_DEFAULTS, threshold: 0.4 };
  const given = withInputDefaults({ ...hand, audio, audioMode: 'reactive', master });
  assert.deepStrictEqual([given.audio, given.audioMode, given.master], [audio, 'reactive', master]);
  assert.strictEqual(given.master, master);
  // And the renderer takes the hand-built input as it always did.
  const store = universes.createUniverseStore(universes.allocateShared());
  createRenderer({ profileOf: getProfile, profilesRevision, now: 0 }).frame(hand, { beatPos: 0, bpm: 120, epoch: 0 }, 0, store);
  const ch = getProfile(PAR).channelMap;
  assert.deepStrictEqual([store.getBuffer(0)[ch.dimmer], store.getBuffer(0)[ch.red]], [255, 255], 'solid red, as before');
});

test('the live director and the audio features both hear every reading', async () => {
  const s = await serve();
  try {
    state.autoSource = 'live';
    s.live.start({ source: 'loopback' });
    s.hear();
    assert.strictEqual(s.integrations.startAutoShow(), 'live');
    // Silence darkens the director's rig; sound after it brings it back, from a reading.
    s.live.handleLine(JSON.stringify({ type: 'event', event: { t: 1, type: 'SILENCE', confidence: 1, intensity: 0, duration: 0, effect: 'kill' } }));
    assert.strictEqual(getLiveState().live.director.silent, true);
    s.hear(2, 1);
    assert.strictEqual(getLiveState().live.director.silent, false, 'the director heard it');
    assert.strictEqual(s.integrations.audio.features.frame().t, 2, 'and so did the audio features');
    s.integrations.stopAutoShow();
  } finally {
    state.autoSource = 'auto';
    await s.close();
  }
});

test('a settings apply, a restart and the return from the Python setup keep the bands', async () => {
  const s = await serve();
  try {
    const bandsOf = (args) => args[args.indexOf('--bands') + 1];
    settings.update({ live: { enabled: true } });
    s.applier.applyChanged(['live.enabled']);
    assert.strictEqual(s.spawned.length, 1);
    assert.strictEqual(bandsOf(s.spawned[0]), KEY);

    // The latency moved: nothing restarts, and the bands stay.
    s.applier.applyChanged(settings.update({ live: { latencyMs: 40 } }));
    assert.strictEqual(s.spawned.length, 1);
    assert.deepStrictEqual(s.live.options.bands, BANDS);
    assert.strictEqual(s.live.options.latencyMs, 40);

    // Another device restarts it, with the bands.
    s.applier.applyChanged(settings.update({ live: { device: 'Line In' } }));
    assert.strictEqual(s.spawned.length, 2);
    assert.strictEqual(bandsOf(s.spawned[1]), KEY);

    // The Python setup stops it and starts it again from its options.
    const before = s.live.options;
    s.live.stop();
    s.live.start(before);
    assert.strictEqual(bandsOf(s.spawned[2]), KEY);

    // The same bands asked for again: no restart.
    s.live.refreshBands();
    assert.strictEqual(s.spawned.length, 3);

    // A line summed over them is heard.
    s.live.handleLine(line(1));
    assert.strictEqual(s.integrations.audio.features.frame().t, 1);
  } finally {
    await s.close();
  }
});
