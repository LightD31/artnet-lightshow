'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const AnalyzerWorker = require('../../src/analyzer-worker');

const FAKE = path.join(__dirname, '..', 'helpers', 'fake-analyzer.js');
const worker = (mode, opts) => {
  process.env.FAKE_MODE = mode;
  return new AnalyzerWorker(process.execPath, FAKE, opts);
};

test('analyses are dispatched and resolved', async () => {
  const w = worker('ok');
  try {
    assert.deepStrictEqual(await w.analyze('/tmp/a.wav', null), { bpm: 128, source: '/tmp/a.wav' });
  } finally { w.shutdown(); }
});

test('high priority jumps the queue ahead of normal work', () => {
  const w = worker('ok');
  try {
    // Inspect ordering without dispatching: submit against a not-yet-spawned
    // worker and read the queue the scheduler built.
    const q = [];
    const stub = (id, priority, tag) => ({ id, priority, tag, resolve() {}, reject() {} });
    w._insertByPriority(stub(1, 'normal', 'n1'));
    w._insertByPriority(stub(2, 'normal', 'n2'));
    w._insertByPriority(stub(3, 'high', 'h1'));
    for (const e of w._queue) q.push(e.tag);
    assert.deepStrictEqual(q, ['h1', 'n1', 'n2'], 'high first, normals keep FIFO order');

    w.promote('n2');
    assert.deepStrictEqual(w._queue.map((e) => e.tag), ['h1', 'n2', 'n1'], 'promoted behind existing highs');

    w._insertByPriority(stub(4, 'current', 'c1'));
    assert.deepStrictEqual(w._queue.map((e) => e.tag), ['c1', 'h1', 'n2', 'n1'], 'the playing song leads');

    // An interrupted job goes back at the head of its own band, not the tail:
    // it has already done work that its peers have not.
    w._insertByPriority(stub(5, 'normal', 'n0'), { front: true });
    // n2 was promoted to high above, so n0 leads the normals.
    assert.deepStrictEqual(w._queue.map((e) => e.tag), ['c1', 'h1', 'n2', 'n0', 'n1']);
  } finally { w.shutdown(); }
});

// Priority ordering alone still left the playing song behind a prefetch that
// had started moments earlier — a minute of darkness with the show queued up
// behind work nobody was waiting for.
test('the playing song interrupts a prefetch that is already running', async () => {
  const w = worker('hangslow', { timeoutMs: 5000 });
  const slow = w.analyze('/tmp/slow.wav', null, { priority: 'normal', tag: 'slow' });
  slow.catch(() => { /* settled by the shutdown below */ });
  assert.strictEqual(w._pending.tag, 'slow', 'prefetch is in flight');

  const now = await w.analyze('/tmp/now.wav', null, { priority: 'current', tag: 'now' });
  assert.deepStrictEqual(now, { bpm: 128, source: '/tmp/now.wav' }, 'served without waiting');
  assert.strictEqual(w._pending.tag, 'slow', 'the interrupted prefetch resumes after it');

  w.shutdown();
  await assert.rejects(slow, /shutting down|worker/);
});

// Only one song plays at a time, so an analysis still running when the track
// changes is for a track the room has left behind. Finishing it would hand the
// previous song's timeline to the show that just started.
test('a newer playing song supersedes the analysis it replaced', async () => {
  const w = worker('hangslow', { timeoutMs: 5000 });
  try {
    const first = w.analyze('/tmp/slow.wav', null, { priority: 'current', tag: 'a' });
    const second = w.analyze('/tmp/now.wav', null, { priority: 'current', tag: 'b' });
    await assert.rejects(first, (err) => err.superseded === true);
    assert.deepStrictEqual(await second, { bpm: 128, source: '/tmp/now.wav' });
    assert.strictEqual(w._queue.length, 0, 'the superseded job is not requeued');
  } finally { w.shutdown(); }
});

// The prefetch that was running turns out to be the song that just started:
// restarting it would throw away everything it has done.
test('a prefetch of the song that just started is left running', () => {
  const w = worker('hangslow', { timeoutMs: 5000 });
  const p = w.analyze('/tmp/slow.wav', null, { priority: 'normal', tag: 'k1' });
  p.catch(() => { /* settled by the shutdown below */ });
  try {
    const proc = w._proc;
    w.promote('k1', 'current');
    assert.strictEqual(w._proc, proc, 'same process, same analysis');
    assert.strictEqual(w._pending.tag, 'k1');
  } finally { w.shutdown(); }
});

// With no timeout a wedged worker left the request unsettled
// forever and every queued prefetch stalled behind it.
test('a hung worker times out instead of stalling the queue', async () => {
  const w = worker('hang', { timeoutMs: 400 });
  try {
    await assert.rejects(w.analyze('/tmp/a.wav', null), /timed out/);
    // The queue survives: a second request runs on a fresh process.
    await assert.rejects(w.analyze('/tmp/b.wav', null), /timed out/);
  } finally { w.shutdown(); }
});

// A mismatched id was logged and then delivered anyway, handing
// one track's analysis to a different track's caller.
test('a stale response is discarded, not delivered to the wrong caller', async () => {
  const w = worker('wrongid', { timeoutMs: 400 });
  try {
    // The reply carries the wrong id, so the caller must not receive it.
    await assert.rejects(w.analyze('/tmp/a.wav', null), /timed out/);
  } finally { w.shutdown(); }
});

test('shutdown rejects work rather than leaving it pending', async () => {
  const w = worker('hang');
  const p = w.analyze('/tmp/a.wav', null);
  w.shutdown();
  await assert.rejects(p, /shutting down|worker/);
});
