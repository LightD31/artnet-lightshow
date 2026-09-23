// The "analyse what is playing" routes, mounted for real on an Express app
// with stand-in sources. They were three copies of one handler; this pins what
// each one asks of the auto show so the shared version cannot drift from them.

import test from 'node:test';
import assert from 'node:assert';
import express from 'express';

import { attachRoutes } from '../../src/server/routes.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyAnalyzeSource, resolveLocalPath } from '../../src/server/routes.js';
import { settings } from '../../src/server/settings.ts';

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

// What "Analyse" accepts. UNC paths make Windows authenticate to whatever
// server they name, other URL schemes reach places yt-dlp and librosa should
// not, and a relative path means whatever the server's working folder says.
test('analyse input is classified, and unsafe forms are refused', () => {
  const kind = (s) => classifyAnalyzeSource(s).kind;

  assert.strictEqual(kind('/music/set/track.flac'), 'local');
  assert.strictEqual(kind('C:\\Music\\track.mp3'), 'local');
  assert.strictEqual(kind('D:/Music/track.wav'), 'local');
  assert.strictEqual(kind('https://example.com/a.mp3'), 'url');
  assert.strictEqual(classifyAnalyzeSource('https://example.com/a.mp3').direct, true);
  assert.strictEqual(classifyAnalyzeSource('https://youtu.be/abc').direct, false);
  assert.strictEqual(kind('Daft Punk - Around the World'), 'search');

  for (const bad of ['\\\\fileserver\\share\\a.mp3', '//fileserver/share/a.mp3', '\\\\?\\C:\\a.mp3',
    'file:///etc/passwd.mp3', 'smb://host/a.mp3', 'ftp://host/a.wav', '../../secret/a.mp3', 'music\\a.mp3']) {
    assert.throws(() => classifyAnalyzeSource(bad), (err) => err.status === 400, bad);
  }
});

test('a local file is resolved through symlinks and held to the library folder', async () => {

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
  fs.writeFileSync(path.join(root, 'in.mp3'), 'x');
  fs.writeFileSync(path.join(outside, 'out.mp3'), 'x');
  const link = path.join(root, 'escape.mp3');
  let linked = true;
  try { fs.symlinkSync(path.join(outside, 'out.mp3'), link); } catch (_) { linked = false; }

  const original = settings.get('analysis.localRoot');
  settings._values.analysis.localRoot = root;
  try {
    assert.strictEqual(await resolveLocalPath(path.join(root, 'in.mp3')), fs.realpathSync(path.join(root, 'in.mp3')));
    await assert.rejects(resolveLocalPath(path.join(outside, 'out.mp3')), (e) => e.status === 403);
    await assert.rejects(resolveLocalPath(path.join(root, 'missing.mp3')), (e) => e.status === 404);
    if (linked) await assert.rejects(resolveLocalPath(link), (e) => e.status === 403, 'symlink out of the folder');
  } finally {
    settings._values.analysis.localRoot = original;
  }
});
