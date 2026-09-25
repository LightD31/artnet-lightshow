#!/usr/bin/env node
/**
 * Check a packaged build (scripts/package.js) starts and stops as it should,
 * on the machine it was built for — CI runs this on each package it makes.
 *
 *   node scripts/smoke-package.js [<the package folder>]
 *
 * Without one, the folder `npm run package` made for this machine; an
 * installed copy works too.
 *
 * The executable is started with a data folder of its own, on a port of its
 * own, with no DMX going out: it must say its version, come up supervised,
 * serve the page from its own files, render on the engine's thread, find the
 * uv it carries, and write where it was told to. Its supervisor is then killed
 * outright, and the server must go with it — the orphan guard, which on
 * Windows is the only way a server learns its console was killed. Where
 * signals are signals, a second run is stopped the polite way, and must exit
 * cleanly.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const dir = path.resolve(process.argv[2] || path.join(ROOT, 'dist', `ArtNet-Lightshow-${version}-${process.platform}-${process.arch}`));
const windows = process.platform === 'win32';
const EXE = path.join(dir, windows ? 'ArtNet Lightshow.exe' : 'artnet-lightshow');
const PORT = 3996;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(what, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (_) { /* not yet */ }
    if (Date.now() > end) return null;
    await sleep(250);
  }
}
const json = async (p) => (await fetch(BASE + p)).json();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

function start(data, log) {
  const out = fs.openSync(log, 'a');
  const child = spawn(EXE, ['--no-browser'], {
    env: { ...process.env, LIGHTSHOW_DATA_DIR: data, LIGHTSHOW_OPEN_BROWSER: '0' },
    stdio: ['ignore', out, out],
  });
  child.exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return child;
}

async function main() {
  if (!check('the executable is there', fs.existsSync(EXE), EXE)) return;
  const said = spawnSync(EXE, ['--version'], { encoding: 'utf8', timeout: 30000 });
  check('it says its version', (said.stdout || '').includes(`ArtNet Lightshow ${version}`), (said.stdout || said.stderr || '').trim());

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lightshow-smoke-'));
  fs.mkdirSync(path.join(data, 'config'));
  fs.writeFileSync(path.join(data, 'config', 'settings.json'), JSON.stringify({
    server: { host: '127.0.0.1', port: PORT, token: '' },
    artnet: { enabled: false },
    sacn: { enabled: false },
    sources: { prolink: false, smtc: false },
  }));
  const log = path.join(data, 'smoke.log');
  try {
    const supervisor = start(data, log);
    const health = await until(async () => {
      const h = await json('/api/health');
      return h.engine && h.engine.running ? h : null;
    }, 90_000);
    if (!check('it comes up, supervised', !!(health && health.supervisor && health.supervisor.supervised),
      health ? `pid ${health.pid}, ${health.status}` : 'no answer in 90 s')) return;
    check('it is the version it says', health.version === version, health.version);
    check('the engine renders on its own thread', health.engine.mode === 'worker' || health.engine.thread === 'worker',
      JSON.stringify(health.engine).slice(0, 120));
    const page = await (await fetch(`${BASE}/`)).text();
    check('the page is served from its own files', page.includes('<title>'), `${page.length} bytes`);
    check('with the bundle and its chunks', (await fetch(`${BASE}/app.bundle.js`)).ok && (await fetch(`${BASE}/chunks/index.json`)).ok);
    const setup = await json('/api/python/setup');
    check('the uv it carries is found', !!(setup.uv && setup.uv.from === 'bundled' && /^uv \d/.test(setup.uv.version || '')),
      setup.uv ? `${setup.uv.version} (${setup.uv.from})` : 'none');
    check('the analysis environment would go in its data folder', path.resolve(setup.environment.dir) === path.join(data, '.venv'),
      setup.environment.dir);
    check('it writes its log in its data folder', fs.existsSync(path.join(data, 'logs', 'lightshow.log')));

    // The supervisor killed outright: the server must not live on.
    supervisor.kill('SIGKILL');
    await supervisor.exited;
    const gone = await until(async () => !alive(health.pid), 20_000);
    check('a supervisor killed outright takes the server with it', !!gone, `server pid ${health.pid}`);
    check('and the port is free again', !!(await until(async () => {
      try { await fetch(`${BASE}/healthz`); return false; } catch (_) { return true; }
    }, 10_000)));

    if (!windows) {
      const second = start(data, log);
      const up = await until(async () => (await json('/api/health')).pid, 90_000);
      check('it starts again on the same data', !!up);
      second.kill('SIGTERM');
      const exit = await second.exited;
      check('stopped politely, it exits cleanly', exit.code === 0, JSON.stringify(exit));
      check('and the server with it', !!(await until(async () => !alive(up), 10_000)));
    }
  } finally {
    if (failures) {
      console.log(`\n--- the package's output (${log}) ---`);
      try { console.log(fs.readFileSync(log, 'utf8').slice(-6000)); } catch (_) { /* none */ }
    }
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

main().then(() => {
  console.log(failures ? `\n${failures} check(s) failed.` : '\nThe package works.');
  process.exit(failures ? 1 : 0);
}, (err) => {
  console.error(err);
  process.exit(1);
});
