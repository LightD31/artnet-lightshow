import { ALL_PALETTES } from '../../src/server/palette-catalogue.ts';
// The effect library's routes (src/server/routes/effects.ts): the built-in
// catalogue and the presets and palettes saved here, edited over REST, and
// commands to the effect on stage. Then the library at work: a preset picked
// by id plays, the palette override, the photosensitivity gate, and the live
// state every page hears the library through.

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
import { EffectLibrary } from '../../src/server/effect-library.ts';
import { PaletteStore } from '../../src/server/palette-store.ts';
import { attachSockets } from '../../src/server/sockets.ts';
import { startEngine, stopEngine, setEffectSource, effectChanged, renderInput } from '../../src/server/engine.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { CueStore, captureLook, recallLook } from '../../src/server/cues.ts';
import { state, getCatalogs, getLiveState } from '../../src/server/state.ts';
import { PALETTES } from '../../src/server/palettes.ts';
import { settings } from '../../src/server/settings.ts';
import { showStore } from '../../src/server/show-store.ts';
import { baseIntentOf, createRenderer } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile, profilesRevision } from '../../src/server/profiles.ts';
import { BUILTIN_PALETTES, CATALOGUE, FAMILIES, presetById } from '../../src/shared/effects/index.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { resolvePalette, toHex } from '../../src/shared/effects/palette.ts';
import { acknowledgeFlashes } from '../helpers/acknowledged.js';

showStore.scheduleSave = () => {};   // never the real show file

const SEED = [0x1234, 0x5678, 0x9abc, 0xdef0];

// applyPatch re-arms the beat timer, which would otherwise hold the process open.
test.after(() => stopEngine());

/**
 * The routes on stand-in sources, with a library and palettes of their own
 * in a throwaway directory: never the operator's config/.
 */
