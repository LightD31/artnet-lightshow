// Spotify stopped handing over ISRCs in February 2026. The lookup that
// replaces it must find the right *edit*, and must say "don't know" rather
// than guess — a wrong recording puts every cue in the wrong place.

import test from 'node:test';
import assert from 'node:assert';
import { resolveIsrc, splitQuery, normalise, _cache } from '../../src/isrc.js';

const quiet = { warn() {} };

function deezer(searchHits, isrcs = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = url.includes('/search?')
      ? { data: searchHits }
      : { isrc: isrcs[url.split('/track/')[1]] };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, calls };
}

const hit = (id, title, artist, duration) => ({ id, title, title_short: title, artist: { name: artist }, duration });

test('the hit whose length matches is the one used', async () => {
  _cache.clear();
  const { fetchImpl, calls } = deezer([
    hit(1, 'Around the World', 'Daft Punk', 238),            // radio edit
    hit(2, 'Around the World', 'Daft Punk', 429),            // album version
  ], { 1: 'GBDUW9700001', 2: 'GBDUW0000059' });
  const isrc = await resolveIsrc({ artist: 'Daft Punk', title: 'Around the World', durationSec: 428 }, { fetchImpl, log: quiet });
  assert.strictEqual(isrc, 'GBDUW0000059');
  assert.ok(calls[0].includes(encodeURIComponent('artist:"Daft Punk"')), calls[0]);
});

test('no confident match is null, not a guess', async () => {
  _cache.clear();
  const { fetchImpl } = deezer([hit(1, 'Around the World', 'Daft Punk', 238)], { 1: 'GBDUW9700001' });
  assert.strictEqual(await resolveIsrc({ artist: 'Daft Punk', title: 'Around the World', durationSec: 428 }, { fetchImpl, log: quiet }), null);

  _cache.clear();
  const other = deezer([hit(3, 'Around the World', 'Red Hot Chili Peppers', 238)], { 3: 'USWB19900001' });
  assert.strictEqual(await resolveIsrc({ artist: 'Daft Punk', title: 'Around the World', durationSec: 238 }, { fetchImpl: other.fetchImpl, log: quiet }), null);
});

test('featured artists, remaster suffixes and accents do not break the match', async () => {
  _cache.clear();
  const { fetchImpl } = deezer([hit(9, 'Get Lucky (Radio Edit)', 'Daft Punk', 248)], { 9: 'USQX91300108' });
  const isrc = await resolveIsrc({ artist: 'Daft Punk, Pharrell Williams', title: 'Get Lucky - Radio Edit', durationSec: 248 }, { fetchImpl, log: quiet });
  assert.strictEqual(isrc, 'USQX91300108');
  assert.strictEqual(normalise('Café (feat. Someone)'), 'cafe');
});

test('a network failure is null and is not remembered', async () => {
  _cache.clear();
  let n = 0;
  const failing = async () => { n++; throw new Error('offline'); };
  assert.strictEqual(await resolveIsrc({ artist: 'A', title: 'B', durationSec: 200 }, { fetchImpl: failing, log: quiet }), null);
  await resolveIsrc({ artist: 'A', title: 'B', durationSec: 200 }, { fetchImpl: failing, log: quiet });
  assert.strictEqual(n, 2, 'retried on the next call');
});

test('an answer, a miss included, is remembered', async () => {
  _cache.clear();
  const { fetchImpl, calls } = deezer([]);
  await resolveIsrc({ artist: 'A', title: 'B', durationSec: 200 }, { fetchImpl, log: quiet });
  await resolveIsrc({ artist: 'A', title: 'B', durationSec: 200 }, { fetchImpl, log: quiet });
  assert.strictEqual(calls.length, 1);
});

test('the "Artist - Title" query splits on the first separator', () => {
  assert.deepStrictEqual(splitQuery('Daft Punk - Around the World'), { artist: 'Daft Punk', title: 'Around the World' });
  assert.deepStrictEqual(splitQuery('Queen - Bohemian Rhapsody - Remastered 2011'), { artist: 'Queen', title: 'Bohemian Rhapsody - Remastered 2011' });
  assert.strictEqual(splitQuery('just a search'), null);
});
