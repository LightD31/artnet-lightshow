// How the server is doing (src/server/health.ts, src/server/supervised.ts):
// what counts as wrong and how it is said, what the supervisor tells the
// server, the heartbeat, and the two routes.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { assess, health } from '../../src/server/health.ts';
import { supervision, startHeartbeat, EXIT_RESTART, EXIT_CONFIG } from '../../src/server/supervised.ts';
import { attachRoutes } from '../../src/server/routes.ts';

const fine = {
  engine: { running: true, fellBack: false, frames: 1000, lateFrames: 3 },
  eventLoop: { p50Ms: 10, p99Ms: 20, maxMs: 30 },
  rssMb: 300,
  errors: { count: 0, last: null },
  supervisor: { supervised: true, restarts: 0, lastExit: null, recovering: false },
  auto: { status: 'ready', error: null },
};

test('a server doing well is ok, with nothing to say', () => {
  assert.deepEqual(assess(fine), { status: 'ok', problems: [] });
});

for (const [name, patch, status, levels] of [
  ['late frames', { engine: { ...fine.engine, lateFrames: 120 } }, 'degraded', ['warn']],
  ['stalled event loop', { eventLoop: { p50Ms: 10, p99Ms: 250, maxMs: 900 } }, 'degraded', ['warn']],
  ['recent errors', { errors: { count: 2, last: { component: 'hue', msg: 'bridge gone\nstack…' } } }, 'degraded', ['warn']],
  ['successful restart', { supervisor: { ...fine.supervisor, restarts: 1, lastExit: { reason: 'stopped responding' } } }, 'ok', ['info']],
  ['stopped engine and high memory', { engine: { running: false }, rssMb: 2000 }, 'failing', ['error', 'warn']],
]) {
  test(`health classifies ${name}`, () => {
    const result = assess({ ...fine, ...patch });
    assert.equal(result.status, status);
    assert.deepEqual(result.problems.map((p) => p.level), levels);
    assert.ok(result.problems.every((p) => p.what.length > 0));
    assert.ok(result.problems.every((p) => !p.what.includes('\n')));
  });
}

test('what the supervisor tells the server, read from its environment', () => {
  assert.deepEqual(supervision({}), { supervised: false, restarts: 0, lastExit: null, recovering: false });
  const lastExit = { code: 1, signal: null, reason: 'crashed with exit code 1', at: '2026-09-25T00:00:00.000Z' };
  assert.deepEqual(supervision({
    LIGHTSHOW_SUPERVISED: '1', LIGHTSHOW_RESTARTS: '2', LIGHTSHOW_LAST_EXIT: JSON.stringify(lastExit), LIGHTSHOW_RECOVER: '1',
  }), { supervised: true, restarts: 2, lastExit, recovering: true });
  assert.equal(supervision({ LIGHTSHOW_LAST_EXIT: '{not json' }).lastExit, null);
  assert.deepEqual([EXIT_RESTART, EXIT_CONFIG], [75, 78]);
});

test('the heartbeat stops sending after teardown', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const sent = [];
  const stop = startHeartbeat((m) => sent.push(m.type), 1000);
  t.mock.timers.tick(3000);
  stop();
  t.mock.timers.tick(3000);
  assert.deepEqual(sent, ['ready', 'heartbeat', 'heartbeat', 'heartbeat']);
});

test('heartbeat teardown works without a supervisor', () => {
  assert.doesNotThrow(() => startHeartbeat(undefined)());
});

test('health routes expose liveness and detailed status', async (t) => {
  const app = express();
  attachRoutes(app, { integrations: { broadcast() {} }, autoShow: { status: 'idle', running: false, error: null } });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const get = (p) => fetch(`http://127.0.0.1:${server.address().port}${p}`).then((res) => res.json());

  assert.deepEqual(await get('/healthz'), { ok: true });
  const h = await get('/api/health');
  // No engine is running in this test, which is what failing means.
  assert.equal(h.status, 'failing');
  assert.equal(h.ok, false);
  assert.equal(h.problems[0].level, 'error');
  for (const key of ['version', 'node', 'pid', 'uptimeS', 'engine', 'memory', 'outputs', 'supervisor', 'log']) assert.ok(key in h, key);
  assert.deepEqual(h.auto, { status: 'idle', running: false, error: null });
  assert.equal(typeof health().uptimeS, 'number');
  assert.equal(typeof h.counts.effects, 'number');
  assert.ok(h.counts.effects > 0);
  assert.equal(h.counts.voices, 0);
  assert.deepEqual(h.counts.sequence, { loaded: 0, playing: 0 });
});
