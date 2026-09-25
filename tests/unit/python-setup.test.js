// Setting the analysis environment up from the app (src/server/python-setup.ts):
// finding uv, suggesting a torch build, and running `uv sync` — here a
// stand-in (tests/helpers/fake-uv.mjs) — with its progress, into the
// environment the server then uses.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyLine, buildsFor, createPythonSetup, detectBuild, findUv, readMarker, PYTHON_VERSION,
} from '../../src/server/python-setup.ts';

const FAKE_UV = path.join(import.meta.dirname, '..', 'helpers', 'fake-uv.mjs');

function blankJob() {
  return {
    build: 'cpu', startedAt: 0, finishedAt: null, ok: null, error: null, phase: 'Starting', python: null, packages: null,
    downloads: { total: 0, done: 0, count: 0, finished: 0, current: null }, lines: [],
  };
}

test('uv\'s own words become the progress on the page', () => {
  const job = blankJob();
  for (const line of [
    'Downloading cpython-3.12.11-linux-x86_64-gnu (download) (29.9MiB)',
    ' Downloading cpython-3.12.11-linux-x86_64-gnu (download)',
    'Using CPython 3.12.11',
    'Creating virtual environment at: /data/.venv',
    'Resolved 183 packages in 3ms',
    'Downloading torch (241.3MiB)',
  ]) applyLine(job, line);
  assert.equal(job.python, '3.12.11');
  assert.equal(job.packages, 183);
  assert.equal(job.phase, 'Downloading torch');
  assert.deepEqual(job.downloads, {
    total: Math.round(29.9 * 1024 ** 2) + Math.round(241.3 * 1024 ** 2),
    done: Math.round(29.9 * 1024 ** 2),
    count: 2,
    finished: 1,
    current: 'torch',
  });
  applyLine(job, ' Downloaded torch');
  assert.equal(job.downloads.finished, 2);
  assert.equal(job.downloads.done, job.downloads.total, 'the older word for done, too');
  applyLine(job, 'Prepared 120 packages in 1m');
  assert.equal(job.phase, 'Installing');
  applyLine(job, 'Installed 120 packages in 2s');
  assert.equal(job.phase, 'Finishing');
  applyLine(job, 'error: no space left on device');
  assert.equal(job.error, 'no space left on device');
  applyLine(job, '   ');
  assert.equal(job.lines.length, 10, 'blank lines are not kept');
});

test('the log keeps the last two hundred lines', () => {
  const job = blankJob();
  for (let i = 0; i < 250; i++) applyLine(job, ` + package-${i}==1.0`);
  assert.equal(job.lines.length, 200);
  assert.equal(job.lines[0], ' + package-50==1.0');
});

test('uv: the packaged build\'s own, then PATH, then where its installer puts it', () => {
  const app = '/opt/lightshow/app';
  const has = (...files) => (f) => files.includes(f);
  assert.deepEqual(findUv({ platform: 'linux', app, env: { PATH: '/usr/bin' }, home: '/home/op', exists: has('/opt/lightshow/tools/uv', '/usr/bin/uv') }),
    { command: '/opt/lightshow/tools/uv', from: 'bundled' });
  assert.deepEqual(findUv({ platform: 'linux', app, env: { PATH: '/usr/bin' }, home: '/home/op', exists: has('/usr/bin/uv', '/home/op/.local/bin/uv') }),
    { command: '/usr/bin/uv', from: 'path' });
  assert.deepEqual(findUv({ platform: 'linux', app, env: { PATH: '/usr/bin' }, home: '/home/op', exists: has('/home/op/.local/bin/uv') }),
    { command: '/home/op/.local/bin/uv', from: 'home' });
  assert.deepEqual(findUv({ platform: 'win32', app: 'C:\\LS\\app', env: { Path: 'C:\\Windows' }, home: 'C:\\Users\\op', exists: has('C:\\LS\\tools\\uv.exe') }),
    { command: 'C:\\LS\\tools\\uv.exe', from: 'bundled' });
  assert.deepEqual(findUv({ platform: 'win32', app: 'C:\\LS\\app', env: { Path: 'C:\\Windows' }, home: 'C:\\Users\\op', exists: has('C:\\Users\\op\\.local\\bin\\uv.exe') }),
    { command: 'C:\\Users\\op\\.local\\bin\\uv.exe', from: 'home' });
  assert.equal(findUv({ platform: 'linux', app, env: { PATH: '/usr/bin' }, home: '/home/op', exists: () => false }), null);
});

