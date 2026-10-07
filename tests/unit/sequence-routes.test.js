// The sequencer's routes (src/server/routes/sequence.ts) and its place in the
// server (integrations.ts): the shelf, the sequence loaded, the transport;
// the engine playing it, the live state carrying its status, the audio
// detectors hearing its clips, a hand on the master ending its automation,
// and the photosensitivity gate at play.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';

import { attachRoutes } from '../../src/server/routes.ts';
import { setupIntegrations } from '../../src/server/integrations.ts';
import { EffectLibrary } from '../../src/server/effect-library.ts';
import { PaletteStore } from '../../src/server/palette-store.ts';
import { SequenceStore } from '../../src/server/sequence-store.ts';
import { startEngine, stopEngine, renderInput } from '../../src/server/engine.ts';
import { applyPatch, processTap } from '../../src/server/patch.ts';
import { conductor } from '../../src/server/conductor.ts';
import { state, getLiveState } from '../../src/server/state.ts';
import { settings } from '../../src/server/settings.ts';
import { showStore } from '../../src/server/show-store.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile } from '../../src/server/profiles.ts';
import { BUILTIN_PALETTES, presetById } from '../../src/shared/effects/index.ts';

showStore.scheduleSave = () => {};   // never the real show file

test.after(() => stopEngine());

