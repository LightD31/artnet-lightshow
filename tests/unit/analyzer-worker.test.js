'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const AnalyzerWorker = require('../../src/analyzer-worker');

const FAKE = path.join(__dirname, '..', 'helpers', 'fake-analyzer.js');
const worker = (mode) => {
  process.env.FAKE_MODE = mode;
  return new AnalyzerWorker(process.execPath, FAKE);
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

    w.bumpToHigh('n2');
    assert.deepStrictEqual(w._queue.map((e) => e.tag), ['h1', 'n2', 'n1'], 'promoted behind existing highs');
  } finally { w.shutdown(); }
});

// AUDIT.md M4: with no timeout a wedged worker left the request unsettled
// forever and every queued prefetch stalled behind it.
test('a hung worker times out instead of stalling the queue', async () => {
  process.env.ANALYZER_TIMEOUT_MS = '400';
  delete require.cache[require.resolve('../../src/analyzer-worker')];
  const Fresh = require('../../src/analyzer-worker');
  process.env.FAKE_MODE = 'hang';
  const w = new Fresh(process.execPath, FAKE);
  try {
    await assert.rejects(w.analyze('/tmp/a.wav', null), /timed out/);
    // The queue survives: a second request runs on a fresh process.
    await assert.rejects(w.analyze('/tmp/b.wav', null), /timed out/);
  } finally {
    w.shutdown();
    delete process.env.ANALYZER_TIMEOUT_MS;
    delete require.cache[require.resolve('../../src/analyzer-worker')];
  }
});

// AUDIT.md M4: a mismatched id was logged and then delivered anyway, handing
// one track's analysis to a different track's caller.
test('a stale response is discarded, not delivered to the wrong caller', async () => {
  process.env.ANALYZER_TIMEOUT_MS = '400';
  delete require.cache[require.resolve('../../src/analyzer-worker')];
  const Fresh = require('../../src/analyzer-worker');
  process.env.FAKE_MODE = 'wrongid';
  const w = new Fresh(process.execPath, FAKE);
  try {
    // The reply carries the wrong id, so the caller must not receive it.
    await assert.rejects(w.analyze('/tmp/a.wav', null), /timed out/);
  } finally {
    w.shutdown();
    delete process.env.ANALYZER_TIMEOUT_MS;
    delete require.cache[require.resolve('../../src/analyzer-worker')];
  }
});

test('shutdown rejects work rather than leaving it pending', async () => {
  const w = worker('hang');
  const p = w.analyze('/tmp/a.wav', null);
  w.shutdown();
  await assert.rejects(p, /shutting down|worker/);
});
