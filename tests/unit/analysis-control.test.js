// Analysis the operator can steer: call it off, have the show start once it
// is in (held on the server, so a tab switch or a closed page does not lose
// it), and hear why it failed.

import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import express from 'express';

import AnalyzerWorker from '../../src/analyzer-worker.ts';
import AutoShow from '../../src/auto-show.ts';
import { attachRoutes } from '../../src/server/routes.ts';
import { cancelledError, isCancelled } from '../../src/errors.ts';

const FAKE = path.join(import.meta.dirname, '..', 'helpers', 'fake-analyzer.js');

test('the analyser drops cancelled work, waiting or running, and carries on with the rest', async () => {
  process.env.FAKE_MODE = 'hangslow';
  const worker = new AnalyzerWorker(process.execPath, FAKE);
  try {
    const running = worker.analyze('slow-track.wav', null, { tag: 'a', priority: 'current' });
    const waiting = worker.analyze('next.wav', null, { tag: 'b' });
    const other = worker.analyze('other.wav', null, { tag: 'c' });
    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(worker.cancel('b'), true);
    await assert.rejects(waiting, (err) => isCancelled(err));
    assert.strictEqual(worker.cancel('a'), true, 'the running one: its process recycled');
    await assert.rejects(running, (err) => isCancelled(err));
    assert.strictEqual((await other).source, 'other.wav', 'the queue behind it is still served');
    assert.strictEqual(worker.cancel('nothing'), false);
    assert.strictEqual(worker.cancel(null), false);
  } finally {
    worker.shutdown();
    delete process.env.FAKE_MODE;
  }
});

function showWithWorker() {
  const show = new AutoShow(() => {}, [{ name: 'Blackout' }], []);
  show._worker.shutdown();
  const jobs = new Map();
  show._worker = {
    analyze(source, target, { tag }) {
      return new Promise((resolve, reject) => jobs.set(tag, { resolve, reject }));
    },
    cancel(tag) {
      const job = jobs.get(tag);
      if (!job) return false;
      job.reject(cancelledError());
      jobs.delete(tag);
      return true;
    },
    promote() {},
    shutdown() {},
  };
  return { show, jobs };
}

test('a cancelled analysis puts the show back as it was, and is not reported as a failure', async () => {
  const { show, jobs } = showWithWorker();
  const done = show.analyze('/music/a.wav', 'file:a');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(show.getClientState().status, 'analyzing');
  show.startPending = Symbol('start');
  assert.strictEqual(show.cancelAnalysis(), true);
  assert.strictEqual(show.getClientState().status, 'idle');
  assert.strictEqual(show.getClientState().startPending, false, 'a start waiting on it is called off too');
  await assert.rejects(done, (err) => isCancelled(err));
  assert.strictEqual(show.getClientState().error, null);
  assert.strictEqual(jobs.size, 0);
  assert.strictEqual(show.cancelAnalysis(), false, 'nothing left to cancel');
});

test('a failed analysis says why, until the next one starts', async () => {
  const { show, jobs } = showWithWorker();
  const done = show.analyze('/music/b.wav', 'file:b');
  await new Promise((r) => setImmediate(r));
  jobs.get('file:b').reject(new Error('no beats found'));
  await assert.rejects(done);
  const { status, error } = show.getClientState();
  assert.strictEqual(status, 'idle');
  assert.strictEqual(error.message, 'no beats found');
  assert.ok(error.at > 0);
  const again = show.analyze('/music/c.wav', 'file:c');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(show.getClientState().error, null);
  jobs.get('file:c').resolve({ bpm: 120, duration: 10, beats: [], segments: [] });
  await again;
});

// ── The routes ───────────────────────────────────────────────────────────────

async function withApp(fn) {
  const calls = { started: 0, gate: null };
  const autoShow = {
    track: null,
    startPending: null,
    analysis: null,
    downloadAndAnalyze() {
      return new Promise((resolve, reject) => { calls.gate = { resolve, reject }; });
    },
    cancelAnalysis() {
      calls.gate.reject(cancelledError());
      return true;
    },
    getClientState: () => ({ analysis: { bpm: 112 } }),
  };
  const integrations = {
    broadcast() {}, prefetchNextFromQueue() {},
    startAutoShow() { calls.started++; return 'spotify'; },
    stopAutoShow() {},
  };
  const spotify = { authenticated: true, getCurrentlyPlaying: async () => ({ trackId: 't', name: 'N', artist: 'A', album: '', durationMs: 180000 }) };
  const app = express();
  app.use(express.json());
  attachRoutes(app, { autoShow, integrations, spotify });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const post = (route, body) => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  const settle = async () => { for (let i = 0; i < 20 && !calls.gate; i++) await new Promise((r) => setTimeout(r, 5)); };
  try {
    await fn({ post, calls, autoShow, settle });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('asked to start, the server starts the show once the analysis is in', async () => {
  await withApp(async ({ post, calls, autoShow, settle }) => {
    const reply = post('/api/auto/analyze-spotify', { start: true });
    await settle();
    assert.ok(autoShow.startPending, 'held on the server while it analyses');
    calls.gate.resolve();
    const { status, body } = await reply;
    assert.strictEqual(status, 200);
    assert.strictEqual(body.started, true);
    assert.strictEqual(calls.started, 1);
    assert.strictEqual(autoShow.startPending, null);
  });
});

test('a stop while it analyses calls the start off; without start, nothing starts', async () => {
  await withApp(async ({ post, calls, settle }) => {
    const reply = post('/api/auto/analyze-spotify', { start: true });
    await settle();
    await post('/api/auto/stop');
    calls.gate.resolve();
    assert.strictEqual((await reply).body.started, false);
    calls.gate = null;
    const plain = post('/api/auto/analyze-spotify');
    await settle();
    calls.gate.resolve();
    assert.strictEqual((await plain).body.started, false);
    assert.strictEqual(calls.started, 0);
  });
});

test('a cancelled analysis answers as cancelled, not as an error', async () => {
  await withApp(async ({ post, calls, autoShow, settle }) => {
    const reply = post('/api/auto/analyze-spotify', { start: true });
    await settle();
    const cancelled = await post('/api/auto/cancel');
    assert.deepStrictEqual(cancelled.body, { ok: true, cancelled: true });
    const { status, body } = await reply;
    assert.strictEqual(status, 409);
    assert.strictEqual(body.cancelled, true);
    assert.strictEqual(calls.started, 0);
    assert.strictEqual(autoShow.startPending, null);
  });
});
