// A DJ mixes from one deck to the other. The show on the outgoing track plays
// on, on the outgoing deck's clock, until the incoming track's analysis is
// ready; then the lights crossfade into the new show over two bars — or cut,
// when the DJ cut.

import test from 'node:test';
import assert from 'node:assert';

import AutoShow from '../../src/auto-show.ts';
import { setupIntegrations } from '../../src/server/integrations.ts';
import { state } from '../../src/server/state.ts';

state.autoSource = 'prolink';

test('a show started to crossfade fades into its first scene, once', () => {
  const patches = [];
  const show = new AutoShow((p) => patches.push(p), [{ name: 'Blackout' }], []);
  try {
    show.timeline = [
      { timeMs: 0, action: 'patch', data: { pattern: 'chase', colorA: 1 } },
      { timeMs: 10000, action: 'patch', data: { pattern: 'fade', colorA: 2 } },
    ];
    show.useFrameClock();
    let pos = 5000;
    show.start(() => pos, { fadeMs: 3750 });
    assert.strictEqual(patches[0].pattern, 'chase');
    assert.strictEqual(patches[0].fadeMs, 3750, 'into the scene the track is in');
    pos = 1000;                                        // a seek back
    show.tick();
    assert.strictEqual(patches[patches.length - 1].fadeMs, undefined, 'a later seek lands at once');
    show.stop();

    // Started before the first scene: nothing to fade into, and nothing saved.
    show.timeline = [{ timeMs: 2000, action: 'patch', data: { pattern: 'fade' } }];
    pos = 0;
    show.start(() => pos, { fadeMs: 3000 });
    pos = 2500;
    show.tick();
    const fired = patches[patches.length - 1];
    assert.strictEqual(fired.pattern, 'fade');
    assert.strictEqual(fired.fadeMs, undefined);
    show.stop();
  } finally { show._worker.shutdown(); }
});

// ── Through the integrations ──────────────────────────────────────────────────

