'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AnalysisCache, keyForSpotify, keyForYouTube, keyForQuery, keyForBuffer, keyForProlinkTrack,
} = require('../../src/analysis-cache');

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
  assert.strictEqual(keyForProlinkTrack({ title: 'T', artist: 'A' }), 'q:a - t');
  assert.strictEqual(keyForProlinkTrack({}), null);
});

test('cache round-trips, lists and clears', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-'));
  try {
    const cache = new AnalysisCache(dir);
    assert.strictEqual(cache.get('missing'), null);
    assert.strictEqual(cache.has('missing'), false);

    cache.set('k1', { schemaVersion: '2.0', bpm: 128, duration: 200 }, { track: { name: 'x' } });
    assert.strictEqual(cache.has('k1'), true);
    assert.deepStrictEqual(cache.get('k1'), { schemaVersion: '2.0', bpm: 128, duration: 200 });

    const [entry] = cache.list();
    assert.strictEqual(entry.key, 'k1');
    assert.strictEqual(entry.bpm, 128);

    assert.strictEqual(cache.delete('k1'), true);
    assert.strictEqual(cache.get('k1'), null);

    cache.set('a', { bpm: 1 });
    cache.set('b', { bpm: 2 });
    assert.strictEqual(cache.clear(), 2);
    assert.strictEqual(cache.list().length, 0);
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
  const { MIN_COMPATIBLE } = require('../../src/analysis-cache');
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'analysis', 'version.py'), 'utf8');
  assert.match(source, new RegExp(`^MIN_COMPATIBLE = '${MIN_COMPATIBLE.join('\.')}'`, 'm'));
});
