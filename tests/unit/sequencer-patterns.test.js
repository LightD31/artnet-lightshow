// Hue Dynamics' patterns (a bundle of lanes dropped into the loaded sequence
// at a beat) and punch recording (pad hits written into it as clips).

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
import { stopEngine } from '../../src/server/engine.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { conductor } from '../../src/server/conductor.ts';
import { state } from '../../src/server/state.ts';
import { settings } from '../../src/server/settings.ts';
import { showStore } from '../../src/server/show-store.ts';

import { Sequencer, validatePattern } from '../../src/server/sequencer.ts';
import { SequenceStore } from '../../src/server/sequence-store.ts';
import { Pads, PadStore, patternPlayer } from '../../src/server/pads.ts';
import { presetById } from '../../src/shared/effects/index.ts';

showStore.scheduleSave = () => {};   // never the real show file
test.after(() => stopEngine());

const FADE = presetById('ldj.FadeCycle').spec;
const GLOW = { kind: 'energy.glow', params: {} };
const resolve = (id) => ({ 'ldj.FadeCycle': FADE })[id] ?? null;
const shared = (id) => ({ id, kind: 'shared', name: id, mute: false, solo: false });
const track = (id, fixtureId) => ({ id, kind: 'track', fixtureId, name: id, mute: false, solo: false });
const clip = (id, laneId, startBeat, lengthBeats, extra = {}) => ({ id, laneId, startBeat, lengthBeats, effect: GLOW, targets: 'lane', mute: false, ...extra });
const SET = { id: 'set', name: 'Set', lanes: [shared('a'), track('t2', 2)], clips: [clip('A', 'a', 0, 4)] };
const PATTERN = {
  id: 'drop', name: 'Drop', lengthBeats: 8,
  lanes: [
    { kind: 'shared', slot: 1, clips: [{ startBeat: 0, lengthBeats: 4, presetId: 'ldj.FadeCycle', targets: 'lane', mute: false }] },
    { kind: 'track', slot: 1, clips: [{ startBeat: 2, lengthBeats: 2, effect: GLOW, targets: 'lane', mute: false }] },
  ],
};

function rig({ fixtures = [1, 2, 3], patterns = [PATTERN], pad = () => null } = {}) {
  const s = new Sequencer({
    resolve, fixtureIds: () => fixtures, pattern: (id) => patterns.find((p) => p.id === id) ?? null, pad,
  });
  s.load(SET);
  return s;
}

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seq-patterns-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'sequences.json');
}

test('pattern insertion maps lanes at the requested beat', () => {
  const s = rig();
  const revision = s.revision();
  const added = s.insertPattern('drop', 16);
  assert.equal(s.revision(), revision + 1, 'one revision for the whole batch');
  const seq = s.current();
  // Shared slot 1 has no lane yet: a second shared lane is made; track slot 1 is the second fixture's track.
  assert.deepEqual(seq.lanes.map((l) => [l.kind, l.fixtureId ?? null]), [['shared', null], ['track', 2], ['shared', null]]);
  const made = seq.lanes[2].id;
  assert.deepEqual(added.map((c) => [c.laneId, c.startBeat, c.lengthBeats]), [[made, 16, 4], ['t2', 18, 2]]);
  assert.equal(new Set(seq.clips.map((c) => c.id)).size, 3, 'fresh clip ids');
  assert.equal(added[0].presetId, 'ldj.FadeCycle');
  // A track slot past the patch, an unknown pattern, nothing loaded: refused, the sequence untouched.
  const before = s.current();
  const far = rig({ fixtures: [1] });
  assert.throws(() => far.insertPattern('drop', 0), (e) => e.status === 409);
  assert.throws(() => s.insertPattern('nope', 0), (e) => e.status === 404);
  assert.throws(() => s.insertPattern('drop', -1), (e) => e.status === 400);
  assert.deepEqual(s.current(), before);
  const empty = new Sequencer({ resolve, pattern: () => PATTERN, fixtureIds: () => [1, 2] });
  assert.throws(() => empty.insertPattern('drop', 0), (e) => e.status === 409);
  // A track missing for a patched fixture is made.
  const bare = new Sequencer({ resolve, pattern: () => PATTERN, fixtureIds: () => [5, 6] });
  bare.load({ id: 'b', name: 'B', lanes: [shared('a')], clips: [] });
  bare.insertPattern('drop', 0);
  assert.deepEqual(bare.current().lanes.map((l) => [l.kind, l.fixtureId ?? null]), [['shared', null], ['shared', null], ['track', 6]]);
});

