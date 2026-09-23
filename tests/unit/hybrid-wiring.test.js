// The hybrid source itself is covered next door. What is easy to get wrong is
// the wiring: which source resolves when, which callbacks feed which half, and
// whether the show ends up running against the OS clock or Spotify's. Those are
// one-line mistakes that no unit test of either class would catch, so this
// stands the real integrations module up against stub subsystems.

import test from 'node:test';
import assert from 'node:assert';

import { setupIntegrations } from '../../src/server/integrations.ts';
import { state } from '../../src/server/state.ts';

const SPOTIFY_TRACK = {
  trackId: 'spotify-1',
  name: 'Shelter',
  artist: 'Porter Robinson, Madeon',
  album: 'Shelter',
  albumArt: null,
  durationMs: 220000,
  progressMs: 30000,
  isPlaying: true,
  isrc: 'USUG11600982',
};

const OS_SESSION = {
  trackId: 'smtc:porter robinson, madeon|shelter',
  name: 'Shelter',
  artist: 'Porter Robinson, Madeon',
  album: 'Shelter',
  albumArt: null,
  durationMs: 220000,
  progressMs: 30000,
  isPlaying: true,
  sourceApp: 'Spotify.exe',
};

/** A callback registry that lets the test fire what the real subsystem would. */
function stubSource(extra = {}) {
  const handlers = {};
  return {
    authenticated: false,
    configured: true,
    onPlaybackUpdate(fn) { handlers.playback = fn; },
    onTrackChange(fn) { handlers.track = fn; },
    getStatus() { return { configured: true, authenticated: this.authenticated }; },
    emitPlayback(payload) { if (handlers.playback) handlers.playback(payload); },
    emitTrack(payload) { if (handlers.track) handlers.track(payload); },
    ...extra,
  };
}

function build({ analysisCache = null } = {}) {
  const started = [];
  const spotify = stubSource({
    startPolling() { this.polling = true; },
    async getQueue() { return []; },
  });
  const nowPlaying = stubSource();
  const deezerSource = stubSource({
    getQueue: () => [],
    updatePlayback() {},
    updateQueue() {},
    disconnect() {},
  });
  const prolink = {
    connected: false,
    stale: false,
    lastError: null,
    getNumPeers: () => 0,
    getFollowed: () => null,
    getTrack: () => null,
    getLoadedTracks: () => [],
    getTempo: () => 0,
    getPositionMs: () => 0,
    onTempoChange() {}, onPeersChange() {}, onFollowChange() {},
    onTrackChange() {}, onLoadedTracksChange() {}, onAnyTrackLoaded() {},
  };
  const autoShow = {
    running: false,
    track: null,
    getPositionMs: () => 0,
    getClientState: () => ({}),
    start(getPosition) { started.push(getPosition); this.running = true; },
    stop() { this.running = false; },
    isCached: () => false,
    gridFor: () => null,
    syncOffsetMs: 0,
    isPrefetching: () => false,
    prefetch: async () => ({ skipped: true, reason: 'already-cached' }),
    applyQueueOrder() {},
    setPaletteSize() {}, setIntensity() {}, setSyncOffsetMs() {},
  };

  const integrations = setupIntegrations({
    io: { emit() {} },
    midi: { enabled: false, sendFeedback() {}, listPorts: () => [] },
    spotify, nowPlaying, deezerSource, prolink, autoShow, analysisCache,
  });
  return { integrations, spotify, nowPlaying, deezerSource, prolink, autoShow, started };
}

// setupIntegrations installs a global extras provider on the shared state
// module, so the source choice has to be put back or later tests inherit it.
function withSource(value, fn) {
  const previous = state.autoSource;
  state.autoSource = value;
  try { return fn(); } finally { state.autoSource = previous; }
}

// ── Source resolution ───────────────────────────────────────────────────────

test('choosing hybrid resolves to hybrid once Spotify is connected', () => {
  const rig = build();
  rig.spotify.authenticated = true;
  withSource('hybrid', () => {
    assert.strictEqual(rig.integrations.resolveAutoSource(), 'hybrid');
  });
});