/** The routes on stand-in sources, with a library, palettes and a shelf of their own in a throwaway directory. */
async function serve(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sequence-routes-'));
  const effectLibrary = new EffectLibrary(path.join(dir, 'effects.json')).load();
  const paletteStore = new PaletteStore(path.join(dir, 'palettes.json'), { seed: () => [1, 2, 3, 4] }).load();
  const sequenceStore = new SequenceStore(path.join(dir, 'sequences.json')).load();
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
    prolink, autoShow, effectLibrary, paletteStore, sequenceStore,
  });
  attachRoutes(app, { integrations, applier: { applyChanged() {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const look = { pattern: state.pattern, masterDimmer: state.masterDimmer, bpm: state.bpm };
  // The settings in memory, unacknowledged; nothing set here is written.
  const values = settings._values;
  const ownSave = Object.hasOwn(settings, 'save') ? settings.save : null;
  settings._values = { ...values, safety: { ...values.safety, photosensitivityAcknowledged: false } };
  settings.save = () => {};
  t.after(async () => {
    settings._values = values;
    if (ownSave) settings.save = ownSave;
    else delete settings.save;
    applyPatch({ ...look, energyOverride: null, paletteOverride: null });
    io.close();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = (method, route, body) => fetch(`${url}${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  /** One engine frame of the sequencer, at the clock's beat now. */
  const frame = () => integrations.sequence.sequencer.frame(conductor.now());
  return { call, integrations, sequenceStore, frame, dir };
}

const GLOW = { kind: 'energy.glow', params: {} };
const lane = (id) => ({ id, kind: 'shared', name: id, mute: false, solo: false });
const clip = (id, startBeat, lengthBeats, effect = GLOW) => ({ id, laneId: 'a', startBeat, lengthBeats, effect, targets: 'lane', mute: false });
const SET = { id: 'set-1', name: 'Set one', lanes: [lane('a')], clips: [clip('A', 0, 4), clip('B', 4, 4)] };

test('routes: CRUD + transport + status', async (t) => {
  const s = await serve(t);
  // ── The shelf ──
  let res = await s.call('GET', '/api/sequences');
  assert.deepEqual([res.status, res.body.sequences], [200, []]);
  res = await s.call('POST', '/api/sequences', SET);
  assert.equal(res.status, 201);
  assert.equal(res.body.sequence.id, 'set-1');
  assert.equal(res.body.sequence.mode, 'arrangement', 'filled in with its defaults');
  res = await s.call('POST', '/api/sequences', SET);
  assert.equal(res.status, 409, 'that id is taken');
  // Without an id, it gets one of its own.
  res = await s.call('POST', '/api/sequences', { name: 'Unnamed', lanes: [lane('a')] });
  assert.equal(res.status, 201);
  const made = res.body.sequence.id;
  assert.ok(made && made !== 'set-1');
  res = await s.call('POST', '/api/sequences', { name: 'Bad', lanes: [lane('a')], clips: [clip('x', -1, 4)] });
  assert.equal(res.status, 400);
  res = await s.call('GET', '/api/sequences');
  assert.deepEqual(res.body.sequences.map((q) => q.id), ['set-1', made]);
  res = await s.call('GET', '/api/sequences/set-1');
  assert.deepEqual([res.status, res.body.sequence.name], [200, 'Set one']);
  assert.equal((await s.call('GET', '/api/sequences/nope')).status, 404);
  res = await s.call('PUT', '/api/sequences/set-1', { ...SET, id: 'ignored', name: 'Set one, edited' });
  assert.deepEqual([res.status, res.body.sequence.id, res.body.sequence.name], [200, 'set-1', 'Set one, edited']);
  assert.equal((await s.call('PUT', '/api/sequences/nope', SET)).status, 404);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'sequences.json'), 'utf8')).sequences.length, 2, 'saved');
  assert.equal((await s.call('DELETE', `/api/sequences/${made}`)).status, 200);
  assert.equal((await s.call('DELETE', `/api/sequences/${made}`)).status, 404);

  // ── The sequence loaded ──
  res = await s.call('GET', '/api/sequence');
  assert.deepEqual([res.body.sequence, res.body.status.loaded], [null, null]);
  // Nothing loaded: the transport has nothing to play.
  assert.equal((await s.call('POST', '/api/sequence/play')).status, 409);
  // Loaded from the shelf by its id; an id nothing has is a 404.
  assert.equal((await s.call('PUT', '/api/sequence', { id: 'nope' })).status, 404);
  res = await s.call('PUT', '/api/sequence', { id: 'set-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.sequence.name, 'Set one, edited');
  assert.deepEqual(res.body.status.loaded, { id: 'set-1', name: 'Set one, edited' });
  assert.equal(res.body.status.playing, false, 'loading plays nothing');
  // Or whole: an edit of the loaded one, apart from the shelf.
  res = await s.call('PUT', '/api/sequence', { ...SET, name: 'Live edit' });
  assert.deepEqual(res.body.status.loaded, { id: 'set-1', name: 'Live edit' });
  assert.equal((await s.call('GET', '/api/sequences/set-1')).body.sequence.name, 'Set one, edited', 'the shelf keeps its own');
  assert.equal((await s.call('PUT', '/api/sequence', { ...SET, clips: [clip('A', 0, 0)] })).status, 400);

  // ── The transport ──
  res = await s.call('POST', '/api/sequence/play');
  assert.deepEqual([res.status, res.body.status.playing], [200, true]);
  s.frame();
  res = await s.call('GET', '/api/sequence/status');
  assert.deepEqual(res.body.status.lanes, [{ id: 'a', clip: 'A' }]);
  await s.call('POST', '/api/sequence/next');
  s.frame();
  assert.deepEqual((await s.call('GET', '/api/sequence/status')).body.status.lanes, [{ id: 'a', clip: 'B' }]);
  await s.call('POST', '/api/sequence/prev');
  s.frame();
  assert.equal((await s.call('GET', '/api/sequence/status')).body.status.lanes[0].clip, 'A');
  await s.call('POST', '/api/sequence/jump/B');
  s.frame();
  assert.equal((await s.call('GET', '/api/sequence/status')).body.status.lanes[0].clip, 'B');
  assert.equal((await s.call('POST', '/api/sequence/jump/nope')).status, 404);
  await s.call('POST', '/api/sequence/seek/2');
  s.frame();
  res = await s.call('GET', '/api/sequence/status');
  assert.ok(res.body.status.beat >= 2 && res.body.status.beat < 2.5, `beat ${res.body.status.beat}`);
  assert.equal((await s.call('POST', '/api/sequence/seek/abc')).status, 400);
  assert.equal((await s.call('POST', '/api/sequence/seek/%20')).status, 400, 'a blank is no beat');
  assert.equal((await s.call('POST', '/api/sequence/resync/phrase')).status, 400);
  assert.equal((await s.call('POST', '/api/sequence/resync/bar')).status, 200);
  s.frame();
  assert.ok((await s.call('GET', '/api/sequence/status')).body.status.beat < 0.5, 'the bar\'s start');
  await s.call('POST', '/api/sequence/shuffle');
  s.frame();
  assert.equal((await s.call('GET', '/api/sequence/status')).body.status.lanes[0].clip, 'B', 'the one that was not playing');
  res = await s.call('POST', '/api/sequence/loop', { on: true, startBeat: 0, endBeat: 8 });
  assert.deepEqual(res.body.status.loop, { on: true, startBeat: 0, endBeat: 8 });
  assert.equal((await s.call('POST', '/api/sequence/loop', { on: true, startBeat: 4, endBeat: 2 })).status, 400);
  res = await s.call('POST', '/api/sequence/pause');
  assert.deepEqual([res.body.status.playing, res.body.status.paused], [false, true]);
  res = await s.call('POST', '/api/sequence/play');
  assert.deepEqual([res.body.status.playing, res.body.status.paused], [true, false]);
  res = await s.call('POST', '/api/sequence/stop');
  assert.deepEqual([res.body.status.playing, res.body.status.stopped], [false, 'hold']);
  res = await s.call('POST', '/api/sequence/stop?blackout=1');
  assert.equal(res.body.status.stopped, 'black');
  // The live state carries the same status, in its own domain.
  assert.deepEqual(getLiveState().sequence, s.integrations.sequence.sequencer.status());
});

test('the live state lists the saved sequences and patterns, and every page hears of a save, a rename or a delete', async (t) => {
  const s = await serve(t);
  const published = [];
  const patterns = [];
  const publish = s.integrations.publisher.publishState;
  s.integrations.publisher.publishState = (live) => {
    published.push(live.sequences);
    patterns.push(live.sequencePatterns);
    return publish.call(s.integrations.publisher, live);
  };
  t.after(() => { s.integrations.publisher.publishState = publish; });
  assert.deepEqual(getLiveState().sequences, []);
  await s.call('POST', '/api/sequences', SET);
  assert.deepEqual(published.at(-1), [{ id: 'set-1', name: 'Set one' }], 'a save is broadcast');
  await s.call('PUT', '/api/sequences/set-1', { ...SET, name: 'Renamed' });
  assert.deepEqual(published.at(-1), [{ id: 'set-1', name: 'Renamed' }]);
  await s.call('DELETE', '/api/sequences/set-1');
  assert.deepEqual(published.at(-1), []);
  assert.deepEqual(getLiveState().sequences, []);
  const made = await s.call('POST', '/api/sequence/patterns', { name: 'Drop', lengthBeats: 4, lanes: [] });
  assert.deepEqual(patterns.at(-1), [{ id: made.body.pattern.id, name: 'Drop', lengthBeats: 4 }], 'a pattern saved is broadcast');
  await s.call('DELETE', `/api/sequence/patterns/${made.body.pattern.id}`);
  assert.deepEqual(patterns.at(-1), []);
});

test('the engine plays the loaded sequence from the sequencer the server registers', async (t) => {
  const s = await serve(t);
  const artnet = state.artnet.enabled;
  state.artnet.enabled = false;   // nothing leaves this machine
  t.after(async () => {
    await stopEngine();
    state.artnet.enabled = artnet;
  });
  applyPatch({ pattern: 'solid', colorA: 0, running: true, masterDimmer: 255, masterBlackout: false });
  const first = state.fixtures[0];
  const green = () => {
    const ch = getProfile(first).channelMap;
    const dmx = universes.getBuffer(first.universe ?? state.artnet.universe);
    return dmx[first.address - 1 + ch.green] === 255 && dmx[first.address - 1 + ch.red] === 0;
  };
  // The look is red; the clip green.
  await s.call('PUT', '/api/sequence', { ...SET, clips: [clip('G', 0, 1e6, { kind: 'ldj.MatrixSolid', params: { cadence: 1, beats: 32 }, palette: ['#00FF00'] })] });
  startEngine({ thread: 'main' });
  await wait(100);
  assert.equal(renderInput().sequenceTransport, null, 'loaded is not playing');
  assert.equal(green(), false);
  await s.call('POST', '/api/sequence/play');
  assert.ok(await until(green, 1000), 'playing: the clip is the rig\'s base');
  assert.ok(renderInput().sequenceTransport, 'the engine hands the renderer a transport');
  assert.equal(renderInput().sequenceRevision, s.integrations.sequence.sequencer.revision());
  assert.equal(getLiveState().sequence.playing, true);

  // Stopped, the sequence holds its picture: the look stays under it until the sequence is unloaded.
  const red = () => {
    const ch = getProfile(first).channelMap;
    const dmx = universes.getBuffer(first.universe ?? state.artnet.universe);
    return dmx[first.address - 1 + ch.red] === 255 && dmx[first.address - 1 + ch.green] === 0;
  };
  await s.call('POST', '/api/sequence/stop');
  await wait(100);
  assert.equal(red(), false, 'stopped: not the look yet');
  const revision = s.integrations.sequence.sequencer.revision();
  let res = await s.call('DELETE', '/api/sequence');
  assert.deepEqual([res.status, res.body.ok, res.body.status.loaded, res.body.status.playing], [200, true, null, false]);
  assert.ok(res.body.status.revision > revision, 'a new revision: the pages and the engine drop the table');
  assert.ok(await until(red, 1000), 'unloaded: the look is back on the rig');
  assert.equal((await s.call('GET', '/api/sequence')).body.sequence, null);
  assert.equal(getLiveState().sequence.loaded, null);
  // Nothing loaded: unloading again is no error, and the transport answers as it does with none.
  res = await s.call('DELETE', '/api/sequence');
  assert.deepEqual([res.status, res.body.status.loaded], [200, null]);
  assert.equal((await s.call('POST', '/api/sequence/play')).status, 409);
});

test('unloading the sequence drops a take that was running', async (t) => {
  const s = await serve(t);
  await s.call('PUT', '/api/sequence', SET);
  assert.equal((await s.call('POST', '/api/sequence/record', { mode: 'overdub' })).status, 200);
  assert.ok(getLiveState().sequence.recording);
  const res = await s.call('DELETE', '/api/sequence');
  assert.deepEqual([res.status, res.body.status.loaded, res.body.status.recording], [200, null, undefined]);
  assert.equal((await s.call('POST', '/api/sequence/record/stop', { keep: true })).status, 409, 'nothing is recording any more');
});

test('the audio detectors run on the settings of a Disco playing as a clip', async (t) => {
  const s = await serve(t);
  const { bands } = presetById('hd.disco.rock').spec.params;
  await s.call('PUT', '/api/sequence', { ...SET, clips: [clip('D', 0, 1e6, presetById('hd.disco.rock').spec)] });
  assert.equal(s.integrations.audio.detectors().disco.owner.from, 'fallback', 'loaded is not playing');
  await s.call('POST', '/api/sequence/play');
  s.frame();
  const { disco } = s.integrations.audio.detectors();
  assert.equal(disco.owner.from, 'clip');
  assert.match(disco.owner.id, /^clip:D:/);
  assert.deepEqual(disco.bands, bands);
  // Stopped, its picture holds but nothing of it plays: the settings again.
  await s.call('POST', '/api/sequence/stop');
  s.frame();
  assert.equal(s.integrations.audio.detectors().disco.owner.from, 'fallback');
});

test('play is refused (409) while a clip needs the photosensitivity acknowledgement, and goes once it is given', async (t) => {
  const s = await serve(t);
  const fast = { kind: 'ldj.StrobeCycle', params: { cadence: 0.25 } };
  await s.call('PUT', '/api/sequence', { ...SET, clips: [clip('A', 0, 4), clip('F', 4, 4, fast)], options: { initialPalette: 'redCyan' } });
  const before = state.paletteOverride;
  let res = await s.call('POST', '/api/sequence/play');
  assert.deepEqual([res.status, res.body.error], [409, 'photosensitivity acknowledgement required']);
  assert.equal(s.integrations.sequence.sequencer.status().playing, false);
  assert.equal(state.paletteOverride, before, 'a refused start puts nothing on');
  res = await s.call('POST', '/api/safety/acknowledge');
  assert.equal(res.status, 200);
  res = await s.call('POST', '/api/sequence/play');
  assert.deepEqual([res.status, res.body.status.playing], [200, true]);
  assert.deepEqual(state.paletteOverride.map((c) => [c.r, c.g, c.b]), [[255, 0, 0], [0, 191, 255]], 'its first palette on');
});

test('a hand on the master or the tempo ends the sequence\'s automation of it; its own commands and samples do not', async (t) => {
  const s = await serve(t);
  applyPatch({ masterDimmer: 100, bpm: 120 });
  await s.call('PUT', '/api/sequence', {
    ...SET, clips: [clip('A', 0, 1e6)],
    automation: {
      brightness: { mode: 'triangle', period: 1, min: 0, max: 200, growing: true },
      tempo: { mode: 'triangle', period: 1, min: 100, max: 140, growing: true },
    },
  });
  await s.call('POST', '/api/sequence/play');
  s.frame();
  const automation = () => s.integrations.sequence.sequencer._automation;
  // Its own samples go through the patch as the sequence's: nothing ends.
  await wait(60);
  s.frame();
  assert.ok(automation().brightness && automation().tempo);
  // A hand on the master: that one ends, the tempo's goes on.
  applyPatch({ masterDimmer: 10 });
  assert.equal(automation().brightness, null);
  assert.ok(automation().tempo);
  s.frame();
  assert.equal(state.masterDimmer, 10, 'the hand\'s level stays');
  // A tapped tempo ends the tempo's.
  processTap();
  processTap();
  assert.equal(automation().tempo, null);
  // The palette override a hand puts on is what the random palette on loop picks against.
  applyPatch({ paletteOverride: ['#FF0000', '#00BFFF'] });
  assert.deepEqual(s.integrations.sequence.sequencer._current().paletteOverride, ['#FF0000', '#00BFFF']);
  applyPatch({ paletteOverride: null });
  assert.equal(s.integrations.sequence.sequencer._current().paletteOverride, null);
});

test('a sequence\'s audio mode that the settings file will not take leaves the mode, and the sequence plays', async (t) => {
  const s = await serve(t);
  t.mock.method(console, 'warn', () => {});
  const mode = settings.get('audio.mode');
  settings.save = () => { throw new Error('read-only disk'); };
  await s.call('PUT', '/api/sequence', { ...SET, musicMode: mode === 'reactive' ? 'tempo' : 'reactive' });
  const res = await s.call('POST', '/api/sequence/play');
  assert.deepEqual([res.status, res.body.status.playing], [200, true]);
  assert.equal(settings.get('audio.mode'), mode);
});

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await wait(10);
  return check();
}

// The built-in palettes the random palette on loop picks from are all a palette the store resolves.
test('every built-in palette resolves through the palette store the server hands the sequencer', async (t) => {
  const s = await serve(t);
  for (const p of BUILTIN_PALETTES) assert.ok(s.integrations.library.palettes.materialize(p.id)?.length, p.id);
});