test('a pattern names at most three shared slots and validates its clips', () => {
  assert.throws(() => validatePattern({ ...PATTERN, lanes: [{ kind: 'shared', slot: 3, clips: [] }] }), (e) => e.status === 400);
  assert.throws(() => validatePattern({ ...PATTERN, lanes: [{ kind: 'shared', slot: 0, clips: [{ startBeat: 0, lengthBeats: 1 }] }] }), (e) => e.status === 400);
  assert.equal(validatePattern(PATTERN).lanes[1].clips[0].effect.kind, 'energy.glow');
});

test('capturePattern round-trips', () => {
  const s = rig();
  s.insertPattern('drop', 16);
  const lanes = s.current().lanes;
  const { pattern, fromBeat, toBeat } = s.captureWithBounds(17, 19, [lanes[2].id, 't2'], 'Again');
  // Whole clips kept; the range grows out to the bars around them.
  assert.deepEqual([fromBeat, toBeat], [16, 20]);
  assert.equal(pattern.name, 'Again');
  assert.equal(pattern.lengthBeats, 4);
  assert.deepEqual(pattern.lanes.map((l) => [l.kind, l.slot, l.clips.map((c) => c.startBeat)]), [['track', 1, [2]], ['shared', 0, [0]]]);
  assert.deepEqual(validatePattern(pattern), pattern);
  // Inserted again elsewhere, it plays the same clips there.
  const t = rig({ patterns: [pattern] });
  const added = t.insertPattern(pattern.id, 32);
  assert.deepEqual(added.map((c) => [c.laneId, c.startBeat, c.lengthBeats]), [['t2', 34, 2], ['a', 32, 4]]);
  assert.equal(s.capturePattern(17, 19, ['t2']).lanes.length, 1);
  assert.throws(() => s.capturePattern(4, 2, ['a']), (e) => e.status === 400);
  assert.throws(() => s.capturePattern(0, 4, ['ghost']), (e) => e.status === 404);
});

test('recording stages quantised clips until the take is kept', () => {
  const pads = { '0:1': { presetId: 'ldj.FadeCycle', targets: 'shared', lengthBeats: 2 }, '0:2': { presetId: 'ldj.FadeCycle', targets: [2, 3], lengthBeats: 4 } };
  const s = rig({ pad: (bank, slot) => pads[`${bank}:${slot}`] ?? null });
  assert.equal(s.status().recording, undefined, 'the status says nothing of a recording until one runs');
  assert.throws(() => s.onPadHit({ bank: 0, slot: 1, startBeat: 1 }), (e) => e.status === 409);
  s.startRecording({ mode: 'overdub', countInBeats: 4, quantise: 1 });
  assert.deepEqual(s.status().recording, { mode: 'overdub', fromBeat: 4, quantise: 1, hits: 0 });
  assert.throws(() => s.startRecording({ mode: 'overdub', countInBeats: 0, quantise: 1 }), (e) => e.status === 409);
  const revision = s.revision();
  assert.equal(s.onPadHit({ bank: 0, slot: 1, startBeat: 2 }), null, 'inside the count-in');
  s.onPadHit({ bank: 0, slot: 1, startBeat: 5.4, endBeat: 5.45 });
  s.onPadHit({ bank: 0, slot: 2, startBeat: 6.5 });
  s.onPadHit({ bank: 0, slot: 9, startBeat: 7 });
  // A held pad: its release, its start mapped a little later, ends the hit it launched.
  s.onPadHit({ bank: 0, slot: 1, startBeat: 12 });
  s.onPadHit({ bank: 0, slot: 1, startBeat: 12.01, endBeat: 15.2 });
  assert.equal(s.revision(), revision, 'the take is staged, the sequence untouched');
  assert.equal(s.status().recording.hits, 3);
  const kept = s.stopRecording(true);
  assert.equal(s.status().recording, undefined);
  assert.equal(s.revision(), revision + 1);
  // Ties go away from zero; at least one quantum long; a pad without a release plays its length.
  // A fixture list lands on those fixtures' tracks, a missing one on the first shared lane.
  assert.deepEqual(kept.added.map((c) => [c.laneId, c.startBeat, c.lengthBeats, c.targets]),
    [['a', 5, 1, 'lane'], ['t2', 7, 4, 'lane'], ['a', 7, 4, [3]], ['a', 12, 3, 'lane']]);
  assert.equal(s.current().clips.length, 5);

  // Replace: whole clips crossing the take on its lanes go; another lane's stay.
  s.startRecording({ mode: 'replace', countInBeats: 0, quantise: 1 });
  s.onPadHit({ bank: 0, slot: 1, startBeat: 1 });
  const replaced = s.stopRecording(true);
  assert.deepEqual(replaced.removed.sort(), ['A'].concat(kept.added.filter((c) => c.laneId === 'a' && c.startBeat < 3).map((c) => c.id)).sort());
  assert.deepEqual(s.current().clips.filter((c) => c.laneId === 'a').map((c) => c.startBeat).sort((x, y) => x - y), [1, 5, 7, 12]);

  // Discarded: nothing changes; an empty take changes nothing either.
  const after = s.revision();
  s.startRecording({ mode: 'replace', countInBeats: 0, quantise: 0 });
  s.onPadHit({ bank: 0, slot: 1, startBeat: 0 });
  assert.deepEqual(s.stopRecording(false), { added: [], removed: [] });
  s.startRecording({ mode: 'overdub', countInBeats: 0, quantise: 0 });
  s.stopRecording(true);
  assert.equal(s.revision(), after);
  assert.throws(() => s.stopRecording(true), (e) => e.status === 409);
  assert.throws(() => s.startRecording({ mode: 'punch', countInBeats: 0, quantise: 0 }), (e) => e.status === 400);
});