test('hybrid does not require the OS session — it degrades to the Spotify clock', () => {
  // On a machine with no SMTC at all, picking hybrid must still start a show.
  const rig = build();
  rig.spotify.authenticated = true;
  rig.nowPlaying.authenticated = false;
  withSource('hybrid', () => {
    assert.strictEqual(rig.integrations.resolveAutoSource(), 'hybrid');
    rig.integrations.startAutoShow();
    rig.spotify.emitPlayback(SPOTIFY_TRACK);
    const position = rig.started[0]();
    assert.ok(Math.abs(position - 30000) < 50, `position was ${position}`);
  });
});

test('hybrid without Spotify falls through rather than running on nothing', () => {
  const rig = build();
  rig.spotify.authenticated = false;
  rig.nowPlaying.authenticated = true;
  withSource('hybrid', () => {
    assert.strictEqual(rig.integrations.resolveAutoSource(), 'nowplaying');
  });
});

test('auto prefers hybrid when both halves are available', () => {
  const rig = build();
  rig.spotify.authenticated = true;
  rig.nowPlaying.authenticated = true;
  withSource('auto', () => {
    assert.strictEqual(rig.integrations.resolveAutoSource(), 'hybrid');
  });
});

test('auto still picks plain Spotify when there is no OS session', () => {
  const rig = build();
  rig.spotify.authenticated = true;
  rig.nowPlaying.authenticated = false;
  withSource('auto', () => {
    assert.strictEqual(rig.integrations.resolveAutoSource(), 'spotify');
  });
});

test('auto still prefers a connected CDJ over everything', () => {
  const rig = build();
  rig.spotify.authenticated = true;
  rig.nowPlaying.authenticated = true;
  rig.prolink.connected = true;
  rig.prolink.getFollowed = () => ({ deviceId: 1 });
  withSource('auto', () => {
    assert.strictEqual(rig.integrations.resolveAutoSource(), 'prolink');
  });
});

// ── Which clock actually drives ─────────────────────────────────────────────

test('in hybrid the show runs on the OS position, not the Spotify one', () => {
  const rig = build();
  rig.spotify.authenticated = true;
  rig.nowPlaying.authenticated = true;

  withSource('hybrid', () => {
    rig.integrations.startAutoShow();
    // Spotify says 30 s; the OS session — the same track — says 31 s and is
    // the one that should win.
    rig.spotify.emitPlayback(SPOTIFY_TRACK);
    rig.nowPlaying.emitPlayback({ ...OS_SESSION, progressMs: 31000 });

    const position = rig.started[0]();
    assert.ok(Math.abs(position - 31000) < 50, `position was ${position}`);
    assert.strictEqual(rig.integrations.hybrid.driver, 'nowplaying');
  });
});

test('an OS session playing something else never reaches the show', () => {
  const rig = build();
  rig.spotify.authenticated = true;
  rig.nowPlaying.authenticated = true;

  withSource('hybrid', () => {
    rig.integrations.startAutoShow();
    rig.spotify.emitPlayback(SPOTIFY_TRACK);
    rig.nowPlaying.emitPlayback({
      ...OS_SESSION, name: 'A Long Podcast', durationMs: 3600000, progressMs: 1200000,
    });

    const position = rig.started[0]();
    assert.ok(Math.abs(position - 30000) < 50,
      `the podcast position leaked in: ${position}`);
    assert.strictEqual(rig.integrations.hybrid.driver, 'spotify');
  });
});

test('the hybrid clock stays warm while another source drives', () => {
  // So that switching to it mid-show does not start from a cold clock.
  const rig = build();
  rig.spotify.authenticated = true;
  rig.nowPlaying.authenticated = true;

  withSource('spotify', () => {
    rig.integrations.startAutoShow();
    rig.spotify.emitPlayback(SPOTIFY_TRACK);
    rig.nowPlaying.emitPlayback(OS_SESSION);
    assert.strictEqual(rig.integrations.hybrid.matched, true);
    assert.ok(Math.abs(rig.integrations.hybrid.getPositionMs() - 30000) < 50);
  });
});

