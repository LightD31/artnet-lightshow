import test from 'node:test';
import assert from 'node:assert';

import { FRAME_MS, FRAME_RATE, MAX_BEHIND_FRAMES, nextIndex, FrameStats, createTicker } from '../../src/server/frame-clock.ts';

test('the frame grid runs at forty-four frames a second', () => {
  assert.strictEqual(FRAME_RATE, 44);
  assert.ok(Math.abs(FRAME_MS - 1000 / 44) < 1e-9);
});

test('nextIndex finds the first deadline at or after a time', () => {
  assert.strictEqual(nextIndex(0, 0, 0, 10), 0);
  assert.strictEqual(nextIndex(10, 0, 0, 10), 1);
  assert.strictEqual(nextIndex(10.5, 0, 0, 10), 2);
  assert.strictEqual(nextIndex(15, 0, 6, 10), 1, 'phase shifts the grid');
  assert.strictEqual(nextIndex(-50, 0, 0, 10), 0, 'never before the epoch');
});

/**
 * A ticker on a fake clock and fake timers, so each firing can land exactly
 * where the test says: `lateBy(k)` is how late firing k is.
 */
function drive({ firings, lateBy = () => 0, phaseMs = 0, periodMs = 10 }) {
  let t = 1000;
  const pending = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, delay) => { const h = { fn, at: t + delay }; pending.push(h); return h; };
  globalThis.clearTimeout = (h) => { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); };
  const ticks = [];
  let ticker;
  try {
    ticker = createTicker({ periodMs, phaseMs, epochMs: 1000, now: () => t, onTick: (due, now) => ticks.push({ due, now }) });
    ticker.start();
    for (let k = 0; k < firings && pending.length; k++) {
      const h = pending.shift();
      t = Math.max(t, h.at) + lateBy(k);
      h.fn();
    }
    ticker.stop();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
  return { ticks, stats: ticker.stats };
}

test('deadlines stay on the grid however late each frame fires', () => {
  const { ticks } = drive({ firings: 6, lateBy: (k) => [3, 0, 7, 1, 0, 4][k] });
  assert.deepStrictEqual(ticks.map((x) => x.due), [1000, 1010, 1020, 1030, 1040, 1050]);
});

test('a late frame does not push the next one later', () => {
  const { ticks } = drive({ firings: 3, lateBy: (k) => (k === 0 ? 8 : 0) });
  // Frame 1 was due at 1010 and armed from 1008: it fires on time.
  assert.strictEqual(ticks[1].now, 1010);
});

test('a stall longer than a couple of frames skips ahead instead of bursting', () => {
  const { ticks, stats } = drive({ firings: 3, lateBy: (k) => (k === 0 ? 55 : 0) });
  // Due at 1000, fired at 1055: frames 0–4 are gone, frame 5 (1050) is served.
  assert.ok(55 > MAX_BEHIND_FRAMES * 10);
  assert.strictEqual(ticks[0].due, 1050);
  assert.strictEqual(ticks[1].due, 1060);
  assert.strictEqual(stats.skipped, 5);
});

test('a phase moves every deadline by the same amount', () => {
  const { ticks } = drive({ firings: 3, phaseMs: 4 });
  assert.deepStrictEqual(ticks.map((x) => x.due), [1004, 1014, 1024]);
});

test('stats report lateness, render time and the frames that went out late', () => {
  const stats = new FrameStats(10, 1);
  for (let i = 0; i < 90; i++) stats.record(1, 2);
  for (let i = 0; i < 10; i++) stats.record(8, 3);
  const s = stats.summary();
  assert.strictEqual(s.frames, 100);
  assert.strictEqual(s.lateMs.p50, 1);
  assert.strictEqual(s.lateMs.max, 8);
  assert.strictEqual(s.lateFrames, 10, 'more than half a period late');
  assert.strictEqual(s.renderMs.p95, 3);
});

test('stats keep a fixed window', () => {
  const stats = new FrameStats(10, 0.1);   // ten frames
  for (let i = 0; i < 25; i++) stats.record(i, 0);
  const s = stats.summary();
  assert.strictEqual(s.frames, 10);
  assert.strictEqual(s.lateMs.max, 24);
  assert.strictEqual(s.lateMs.p50, 20, 'only the last ten remain');
});

test('a real ticker keeps time against the wall', async () => {
  const ticks = [];
  const ticker = createTicker({ onTick: (due, now) => ticks.push(now - due) });
  ticker.start();
  await new Promise((r) => setTimeout(r, 300));
  ticker.stop();
  // 300 ms at 44 Hz is about thirteen frames; a slow runner may lose one or two.
  assert.ok(ticks.length >= 10 && ticks.length <= 15, `${ticks.length} frames in 300 ms`);
  const count = ticks.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(ticks.length, count, 'stop means stop');
});
