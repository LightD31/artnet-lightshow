// The supervisor, for real: `node server.js` as `npm start` runs it, on a
// port and a config directory of its own. The server is killed mid-look and
// must come back with the look; a restart asked for from the app must too;
// and stopping the supervisor stops everything, cleanly.

import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3997;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(import.meta.dirname, '..', '..');

test.describe.configure({ mode: 'serial' });
test.setTimeout(90_000);

let dir;
let supervisor;
let exited;

const get = (p) => fetch(BASE + p).then((res) => res.json());
const post = (p, data = {}) => fetch(BASE + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
}).then(async (res) => ({ status: res.status, body: await res.json() }));

/** The server's health once it answers, from a process other than `notPid`. */
async function serverUp(notPid = null) {
  let last = null;
  await expect.poll(async () => {
    try {
      last = await get('/api/health');
      return last.pid !== notPid;
    } catch (_) {
      return false;
    }
  }, { timeout: 30_000, intervals: [250] }).toBe(true);
  return last;
}

test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightshow-supervised-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    server: { host: '127.0.0.1', port: PORT, token: '' },
    artnet: { enabled: false },
    sacn: { enabled: false },
    sources: { prolink: false, smtc: false },
  }));
  const env = {
    ...process.env,
    LIGHTSHOW_CONFIG_DIR: dir,
    LIGHTSHOW_CACHE_DIR: path.join(dir, 'cache'),
    LIGHTSHOW_LOG_DIR: path.join(dir, 'logs'),
  };
  delete env.LIGHTSHOW_SUPERVISOR;
  delete env.LIGHTSHOW_SUPERVISED;
  supervisor = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  exited = new Promise((resolve) => supervisor.on('exit', (code, signal) => resolve({ code, signal })));
});

test.afterAll(async () => {
  if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('killed mid-look, the server is started again with the look it had', async () => {
  const first = await serverUp();
  expect(first.supervisor).toMatchObject({ supervised: true, restarts: 0 });

  await post('/api/set', { pattern: 'solid', colorA: 4, masterDimmer: 180, energyOverride: 'blinder' });
  // Kept every two seconds.
  await expect.poll(() => fs.existsSync(path.join(dir, 'look.json')), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(dir, 'look.json'), 'utf8')).look.colorA, { timeout: 10_000 }).toBe(4);

  process.kill(first.pid, 'SIGKILL');
  const second = await serverUp(first.pid);
  expect(second.supervisor).toMatchObject({ supervised: true, restarts: 1, recovering: true });
  expect(second.supervisor.lastExit.reason).toBe('killed by SIGKILL');
  expect(second.problems.map((p) => p.what).join(' ')).toContain('Restarted 1 time by the supervisor');

  const state = await get('/api/state');
  expect([state.pattern, state.colorA, state.masterDimmer]).toEqual(['solid', 4, 180]);
  expect(state.energyOverride, 'a held blinder does not come back stuck on').toBeNull();

  const logs = await get('/api/logs?level=info');
  const said = logs.entries.map((e) => `${e.component}: ${e.msg}`).join('\n');
  expect(said).toContain('supervisor: restart 1: the last run killed by SIGKILL');
  expect(said).toContain('look: put back the look');
  expect(logs.entries.some((e) => e.previous), 'the run before, read back from the file').toBe(true);
});

test('a restart asked for from the app comes back the same way', async () => {
  const before = await serverUp();
  const asked = await post('/api/server/restart');
  expect(asked).toEqual({ status: 200, body: { ok: true, restarting: true } });
  const after = await serverUp(before.pid);
  expect(after.supervisor.restarts).toBe(2);
  expect(after.supervisor.lastExit.reason).toBe('restarted on request (from the app)');
  expect((await get('/api/state')).colorA).toBe(4);
});

test('stopping the supervisor stops the server with it, cleanly', async () => {
  const { pid } = await serverUp();
  supervisor.kill('SIGTERM');
  expect(await exited).toEqual({ code: 0, signal: null });
  expect(() => process.kill(pid, 0), 'the server is gone too').toThrow();
});
