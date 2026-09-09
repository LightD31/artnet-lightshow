'use strict';

// Hybrid takes the clock from the OS media session and the content from
// Spotify. Almost all of its risk is in one question — is the session the OS is
// reporting actually the track Spotify says is playing — so that is where most
// of these tests are. The rest pin the promise that hybrid is never worse than
// plain Spotify: whenever the session cannot be trusted, the clock falls back
// to exactly what the Spotify source would have done.

const test = require('node:test');
const assert = require('node:assert');

const HybridSource = require('../../src/hybrid-source');
const { tracksMatch, normalise, MISMATCH_GRACE } = HybridSource;

const SPOTIFY = {
  trackId: '4uLU6hMCjMI75M1A2tKUQC',
  name: 'Shelter',
  artist: 'Porter Robinson, Madeon',
  durationMs: 220000,
  progressMs: 0,
  isPlaying: true,
  isrc: 'USUG11600982',
};

const session = (over = {}) => ({
  trackId: 'smtc:porter robinson, madeon|shelter',
  name: 'Shelter',
  artist: 'Porter Robinson, Madeon',
  durationMs: 220000,
  progressMs: 0,
  isPlaying: true,
  sourceApp: 'Spotify.exe',
  ...over,
});

/** A source driven by a clock the test controls, so nothing depends on timing. */
function harness() {
  let now = 100000;
  const source = new HybridSource({ now: () => now });
  return {
    source,
    at: (t) => { now = t; return now; },
    advance: (ms) => { now += ms; return now; },
    get now() { return now; },
  };
}

// ── Matching ────────────────────────────────────────────────────────────────

test('the same track from both sources matches', () => {
  assert.ok(tracksMatch(SPOTIFY, session()));
});

test('a featured-artist suffix on one side still matches', () => {
  // Routine: players disagree about whether the feature belongs in the title.
  assert.ok(tracksMatch(SPOTIFY, session({
    name: 'Shelter (feat. Madeon)', artist: 'Porter Robinson',
  })));
});

test('accents and punctuation are not a difference', () => {
  assert.ok(tracksMatch(
    { name: 'Jóga', artist: 'Björk', durationMs: 301000 },
    { name: 'Joga', artist: 'Bjork', durationMs: 301000 },
  ));
});

test('a different track does not match', () => {
  assert.ok(!tracksMatch(SPOTIFY, session({ name: 'Sad Machine' })));
});

test('the same title at a very different length does not match', () => {
  // A remix, an extended mix, or a live version — same name, different
  // recording, and the timeline for one is wrong for the other.
  assert.ok(!tracksMatch(SPOTIFY, session({ durationMs: 400000 })));
});

test('a duration one player rounds differently still matches', () => {
  assert.ok(tracksMatch(SPOTIFY, session({ durationMs: 221200 })));
});

test('a matching duration carries a track whose artist strings disagree', () => {
  // SMTC often reports only the primary artist.
  assert.ok(tracksMatch(SPOTIFY, session({ artist: 'Porter Robinson' })));
});

test('a missing duration falls back to the artist agreeing', () => {
  assert.ok(tracksMatch(SPOTIFY, session({ durationMs: 0 })));
  assert.ok(!tracksMatch(SPOTIFY, session({ durationMs: 0, artist: 'Someone Else' })));
});

test('missing or empty reports never match', () => {
  assert.ok(!tracksMatch(null, session()));
  assert.ok(!tracksMatch(SPOTIFY, null));
  assert.ok(!tracksMatch(SPOTIFY, session({ name: '' })));
});

test('normalise strips everything two players might spell differently', () => {
  assert.strictEqual(normalise('  Björk – Jóga (Remastered) '), 'bjork joga remastered');
  assert.strictEqual(normalise(null), '');
});

// ── Which half drives ───────────────────────────────────────────────────────

test('a matching OS session drives the clock', () => {
  const h = harness();
  h.source.observeContent({ ...SPOTIFY, progressMs: 30000 }, h.now);
  h.source.observeSession(session({ progressMs: 30000 }), h.now);

  assert.strictEqual(h.source.driver, 'nowplaying');
  assert.ok(h.source.matched);
  assert.strictEqual(h.source.getPositionMs(h.now), 30000);
});

test('with no OS session at all it runs on Spotify, like the plain source', () => {
  const h = harness();
  h.source.observeContent({ ...SPOTIFY, progressMs: 30000 }, h.now);
  assert.strictEqual(h.source.driver, 'spotify');
  assert.strictEqual(h.source.getPositionMs(h.now), 30000);
  assert.strictEqual(h.source.getPositionMs(h.advance(1000)), 31000);
});

test('a session playing something else does not drive the clock', () => {
  const h = harness();
  h.source.observeContent({ ...SPOTIFY, progressMs: 30000 }, h.now);
  h.source.observeSession(session({ name: 'A Podcast', durationMs: 3600000, progressMs: 900000 }), h.now);

  assert.ok(!h.source.matched);
  assert.strictEqual(h.source.driver, 'spotify');
  assert.strictEqual(h.source.getPositionMs(h.now), 30000,
    'the podcast position must not reach the show');
});

