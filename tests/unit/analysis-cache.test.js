import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AnalysisCache, keyForSpotify, keyForYouTube, keyForQuery, keyForBuffer, keyForProlinkTrack } from '../../src/analysis-cache.js';
import { MIN_COMPATIBLE } from '../../src/analysis-cache.js';

test('cache keys are stable and distinct per source', () => {
  assert.strictEqual(keyForSpotify('abc'), 'spotify:abc');
  assert.strictEqual(keyForSpotify(null), null);

  // Every YouTube URL shape must collapse to the same 11-char video id.
  for (const url of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
  ]) {
    assert.strictEqual(keyForYouTube(url), 'yt:dQw4w9WgXcQ', url);
  }
  assert.strictEqual(keyForYouTube('not a url'), null);

  // Query keys normalise case and whitespace so the same search hits cache.
  assert.strictEqual(keyForQuery('  Daft   Punk - ONE MORE Time '), 'q:daft punk - one more time');
  assert.strictEqual(keyForQuery('   '), null);

  assert.strictEqual(keyForBuffer(Buffer.from('a')), keyForBuffer(Buffer.from('a')));
  assert.notStrictEqual(keyForBuffer(Buffer.from('a')), keyForBuffer(Buffer.from('b')));
  assert.strictEqual(keyForBuffer(Buffer.alloc(0)), null);

  assert.strictEqual(keyForProlinkTrack({ deviceId: 1, slot: 2, trackId: 3 }), 'prolink:1:2:3');
  assert.strictEqual(keyForProlinkTrack({ title: 'T', artist: 'A' }), 'prolink:a - t:0');
  assert.strictEqual(keyForProlinkTrack({}), null);
  // rekordbox ids are per export: the same id on two sticks is two songs, and
  // the same song on two sticks is one analysis.
  const onStickA = { deviceId: 2, slot: 3, trackId: 17, artist: 'Justice', title: 'Genesis', durationMs: 234000 };
  const onStickB = { ...onStickA, deviceId: 3, trackId: 902 };
  const otherSong = { ...onStickA, artist: 'Daft Punk', title: 'Rollin\' & Scratchin\'' };
  assert.strictEqual(keyForProlinkTrack(onStickA), keyForProlinkTrack(onStickB));
  assert.notStrictEqual(keyForProlinkTrack(onStickA), keyForProlinkTrack(otherSong));
  // An extended mix and a radio edit are different downloads.
  assert.notStrictEqual(keyForProlinkTrack(onStickA), keyForProlinkTrack({ ...onStickA, durationMs: 397000 }));
});

