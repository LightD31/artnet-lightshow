// Auto-sync (src/auto-sync.ts): the live input hears the song, the analysis
// knows its onsets, and sliding one against the other says how far the
// playback source's position is off. These tests build both from one made-up
// song and move the source.

import test from 'node:test';
import assert from 'node:assert';

import { AutoSync, estimateOffset, onsetTrain } from '../../src/auto-sync.ts';
import AutoShow from '../../src/auto-show.ts';

const HOP_SEC = 256 / 22050;

/** A seeded random, so every run hears the same song. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/**
 * A song's onsets: a kick every beat at 126 BPM, and — as real music has —
 * snares, hats and a melody that do not repeat every beat.
 */
function song({ seconds = 60, bpm = 126, extras = true, seed = 7 } = {}) {
  const rand = rng(seed);
  const beat = 60 / bpm;
  const onsets = [];
  for (let t = 0.2; t < seconds; t += beat) {
    onsets.push(t);
    if (!extras) continue;
    if (rand() < 0.45) onsets.push(t + beat / 2);
    if (rand() < 0.25) onsets.push(t + beat * (0.25 + 0.5 * Math.floor(rand() * 2)));
    if (rand() < 0.15) onsets.push(t + beat * rand());
  }
  return onsets.sort((a, b) => a - b);
}

/**
 * What the live input would have kept: a flux value every hop, a spike at
 * each onset and noise between. Stream time runs with the track: stream 0 is
 * track `startSec`.
 */
function heard(onsets, { startSec, seconds, seed = 3, noise = 0.15 }) {
  const rand = rng(seed);
  const out = [];
  let k = 0;
  for (let t = 0; t < seconds; t += HOP_SEC) {
    const trackT = startSec + t;
    while (k < onsets.length && onsets[k] < trackT - HOP_SEC) k++;
    let flux = noise * rand();
    for (let j = k; j < onsets.length && onsets[j] <= trackT + HOP_SEC; j++) {
      const d = Math.abs(onsets[j] - trackT) / HOP_SEC;
      if (d < 1) flux += (1 - d) * (0.6 + 0.4 * rand());
    }
    out.push({ t, flux, rms: 0.1 });
  }
  return out;
}

test('the source\'s error is measured from the song itself', () => {
  const onsets = song();
  const envelope = heard(onsets, { startSec: 20, seconds: 16 });
  const streamEnd = envelope[envelope.length - 1].t;
  for (const errorMs of [-1200, -640, -180, 0, 95, 333, 900]) {
    // The source says the track is `errorMs` behind where it really is.
    const trackMsAt = (s) => (20 + s) * 1000 - errorMs;
    const est = estimateOffset({ envelope, onsets, trackMsAt });
    assert.ok(Math.abs(est.offsetMs - errorMs) <= 10, `${errorMs} ms off, measured ${est.offsetMs}`);
    assert.ok(est.peak > 0.5 && est.margin > 0.1, `clear at ${errorMs}: peak ${est.peak.toFixed(2)}, margin ${est.margin.toFixed(2)}`);
  }
  assert.ok(streamEnd > 15.9);
});

test('a beat that only repeats itself cannot say which beat it is', () => {
  const onsets = song({ extras: false });
  const envelope = heard(onsets, { startSec: 20, seconds: 16 });
  const est = estimateOffset({ envelope, onsets, trackMsAt: (s) => (20 + s) * 1000 - 180 });
  assert.ok(est.margin < 0.06, `margin ${est.margin.toFixed(3)}: one beat along matches as well`);
});

test('too little heard, or too few onsets, is no measurement', () => {
  const onsets = song();
  assert.strictEqual(estimateOffset({ envelope: heard(onsets, { startSec: 20, seconds: 5 }), onsets, trackMsAt: (s) => (20 + s) * 1000 }), null);
  assert.strictEqual(estimateOffset({ envelope: heard(onsets, { startSec: 20, seconds: 16 }), onsets: [1, 2, 3], trackMsAt: (s) => (20 + s) * 1000 }), null);
  const train = onsetTrain([0.1], 0, 30);
  assert.ok(Math.abs(train[10] - 1) < 1e-9 && train[8] > 0.3 && train[8] < 0.5 && train[0] < 1e-4, 'an onset is a narrow bump');
});

// ── The loop ──────────────────────────────────────────────────────────────────

function loop({ errorMs = 250, running = true, enabled = true } = {}) {
  const onsets = song();
  let streamNow = 16000;
  // The source is `errorMs` late; the show adds whatever auto-sync has found.
  const show = {
    running, autoSyncMs: 0, analysis: { onsets },
    getPositionMs() { return 20000 + streamNow - errorMs + this.autoSyncMs; },
    adjustAutoSync(d) { this.autoSyncMs += d; },
  };
  const live = {
    streamNowMs: () => streamNow,
    recentEnvelope: () => heard(onsets, { startSec: 20 + (streamNow - 16000) / 1000, seconds: 16 })
      .map((e) => ({ ...e, t: e.t + (streamNow - 16000) / 1000 })),
  };
  const sync = new AutoSync({ show, live, enabled: () => enabled });
  return { sync, show, advance: (ms) => { streamNow += ms; } };
}

test('two measurements that agree move the show, and then it holds', () => {
  const l = loop({ errorMs: 250 });
  l.sync.tick();
  assert.strictEqual(l.show.autoSyncMs, 0, 'one measurement is not enough');
  l.advance(1000);
  l.sync.tick();
  assert.ok(Math.abs(l.show.autoSyncMs - 250) <= 10, `corrected by ${l.show.autoSyncMs}`);
  for (let i = 0; i < 5; i++) { l.advance(1000); l.sync.tick(); }
  assert.ok(Math.abs(l.show.autoSyncMs - 250) <= 10, 'and stays: what is left is inside the dead band');
  assert.deepStrictEqual(Object.keys(l.sync.status()), ['correctionMs', 'peak', 'corrections']);
  assert.strictEqual(l.sync.status().corrections, 1);
});

test('nothing moves while the show is stopped, auto-sync is off, or nothing is heard', () => {
  for (const opts of [{ running: false }, { enabled: false }]) {
    const l = loop(opts);
    l.sync.tick(); l.advance(1000); l.sync.tick();
    assert.strictEqual(l.show.autoSyncMs, 0);
  }
  const l = loop();
  l.sync._live.streamNowMs = () => null;
  l.sync.tick(); l.sync.tick();
  assert.strictEqual(l.show.autoSyncMs, 0);
});

test('the show carries the correction in its position, and a new show starts without one', () => {
  const show = new AutoShow(() => {}, [{ name: 'Blackout' }], []);
  try {
    show.timeline = [{ timeMs: 0, action: 'patch', data: { pattern: 'chase' } }];
    show.useFrameClock();
    show.start(() => 10000);
    show.adjustAutoSync(250);
    assert.strictEqual(show.getPositionMs(), 10250 + show.syncOffsetMs);
    show.adjustAutoSync(5000);
    assert.strictEqual(show.autoSyncMs, 2000, 'no further than the manual offset may go');
    assert.strictEqual(show.getClientState().autoSyncMs, 2000);
    show.stop();
    show.start(() => 10000);
    assert.strictEqual(show.autoSyncMs, 0);
    show.stop();
  } finally { show._worker.shutdown(); }
});