test('a stale OS session hands the clock back to Spotify', () => {
  const h = harness();
  h.source.observeContent({ ...SPOTIFY, progressMs: 30000 }, h.now);
  h.source.observeSession(session({ progressMs: 30000 }), h.now);
  assert.strictEqual(h.source.driver, 'nowplaying');

  // The reader stopped; Spotify keeps polling.
  h.advance(5000);
  h.source.observeContent({ ...SPOTIFY, progressMs: 35000 }, h.now);
  assert.strictEqual(h.source.driver, 'spotify');
});

test('one disagreeing report does not flap the clock over', () => {
  // The two sources never change track on the same tick, so a single-report
  // test would hand the clock back and forth across every track boundary.
  const h = harness();
  h.source.observeContent({ ...SPOTIFY, progressMs: 30000 }, h.now);
  h.source.observeSession(session({ progressMs: 30000 }), h.now);

  h.source.observeSession(session({ name: 'Something Else' }), h.advance(500));
  assert.ok(h.source.matched, 'still matched after one disagreement');

  for (let i = 1; i < MISMATCH_GRACE; i++) {
    h.source.observeSession(session({ name: 'Something Else' }), h.advance(500));
  }
  assert.ok(!h.source.matched, 'and gives up after a few');
});

// ── Track changes ───────────────────────────────────────────────────────────

test('a new Spotify track resets the clock rather than carrying the old one', () => {
  const h = harness();
  h.source.observeContent({ ...SPOTIFY, progressMs: 200000 }, h.now);
  h.source.observeSession(session({ progressMs: 200000 }), h.now);
  assert.strictEqual(h.source.getPositionMs(h.now), 200000);

  h.advance(1000);
  h.source.observeContent(
    { ...SPOTIFY, trackId: 'other', name: 'Sad Machine', durationMs: 300000, progressMs: 0 },
    h.now);
  assert.strictEqual(h.source.getPositionMs(h.now), 0,
    'the new track must not inherit the old position');
});

test('the clock re-matches as soon as the OS session catches up', () => {
  const h = harness();
  h.source.observeContent({ ...SPOTIFY, progressMs: 200000 }, h.now);
  h.source.observeSession(session({ progressMs: 200000 }), h.now);

  const next = { ...SPOTIFY, trackId: 'other', name: 'Sad Machine', durationMs: 300000, progressMs: 500 };
  h.source.observeContent(next, h.advance(1000));
  h.source.observeSession(
    session({ name: 'Sad Machine', durationMs: 300000, progressMs: 900 }), h.advance(400));

  assert.ok(h.source.matched);
  assert.strictEqual(h.source.driver, 'nowplaying');
  assert.strictEqual(h.source.getPositionMs(h.now), 900);
});

test('content without a track id is ignored', () => {
  const h = harness();
  h.source.observeContent({ name: 'Nameless', progressMs: 1000 }, h.now);
  assert.strictEqual(h.source.getPositionMs(h.now), 0);
});

// ── Behaviour of the combined clock ─────────────────────────────────────────

test('the position advances smoothly between OS reports', () => {
  const h = harness();
  h.source.observeContent({ ...SPOTIFY, progressMs: 0 }, h.now);
  h.source.observeSession(session({ progressMs: 0 }), h.now);

  let previous = 0;
  for (let step = 0; step < 200; step++) {
    h.advance(50);
    if (step % 10 === 9) {
      // The OS reports twice a second, quantised and a little jittery.
      const truth = (step + 1) * 50;
      h.source.observeSession(
        session({ progressMs: truth + (step % 3 === 0 ? 40 : -30) }), h.now);
    }
    const position = h.source.getPositionMs(h.now);
    assert.ok(position >= previous, `went backwards at step ${step}`);
    assert.ok(position - previous < 120, `jumped ${position - previous}ms at step ${step}`);
    previous = position;
  }
  assert.ok(Math.abs(previous - 10000) < 200, `drifted to ${previous}`);
});

test('a pause on the OS side stops the show clock', () => {
  const h = harness();
  h.source.observeContent({ ...SPOTIFY, progressMs: 30000 }, h.now);
  h.source.observeSession(session({ progressMs: 30000 }), h.now);
  h.source.observeSession(session({ progressMs: 30000, isPlaying: false }), h.advance(500));

  assert.strictEqual(h.source.getPositionMs(h.advance(5000)), 30000);
});

test('reset clears both halves', () => {
  const h = harness();
  h.source.observeContent({ ...SPOTIFY, progressMs: 30000 }, h.now);
  h.source.observeSession(session({ progressMs: 30000 }), h.now);
  h.source.reset();

  assert.strictEqual(h.source.driver, 'none');
  assert.ok(!h.source.matched);
  assert.strictEqual(h.source.getPositionMs(h.now), 0);
});

test('the status says which half is driving and how far apart they are', () => {
  const h = harness();
  h.source.observeContent({ ...SPOTIFY, progressMs: 30000 }, h.now);
  h.source.observeSession(session({ progressMs: 30000 }), h.now);
  h.source.observeSession(session({ progressMs: 30600 }), h.advance(500));

  const status = h.source.getStatus();
  assert.strictEqual(status.driver, 'nowplaying');
  assert.strictEqual(status.matched, true);
  assert.strictEqual(status.sessionLive, true);
  assert.strictEqual(status.sessionApp, 'Spotify.exe');
  assert.match(status.contentTrack, /Shelter/);
  assert.strictEqual(status.clock.driftMs, 100);
});
