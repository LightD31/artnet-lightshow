// The effect library's routes (src/server/routes/effects.ts): the built-in
// catalogue and the presets and palettes saved here, edited over REST, and
// commands to the effect on stage.

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
import { startEngine, stopEngine, setEffectSource } from '../../src/server/engine.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { state } from '../../src/server/state.ts';
import { PALETTES } from '../../src/server/palettes.ts';
import { showStore } from '../../src/server/show-store.ts';
import { BUILTIN_PALETTES, CATALOGUE, FAMILIES } from '../../src/shared/effects/index.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { acknowledgeFlashes } from '../helpers/acknowledged.js';

showStore.scheduleSave = () => {};   // never the real show file

// applyPatch re-arms the beat timer, which would otherwise hold the process open.
test.after(() => stopEngine());

/**
 * The routes on stand-in sources, with a library and palettes of their own
 * in a throwaway directory: never the operator's config/.
 */
async function serve(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'effects-routes-'));
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
  attachRoutes(app, { integrations, applier: { applyChanged() {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const pattern = state.pattern;
  t.after(async () => {
    applyPatch({ pattern });
    io.close();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = (method, route, body) => fetch(`${url}${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  return { call, integrations, effectLibrary, paletteStore, dir };
}

const FADE = { kind: 'ldj.FadeCycle', params: { cadence: 2 } };
// Faster than the photosensitivity threshold, though it does not say so itself.
const FAST = { kind: 'ldj.StrobeCycle', params: { cadence: 0.25 }, rapidFlash: false };
const json = (value) => JSON.parse(JSON.stringify(value));

test('GET /api/effects lists families, built-ins, user presets and both palette lists', async (t) => {
  const s = await serve(t);
  const preset = s.effectLibrary.create({ name: 'Mine', spec: FADE });
  const palette = s.paletteStore.create({ name: 'Mine', colours: ['#FF0000', 'random'] });
  const res = await s.call('GET', '/api/effects');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.families, json(FAMILIES));
  assert.deepEqual(res.body.builtin, json(CATALOGUE));
  assert.equal(res.body.builtin.length, 214);
  assert.deepEqual(res.body.user, [preset]);
  assert.deepEqual(res.body.palettes, { builtin: json(BUILTIN_PALETTES), user: [palette] });
  assert.equal(res.body.palettes.builtin.length, 28);
  assert.deepEqual(res.body.palettes.user[0].colours, ['#FF0000', { random: true }]);

  // The look palettes keep their route and its answer.
  const legacy = await s.call('GET', '/api/palettes');
  assert.deepEqual(legacy.body, { ok: true, palettes: json(PALETTES), palette: state.palette });

  // One preset by id or alias, with what the list carries.
  let one = await s.call('GET', '/api/effects/white-strobe');
  assert.equal(one.status, 200);
  assert.equal(one.body.source, 'builtin');
  assert.equal(one.body.preset.id, 'energy.whiteStrobe');
  one = await s.call('GET', `/api/effects/${preset.id}`);
  assert.deepEqual(one.body, { ok: true, source: 'user', preset });
  one = await s.call('GET', '/api/effects/no-such-effect');
  assert.equal(one.status, 404);
  assert.equal(one.body.ok, false);
});

test('POST/PUT/DELETE round trip', async (t) => {
  const s = await serve(t);

  let res = await s.call('POST', '/api/effects', { name: 'Slow fade', spec: FADE });
  assert.equal(res.status, 201);
  const { preset } = res.body;
  assert.equal(preset.name, 'Slow fade');
  assert.deepEqual(preset.spec, validateSpec(FADE));
  assert.deepEqual(s.effectLibrary.list().user, [preset]);

  res = await s.call('PUT', `/api/effects/${preset.id}`, { name: 'Slower fade', spec: { kind: 'ldj.FadeCycle', params: { cadence: 4 } } });
  assert.equal(res.status, 200);
  assert.equal(res.body.preset.name, 'Slower fade');
  assert.equal(res.body.preset.spec.params.cadence, 4);
  const edited = res.body.preset;

  // Refused edits leave the preset as it was.
  res = await s.call('PUT', `/api/effects/${preset.id}`, { spec: { kind: 'no.such.kind' } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /unknown effect kind/);
  res = await s.call('PUT', `/api/effects/${preset.id}`, { effect: FADE });
  assert.equal(res.status, 400);
  res = await s.call('POST', '/api/effects', { name: 'Nope', spec: { ...FADE, palette: ['random'] } });
  assert.equal(res.status, 400);
  assert.deepEqual(s.effectLibrary.list().user, [edited]);

  // A built-in, by id or alias, is nobody's to edit.
  for (const id of ['energy.whiteStrobe', 'white-strobe', 'position-chase']) {
    res = await s.call('PUT', `/api/effects/${id}`, { name: 'Mine now' });
    assert.equal(res.status, 404, id);
    assert.match(res.body.error, /built-in/);
    res = await s.call('DELETE', `/api/effects/${id}`);
    assert.equal(res.status, 404, id);
  }
  res = await s.call('PUT', '/api/effects/no-such-effect', { name: 'x' });
  assert.equal(res.status, 404);

  res = await s.call('DELETE', `/api/effects/${preset.id}`);
  assert.deepEqual([res.status, res.body], [200, { ok: true }]);
  assert.deepEqual(s.effectLibrary.list().user, []);
  res = await s.call('DELETE', `/api/effects/${preset.id}`);
  assert.equal(res.status, 404);
  res = await s.call('GET', `/api/effects/${preset.id}`);
  assert.equal(res.status, 404);

  // Palettes the same way; the look palettes' singular route is untouched.
  res = await s.call('POST', '/api/palettes', { name: 'Sunset', colours: ['#ff8800', 'random'] });
  assert.equal(res.status, 201);
  const { palette } = res.body;
  assert.deepEqual(palette.colours, ['#FF8800', { random: true }]);
  res = await s.call('PUT', `/api/palettes/${palette.id}`, { colours: ['#000000', '#FFFFFF'] });
  assert.deepEqual([res.status, res.body.palette.colours], [200, ['#000000', '#FFFFFF']]);
  res = await s.call('PUT', `/api/palettes/${palette.id}`, { colours: Array(9).fill('#FFFFFF') });
  assert.equal(res.status, 400);
  res = await s.call('PUT', '/api/palettes/redCyan', { name: 'Mine now' });
  assert.equal(res.status, 404);
  res = await s.call('DELETE', '/api/palettes/redCyan');
  assert.equal(res.status, 404);
  res = await s.call('DELETE', `/api/palettes/${palette.id}`);
  assert.deepEqual([res.status, res.body], [200, { ok: true }]);
  assert.deepEqual(s.paletteStore.list(), []);
  res = await s.call('POST', `/api/palette/${PALETTES[0].id}`);
  assert.equal(res.status, 200);
});

test('a full library is a 400; a disk that will not take the write is a 500, not the client\'s fault', async (t) => {
  const s = await serve(t);
  const warn = t.mock.method(console, 'warn', () => {});
  const error = t.mock.method(console, 'error', () => {});
  t.mock.method(s.effectLibrary, 'write', () => { throw new Error('disk full'); });
  let res = await s.call('POST', '/api/effects', { name: 'Lost', spec: FADE });
  assert.equal(res.status, 500);
  assert.match(res.body.error, /disk full/);
  t.mock.method(s.paletteStore, 'write', () => { throw new Error('disk full'); });
  res = await s.call('POST', '/api/palettes', { name: 'Lost', colours: ['#FFFFFF'] });
  assert.equal(res.status, 500);
  assert.ok(warn.mock.callCount() >= 2 && error.mock.callCount() >= 2);

  t.mock.restoreAll();
  for (let i = 0; i < 128; i++) s.paletteStore.create({ name: `P${i}`, colours: ['#FFFFFF'] });
  res = await s.call('POST', '/api/palettes', { name: 'One too many', colours: ['#FFFFFF'] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /full/);
});

test('saving a new spec over the preset on stage is 409 until acknowledged; a preset not on stage saves', async (t) => {
  const s = await serve(t);
  const onStage = s.effectLibrary.create({ name: 'On stage', spec: FADE });
  const offStage = s.effectLibrary.create({ name: 'Off stage', spec: FADE });
  applyPatch({ pattern: onStage.id });

  let res = await s.call('PUT', `/api/effects/${onStage.id}`, { spec: FAST });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /photosensitivity acknowledgement required/);
  assert.deepEqual(s.effectLibrary.get(onStage.id).preset, onStage);
  assert.equal(s.effectLibrary.revision(), 2);
  // A rename of the one on stage plays nothing new.
  res = await s.call('PUT', `/api/effects/${onStage.id}`, { name: 'Still on stage' });
  assert.equal(res.status, 200);

  // Editing the library is not playing it.
  res = await s.call('PUT', `/api/effects/${offStage.id}`, { spec: FAST });
  assert.equal(res.status, 200);
  res = await s.call('POST', '/api/effects', { name: 'Fast', spec: FAST });
  assert.equal(res.status, 201);

  const restore = acknowledgeFlashes();
  try {
    res = await s.call('PUT', `/api/effects/${onStage.id}`, { spec: FAST });
    assert.equal(res.status, 200);
    assert.equal(res.body.preset.spec.params.cadence, 0.25);
  } finally {
    restore();
  }
});

test('POST /api/effects/command with a non-studio base is 409', async (t) => {
  const s = await serve(t);
  const artnet = state.artnet.enabled;
  state.artnet.enabled = false;   // nothing leaves this machine
  t.after(async () => {
    await stopEngine();
    setEffectSource(null);
    state.artnet.enabled = artnet;
  });

  // No engine running: nothing can take it.
  let res = await s.call('POST', '/api/effects/command', { cmd: 'toggleDirection' });
  assert.equal(res.status, 409);
  assert.equal(res.body.status, 'unavailable');

  // The look the library plays, as the engine will ask it once presets are patterns.
  setEffectSource((id) => s.effectLibrary.resolve(id));
  const studio = s.effectLibrary.create({ name: 'Swirl', spec: { kind: 'ldj.StudioSwirl', params: {} } });
  const fade = s.effectLibrary.create({ name: 'Fade', spec: FADE });
  applyPatch({ pattern: 'solid', running: true, masterDimmer: 255, masterBlackout: false });
  startEngine({ thread: 'main' });

  // A pattern, and an effect that takes no commands.
  res = await s.call('POST', '/api/effects/command', { cmd: 'toggleDirection' });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.status, 'unsupported');
  assert.equal(typeof res.body.seq, 'number');
  applyPatch({ pattern: fade.id });
  res = await s.call('POST', '/api/effects/command', { cmd: 'toggleDirection' });
  assert.deepEqual([res.status, res.body.status], [409, 'unsupported']);

  // Studio takes it, applied on a frame of the renderer that plays it.
  applyPatch({ pattern: studio.id });
  res = await s.call('POST', '/api/effects/command', { cmd: 'toggleDirection' });
  assert.deepEqual([res.status, res.body.ok, res.body.status], [200, true, 'applied']);
  const { seq } = res.body;
  res = await s.call('POST', '/api/effects/command', { cmd: 'setPulserBaselineColor', arg: { r: 255, g: 0, b: 0 } });
  assert.deepEqual([res.status, res.body.status, res.body.seq], [200, 'applied', seq + 1]);

  // A command it does not know is the caller's mistake; so is a body without one.
  res = await s.call('POST', '/api/effects/command', { cmd: 'explode' });
  assert.deepEqual([res.status, res.body.status], [400, 'invalid']);
  res = await s.call('POST', '/api/effects/command', { arg: 1 });
  assert.equal(res.status, 400);
  assert.equal(res.body.seq, undefined, 'refused before it was numbered');
  res = await s.call('POST', '/api/effects/command', { cmd: 'stop', extra: true });
  assert.equal(res.status, 400);
});