test('a sequencePattern pad inserts at the next grid line', (t) => {
  const s = rig();
  const store = new PadStore(path.join(path.dirname(tempStore(t)), 'pads.json')).load();
  const c = { beat: 10.1 };
  const patternVoice = patternPlayer({ voices: {}, pattern: () => null, fixtureIds: () => [1, 2, 3], resolve: () => null });
  const pads = new Pads({
    voices: {}, store, lookup: () => () => null, pattern: (id) => (id === PATTERN.id ? PATTERN : null), fixtureIds: () => [1, 2, 3], beat: () => c.beat,
    insertPattern: (id, at) => s.insertPattern(id, at), patternVoice,
  });
  store.set(1, 4, { label: 'Drop', accent: '#A855F7', content: { kind: 'sequencePattern', id: 'drop' }, launch: 'once', quantise: 4, targets: 'shared' });
  assert.equal(pads.press(1, 4, 'tablet', 't'), null);
  assert.deepEqual(s.current().clips.slice(1).map((x) => x.startBeat), [12, 14]);
});

test('pattern shelves retain compatibility with pre-pattern files', (t) => {
  const file = tempStore(t);
  fs.writeFileSync(file, JSON.stringify({ version: 1, sequences: [{ ...SET, clips: [] }] }));
  const store = new SequenceStore(file).load();
  assert.deepEqual([store.list().length, store.listPatterns()], [1, []]);
  let changes = 0;
  store.onChange(() => changes++);
  const saved = store.savePattern(PATTERN);
  assert.equal(saved.lanes[0].clips[0].presetId, 'ldj.FadeCycle');
  assert.equal(store.savePattern(PATTERN).id, 'drop');
  assert.equal(changes, 1, 'the same pattern again is not written');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).patterns.map((p) => p.id), ['drop']);
  assert.deepEqual(new SequenceStore(file).load().getPattern('drop'), saved);
  assert.deepEqual(store.patternSummaries(), [{ id: 'drop', name: 'Drop', lengthBeats: 8 }], 'what the live state lists');
  for (let i = 1; i < 64; i++) store.savePattern({ ...PATTERN, id: `p${i}` });
  assert.throws(() => store.savePattern({ ...PATTERN, id: 'one-more' }), (e) => e.status === 400);
  store.savePattern({ ...PATTERN, id: 'p1', name: 'Renamed' });
  assert.equal(store.removePattern('p1'), true);
  assert.equal(store.removePattern('p1'), false);
  assert.equal(store.getPattern('p1'), null);
  assert.ok(!store.patternSummaries().some((p) => p.id === 'p1'));
});

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

