'use strict';

// The hybrid source itself is covered next door. What is easy to get wrong is
// the wiring: which source resolves when, which callbacks feed which half, and
// whether the show ends up running against the OS clock or Spotify's. Those are
// one-line mistakes that no unit test of either class would catch, so this
// stands the real integrations module up against stub subsystems.

const test = require('node:test');
const assert = require('node:assert');

const { setupIntegrations } = require('../../src/server/integrations');
const { state } = require('../../src/server/state');

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

function build() {
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
    getMaster: () => null,
    getTrack: () => null,
    getLoadedTracks: () => [],
    getTempo: () => 0,
    getPositionMs: () => 0,
    onTempoChange() {}, onPeersChange() {}, onMasterChange() {},
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
    isPrefetching: () => false,
    prefetch: async () => ({ skipped: true, reason: 'already-cached' }),
    setPaletteSize() {}, setIntensity() {}, setSyncOffsetMs() {},
  };

  const integrations = setupIntegrations({
    io: { emit() {} },
    midi: { enabled: false, sendFeedback() {}, listPorts: () => [] },
    spotify, nowPlaying, deezerSource, prolink, autoShow,
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
  rig.prolink.getMaster = () => ({ id: 1 });
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
    const { getLiveState } = require('../../src/server/state');
    const live = getLiveState();
    assert.strictEqual(live.autoSource, 'auto', 'the choice');
    assert.strictEqual(live.activeSource, 'hybrid', 'and what it resolved to');
    assert.ok(live.hybrid, 'with the hybrid status alongside it');
  });
});
