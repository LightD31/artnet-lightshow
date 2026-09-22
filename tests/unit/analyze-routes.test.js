'use strict';

// The "analyse what is playing" routes, mounted for real on an Express app
// with stand-in sources. They were three copies of one handler; this pins what
// each one asks of the auto show so the shared version cannot drift from them.

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { attachRoutes } = require('../../src/server/routes');

const PLAYING = {
  trackId: 'sp1', isrc: 'GBAYE0601498', name: 'Crazy', artist: 'Gnarls Barkley',
  album: 'St. Elsewhere', albumArt: null, durationMs: 182000,
};

async function withApp(sources, fn) {
  const calls = { analyze: [], prefetch: 0 };
  const autoShow = {
    track: null,
    async downloadAndAnalyze(...args) { calls.analyze.push(args); },
    getClientState: () => ({ analysis: { bpm: 112 } }),
  };
  const integrations = { broadcast() {}, prefetchNextFromQueue() { calls.prefetch++; } };
  const app = express();
  app.use(express.json());
  attachRoutes(app, { autoShow, integrations, ...sources });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const post = async (path) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST' });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn(post, calls, autoShow);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const playingSource = (playing = PLAYING) => ({ authenticated: true, getCurrentlyPlaying: async () => playing });

test('Spotify is keyed by its track id and prefetches the queue after', async () => {
  await withApp({ spotify: playingSource() }, async (post, calls, autoShow) => {
    const { status, body } = await post('/api/auto/analyze-spotify');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.analysis, { bpm: 112 });
    assert.deepStrictEqual(calls.analyze, [['Gnarls Barkley - Crazy', 182, 'spotify:sp1', 'GBAYE0601498']]);
    assert.strictEqual(calls.prefetch, 1);
    assert.strictEqual(autoShow.track.name, 'Crazy');
  });
});

test('the OS media session and Deezer are keyed by name, with no prefetch', async () => {
  for (const [route, key] of [['analyze-nowplaying', 'nowPlaying'], ['analyze-deezer', 'deezerSource']]) {
    await withApp({ [key]: playingSource() }, async (post, calls) => {
      assert.strictEqual((await post(`/api/auto/${route}`)).status, 200, route);
      assert.deepStrictEqual(calls.analyze, [['Gnarls Barkley - Crazy', 182, 'q:gnarls barkley - crazy', 'GBAYE0601498']], route);
      assert.strictEqual(calls.prefetch, 0, route);
    });
  }
});

test('each source says in its own words that it is not connected, or not playing', async () => {
  const cases = [
    ['analyze-spotify', 'spotify', 'Spotify not connected', 'No track currently playing on Spotify'],
    ['analyze-nowplaying', 'nowPlaying', 'Nothing is currently playing', 'Nothing is currently playing'],
    ['analyze-deezer', 'deezerSource', 'Deezer extension not connected', 'No track currently playing on Deezer'],
  ];
  for (const [route, key, offline, idle] of cases) {
    await withApp({ [key]: { authenticated: false } }, async (post, calls) => {
      const { status, body } = await post(`/api/auto/${route}`);
      assert.deepStrictEqual([status, body.error], [400, offline], route);
      assert.strictEqual(calls.analyze.length, 0);
    });
    await withApp({ [key]: playingSource(null) }, async (post) => {
      const { status, body } = await post(`/api/auto/${route}`);
      assert.deepStrictEqual([status, body.error], [400, idle], route);
    });
  }
});
