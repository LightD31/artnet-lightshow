// A CDJ track is analysed from its own file, fetched off the player, and only
// searched for by name when the player cannot hand the file over. The two
// analyses are cached apart: one of a recording found by name need not line
// up with the deck, and must never pass for the real file's.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import AutoShow from '../../src/auto-show.ts';
import { keyForProlinkTrack } from '../../src/analysis-cache.ts';
import { audioToTempWav } from '../../src/audio-file.ts';
import { setupIntegrations } from '../../src/server/integrations.ts';
import ProLink from '../../src/prolink.ts';

const TRACK = { trackId: 7, deviceId: 2, slot: 3, trackType: 1, title: 'Song', artist: 'Artist', durationMs: 301400, fileName: 'Song.aiff' };

test('the file\'s analysis has a key of its own, and needs a name to have one', () => {
  assert.strictEqual(keyForProlinkTrack(TRACK), 'prolink:artist - song:301');
  assert.strictEqual(keyForProlinkTrack(TRACK, { exact: true }), 'prolink-file:artist - song:301');
  assert.strictEqual(keyForProlinkTrack({ deviceId: 2, slot: 3, trackId: 7 }, { exact: true }), null,
    'an address is not the same file on another stick');
});

test('a file off the player becomes a WAV for the analyser',
  { skip: process.platform === 'win32' && 'uses a POSIX shell stand-in' }, async () => {
    // An ffmpeg that records what it was asked and copies input to output.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ffmpeg-'));
    const log = path.join(dir, 'calls.log');
    fs.writeFileSync(path.join(dir, 'ffmpeg'), `#!/bin/sh
echo "$@" >> "${log}"
in=""; prev=""; for a in "$@"; do if [ "$prev" = "-i" ]; then in="$a"; fi; prev="$a"; done
for a in "$@"; do out="$a"; done
cp "$in" "$out"
`, { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
    try {
      const wav = await audioToTempWav(Buffer.from('FORM....AIFF'), 'Song.aiff');
      assert.match(wav, /\.wav$/);
      assert.strictEqual(fs.readFileSync(wav, 'utf8'), 'FORM....AIFF');
      const [call] = fs.readFileSync(log, 'utf8').trim().split('\n');
      const input = call.split(' ')[call.split(' ').indexOf('-i') + 1];
      assert.match(input, /\.aiff$/, 'ffmpeg is told what the file is');
      assert.ok(!fs.existsSync(input), 'and the original is gone');
      fs.rmSync(wav);

      const odd = await audioToTempWav(Buffer.from('x'), '../../etc/evil.sh');
      const oddCall = fs.readFileSync(log, 'utf8').trim().split('\n')[1];
      assert.doesNotMatch(oddCall, /evil|\.sh/, 'a name off the stick contributes a known extension or nothing');
      fs.rmSync(odd);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

test('an exact source analyses its file whole, and never falls back to a search itself', async () => {
  const saved = [];
  const cache = { has: () => false, save: async (key, analysis, meta) => { saved.push({ key, meta, analysis }); } };
  const show = new AutoShow(() => {}, [{ name: 'Blackout' }], [], cache);
  try {
    const searched = [];
    show._downloadAudio = async (query) => { searched.push(query); return null; };
    const analysed = [];
    show._runAnalyzer = async (file, target) => { analysed.push({ file, target }); return { beats: [0, 0.5, 1] }; };
    const file = path.join(os.tmpdir(), `exact-${process.pid}.wav`);
    fs.writeFileSync(file, 'RIFF');

    show.setExactAudio('prolink-file:a - s:301', { fetch: async () => file, refine: (a) => ({ ...a, beatSource: 'rekordbox' }) });
    const r = await show.prefetch('A - S', 301, 'prolink-file:a - s:301', { title: 'S' });
    assert.deepStrictEqual(r, { skipped: false });
    assert.deepStrictEqual(analysed, [{ file, target: null }], 'the file is the track: nothing to trim');
    assert.deepStrictEqual(searched, []);
    assert.ok(!fs.existsSync(file), 'and removed afterwards');
    assert.deepStrictEqual(saved.map((s) => s.key), ['prolink-file:a - s:301']);
    assert.strictEqual(saved[0].analysis.beatSource, 'rekordbox', 'refined before it is cached');

    // A refinement that fails keeps the analysis as it came.
    fs.writeFileSync(file, 'RIFF');
    show.setExactAudio('prolink-file:a - s:302', { fetch: async () => file, refine: () => { throw new Error('bad grid'); } });
    assert.deepStrictEqual(await show.prefetch('A - S', 302, 'prolink-file:a - s:302'), { skipped: false });
    assert.deepStrictEqual(saved[1].analysis, { beats: [0, 0.5, 1] });

    show.setExactAudio('prolink-file:b - t:200', { fetch: async () => null });
    const failed = await show.prefetch('B - T', 200, 'prolink-file:b - t:200');
    assert.match(failed.error, /own audio file could not be fetched/);
    assert.deepStrictEqual(searched, [], 'no search under the exact key');

    // Without an exact source, the key is searched for as before.
    await show.prefetch('C - U', 180, 'prolink:c - u:180');
    assert.deepStrictEqual(searched, ['C - U']);
  } finally { show._worker.shutdown(); }
});

// ── Through the integrations ──────────────────────────────────────────────────

function rig({ canFetch = true, fetched = { data: Buffer.from('audio'), fileName: 'x.mp3' }, cached = [] } = {}) {
  const idle = { onPlaybackUpdate() {}, onTrackChange() {}, getStatus: () => ({}), authenticated: false };
  const calls = [];
  const prolink = {
    connected: true, stale: false, lastError: null,
    getNumPeers: () => 2, getFollowed: () => null, getTrack: () => null, getLoadedTracks: () => [],
    getTempo: () => 0, getPositionMs: () => 0,
    onTempoChange() {}, onPeersChange() {}, onFollowChange() {}, onLoadedTracksChange() {},
    onTrackChange(fn) { this.trackChanged = fn; },
    onAnyTrackLoaded(fn) { this.anyLoaded = fn; },
    canFetchAudio: () => canFetch,
    fetchAudio: async () => fetched,
  };
  const exact = new Map();
  const autoShow = {
    running: false, track: null, syncOffsetMs: 0,
    getPositionMs: () => 0, getClientState: () => ({}), start() {}, stop() {},
    isCached: (key) => cached.includes(key), gridFor: () => null, isPrefetching: () => false,
    applyQueueOrder() {}, setPaletteSize() {}, setIntensity() {}, setSyncOffsetMs() {},
    setExactAudio(key, source) { exact.set(key, source); },
    // The file source is registered before its key is asked for; whether it
    // yields a file is the player's business, stood in for by `fetched`.
    fileFails(key) {
      if (!key.startsWith('prolink-file:')) return false;
      assert.ok(exact.has(key), 'the file source is registered under its key');
      return !fetched;
    },
    async downloadAndAnalyze(query, target, key) {
      calls.push(['current', key, target]);
      if (this.fileFails(key)) throw new Error('no file');
      return { analysis: {}, cached: false };
    },
    async prefetch(query, target, key) {
      calls.push(['prefetch', key, target]);
      if (this.fileFails(key)) return { skipped: false, error: 'no file' };
      return { skipped: false };
    },
  };
  const integrations = setupIntegrations({
    io: { emit() {} }, midi: { enabled: false, sendFeedback() {}, listPorts: () => [] },
    spotify: { ...idle, startPolling() {}, async getQueue() { return []; } },
    nowPlaying: idle,
    deezerSource: { ...idle, getQueue: () => [], updatePlayback() {}, updateQueue() {}, disconnect() {} },
    prolink, autoShow,
  });
  return { integrations, prolink, calls };
}

const FILE_KEY = 'prolink-file:artist - song:301';
const SEARCH_KEY = 'prolink:artist - song:301';

test('the playing track is analysed from its own file, and searched for only when that fails', async () => {
  const good = rig();
  await good.integrations.analyseCdjTrack(TRACK);
  assert.deepStrictEqual(good.calls, [['current', FILE_KEY, null]]);

  const noFile = rig({ fetched: null });
  await noFile.integrations.analyseCdjTrack(TRACK);
  assert.deepStrictEqual(noFile.calls, [['current', FILE_KEY, null], ['current', SEARCH_KEY, 301.4]]);

  const cannot = rig({ canFetch: false });
  await cannot.integrations.analyseCdjTrack(TRACK);
  assert.deepStrictEqual(cannot.calls, [['current', SEARCH_KEY, 301.4]], 'rekordbox over the link: search at once');

  // Made already by search, not yet from the file: play what there is now.
  const searched = rig({ cached: [SEARCH_KEY] });
  await searched.integrations.analyseCdjTrack(TRACK);
  assert.deepStrictEqual(searched.calls, [['current', SEARCH_KEY, 301.4]]);

  await assert.rejects(rig({ canFetch: false }).integrations.analyseCdjTrack({ ...TRACK, title: null }), /no rekordbox metadata/);
});

test('a loaded track is prefetched from its file, even when a search has already analysed it', async () => {
  const r = rig({ cached: [SEARCH_KEY] });
  r.prolink.anyLoaded(TRACK);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(r.calls, [['prefetch', FILE_KEY, null]]);

  const fallback = rig({ fetched: null });
  fallback.prolink.anyLoaded(TRACK);
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(fallback.calls, [['prefetch', FILE_KEY, null], ['prefetch', SEARCH_KEY, 301.4]]);

  const done = rig({ cached: [FILE_KEY] });
  done.prolink.anyLoaded(TRACK);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(done.calls, []);
});

test('the player hands over a track\'s file and phrases only from its own media', async () => {
  const asked = [];
  const raw = {
    title: 'Song', duration: 301, artist: { name: 'Artist' }, album: null, beatGrid: null,
    filePath: '/Contents/Artist/Song.flac', fileName: 'Song.flac', analyzePath: '/PIONEER/USBANLZ/P01/0001/ANLZ0000',
  };
  const structure = { mood: 'high', endBeat: 400, phrases: [{ index: 1, beat: 1, kind: 1, phraseType: 'Intro' }] };
  const p = new ProLink();
  p._network = {
    db: {
      getMetadata: async () => raw,
      getFile: async (q) => { asked.push(['file', q.deviceId, q.trackSlot, q.track.filePath]); return Buffer.from('fLaC'); },
      getTrackAnalysis: async (q) => { asked.push(['analysis', q.track.analyzePath]); return { songStructure: structure }; },
    },
  };
  const usb = await p._resolveTrackMetadata(2, 3, 1, 7);
  assert.deepStrictEqual([usb.title, usb.artist, usb.durationMs, usb.fileName], ['Song', 'Artist', 301000, 'Song.flac']);
  assert.strictEqual(p.canFetchAudio(usb), true);
  assert.deepStrictEqual(await p.fetchAudio(usb), { data: Buffer.from('fLaC'), fileName: 'Song.flac' });
  assert.deepStrictEqual(await p.fetchSongStructure(usb), structure);
  assert.deepStrictEqual(asked, [['file', 2, 3, '/Contents/Artist/Song.flac'], ['analysis', '/PIONEER/USBANLZ/P01/0001/ANLZ0000']]);

  // rekordbox over the link: metadata, but no file to fetch.
  const linked = await p._resolveTrackMetadata(17, 4, 1, 9);
  assert.strictEqual(p.canFetchAudio(linked), false);
  // A track never described is not guessed at.
  assert.strictEqual(p.canFetchAudio({ ...usb, trackId: 99 }), false);
  assert.strictEqual(await p.fetchAudio({ ...usb, trackId: 99 }), null);

  p._network.db.getTrackAnalysis = async () => ({ songStructure: { mood: 'mid', endBeat: 0, phrases: [] } });
  assert.strictEqual(await p.fetchSongStructure(usb), null, 'no phrases, no structure');
});