function rig() {
  const idle = { onPlaybackUpdate() {}, onTrackChange() {}, getStatus: () => ({}), authenticated: false };
  const log = [];
  const deckPositions = { 1: 60000, 2: 30000 };
  const prolink = {
    connected: true, stale: false, lastError: null, followed: 1, tempo: 128,
    getNumPeers: () => 2, getTrack: () => null, getLoadedTracks: () => [],
    getFollowed() { return { deviceId: this.followed }; },
    getTempo() { return this.tempo; },
    getPositionMs() { return deckPositions[this.followed]; },
    getDeckPositionMs: (player) => deckPositions[player],
    onTempoChange() {}, onPeersChange() {}, onFollowChange() {}, onLoadedTracksChange() {}, onAnyTrackLoaded() {},
    onTrackChange(fn) { this.trackChanged = fn; },
    canFetchAudio: () => false,
  };
  const cached = new Set();
  const gates = new Map();                            // key → release(), for analyses that take a while
  const autoShow = {
    running: false, track: null, syncOffsetMs: 0, position: null,
    getClientState: () => ({}), getPositionMs() { return this.position ? this.position() : 0; },
    start(getPosition, opts = {}) { log.push(['start', opts.fadeMs || 0]); this.position = getPosition; this.running = true; },
    stop() { log.push(['stop']); this.running = false; },
    isCached: (key) => cached.has(key), gridFor: () => null, isPrefetching: () => false,
    applyQueueOrder() {}, setPaletteSize() {}, setIntensity() {}, setSyncOffsetMs() {}, setExactAudio() {},
    async prefetch(query, target, key, meta, isrc, priority) {
      log.push(['prefetch', query, priority]);
      await new Promise((resolve) => gates.set(key, resolve));
      cached.add(key);
      return { skipped: false };
    },
    async awaitInFlight() {},
    async downloadAndAnalyze(query, target, key) {
      log.push(['analyse', query, cached.has(key) ? 'cached' : 'made now']);
      cached.add(key);
      return { analysis: {}, cached: true };
    },
  };
  const integrations = setupIntegrations({
    io: { emit() {} }, midi: { enabled: false, sendFeedback() {}, listPorts: () => [] },
    spotify: { ...idle, startPolling() {}, async getQueue() { return []; } },
    nowPlaying: idle,
    deezerSource: { ...idle, getQueue: () => [], updatePlayback() {}, updateQueue() {}, disconnect() {} },
    prolink, autoShow,
  });
  const track = (id, title) => ({ trackId: id, deviceId: id, slot: 3, title, artist: 'DJ', durationMs: 300000 });
  const release = async (key) => {
    for (let i = 0; i < 20 && !gates.has(key); i++) await new Promise((r) => setImmediate(r));
    gates.get(key)();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  return { integrations, prolink, autoShow, log, track, release, deckPositions };
}

test('through a mix, the outgoing show plays on its own deck until the incoming one is ready, then crossfades', async () => {
  const r = rig();
  r.integrations.startAutoShow();
  assert.strictEqual(r.autoShow.getPositionMs(), 60000, 'the show plays on CDJ-1');

  // The DJ has blended CDJ-2 in over sixteen bars; the show now follows it.
  r.prolink.followed = 2;
  const done = r.prolink.trackChanged(r.track(2, 'Next'), { handoff: true, fromPlayer: 1, toPlayer: 2, overlapMs: 30000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(r.log.slice(1), [['prefetch', 'DJ - Next', 'current']], 'made ready first, the old show untouched');
  assert.strictEqual(r.autoShow.running, true);
  assert.strictEqual(r.autoShow.getPositionMs(), 60000, 'still on the outgoing deck\'s clock');

  await r.release('prolink:dj - next:300');
  await done;
  assert.deepStrictEqual(r.log.slice(2), [['stop'], ['analyse', 'DJ - Next', 'cached'], ['start', 3750]],
    'two bars at 128 BPM');
  assert.strictEqual(r.autoShow.getPositionMs(), 30000, 'and the new show runs on CDJ-2');
});

test('a cut is a cut, and a newer change wins over one still waiting', async () => {
  const r = rig();
  r.integrations.startAutoShow();
  r.prolink.followed = 2;
  const first = r.prolink.trackChanged(r.track(2, 'Slow'), { handoff: true, fromPlayer: 1, toPlayer: 2, overlapMs: 30000 });
  await new Promise((resolve) => setImmediate(resolve));

  // Before it is ready the DJ cuts back to CDJ-1, now with another track.
  // The show is still on CDJ-1, whose old track is gone: nothing to play on.
  r.prolink.followed = 1;
  await r.prolink.trackChanged(r.track(1, 'Cut'), { handoff: true, fromPlayer: 2, toPlayer: 1, overlapMs: 200 });
  await r.release('prolink:dj - slow:300');
  await first;
  const starts = r.log.filter((e) => e[0] === 'start');
  assert.deepStrictEqual(starts, [['start', 0], ['start', 0]], 'the first start, then the cut; the slow one never starts');
  assert.deepStrictEqual(r.log.filter((e) => e[0] === 'analyse').map((e) => e[1]), ['DJ - Cut']);
});

test('a new track on the same deck is not a mix', async () => {
  const r = rig();
  r.integrations.startAutoShow();
  const done = r.prolink.trackChanged(r.track(1, 'Same deck'), { handoff: false, fromPlayer: null, toPlayer: 1, overlapMs: 0 });
  await done;
  assert.deepStrictEqual(r.log.slice(1), [['stop'], ['analyse', 'DJ - Same deck', 'made now'], ['start', 0]]);
});

test('a change that arrives while the last is still being analysed takes over', async () => {
  const r = rig();
  r.integrations.startAutoShow();
  // A slow analysis for a new track on CDJ-1: the show has stopped for it.
  let finishSlow;
  r.autoShow.downloadAndAnalyze = async function (query) {
    r.log.push(['analyse', query]);
    if (query === 'DJ - First') {
      await new Promise((resolve) => { finishSlow = resolve; });
      throw Object.assign(new Error('superseded by a newer current track'), { superseded: true });
    }
    return { analysis: {}, cached: true };
  };
  const first = r.prolink.trackChanged(r.track(1, 'First'), { handoff: false, fromPlayer: null, toPlayer: 1, overlapMs: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(r.autoShow.running, false);
  await r.prolink.trackChanged(r.track(1, 'Second'), { handoff: false, fromPlayer: null, toPlayer: 1, overlapMs: 0 });
  finishSlow();
  await first;
  assert.deepStrictEqual(r.log.filter((e) => e[0] === 'analyse').map((e) => e[1]), ['DJ - First', 'DJ - Second']);
  assert.deepStrictEqual(r.log.filter((e) => e[0] === 'start'), [['start', 0], ['start', 0]], 'the second track\'s show runs');
});

test('a mix lined up on the incoming drop blends until the drop, and lets it land', async () => {
  const r = rig();
  r.integrations.startAutoShow();
  // The incoming track, as its analysis will say once it is loaded: a drop
  // four seconds past where CDJ-2 is now.
  r.autoShow.analysis = { bpm: r.prolink.tempo, drops: [{ t: 34, confidence: 0.9 }], downbeats: [], segments: [] };
  r.prolink.followed = 2;
  const done = r.prolink.trackChanged(r.track(2, 'Next'), { handoff: true, fromPlayer: 1, toPlayer: 2, overlapMs: 30000 });
  await r.release('prolink:dj - next:300');
  await done;
  assert.deepStrictEqual(r.log[r.log.length - 1], ['start', 4000]);
});