test('routes', async (t) => {
  const s = await serve(t);
  let res = await s.call('GET', '/api/sequence/patterns');
  assert.deepEqual([res.status, res.body.patterns], [200, []]);
  res = await s.call('POST', '/api/sequence/patterns', PATTERN);
  assert.deepEqual([res.status, res.body.pattern.id], [201, 'drop']);
  assert.equal((await s.call('POST', '/api/sequence/patterns', PATTERN)).status, 409);
  res = await s.call('POST', '/api/sequence/patterns', { ...PATTERN, id: undefined, name: 'Made' });
  assert.equal(res.status, 201);
  const made = res.body.pattern.id;
  assert.equal((await s.call('PUT', `/api/sequence/patterns/${made}`, { ...PATTERN, name: 'Renamed' })).body.pattern.name, 'Renamed');
  assert.equal((await s.call('PUT', '/api/sequence/patterns/ghost', PATTERN)).status, 404);
  assert.equal((await s.call('GET', `/api/sequence/patterns/${made}`)).body.pattern.id, made);
  assert.equal((await s.call('DELETE', `/api/sequence/patterns/${made}`)).status, 200);
  assert.equal((await s.call('GET', `/api/sequence/patterns/${made}`)).status, 404);
  assert.equal((await s.call('POST', '/api/sequence/patterns', { ...PATTERN, id: 'bad', lengthBeats: 0 })).status, 400);

  // Nothing loaded: 409.
  assert.equal((await s.call('POST', '/api/sequence/insert-pattern', { id: 'drop', atBeat: 0 })).status, 409);
  await s.call('PUT', '/api/sequence', SET);
  state.fixtures.length >= 2 || assert.fail('the routes need two patched fixtures');
  res = await s.call('POST', '/api/sequence/insert-pattern', { id: 'drop', atBeat: 8 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.clips.map((c) => c.startBeat), [8, 10]);
  assert.equal(res.body.status.revision, s.integrations.sequence.sequencer.revision());
  assert.equal((await s.call('POST', '/api/sequence/insert-pattern', { id: 'ghost', atBeat: 0 })).status, 404);
  assert.equal((await s.call('POST', '/api/sequence/insert-pattern', { id: 'drop', atBeat: 'soon' })).status, 400);

  res = await s.call('POST', '/api/sequence/capture-pattern', { fromBeat: 0, toBeat: 4, laneIds: ['a'], name: 'Intro' });
  assert.deepEqual([res.status, res.body.pattern.name, res.body.fromBeat, res.body.toBeat], [201, 'Intro', 0, 4]);
  assert.ok(s.sequenceStore.getPattern(res.body.pattern.id), 'kept on the shelf');

  res = await s.call('POST', '/api/sequence/record', { mode: 'overdub', countInBeats: 0, quantise: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.body.status.recording.mode, 'overdub');
  assert.equal((await s.call('POST', '/api/sequence/record', { mode: 'overdub', countInBeats: 0, quantise: 1 })).status, 409);
  res = await s.call('POST', '/api/sequence/record/stop', { keep: false });
  assert.deepEqual([res.status, res.body.status.recording, res.body.added, res.body.removed], [200, undefined, [], []]);
  assert.equal((await s.call('POST', '/api/sequence/record/stop', { keep: true })).status, 409);
  assert.equal((await s.call('POST', '/api/sequence/record', { mode: 'punch' })).status, 400);

  // Pads launched while recording land as clips on the pad's fixtures; a held pad ends at its release.
  const pads = s.integrations.pads;
  pads.store.set(0, 6, { label: 'Fade', accent: '#A855F7', content: { kind: 'preset', id: 'ldj.FadeCycle' }, launch: 'hold', quantise: 0, targets: 'shared' });
  await s.call('POST', '/api/sequence/record', { mode: 'overdub', countInBeats: 0, quantise: 0 });
  pads.once(0, 6);
  pads.press(0, 6, 'tablet', 'held');
  assert.equal(pads.release(0, 6, 'tablet', 'held'), true);
  assert.equal(s.integrations.sequence.sequencer.recording().hits, 2);
  res = await s.call('POST', '/api/sequence/record/stop', { keep: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.added.map((c) => [c.laneId, c.presetId, c.targets]), [['a', 'ldj.FadeCycle', 'lane'], ['a', 'ldj.FadeCycle', 'lane']]);
  assert.ok(res.body.added[1].lengthBeats > 0);
  assert.deepEqual(res.body.beyondRange, [], 'an overdub removes nothing');
  assert.ok(res.body.range.toBeat >= res.body.range.fromBeat);
  // A hold stopped by stop-all is closed at the next sweep, through the same hook.
  await s.call('POST', '/api/sequence/record', { mode: 'overdub', countInBeats: 0, quantise: 0 });
  pads.press(0, 6, 'tablet', 'gone');
  pads.stopAll();
  pads.sweep();
  assert.equal(pads._holds.size, 0);
  assert.equal(s.integrations.sequence.sequencer._record.take.at(-1).open, false);
  await s.call('POST', '/api/sequence/record/stop', { keep: false });
  pads.stopAll();
  assert.equal(conductor.now().beatPos >= 0, true);
});
