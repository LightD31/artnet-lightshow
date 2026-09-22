'use strict';

// The master deck's position, as the auto show reads it. Status packets
// arrive about five times a second and name the beat, not the moment within
// it — the position between them has to run on its own and must not snap
// back to the top of the beat on every packet.

const test = require('node:test');
const assert = require('node:assert');
const ProLink = require('../../src/prolink');

const PLAYING = 3;              // prolink-connect PlayState.Playing
const PAUSED = 5;

/** A deck at `bpm` with no beat grid, driven by hand on a fake clock. */
function deck({ bpm = 120 } = {}) {
  const p = new ProLink();
  let now = 1000;
  p._now = () => now;
  // No network: metadata lookups fail fast and fall back, which is fine here.
  p._resolveTrackMetadata = () => Promise.reject(new Error('offline'));
  const beatMs = 60000 / bpm;
  const status = ({ beat, pitch = 0, playState = PLAYING }) => p._onStatus({
    isMaster: true, deviceId: 1, trackDeviceId: 1, trackSlot: 3, trackType: 1, trackId: 42,
    trackBPM: bpm, effectivePitch: pitch, beat, beatInMeasure: ((beat - 1) % 4) + 1, playState,
  });
  return {
    p, beatMs, status,
    advance(ms) { now += ms; },
    pos: () => p.getPositionMs(),
  };
}

/** Play `seconds` of track through the deck, packets every `every` ms. */
function play(d, { seconds, every = 200, pitch = 0, startBeat = 1 }) {
  const rate = 1 + pitch / 100;
  const samples = [];
  let trackMs = (startBeat - 1) * d.beatMs;
  for (let t = 0; t <= seconds * 1000; t += 20) {
    if (t % every === 0) d.status({ beat: Math.floor(trackMs / d.beatMs) + 1, pitch });
    samples.push({ truth: trackMs, pos: d.pos() });
    d.advance(20);
    trackMs += 20 * rate;
  }
  return samples;
}

test('the position never runs backwards far enough to make the show re-seek', () => {
  const d = deck({ bpm: 128 });
  const samples = play(d, { seconds: 20 });
  let worstBack = 0;
  for (let i = 1; i < samples.length; i++) {
    worstBack = Math.max(worstBack, samples[i - 1].pos - samples[i].pos);
  }
  // The auto show re-seeks, restarting its pattern, on a backward step of
  // 100 ms. The old anchoring stepped back by up to a whole packet interval.
  assert.ok(worstBack < 25, `worst backward step ${worstBack.toFixed(1)} ms`);
});

test('the position tracks the deck to within a fraction of a beat', () => {
  const d = deck({ bpm: 128 });
  const samples = play(d, { seconds: 20 }).slice(50);   // after the first beat or two
  const worst = Math.max(...samples.map((s) => Math.abs(s.pos - s.truth)));
  assert.ok(worst < d.beatMs / 2, `worst error ${worst.toFixed(1)} ms of a ${d.beatMs.toFixed(0)} ms beat`);
});

// At +8 % the deck moves through the track 8 % faster than the wall clock;
// extrapolating at 1× lost that much between packets.
test('the position runs at the deck\'s pitch between packets', () => {
  const d = deck({ bpm: 120 });
  play(d, { seconds: 4, pitch: 8 });
  const before = d.pos();
  d.advance(150);                          // no packet in this window
  const moved = d.pos() - before;
  assert.ok(Math.abs(moved - 150 * 1.08) < 1, `moved ${moved.toFixed(1)} ms in 150 ms at +8 %`);
});

test('a jump to another part of the track is followed at once', () => {
  const d = deck({ bpm: 120 });
  play(d, { seconds: 4 });
  d.status({ beat: 200 });                 // hot cue far ahead
  const expected = 199 * d.beatMs;
  assert.ok(Math.abs(d.pos() - expected) < d.beatMs, `at ${d.pos().toFixed(0)}, expected about ${expected.toFixed(0)}`);
});

test('pausing freezes the position and playing resumes from it', () => {
  const d = deck({ bpm: 120 });
  play(d, { seconds: 4 });
  const beat = Math.floor(d.pos() / d.beatMs) + 1;
  d.status({ beat, playState: PAUSED });
  const frozen = d.pos();
  d.advance(5000);
  assert.strictEqual(d.pos(), frozen, 'held while paused');
  d.status({ beat, playState: PLAYING });
  assert.ok(Math.abs(d.pos() - frozen) < 5, 'resumes where it stopped');
});

test('only the master\'s silence makes the position stale', () => {
  const d = deck({ bpm: 120 });
  play(d, { seconds: 2 });
  // Another deck keeps talking; the master has gone quiet.
  for (let i = 0; i < 40; i++) {
    d.advance(200);
    d.p._onStatus({ isMaster: false, deviceId: 2, trackId: 0 });
  }
  d.pos();
  assert.strictEqual(d.p.stale, true);
});

// ── In beats, for the pattern clock ───────────────────────────────────────────

test('the deck\'s beat reading follows its position through rekordbox\'s grid', () => {
  const d = deck({ bpm: 120 });
  assert.strictEqual(d.p.getBeatReading(), null, 'nothing loaded, nothing to lock to');
  play(d, { seconds: 4, pitch: 5 });
  const counted = d.p.getBeatReading();
  assert.ok(counted, 'without a grid it counts at the track tempo');
  assert.ok(Math.abs(counted.beatPos - d.pos() / 500) < 1e-6);
  assert.ok(Math.abs(counted.bpm - 126) < 1e-6, 'and reports the pitched tempo the room hears');

  // rekordbox's grid, first beat 300 ms in, so the beats are not where the
  // track tempo alone would put them.
  d.p._beatGrid = Array.from({ length: 64 }, (_, i) => ({ offset: 300 + i * 500, count: (i % 4) + 1, bpm: 120 }));
  const locked = d.p.getBeatReading();
  assert.ok(Math.abs(locked.beatPos - (d.pos() - 300) / 500) < 1e-6, 'through the grid');
});

test('a paused or silent deck has no beat reading', () => {
  const d = deck({ bpm: 120 });
  play(d, { seconds: 2 });
  assert.ok(d.p.getBeatReading());
  d.status({ beat: 5, playState: PAUSED });
  assert.strictEqual(d.p.getBeatReading(), null, 'paused');
  d.status({ beat: 5 });
  assert.ok(d.p.getBeatReading(), 'playing again');
  d.advance(6000);                          // the master stops reporting
  assert.strictEqual(d.p.getBeatReading(), null, 'stale');
});