test('cache round-trips, lists and clears', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-'));
  try {
    const cache = new AnalysisCache(dir);
    assert.strictEqual(cache.get('missing'), null);
    assert.strictEqual(cache.has('missing'), false);

    cache.set('k1', { schemaVersion: '2.0', bpm: 128, duration: 200 }, { track: { name: 'x' } });
    assert.strictEqual(cache.has('k1'), true);
    assert.deepStrictEqual(cache.get('k1'), { schemaVersion: '2.0', bpm: 128, duration: 200 });

    const [entry] = await cache.list();
    assert.strictEqual(entry.key, 'k1');
    assert.strictEqual(entry.bpm, 128);

    assert.strictEqual(cache.delete('k1'), true);
    assert.strictEqual(cache.get('k1'), null);

    cache.set('a', { bpm: 1 });
    cache.set('b', { bpm: 2 });
    assert.strictEqual(cache.clear(), 2);
    assert.strictEqual((await cache.list()).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The analyser marks what it wrote; version.py names the oldest a consumer can
// still read. Older entries used to replay forever after an analyser upgrade.
test('an entry from an analyser too old to read is a miss, and goes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-'));
  const log = console.log;
  console.log = () => {};
  try {
    const cache = new AnalysisCache(dir);
    cache.set('old', { schemaVersion: '1.4', bpm: 120 });
    cache.set('none', { bpm: 120 });
    cache.set('now', { schemaVersion: '2.0', bpm: 120 });
    cache.set('newer', { schemaVersion: '2.3', bpm: 120 });

    assert.strictEqual(cache.get('old'), null);
    assert.strictEqual(cache.has('old'), false, 'removed, so the warmer stops counting it');
    assert.strictEqual(cache.get('none'), null, 'unversioned is pre-2.0');
    assert.strictEqual(cache.get('now').bpm, 120);
    assert.strictEqual(cache.get('newer').bpm, 120, 'additive changes stay readable');
  } finally {
    console.log = log;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the oldest readable version comes from the analyser itself', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'analysis', 'version.py'), 'utf8');
  assert.match(source, new RegExp(`^MIN_COMPATIBLE = '${MIN_COMPATIBLE.join('\\.')}'`, 'm'));
});

// ── Storage ─────────────────────────────────────────────────────────────────

function tmpCache(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-'));
  return { dir, cache: new AnalysisCache(dir, options), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('save and load round-trip without blocking, and leave no temp files', async () => {
  const { dir, cache, done } = tmpCache();
  try {
    await cache.save('k', { schemaVersion: '2.0', bpm: 124, duration: 180 }, { track: { name: 'x' } });
    assert.strictEqual(cache.has('k'), true);
    assert.deepStrictEqual(await cache.load('k'), { schemaVersion: '2.0', bpm: 124, duration: 180 });
    assert.strictEqual(await cache.load('missing'), null);
    assert.ok(fs.readdirSync(dir).every((f) => !f.includes('.tmp-')), 'temp files renamed into place');
  } finally { done(); }
});

// Listing used to parse every analysis — megabytes each — on the thread that
// renders DMX. It reads the small summaries now, and gives an older entry one.
test('listing reads summaries, and gives an entry from before them one', async () => {
  const { dir, cache, done } = tmpCache();
  try {
    await cache.save('new', { schemaVersion: '2.0', bpm: 100 });
    // An entry written by an older build: no summary alongside it.
    const legacy = path.join(dir, `${crypto.createHash('sha1').update('old').digest('hex')}.json`);
    fs.writeFileSync(legacy, JSON.stringify({ key: 'old', meta: {}, cachedAt: '2020-01-01T00:00:00Z',
      analysis: { schemaVersion: '2.0', bpm: 90 } }));

    const entries = await cache.list();
    assert.deepStrictEqual(entries.map((e) => e.key), ['new', 'old'], 'newest first');
    assert.strictEqual(entries[1].bpm, 90);
    assert.ok(fs.existsSync(legacy.replace(/\.json$/, '.summary.json')), 'the old entry gained a summary');
    assert.strictEqual(cache.count(), 2);
  } finally { done(); }
});

// has() is what the warmer and the prefetch poll. An entry the analyser has
// moved past must read as missing there too, so it is analysed again.
test('an entry too old to replay is missing to has() as well', async () => {
  const { cache, done } = tmpCache();
  const log = console.log;
  console.log = () => {};
  try {
    await cache.save('old', { schemaVersion: '1.4', bpm: 120 });
    assert.strictEqual(cache.has('old'), false);
    assert.strictEqual(cache.count(), 0, 'and it is removed');
  } finally { console.log = log; done(); }
});

test('the cache keeps to its budget, dropping the least recently used first', async () => {
  const { cache, done } = tmpCache({ maxBytes: 4000 });
  const log = console.log;
  console.log = () => {};
  try {
    const doc = (n) => ({ schemaVersion: '2.0', bpm: n, pad: 'x'.repeat(1500) });
    await cache.save('a', doc(1));
    await cache.save('b', doc(2));
    // Played since: 'a' is now the more recently used of the two.
    await new Promise((r) => setTimeout(r, 20));
    await cache.load('a');
    await new Promise((r) => setTimeout(r, 20));
    await cache.save('c', doc(3));
    assert.strictEqual(cache.has('a'), true, 'recently played is kept');
    assert.strictEqual(cache.has('b'), false, 'least recently used goes');
    assert.strictEqual(cache.has('c'), true);
  } finally { console.log = log; done(); }
});