async function serve(t, { cues } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'effects-routes-'));
  const effectLibrary = new EffectLibrary(path.join(dir, 'effects.json')).load();
  // Every random colour an activation rolls comes from this seed, so a test knows the colours.
  const paletteStore = new PaletteStore(path.join(dir, 'palettes.json'), { seed: () => [...SEED] }).load();
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
  attachRoutes(app, { integrations, applier: { applyChanged() {} }, ...(cues ? { cues } : {}) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const pattern = state.pattern;
  // The settings in memory, unacknowledged; an acknowledgement given here is never written.
  const values = settings._values;
  const ownSave = Object.hasOwn(settings, 'save') ? settings.save : null;
  settings._values = { ...values, safety: { ...values.safety, photosensitivityAcknowledged: false } };
  settings.save = () => {};
  t.after(async () => {
    settings._values = values;
    if (ownSave) settings.save = ownSave;
    else delete settings.save;
    applyPatch({ pattern, energyOverride: null, paletteOverride: null });
    io.close();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = (method, route, body) => fetch(`${url}${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  return { call, integrations, effectLibrary, paletteStore, dir, io, midi, url };
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
  assert.deepEqual(res.body.palettes, { builtin: json(ALL_PALETTES), user: [palette] });
  assert.equal(res.body.palettes.builtin.length, 54);
  assert.deepEqual(res.body.palettes.user[0].colours, ['#FF0000', { random: true }]);

  // Indexed clients retain curated variants alongside the shared catalogue.
  const legacy = await s.call('GET', '/api/palettes');
  assert.deepEqual(legacy.body, { ok: true, palettes: json(PALETTES), builtin: json(ALL_PALETTES), user: [palette], palette: state.palette });

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
  assert.equal(typeof res.body.error, 'string');
  res = await s.call('PUT', `/api/effects/${preset.id}`, { effect: FADE });
  assert.equal(res.status, 400);
  res = await s.call('POST', '/api/effects', { name: 'Nope', spec: { ...FADE, palette: ['random'] } });
  assert.equal(res.status, 400);
  assert.deepEqual(s.effectLibrary.list().user, [edited]);

  // A built-in, by id or alias, is nobody's to edit.
  for (const id of ['energy.whiteStrobe', 'white-strobe', 'position-chase']) {
    res = await s.call('PUT', `/api/effects/${id}`, { name: 'Mine now' });
    assert.equal(res.status, 404, id);
    assert.equal(typeof res.body.error, 'string');
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
  res = await s.call('GET', `/api/palettes/${palette.id}`);
  assert.deepEqual([res.status, res.body], [200, { ok: true, source: 'user', palette }]);
  res = await s.call('GET', '/api/palettes/redCyan');
  assert.deepEqual([res.status, res.body.source, res.body.palette], [200, 'builtin', json(BUILTIN_PALETTES.find((p) => p.id === 'redCyan'))]);
  res = await s.call('GET', '/api/palettes/no-such-palette');
  assert.deepEqual([res.status, res.body.ok], [404, false]);
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
  res = await s.call('GET', `/api/palettes/${palette.id}`);
  assert.equal(res.status, 404);
  res = await s.call('POST', `/api/palette/${PALETTES[0].id}`);
  assert.equal(res.status, 200);
});

test("concurrent preset edits persist in order", async (t) => {
  const s = await serve(t);
  const preset = s.effectLibrary.create({ name: 'Fade', spec: FADE });
  const before = s.effectLibrary.revision();
  const answers = await Promise.all([
    s.call('PUT', `/api/effects/${preset.id}`, { name: 'First', spec: { ...FADE, params: { cadence: 4 } } }),
    s.call('PUT', `/api/effects/${preset.id}`, { name: 'Second', spec: { ...FADE, params: { cadence: 8 } } }),
  ]);
  assert.deepEqual(answers.map((a) => a.status), [200, 200]);
  assert.equal(s.effectLibrary.revision(), before + 2);
  const [saved] = s.effectLibrary.list().user;
  assert.ok(['First', 'Second'].includes(saved.name));
  assert.equal(saved.spec.params.cadence, saved.name === 'First' ? 4 : 8, 'one edit whole, never half of each');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dir, 'effects.json'), 'utf8')), { presets: [saved] });
  assert.deepEqual(fs.readdirSync(s.dir).filter((f) => f.endsWith('.tmp')), []);
});

test("failed preset and palette writes return HTTP 500", async (t) => {
  const s = await serve(t);
  const warn = t.mock.method(console, 'warn', () => {});
  const error = t.mock.method(console, 'error', () => {});
  t.mock.method(s.effectLibrary, 'write', () => { throw new Error('disk full'); });
  let res = await s.call('POST', '/api/effects', { name: 'Lost', spec: FADE });
  assert.equal(res.status, 500);
  assert.equal(typeof res.body.error, 'string');
  t.mock.method(s.paletteStore, 'write', () => { throw new Error('disk full'); });
  res = await s.call('POST', '/api/palettes', { name: 'Lost', colours: ['#FFFFFF'] });
  assert.equal(res.status, 500);
  assert.ok(warn.mock.callCount() >= 2 && error.mock.callCount() >= 2);
  assert.deepEqual(s.paletteStore.list(), []);
  t.mock.restoreAll();
});

test("full palette libraries return HTTP 400", async (t) => {
  const s = await serve(t);
  for (let i = 0; i < 128; i++) s.paletteStore.create({ name: `P${i}`, colours: ['#FFFFFF'] });
  const res = await s.call('POST', '/api/palettes', { name: 'One too many', colours: ['#FFFFFF'] });
  assert.equal(res.status, 400);
  assert.equal(typeof res.body.error, 'string');
});

test("editing the live preset respects acknowledgement", async (t) => {
  const s = await serve(t);
  const onStage = s.effectLibrary.create({ name: 'On stage', spec: FADE });
  const offStage = s.effectLibrary.create({ name: 'Off stage', spec: FADE });
  applyPatch({ pattern: onStage.id });

  const playing = renderInput();
  let res = await s.call('PUT', `/api/effects/${onStage.id}`, { spec: FAST });
  assert.equal(res.status, 409);
  assert.equal(typeof res.body.error, 'string');
  assert.deepEqual(s.effectLibrary.get(onStage.id).preset, onStage);
  assert.equal(s.effectLibrary.revision(), 2);
  assert.deepEqual([renderInput().effect, renderInput().effectRevision], [playing.effect, playing.effectRevision], 'the rig plays on as it was');
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
    assert.equal(renderInput().effect.params.cadence, 0.25, 'the rig plays the new spec at once');
    assert.equal(renderInput().effectRevision, playing.effectRevision + 1, 'and starts it afresh');
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

// ─── Presets as patterns ──────────────────────────────────────────────────

/**
 * The engine's input for the look on stage, rendered on a renderer of its
 * own: universe 0's first 48 channels, frame by frame. From now, on the
 * engine's clock, which the voices in the input are timed by, on a frame
 * grid that starts there.
 */
function renderStage(times = [0, 250, 500, 1000]) {
  const t0 = performance.now();
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: t0 });
  const store = universes.createUniverseStore(universes.allocateShared());
  const input = renderInput();
  return times.map((ms) => {
    renderer.frame(input, { beatPos: ms / 500, bpm: 120, epoch: 0 }, t0 + ms, store, t0);
    return Array.from(store.getBuffer(0).subarray(0, 48));
  });
}

test("pattern routes resolve effect presets into engine input", async (t) => {
  const s = await serve(t);
  // A built-in by its id: the engine plays the catalogue's own spec.
  let res = await s.call('POST', '/api/pattern/ldj.FadeCycle');
  assert.deepEqual([res.status, res.body], [200, { ok: true, pattern: 'ldj.FadeCycle' }]);
  assert.equal(renderInput().effect, presetById('ldj.FadeCycle').spec);
  const played = renderStage();

  // A preset of one's own the same way.
  const mine = (await s.call('POST', '/api/effects', { name: 'Mine', spec: FADE })).body.preset;
  res = await s.call('POST', `/api/pattern/${mine.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(renderInput().effect, validateSpec(FADE));

  // A legacy look still draws through its pattern function.
  res = await s.call('POST', '/api/pattern/position-chase');
  assert.equal(res.status, 200);
  assert.equal(renderInput().effect, null);

  // An id nothing knows is taken as it always was (Home Assistant's pattern/<id>), and plays nothing.
  res = await s.call('POST', '/api/pattern/no-such-look');
  assert.deepEqual([res.status, res.body], [200, { ok: true, pattern: 'no-such-look' }]);
  assert.equal(renderInput().effect, null);
  const nothing = renderStage();
  assert.notDeepEqual(played, nothing, 'the preset played, not the unknown-id path');
  assert.equal(new Set(played.map(String)).size > 1, true, 'and it moves');
  res = await s.call('GET', '/api/effects/no-such-look');
  assert.equal(res.status, 404);
});

test('a rapidFlash preset is 409 until POST /api/safety/acknowledge', async (t) => {
  const s = await serve(t);
  applyPatch({ pattern: 'ldj.FadeCycle', masterDimmer: 255, colorA: 0 });
  let res = await s.call('GET', '/api/safety');
  assert.deepEqual([res.status, res.body], [200, { ok: true, photosensitivityAcknowledged: false, hdFlashIntervalMs: 350, strobeMaxLatchSec: 60 }]);
  assert.deepEqual(getLiveState().safety, { photosensitivityAcknowledged: false, hdFlashIntervalMs: 350, strobeMaxLatchSec: 60 });

  res = await s.call('POST', '/api/pattern/ldj.visualizer.flash');
  assert.equal(res.status, 409);
  assert.deepEqual([res.body.ok, typeof res.body.error], [false, 'string']);
  assert.equal(state.pattern, 'ldj.FadeCycle', 'the running look stays');
  res = await s.call('POST', '/api/set', { pattern: 'ldj.visualizer.flash', masterDimmer: 10, colorA: 5 });
  assert.equal(res.status, 409);
  assert.deepEqual([state.pattern, state.masterDimmer, state.colorA], ['ldj.FadeCycle', 255, 0], 'none of the patch');

  res = await s.call('POST', '/api/safety/acknowledge');
  assert.deepEqual([res.status, res.body], [200, { ok: true, photosensitivityAcknowledged: true, hdFlashIntervalMs: 350, strobeMaxLatchSec: 60 }]);
  assert.equal(settings.get('safety.photosensitivityAcknowledged'), true);
  assert.equal(getLiveState().safety.photosensitivityAcknowledged, true);
  assert.equal(renderInput().safety.acknowledged, true, 'the renderer hears it');

  res = await s.call('POST', '/api/pattern/ldj.visualizer.flash');
  assert.equal(res.status, 200);
  assert.equal(renderInput().effect.kind, 'ldj.visualizer');
});

test("energy strobe routes respect acknowledgement", async (t) => {
  const s = await serve(t);
  applyPatch({ pattern: 'ldj.FadeCycle', energyOverride: null, masterDimmer: 255, masterBlackout: false });
  const look = renderStage();
  for (const id of ['white-strobe', 'color-strobe', 'palette-strobe']) {
    const res = await s.call('POST', `/api/energy/${id}`);
    assert.deepEqual([res.status, res.body.ok, typeof res.body.error], [409, false, 'string']);
    assert.equal(getLiveState().energyOverride, null, `${id} is not shown as on`);
    assert.deepEqual(renderStage(), look, `${id} waits for the acknowledgement`);
  }
  await s.call('POST', '/api/safety/acknowledge');
  await s.call('POST', '/api/energy/white-strobe');
  assert.notDeepEqual(renderStage(), look, 'acknowledged, the strobe shows');
  const res = await s.call('POST', '/api/energy/off');
  assert.equal(res.status, 200);
});

// ─── The palette override ─────────────────────────────────────────────────

test("hex palette overrides reach live and engine state", async (t) => {
  const s = await serve(t);
  const res = await s.call('PUT', '/api/palette-override', { colours: ['#ff0000', '#00FF0080'] });
  assert.deepEqual([res.status, res.body], [200, { ok: true, paletteOverride: ['#FF0000', '#00FF0080'] }]);
  assert.deepEqual(getLiveState().paletteOverride, ['#FF0000', '#00FF0080']);
  assert.deepEqual(renderInput().paletteOverride, [{ r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0 }, { r: 0, g: 255, b: 0, w: 128, a: 0, uv: 0 }]);
});

test("built-in palette overrides resolve by id", async (t) => {
  const s = await serve(t);
  const res = await s.call('PUT', '/api/palette-override', { paletteId: 'redCyan' });
  const redCyan = BUILTIN_PALETTES.find((p) => p.id === 'redCyan');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.paletteOverride, redCyan.colours.map((c) => toHex(resolvePalette({ palette: [c] }, null, [], SEED, 0)[0])));
});

test("user palette overrides freeze resolved colours", async (t) => {
  const s = await serve(t);
  const palette = s.paletteStore.create({ name: 'Mine', colours: ['#FFFFFF80', 'random', 'random'] });
  const res = await s.call('PUT', '/api/palette-override', { paletteId: palette.id });
  assert.equal(res.status, 200);
  const rolled = resolvePalette({ palette: palette.colours }, null, [], SEED, 0).map(toHex);
  assert.deepEqual(res.body.paletteOverride, rolled);
  assert.ok(res.body.paletteOverride.every((c) => typeof c === 'string' && /^#[0-9A-F]{6}([0-9A-F]{2})?$/.test(c)), 'colours, never a random sentinel');
  assert.equal(renderInput().paletteOverride[0].w, 128, 'the white byte kept');
  assert.notEqual(rolled[1], rolled[2], 'two random entries, two hues');
  assert.deepEqual(getLiveState().paletteOverride, rolled);
  assert.deepEqual(renderInput().paletteOverride, resolvePalette({ palette: palette.colours }, null, [], SEED, 0), 'the very bytes rolled');
  s.paletteStore.update(palette.id, { colours: ['#000000'] });
  s.paletteStore.remove(palette.id);
  assert.deepEqual(getLiveState().paletteOverride, rolled);
  const look = captureLook();
  assert.deepEqual(look.paletteOverride, rolled);
  applyPatch({ paletteOverride: null });
  recallLook(look);
  assert.deepEqual(renderInput().paletteOverride, resolvePalette({ palette: palette.colours }, null, [], SEED, 0));
});

test("invalid palette overrides preserve current colours", async (t) => {
  const s = await serve(t);
  const palette = s.paletteStore.create({ name: 'Mine', colours: ['#FFFFFF80', 'random', 'random'] });
  let res;
  await s.call('PUT', '/api/palette-override', { paletteId: palette.id });
  const rolled = resolvePalette({ palette: palette.colours }, null, [], SEED, 0).map(toHex);
  for (const body of [{}, { colours: [] }, { colours: Array(9).fill('#FFFFFF') }, { colours: ['not-a-colour'] },
    { colours: ['#FFFFFF'], paletteId: 'redCyan' }, { paletteId: '' }, { colours: ['#FFFFFF'], extra: 1 }]) {
    res = await s.call('PUT', '/api/palette-override', body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  res = await s.call('PUT', '/api/palette-override', { paletteId: 'no-such-palette' });
  assert.deepEqual([res.status, res.body.ok], [404, false]);
  assert.deepEqual(getLiveState().paletteOverride, rolled, 'a refused request leaves it');
});

test("palette override DELETE clears live and engine state", async (t) => {
  const s = await serve(t);
  await s.call('PUT', '/api/palette-override', { colours: ['#ff0000', '#00FF0080'] });
  const res = await s.call('DELETE', '/api/palette-override');
  assert.deepEqual([res.status, res.body], [200, { ok: true, paletteOverride: null }]);
  assert.equal(state.paletteOverride, null);
  assert.equal(renderInput().paletteOverride, null);
});

test('a random override retains its palette identity in live state', async (t) => {
  const s = await serve(t);
  const res = await s.call('PUT', '/api/palette-override', { paletteId: 'randomRandom' });
  assert.equal(res.status, 200);
  assert.deepEqual([getLiveState().paletteOverride, getLiveState().paletteOverrideId], [res.body.paletteOverride, 'randomRandom']);
  assert.ok(res.body.paletteOverride.every((c) => /^#[0-9A-F]{6}$/.test(c)));
});

test('an unrelated patch preserves override identity', async (t) => {
  const s = await serve(t);
  await s.call('PUT', '/api/palette-override', { paletteId: 'redCyan' });
  applyPatch({ masterDimmer: 200 });
  assert.equal(getLiveState().paletteOverrideId, 'redCyan');
});

test('a missing palette request preserves override identity', async (t) => {
  const s = await serve(t);
  await s.call('PUT', '/api/palette-override', { paletteId: 'redCyan' });
  const res = await s.call('PUT', '/api/palette-override', { paletteId: 'missing' });
  assert.equal(res.status, 404);
  assert.equal(getLiveState().paletteOverrideId, 'redCyan');
});

for (const [name, change] of [
  ['explicit colours', (s) => s.call('PUT', '/api/palette-override', { colours: ['#123456'] })],
  ['patch colours', () => applyPatch({ paletteOverride: ['#FF0000'] })],
  ['cue recall', () => recallLook({ ...captureLook(), paletteOverride: ['#FF0000'] })],
  ['DELETE', (s) => s.call('DELETE', '/api/palette-override')],
]) {
  test(`${name} clears the previous override identity`, async (t) => {
    const s = await serve(t);
    await s.call('PUT', '/api/palette-override', { paletteId: 'redCyan' });
    await change(s);
    assert.equal(getLiveState().paletteOverrideId, null);
  });
}

// The built-ins (about 75 KB) go out once per connection and in GET
// /api/state; a patch or a cue recall answers with the live state alone, which
// is all any caller reads from it.
test("mutation responses omit catalogues from live state", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'effects-routes-cues-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cues = new CueStore(path.join(dir, 'cues.json')).load();
  const s = await serve(t, { cues });
  const catalogues = Object.keys(getCatalogs());
  const full = (await s.call('GET', '/api/state')).body;
  for (const key of [...catalogues, ...Object.keys(getLiveState()), 'dmxSnapshot']) assert.ok(key in full, `GET /api/state has ${key}`);
  assert.deepEqual(full.families, JSON.parse(JSON.stringify(FAMILIES)));

  let res = await s.call('POST', '/api/set', { pattern: 'chase', paletteOverride: ['#FF0000'] });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body.state).sort(), Object.keys(getLiveState()).sort(), 'every live key');
  assert.deepEqual([res.body.state.pattern, res.body.state.paletteOverride], ['chase', ['#FF0000']]);
  for (const key of catalogues) assert.equal(key in res.body.state, false, `no ${key}`);

  const cue = cues.create({ name: 'Red chase' });
  applyPatch({ pattern: 'rainbow', paletteOverride: null });
  for (const route of [`/api/cues/${cue.id}/recall`, '/api/cues/by-name/red%20chase/recall']) {
    res = await s.call('POST', route);
    assert.equal(res.status, 200, route);
    assert.deepEqual([res.body.state.pattern, res.body.state.paletteOverride], ['chase', ['#FF0000']], route);
    for (const key of catalogues) assert.equal(key in res.body.state, false, `${route}: no ${key}`);
    applyPatch({ pattern: 'rainbow', paletteOverride: null });
  }
});

// ─── The live state ───────────────────────────────────────────────────────

test('a user preset saved by one client appears in the live state (domain library)', async (t) => {
  const s = await serve(t);
  attachSockets(s.io, { midi: s.midi, integrations: s.integrations });
  const socket = connect(s.url, { auth: { protocol: 2 }, transports: ['websocket'], reconnection: false });
  t.after(() => socket.close());
  const patches = [];
  socket.on('patch', (p) => patches.push(p));
  const snapshot = await new Promise((resolve) => socket.once('snapshot', resolve));
  assert.deepEqual(snapshot.state.effects, []);
  assert.deepEqual(snapshot.state.userPalettes, []);
  assert.equal(snapshot.versions.library, 0);
  assert.deepEqual(snapshot.state.families, JSON.parse(JSON.stringify(FAMILIES)), 'the built-ins come once, with the catalogues');
  assert.deepEqual(snapshot.state.builtinPalettes, JSON.parse(JSON.stringify(ALL_PALETTES)));

  // What is sent arrives in order, but a busy runner may take a while: wait by deadline.
  const waitFor = async (found, what) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const hit = found();
      if (hit) return hit;
      if (Date.now() > deadline) assert.fail(`no ${what}: ${JSON.stringify(patches)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const until = (find, what) => waitFor(() => patches.find(find), what);
  const fast = (await s.call('POST', '/api/effects', { name: 'Fast', spec: FAST })).body.preset;
  let patch = await until((p) => p.d === 'library' && p.set.effects?.length, 'library patch for the preset');
  assert.deepEqual(patch.set.effects, [{ id: fast.id, name: 'Fast', kind: 'ldj.StrobeCycle', rapidFlash: true, scope: null, updatedAt: fast.updatedAt }],
    'enough for a picker: what it is, and that it waits for the acknowledgement');
  assert.equal(Object.keys(patch.set).includes('patterns'), false, 'the catalogues are not sent again');

  const palette = (await s.call('POST', '/api/palettes', { name: 'Warm', colours: ['#FF8800'] })).body.palette;
  patch = await until((p) => p.d === 'library' && p.set.userPalettes?.length, 'library patch for the palette');
  assert.deepEqual(patch.set.userPalettes, [palette]);

  await s.call('PUT', '/api/palette-override', { colours: ['#FF0000'] });
  patch = await until((p) => p.d === 'look' && p.set.paletteOverride, 'look patch for the override');
  assert.deepEqual(patch.set.paletteOverride, ['#FF0000']);

  // The socket's `set` is the same one entry: an id nothing knows is taken, a fast effect refused whole.
  const errors = [];
  socket.on('error-msg', (e) => errors.push(e));
  socket.emit('set', { pattern: 'no-such-look' });
  await waitFor(() => state.pattern === 'no-such-look', 'the unknown id taken');
  socket.emit('set', { pattern: 'ldj.visualizer.flash', masterDimmer: 12 });
  await waitFor(() => errors.length, 'the refusal');
  assert.deepEqual(errors.map((e) => [e.source, typeof e.message]), [['set', 'string']]);
  assert.equal(state.pattern, 'no-such-look');
  assert.notEqual(state.masterDimmer, 12);
});

/** Each lamp's red, green, blue and dimmer channels as the renderer left them. */
function lampsOf(store, input) {
  return input.fixtures.map((f) => {
    const { channelMap: ch } = getProfile(f.profileId);
    const dmx = store.getBuffer(f.universe);
    return ['red', 'green', 'blue', 'dimmer'].map((name) => dmx[f.address - 1 + ch[name]]);
  });
}

test("live presets restart only when their effect content changes", async (t) => {
  const s = await serve(t);
  const mine = s.effectLibrary.create({ name: 'Mine', spec: FADE });
  applyPatch({ pattern: mine.id });
  const r0 = renderInput().effectRevision;
  assert.equal(typeof r0, 'number');

  // A rename, edits to another preset and the same spec written in another order: the same effect playing on.
  await s.call('PUT', `/api/effects/${mine.id}`, { name: 'Renamed' });
  const other = (await s.call('POST', '/api/effects', { name: 'Other', spec: FADE })).body.preset;
  await s.call('PUT', `/api/effects/${other.id}`, { spec: { ...FADE, params: { cadence: 1 } } });
  await s.call('DELETE', `/api/effects/${other.id}`);
  await s.call('PUT', `/api/effects/${mine.id}`, { spec: { params: { cadence: 2 }, kind: 'ldj.FadeCycle' } });
  assert.equal(renderInput().effectRevision, r0);

  // Its colours and brightness are played live (the next test): no new start.
  await s.call('PUT', `/api/effects/${mine.id}`, { spec: { ...FADE, palette: ['#FF0000'], brightness: 0.5 } });
  assert.equal(renderInput().effect.brightness, 0.5, 'the rig is handed the new spec');
  assert.equal(renderInput().effectRevision, r0);

  // A new setting starts it again, once.
  await s.call('PUT', `/api/effects/${mine.id}`, { spec: { ...FADE, params: { cadence: 1 }, palette: ['#FF0000'], brightness: 0.5 } });
  assert.equal(renderInput().effectRevision, r0 + 1);
  assert.equal(renderInput().effectRevision, r0 + 1, 'once');

  // Deleted while on stage: the id stays, the effect goes.
  await s.call('DELETE', `/api/effects/${mine.id}`);
  assert.equal(state.pattern, mine.id);
  assert.equal(renderInput().effect, null);
  assert.equal(renderInput().effectRevision, r0 + 2);

  // An effect that goes and comes back between two frames still starts again: each change is counted as it happens.
  let spec = validateSpec(FADE);
  setEffectSource(() => spec);
  applyPatch({ pattern: 'anything' });
  const r1 = renderInput().effectRevision;
  spec = null;
  effectChanged();
  spec = validateSpec(FADE);
  effectChanged();
  assert.equal(renderInput().effectRevision, r1 + 2);
  // A rebuilt but equal spec is the same effect, and so is one in other colours.
  spec = validateSpec(FADE);
  effectChanged();
  spec = validateSpec({ ...FADE, palette: ['#00FF00'] });
  effectChanged();
  assert.equal(renderInput().effectRevision, r1 + 2);
  setEffectSource((id) => s.effectLibrary.resolve(id));
});

// A palette or brightness edit to the preset on stage is the same effect
// playing on, as the renderer keys it: its run, its state and a command sent
// before the edit carry on, and the new colours and level show on the next
// frame. A new setting or kind is a new effect.
test("live palette edits preserve effect state", async (t) => {
  const s = await serve(t);
  const running = state.running;
  t.after(() => applyPatch({ running }));
  applyPatch({ running: true, masterDimmer: 255, masterBlackout: false });
  const store = universes.createUniverseStore(universes.allocateShared());
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
  let ms = 0;
  // The engine's input for the look on stage, a frame at a time on one renderer, as the rig plays it.
  const play = (frames) => Array.from({ length: frames }, () => {
    ms += 1000 / 44;
    const input = renderInput();
    renderer.frame(input, { beatPos: ms / 500, bpm: 120, epoch: 0 }, ms, store);
    return lampsOf(store, input);
  });

  const fade = s.effectLibrary.create({ name: 'Fade', spec: { ...FADE, palette: ['#00FF00', '#0000FF'] } });
  applyPatch({ pattern: fade.id });
  const revision = renderInput().effectRevision;
  assert.ok(play(40).flat().some(([, g, b]) => g + b > 0), 'it plays in its own colours');

  await s.call('PUT', `/api/effects/${fade.id}`, { spec: { ...FADE, palette: ['#FF0000'] } });
  assert.equal(renderInput().effectRevision, revision, 'not started again');
  const red = play(20).flat();
  assert.ok(red.every(([, g, b]) => g === 0 && b === 0), 'the next frame on is in the new colour');
  assert.ok(red.some(([r]) => r > 0), 'and lit');
  await s.call('PUT', `/api/effects/${fade.id}`, { spec: { ...FADE, palette: ['#FF0000'], brightness: 0 } });
  assert.equal(renderInput().effectRevision, revision);
  assert.ok(play(20).flat().every((lamp) => lamp.every((v) => v === 0)), 'at brightness 0 it shows nothing from the next frame');

  // A command meant for the effect before its colours changed still reaches it; one meant for it before it became another does not.
  const studio = s.effectLibrary.create({ name: 'Swirl', spec: { kind: 'ldj.StudioSwirl', params: {}, palette: ['#00FF00'] } });
  applyPatch({ pattern: studio.id });
  play(5);
  const before = baseIntentOf(renderInput());
  await s.call('PUT', `/api/effects/${studio.id}`, { spec: { kind: 'ldj.StudioSwirl', params: {}, palette: ['#FF0000'], brightness: 0.5 } });
  renderer.command(1, 'toggleDirection', undefined, before);
  play(1);
  assert.deepEqual(renderer.takeCommandResults(), [{ seq: 1, status: 'applied' }]);
  const recoloured = baseIntentOf(renderInput());
  await s.call('PUT', `/api/effects/${studio.id}`, { spec: { kind: 'ldj.StudioWave', params: {}, palette: ['#FF0000'] } });
  assert.equal(renderInput().effectRevision, recoloured.revision + 1, 'another kind starts it again');
  renderer.command(2, 'toggleDirection', undefined, recoloured);
  play(1);
  assert.deepEqual(renderer.takeCommandResults(), [{ seq: 2, status: 'stale' }]);
});

test('a Disco preset on stage runs the audio detectors on its own bands', async (t) => {
  const s = await serve(t);
  const { bands } = presetById('hd.disco.rock').spec.params;
  const edges = [bands.bass, bands.voice, bands.treble];
  applyPatch({ pattern: 'ldj.FadeCycle' });
  assert.equal(s.integrations.audio.detectors().disco.owner.from, 'fallback');
  assert.ok(!edges.every((e) => s.integrations.audio.features.bandList().some((b) => b[0] === e[0] && b[1] === e[1])),
    'the settings\' bands are not the preset\'s');
  applyPatch({ pattern: 'hd.disco.rock' });
  const { disco } = s.integrations.audio.detectors();
  assert.equal(disco.owner.from, 'base');
  assert.deepEqual(disco.bands, bands);
  // What the live input is asked to sum follows: the audio features read the base's Disco.
  const list = s.integrations.audio.features.bandList();
  for (const [lo, hi] of edges) assert.ok(list.some(([l, h]) => l === lo && h === hi), `${lo}-${hi}`);
});

test("internal bundles are absent from public effect lists", async (t) => {
  const s = await serve(t);
  const listed = (await s.call('GET', '/api/effects')).body;
  assert.ok(!JSON.stringify(listed).includes('pattern.bundle'));
});

test("public effect routes reject internal bundles", async (t) => {
  const s = await serve(t);
  const params = { patternId: 'p', lengthBeats: 4, once: false, table: { revision: 0, lanes: [], clips: [] } };
  const res = await s.call('POST', '/api/effects', { name: 'Bundle', spec: { kind: 'pattern.bundle', params } });
  assert.equal(res.status, 400);
});