// ── Content and queue ───────────────────────────────────────────────────────

test('hybrid takes its content from Spotify, so a track change analyses', async () => {
  const rig = build();
  rig.spotify.authenticated = true;
  rig.nowPlaying.authenticated = true;
  rig.autoShow.running = true;

  const analysed = [];
  rig.autoShow.downloadAndAnalyze = async (query, durationSec, key, isrc) => {
    analysed.push({ query, durationSec, isrc });
  };

  await withSource('hybrid', async () => {
    rig.spotify.emitTrack(SPOTIFY_TRACK);
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.strictEqual(analysed.length, 1);
  assert.strictEqual(analysed[0].query, 'Porter Robinson, Madeon - Shelter');
  assert.strictEqual(analysed[0].isrc, 'USUG11600982',
    'the ISRC is the whole reason content comes from Spotify');
});

test('a track change in hybrid restarts the show on the hybrid clock', async () => {
  const rig = build();
  rig.spotify.authenticated = true;
  rig.nowPlaying.authenticated = true;
  rig.autoShow.running = true;
  rig.autoShow.downloadAndAnalyze = async () => {};

  await withSource('hybrid', async () => {
    rig.spotify.emitTrack(SPOTIFY_TRACK);
    await new Promise((resolve) => setImmediate(resolve));
    rig.spotify.emitPlayback(SPOTIFY_TRACK);
    rig.nowPlaying.emitPlayback({ ...OS_SESSION, progressMs: 45000 });
  });

  assert.strictEqual(rig.started.length, 1, 'the show restarted');
  const position = rig.started[0]();
  assert.ok(Math.abs(position - 45000) < 50,
    `restarted on the wrong clock: ${position}`);
});

test('hybrid peeks the Spotify queue, which is what the OS session cannot see', () => {
  const rig = build();
  rig.spotify.authenticated = true;
  rig.nowPlaying.authenticated = true;
  rig.autoShow.running = true;

  let peeked = 0;
  rig.spotify.getQueue = async () => { peeked++; return []; };

  withSource('hybrid', () => {
    rig.integrations.startAutoShow();
    rig.spotify.emitPlayback(SPOTIFY_TRACK);
  });
  assert.strictEqual(peeked, 1);
});

test('the resolved source is published, not just the operator’s choice', () => {
  const rig = build();
  rig.spotify.authenticated = true;
  rig.nowPlaying.authenticated = true;
  withSource('auto', () => {
    const live = getLiveState();
    assert.strictEqual(live.autoSource, 'auto', 'the choice');
    assert.strictEqual(live.activeSource, 'hybrid', 'and what it resolved to');
    assert.ok(live.hybrid, 'with the hybrid status alongside it');
  });
});

// ── Track changes, per source ────────────────────────────────────────────────
// Three handlers that were copies of one another now share restartShowFor.
// Each source must still restart only a show it is driving, and key its cache
// the way it always has.

const settle = () => new Promise((resolve) => setImmediate(resolve));

for (const [source, rigKey, expectedKey] of [
  ['spotify', 'spotify', 'spotify:spotify-1'],
  ['nowplaying', 'nowPlaying', 'q:porter robinson, madeon - shelter'],
  ['deezer', 'deezerSource', 'q:porter robinson, madeon - shelter'],
]) {
  test(`a ${source} track change restarts the show it is driving`, async () => {
    const rig = build();
    rig[rigKey].authenticated = true;
    rig.autoShow.running = true;
    const analysed = [];
    rig.autoShow.downloadAndAnalyze = async (...args) => { analysed.push(args); };

    await withSource(source, async () => { rig[rigKey].emitTrack(SPOTIFY_TRACK); await settle(); });

    assert.deepStrictEqual(analysed, [['Porter Robinson, Madeon - Shelter', 220, expectedKey, 'USUG11600982']]);
    assert.strictEqual(rig.started.length, 1, 'and starts it again');
    assert.strictEqual(rig.autoShow.track.name, 'Shelter');
  });

  test(`a ${source} track change leaves a show it is not driving alone`, async () => {
    const rig = build();
    rig[rigKey].authenticated = true;
    const analysed = [];
    rig.autoShow.downloadAndAnalyze = async (...args) => { analysed.push(args); };

    rig.autoShow.running = false;
    await withSource(source, async () => { rig[rigKey].emitTrack(SPOTIFY_TRACK); await settle(); });
    // Another connected source driving: an unconnected choice would fall
    // back to this one, which would then really be driving.
    const [other, otherKey] = source === 'nowplaying' ? ['deezer', 'deezerSource'] : ['nowplaying', 'nowPlaying'];
    rig[otherKey].authenticated = true;
    rig.autoShow.running = true;
    await withSource(other, async () => { rig[rigKey].emitTrack(SPOTIFY_TRACK); await settle(); });

    assert.deepStrictEqual(analysed, [], 'neither a stopped show nor another source\'s show');
    assert.strictEqual(rig.started.length, 0);
  });
}

test('a failed analysis on a track change is reported, and the show stays stopped', async () => {
  const rig = build();
  rig.deezerSource.authenticated = true;
  rig.autoShow.running = true;
  rig.autoShow.downloadAndAnalyze = async () => { throw new Error('no audio'); };
  const warn = console.warn; const error = console.error;
  console.warn = () => {}; console.error = () => {};
  try {
    await withSource('deezer', async () => { rig.deezerSource.emitTrack(SPOTIFY_TRACK); await settle(); });
  } finally { console.warn = warn; console.error = error; }
  assert.strictEqual(rig.autoShow.running, false);
  assert.strictEqual(rig.started.length, 0);
});

// Spotify alone used to re-anchor on every poll: a report a little behind the
// previous one moved the show backwards, which re-seeks the timeline and
// restarts the pattern. It now runs through the same smoothing clock as the
// hybrid source.
test('with Spotify alone, a slightly late report does not move the show backwards', () => {
  const rig = build();
  rig.spotify.authenticated = true;
  rig.nowPlaying.authenticated = false;

  withSource('spotify', () => {
    rig.integrations.startAutoShow();
    const t0 = Date.now();
    rig.spotify.emitPlayback({ ...SPOTIFY_TRACK, progressMs: 30000, sampledAt: t0 - 1000 });
    const before = rig.started[0]();
    // One second later by the wall clock, Spotify reports only 800 ms of
    // progress: 200 ms of jitter, not a seek.
    rig.spotify.emitPlayback({ ...SPOTIFY_TRACK, progressMs: 30800, sampledAt: t0 });
    const after = rig.started[0]();
    assert.ok(after >= before, `moved from ${before} back to ${after}`);
    // A seek is still followed at once.
    rig.spotify.emitPlayback({ ...SPOTIFY_TRACK, progressMs: 120000, sampledAt: Date.now() });
    assert.ok(Math.abs(rig.started[0]() - 120000) < 100);
  });
});

// ── The pattern clock's track lock ──────────────────────────────────────────
// With the auto show off, manual patterns lock to the song that is playing
// whenever its analysis is cached (conductor.js, the `track` source).

import { conductor } from '../../src/server/conductor.ts';
import { keyForSpotify } from '../../src/analysis-cache.ts';
import { getLiveState } from '../../src/server/state.ts';
import { makeGrid } from '../../src/shared/beat-clock.ts';

const beatsAt = (bpm) => Array.from({ length: 600 }, (_, i) => i * (60 / bpm));

/** A cache holding `docs` by key, counting the reads. */
function cacheOf(docs) {
  const loads = [];
  return { loads, load: async (key) => { loads.push(key); return docs[key] || null; } };
}

test('with the show off, a cached track locks the patterns to its beats', async () => {
  const key = keyForSpotify(SPOTIFY_TRACK.trackId);
  const cache = cacheOf({ [key]: { beats: beatsAt(128) } });
  const rig = build({ analysisCache: cache });
  rig.spotify.authenticated = true;
  rig.autoShow.isCached = (k) => k === key;
  rig.autoShow.syncOffsetMs = 100;

  await withSource('spotify', async () => {
    rig.spotify.emitPlayback({ ...SPOTIFY_TRACK, progressMs: 30000, sampledAt: Date.now() });
    rig.spotify.emitTrack(SPOTIFY_TRACK);
    await settle();
  });

  assert.deepStrictEqual(cache.loads, [key]);
  assert.strictEqual(conductor.trackKey, key);
  const reading = conductor.now();
  assert.strictEqual(reading.source, 'track');
  // 30.1 s into a 128 BPM grid (the sync offset included): beat 64.2.
  assert.ok(Math.abs(reading.beatPos - (30100 / 1000) * (128 / 60)) < 0.2, `beat ${reading.beatPos}`);
  assert.ok(Math.abs(reading.bpm - 128) < 1e-6);
  conductor.clearTrack();
});

test('a track with no analysis yet locks the moment one lands', async () => {
  const cache = cacheOf({});
  const rig = build({ analysisCache: cache });
  rig.spotify.authenticated = true;
  const key = keyForSpotify(SPOTIFY_TRACK.trackId);

  await withSource('spotify', async () => {
    rig.spotify.emitPlayback({ ...SPOTIFY_TRACK, sampledAt: Date.now() });
    rig.spotify.emitTrack(SPOTIFY_TRACK);
    await settle();
    assert.strictEqual(conductor.trackKey, null, 'nothing to lock to yet');
    assert.deepStrictEqual(cache.loads, [], 'and no read of a document that is not there');

    rig.autoShow.onAnalysisCached('spotify:someone-else', { beats: beatsAt(100) });
    assert.strictEqual(conductor.trackKey, null, 'another song\'s analysis is not this one');
    rig.autoShow.onAnalysisCached(key, { beats: beatsAt(128) });
    assert.strictEqual(conductor.trackKey, key, 'the prefetch finished: locked');
  });
  conductor.clearTrack();
});

// While the show runs it loads the new song itself; reading the same document
// again here would parse megabytes twice on the render loop's thread. It
// locks from the show's copy once the show has restarted.
test('a running show shares its copy of the analysis with the track lock', async () => {
  const key = keyForSpotify(SPOTIFY_TRACK.trackId);
  const cache = cacheOf({ [key]: { beats: beatsAt(128) } });
  const rig = build({ analysisCache: cache });
  rig.spotify.authenticated = true;
  rig.autoShow.running = true;
  rig.autoShow.isCached = () => true;
  let loaded = null;
  rig.autoShow.downloadAndAnalyze = async (query, sec, cacheKey) => { loaded = cacheKey; };
  rig.autoShow.gridFor = (k) => (k === loaded ? makeGrid(beatsAt(128)) : null);

  await withSource('spotify', async () => {
    rig.spotify.emitTrack(SPOTIFY_TRACK);
    await settle();
  });
  assert.deepStrictEqual(cache.loads, [], 'no second read');
  assert.strictEqual(conductor.trackKey, key, 'locked from the show\'s copy');
  conductor.clearTrack();
});

test('a new song lets go of the last one\'s beats at once', async () => {
  const key = keyForSpotify(SPOTIFY_TRACK.trackId);
  const cache = cacheOf({ [key]: { beats: beatsAt(128) } });
  const rig = build({ analysisCache: cache });
  rig.spotify.authenticated = true;
  rig.autoShow.isCached = (k) => k === key;

  await withSource('spotify', async () => {
    rig.spotify.emitTrack(SPOTIFY_TRACK);
    await settle();
    assert.strictEqual(conductor.trackKey, key);
    rig.spotify.emitTrack({ ...SPOTIFY_TRACK, trackId: 'spotify-2', name: 'Other' });
    assert.strictEqual(conductor.trackKey, null, 'the old grid is not read against the new song');
  });
});
