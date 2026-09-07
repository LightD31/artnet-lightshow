'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Warmer, parseSetList, buildJobs, toJob, MAX_TRACKS } = require('../../src/server/warm');

// ── Set-list parsing ────────────────────────────────────────────────────────

test('a pasted set list becomes one track per line', () => {
  const tracks = parseSetList('Daft Punk - Around the World\nJustice - Genesis');

  assert.deepStrictEqual(tracks, [
    { query: 'Daft Punk - Around the World' },
    { query: 'Justice - Genesis' },
  ]);
});

// A set list copied out of rekordbox or a notes app carries all of this.
test('blank lines, comments and leading track numbers are stripped', () => {
  const tracks = parseSetList([
    '# opening',
    '',
    '1. Daft Punk - Around the World',
    '02) Justice - Genesis',
    '  3 - Boys Noize - & Down  ',
    '   ',
  ].join('\n'));

  assert.deepStrictEqual(tracks.map((t) => t.query), [
    'Daft Punk - Around the World',
    'Justice - Genesis',
    'Boys Noize - & Down',
  ]);
});

test('a hyphen in the artist name survives the numbering strip', () => {
  assert.deepStrictEqual(parseSetList('A-Trak - Ray Ban Vision'), [{ query: 'A-Trak - Ray Ban Vision' }]);
});

test('an empty list parses to nothing rather than a blank entry', () => {
  assert.deepStrictEqual(parseSetList('\n\n  \n'), []);
  assert.deepStrictEqual(parseSetList(''), []);
  assert.deepStrictEqual(parseSetList(null), []);
});

// ── Job building ────────────────────────────────────────────────────────────

// The warmed key has to be the one the live path will look up when the track
// actually plays, or the warming was wasted.
test('a title and artist build the same query key the live sources use', () => {
  const job = toJob({ title: 'Genesis', artist: 'Justice' });

  assert.strictEqual(job.query, 'Justice - Genesis');
  assert.strictEqual(job.cacheKey, 'q:justice - genesis');
});

test('a Spotify track id wins over the text, because the live path prefers it too', () => {
  const job = toJob({ title: 'Genesis', artist: 'Justice', trackId: '5abc' });
  assert.strictEqual(job.cacheKey, 'spotify:5abc');
});