test('the torch build suggested: CUDA for an NVIDIA card, ROCm where it is installed, else the CPU', async () => {
  const run = async (command) => (command.includes('nvidia-smi') ? 'NVIDIA GeForce RTX 4070\n' : null);
  const has = (...files) => (f) => files.includes(f);
  assert.deepEqual(await detectBuild({ platform: 'linux', env: { PATH: '/usr/bin' }, exists: has('/usr/bin/nvidia-smi'), run }),
    { build: 'cu128', why: 'found NVIDIA GeForce RTX 4070' });
  assert.deepEqual(await detectBuild({ platform: 'win32', env: { Path: 'C:\\Tools' }, exists: has('C:\\Windows\\System32\\nvidia-smi.exe'), run }),
    { build: 'cu128', why: 'found NVIDIA GeForce RTX 4070' }, 'where the driver puts it, though not on PATH');
  assert.equal((await detectBuild({ platform: 'linux', env: { PATH: '/usr/bin' }, exists: has('/usr/bin/nvidia-smi'), run: async () => null })).build,
    'cpu', 'an nvidia-smi that finds no card is no card');
  assert.deepEqual(await detectBuild({ platform: 'linux', env: { PATH: '/usr/bin' }, exists: has('/dev/kfd'), run }),
    { build: 'rocm', why: 'ROCm is installed' });
  assert.equal((await detectBuild({ platform: 'darwin', env: { PATH: '/usr/bin' }, exists: () => false, run })).build, 'cpu');
  const windows = await detectBuild({ platform: 'win32', env: { Path: 'C:\\Tools' }, exists: () => false, run });
  assert.equal(windows.build, 'cpu');
  assert.match(windows.why, /AMD card on Windows/);
  assert.deepEqual(buildsFor('win32'), ['cpu', 'cu128']);
  assert.deepEqual(buildsFor('linux'), ['cpu', 'cu128', 'rocm']);
  assert.deepEqual(buildsFor('darwin'), ['cpu']);
});

function setup(t, { plan = 'ok', uv = true, platform = process.platform } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'python-setup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const record = path.join(dir, 'uv.json');
  const venv = path.join(dir, 'data', '.venv');
  const app = path.join(dir, 'app');
  fs.mkdirSync(app);
  const events = [];
  const s = createPythonSetup({
    uv: () => (uv ? { command: 'uv', from: 'path' } : null),
    // The stand-in, run by this Node wherever `uv` would have been.
    spawner: (command, args, options) => {
      events.push(`spawn ${command}`);
      return spawn(process.execPath, [FAKE_UV, ...args], {
        ...options, env: { ...options.env, FAKE_UV_PLAN: plan, FAKE_UV_RECORD: record },
      });
    },
    app,
    venv: () => venv,
    platform,
  });
  s.onHooks({ before: (reason) => events.push(`before: ${reason}`), after: (job) => events.push(`after: ${job.ok}`) });
  const finished = (job) => new Promise((resolve) => {
    const wait = () => (job.ok === null ? setTimeout(wait, 20) : resolve(job));
    wait();
  });
  return { s, record, venv, app, events, finished };
}

test('a setup runs uv sync from the lockfile, into the environment, with uv\'s own Python', async (t) => {
  const { s, record, venv, app, events, finished } = setup(t);
  const job = await finished(s.start('cpu'));
  assert.equal(job.ok, true, job.error);
  assert.equal(job.phase, 'Done');
  assert.equal(job.python, '3.12.11');
  assert.equal(job.packages, 183);
  assert.equal(job.downloads.finished, 3);
  const ran = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.deepEqual(ran.args, ['sync', '--locked', '--extra', 'cpu', '--python', PYTHON_VERSION, '--project', app]);
  assert.equal(ran.cwd, app);
  assert.equal(ran.venv, venv);
  assert.equal(ran.preference, 'only-managed', 'not whatever Python the machine has');
  assert.equal(ran.noColor, '1');
  assert.deepEqual(events, ['before: the analysis environment is being set up', 'spawn uv', 'after: true'],
    'what runs from the environment stands aside first, and comes back after');
  assert.deepEqual({ ...readMarker(venv), at: 'x' }, { build: 'cpu', python: '3.12.11', at: 'x' });
});

test('a setup that fails says why, in uv\'s words, and lets the analysis go on', async (t) => {
  const { s, venv, events, finished } = setup(t, { plan: 'fail' });
  const job = await finished(s.start('cu128'));
  assert.equal(job.ok, false);
  assert.equal(job.phase, 'Failed');
  assert.match(job.error, /doesn't have a wheel for the current platform/);
  assert.equal(readMarker(venv), null);
  assert.equal(events.at(-1), 'after: false');
});

test('one setup at a time, and one can be cancelled', async (t) => {
  const { s, events, finished } = setup(t, { plan: 'slow' });
  const job = s.start('cpu');
  assert.equal(s.start('cu128'), job, 'a second press is the same setup');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(job.phase, 'Downloading torch');
  assert.equal(s.cancel(), true);
  await finished(job);
  assert.deepEqual([job.ok, job.phase, job.error], [false, 'Cancelled', 'cancelled']);
  assert.equal(events.at(-1), 'after: false');
  assert.equal(s.cancel(), false, 'nothing left to cancel');
});

test('without uv, or with a build this machine cannot run, nothing starts', async (t) => {
  const none = setup(t, { uv: false });
  const job = none.s.start('cpu');
  assert.equal(job.ok, false);
  assert.match(job.error, /uv is not installed/);
  assert.deepEqual(none.events, ['after: false'], 'nothing was stopped, so nothing to hold');

  const windows = setup(t, { platform: 'win32' });
  const rocm = windows.s.start('rocm');
  assert.equal(rocm.ok, false);
  assert.match(rocm.error, /not available on this system/);
});

test('the status says what is there and what would be set up', async (t) => {
  const { s, venv } = setup(t, { uv: false });
  const status = await s.status();
  assert.equal(status.uv, null);
  assert.deepEqual(status.environment, { dir: venv, exists: false, marker: null });
  assert.equal(status.pythonVersion, PYTHON_VERSION);
  assert.ok(status.builds.some((b) => b.id === 'cpu'));
  assert.ok(['cpu', 'cu128', 'rocm'].includes(status.detected.build));
  assert.equal(typeof status.python.ready, 'boolean');
});