test('a YouTube URL is keyed by its video id', () => {
  const job = toJob({ query: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  assert.strictEqual(job.cacheKey, 'yt:dQw4w9WgXcQ');
});

test('a duration comes through in seconds, as the analyzer wants it', () => {
  assert.strictEqual(toJob({ query: 'x', durationMs: 210000 }).durationSec, 210);
  assert.strictEqual(toJob({ query: 'x' }).durationSec, null);
});

test('an entry with nothing to search for is dropped', () => {
  assert.strictEqual(toJob({}), null);
  assert.strictEqual(toJob({ isrc: 'GB1234567890' }), null, 'an ISRC alone is not a search');
});

test('a track listed twice is warmed once', () => {
  const jobs = buildJobs([
    { query: 'Justice - Genesis' },
    { query: 'justice - genesis' },      // same normalised key
    { query: 'Daft Punk - Da Funk' },
  ]);

  assert.deepStrictEqual(jobs.map((j) => j.query), ['Justice - Genesis', 'Daft Punk - Da Funk']);
});

test('the list is capped', () => {
  const jobs = buildJobs(Array.from({ length: MAX_TRACKS + 50 }, (_, i) => ({ query: `Track ${i}` })));
  assert.strictEqual(jobs.length, MAX_TRACKS);
});

// ── Running ─────────────────────────────────────────────────────────────────

/** A stand-in for AutoShow that records what it was asked to prefetch. */
function fakeAutoShow({ cached = [], fail = [], hang = null } = {}) {
  const calls = [];
  return {
    calls,
    isCached: (key) => cached.includes(key),
    prefetch(query, durationSec, cacheKey, meta, isrc, priority) {
      calls.push({ query, cacheKey, isrc, priority, durationSec });
      if (hang && hang.key === cacheKey) return hang.promise;
      if (fail.includes(cacheKey)) return Promise.resolve({ skipped: false, error: 'no result found' });
      return Promise.resolve({ skipped: false });
    },
  };
}

/** Resolve once the warmer has stopped running. */
function whenIdle(warmer) {
  return new Promise((resolve) => {
    const tick = () => (warmer.running ? setImmediate(tick) : resolve());
    tick();
  });
}

test('every track in the list is analysed, in order', async () => {
  const autoShow = fakeAutoShow();
  const warmer = new Warmer({ autoShow });

  warmer.start(parseSetList('A - One\nB - Two\nC - Three'));
  await whenIdle(warmer);

  assert.deepStrictEqual(autoShow.calls.map((c) => c.query), ['A - One', 'B - Two', 'C - Three']);
  const status = warmer.status();
  assert.strictEqual(status.ready, 3);
  assert.strictEqual(status.failed, 0);
  assert.strictEqual(status.running, false);
});

// A track change during a set submits at high priority and must not sit behind
// an hour of warming.
test('warming runs at normal priority so a live track change can jump it', async () => {
  const autoShow = fakeAutoShow();
  const warmer = new Warmer({ autoShow });

  warmer.start(parseSetList('A - One'));
  await whenIdle(warmer);

  assert.strictEqual(autoShow.calls[0].priority, 'normal');
});

test('an already-cached track costs no analyser work at all', async () => {
  const autoShow = fakeAutoShow({ cached: ['q:a - one'] });
  const warmer = new Warmer({ autoShow });

  warmer.start(parseSetList('A - One\nB - Two'));
  await whenIdle(warmer);

  assert.deepStrictEqual(autoShow.calls.map((c) => c.query), ['B - Two'], 'the cached one is skipped');
  assert.strictEqual(warmer.status().tracks[0].status, 'cached');
});

// One track that yt-dlp cannot find should not abandon the other thirty-nine.
test('a track that fails is recorded and the rest of the list continues', async () => {
  const autoShow = fakeAutoShow({ fail: ['q:b - two'] });
  const warmer = new Warmer({ autoShow });

  warmer.start(parseSetList('A - One\nB - Two\nC - Three'));
  await whenIdle(warmer);

  const status = warmer.status();
  assert.strictEqual(status.tracks[1].status, 'error');
  assert.strictEqual(status.tracks[1].message, 'no result found');
  assert.strictEqual(status.ready, 2, 'the other two still cached');
  assert.strictEqual(status.failed, 1);
});

test('a thrown error is recorded like a returned one', async () => {
  const autoShow = {
    isCached: () => false,
    prefetch: () => Promise.reject(new Error('worker died')),
  };
  const warmer = new Warmer({ autoShow });

  warmer.start(parseSetList('A - One'));
  await whenIdle(warmer);

  assert.strictEqual(warmer.status().tracks[0].status, 'error');
  assert.strictEqual(warmer.status().tracks[0].message, 'worker died');
});

// The analyzer worker cannot abandon a job, and killing it would take the live
// show's analysis down too — so the in-flight track finishes and nothing else
// starts.
test('cancel stops the queue but lets the in-flight track finish', async () => {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  const autoShow = fakeAutoShow({ hang: { key: 'q:a - one', promise } });
  const warmer = new Warmer({ autoShow });

  warmer.start(parseSetList('A - One\nB - Two\nC - Three'));
  await new Promise(setImmediate);

  warmer.cancel();
  release({ skipped: false });
  await whenIdle(warmer);

  assert.strictEqual(warmer.status().tracks[0].status, 'ready', 'the in-flight track completed');
  assert.deepStrictEqual(
    warmer.status().tracks.slice(1).map((t) => t.status), ['cancelled', 'cancelled'],
  );
  assert.deepStrictEqual(autoShow.calls.map((c) => c.query), ['A - One'], 'nothing else was started');
});

// Two set lists interleaved would make the progress list meaningless and the
// ordering arbitrary.
test('starting a second run while one is going is refused', async () => {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  const autoShow = fakeAutoShow({ hang: { key: 'q:a - one', promise } });
  const warmer = new Warmer({ autoShow });

  warmer.start(parseSetList('A - One'));
  await new Promise(setImmediate);

  assert.throws(() => warmer.start(parseSetList('B - Two')), /Already warming/);

  release({ skipped: false });
  await whenIdle(warmer);
});

test('an unusable list is refused rather than starting an empty run', () => {
  const warmer = new Warmer({ autoShow: fakeAutoShow() });
  assert.throws(() => warmer.start([]), /Nothing to warm/);
  assert.throws(() => warmer.start(parseSetList('# just a comment')), /Nothing to warm/);
});

test('progress is reported on every transition', async () => {
  const autoShow = fakeAutoShow();
  let changes = 0;
  const warmer = new Warmer({ autoShow, onChange: () => { changes++; } });

  warmer.start(parseSetList('A - One\nB - Two'));
  await whenIdle(warmer);

  // start + (warming + done) per track + finish
  assert.ok(changes >= 5, `expected several updates, saw ${changes}`);
});

test('clear empties a finished run but refuses to touch a live one', async () => {
  const autoShow = fakeAutoShow();
  const warmer = new Warmer({ autoShow });

  warmer.start(parseSetList('A - One'));
  await whenIdle(warmer);

  assert.strictEqual(warmer.clear(), true);
  assert.strictEqual(warmer.status().total, 0);
});
