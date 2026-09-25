// The supervisor (src/supervisor.ts), driving real processes: a stand-in
// server (tests/helpers/fake-server.mjs) that crashes, hangs, asks to be
// restarted or will not start, as each test plans it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { supervise, deezerArlSet, describeExit } from '../../src/supervisor.ts';
import { EXIT_CONFIG, listenToSupervisor } from '../../src/server/supervised.ts';

const FAKE = path.join(import.meta.dirname, '..', 'helpers', 'fake-server.mjs');

/** What the fake server wrote: a line per run, and how a run that stayed ended. */
function reader(record) {
  const lines = () => (fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    runs: () => lines().filter((l) => 'run' in l),
    endings: () => lines().filter((l) => 'ended' in l).map((l) => l.ended),
  };
}

function run(t, plan, options = {}, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const record = path.join(dir, 'runs.jsonl');
  const said = [];
  const supervisor = supervise({
    script: FAKE,
    env: { ...process.env, NODE_OPTIONS: '', FAKE_SERVER_PLAN: plan, FAKE_SERVER_RECORD: record, ...env },
    log: (m) => said.push(m),
    backoffMs: [20],
    hangMs: 300,
    startupMs: 5000,
    checkMs: 50,
    sea: false,
    ...options,
  });
  return { supervisor, said, ...reader(record) };
}

test('a crash is followed by a restart that knows it is one; a clean exit ends it', async (t) => {
  const { supervisor, runs, said } = run(t, '3,0');
  assert.equal(await supervisor.done, 0);
  assert.equal(supervisor.restarts(), 1);
  const [first, second] = runs();
  assert.deepEqual([first.run, first.recover, first.lastExit], [0, '', null]);
  assert.deepEqual([second.run, second.recover, second.lastExit], [1, '1', 'crashed with exit code 3']);
  assert.match(said.join('\n'), /the server crashed with exit code 3 — starting it again in 20 ms/);
});

test('a server that stops beating is killed and started again', async (t) => {
  const { supervisor, runs, said } = run(t, 'hang,0');
  assert.equal(await supervisor.done, 0);
  assert.match(runs()[1].lastExit, /^stopped responding for \d+ s$/);
  assert.match(said[0], /has not answered for \d+ s — restarting it/);
});

test('asked to restart, it is started again at once, and the look is recovered', async (t) => {
  const { supervisor, runs, said } = run(t, 'restart,0', { backoffMs: [60_000] });
  assert.equal(await supervisor.done, 0, 'no backoff held it up');
  assert.deepEqual(runs().map((r) => [r.recover, r.lastExit]), [['', null], ['1', 'restarted on request (a setting)']]);
  assert.deepEqual(said, ['restarting the server (a setting)']);
});

test('a configuration that cannot start is not started again', async (t) => {
  const { supervisor, runs, said } = run(t, '78');
  assert.equal(await supervisor.done, 78);
  assert.equal(runs().length, 1);
  assert.match(said[0], /cannot start with this configuration/);
});

test('a server that dies before it starts, three times, is given up on', async (t) => {
  const { supervisor, runs, said } = run(t, 'nostart');
  assert.equal(await supervisor.done, 1);
  assert.equal(runs().length, 3);
  assert.match(said.at(-1), /crashed with exit code 1 3 times before it could start — giving up/);
});

test('stopping the supervisor asks the server to stop, and ends with it', async (t) => {
  const { supervisor, runs, endings } = run(t, 'stay', { forwardSignals: true });
  await new Promise((r) => setTimeout(r, 300));
  supervisor.stop('SIGTERM');
  assert.equal(await supervisor.done, 0);
  assert.equal(runs().length, 1);
  assert.deepEqual(endings(), ['asked (SIGTERM)'], 'over the channel, where it blacks out first — not a signal');
});

test('where a signal would be a kill (Windows), the server is still asked, and does not wait out the timeout', async (t) => {
  const { supervisor, endings } = run(t, 'stay', { forwardSignals: false, stopMs: 20_000 });
  await new Promise((r) => setTimeout(r, 300));
  const asked = Date.now();
  supervisor.stop('SIGINT');
  assert.equal(await supervisor.done, 0);
  assert.ok(Date.now() - asked < 5000, 'stopped when asked, not killed ten seconds later');
  assert.deepEqual(endings(), ['asked (SIGINT)']);
});

test('a server whose supervisor is killed stops too, rather than hold the port with nothing to restart it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const record = path.join(dir, 'runs.jsonl');
  const { runs, endings } = reader(record);
  const script = `
    const { supervise } = await import(${JSON.stringify(new URL('../../src/supervisor.ts', import.meta.url).href)});
    supervise({ script: ${JSON.stringify(FAKE)}, sea: false, log: () => {} });
    setInterval(() => {}, 1000);
  `;
  const env = { ...process.env, NODE_OPTIONS: '', FAKE_SERVER_PLAN: 'stay', FAKE_SERVER_RECORD: record };
  const parent = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: 'ignore' });
  t.after(() => { try { parent.kill('SIGKILL'); } catch (_) { /* gone */ } });
  const until = async (what, fn) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fn(), what);
  };
  await until('the server started', () => runs().length === 1);
  const { pid } = runs()[0];
  parent.kill('SIGKILL');
  await until('the server noticed', () => endings().length === 1);
  assert.deepEqual(endings(), ['the supervisor has gone']);
  await until('the server is gone', () => { try { process.kill(pid, 0); return false; } catch (_) { return true; } });
});

test('the server hears a stop, and its supervisor going, over the channel', () => {
  const channel = new EventEmitter();
  const heard = [];
  listenToSupervisor({ stop: (signal) => heard.push(`stop ${signal}`), gone: () => heard.push('gone') }, channel);
  channel.emit('message', { type: 'stop', signal: 'SIGINT' });
  channel.emit('message', { type: 'stop' });
  channel.emit('message', { type: 'heartbeat' });
  channel.emit('message', 'stop');
  channel.emit('message', null);
  channel.emit('disconnect');
  assert.deepEqual(heard, ['stop SIGINT', 'stop SIGTERM', 'gone']);
  assert.doesNotThrow(() => listenToSupervisor({ stop() {}, gone() {} }, null), 'without a supervisor, nothing to hear');
});

test('the legacy OpenSSL provider only when a Deezer ARL is set', async (t) => {
  const { supervisor, runs } = run(t, '0', { legacyProvider: () => true, execArgv: ['--openssl-legacy-provider', '--max-old-space-size=512'] });
  await supervisor.done;
  assert.deepEqual(runs()[0].execArgv, ['--max-old-space-size=512', '--openssl-legacy-provider'], 'once, not twice');
  const off = run(t, '0', { legacyProvider: () => false, execArgv: ['--openssl-legacy-provider'] });
  await off.supervisor.done;
  assert.deepEqual(off.runs()[0].execArgv, []);

  // A single executable takes no flags on its command line: NODE_OPTIONS
  // carries them, after the operator's own.
  const sea = run(t, '0', { sea: true, legacyProvider: () => true, execArgv: ['--max-old-space-size=512'] },
    { NODE_OPTIONS: '--no-warnings --openssl-legacy-provider' });
  await sea.supervisor.done;
  assert.deepEqual(sea.runs()[0].execArgv, []);
  assert.equal(sea.runs()[0].nodeOptions, '--no-warnings --max-old-space-size=512 --openssl-legacy-provider');
  const seaOff = run(t, '0', { sea: true, legacyProvider: () => false }, { NODE_OPTIONS: '--openssl-legacy-provider --no-warnings' });
  await seaOff.supervisor.done;
  assert.equal(seaOff.runs()[0].nodeOptions, '--no-warnings', 'not when no ARL is set, even left over from before');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  assert.equal(deezerArlSet(file), false, 'no file');
  fs.writeFileSync(file, JSON.stringify({ deezer: { arl: '  ' } }));
  assert.equal(deezerArlSet(file), false, 'blank');
  fs.writeFileSync(file, JSON.stringify({ deezer: { arl: 'abc' } }));
  assert.equal(deezerArlSet(file), true);
});

test('why a run ended, in words', () => {
  assert.equal(describeExit(1, null), 'crashed with exit code 1');
  assert.equal(describeExit(null, 'SIGSEGV'), 'killed by SIGSEGV');
  assert.equal(describeExit(null, 'SIGKILL', { hungMs: 16_400 }), 'stopped responding for 16 s');
  assert.equal(describeExit(75, null, { requested: 'a setting' }), 'restarted on request (a setting)');
});

// `node server.js` as npm start runs it, from a folder with a .env: a server
// the configuration will not let start (a network address, no token) exits
// with EXIT_CONFIG, under the supervisor or not.
async function startFrom(t, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'settings.json'), JSON.stringify({ server: { host: '0.0.0.0', token: '' } }));
  fs.writeFileSync(path.join(dir, '.env'), Object.entries({
    LIGHTSHOW_CONFIG_DIR: path.join(dir, 'config'),
    LIGHTSHOW_CACHE_DIR: path.join(dir, 'cache'),
    LIGHTSHOW_LOG_DIR: path.join(dir, 'logs'),
    ...env,
  }).map(([k, v]) => `${k}=${v}`).join('\n'));
  const clean = { ...process.env };
  for (const k of ['LIGHTSHOW_CONFIG_DIR', 'LIGHTSHOW_CACHE_DIR', 'LIGHTSHOW_LOG_DIR', 'LIGHTSHOW_SUPERVISOR',
    'LIGHTSHOW_SUPERVISED', 'WATCH_REPORT_DEPENDENCIES', 'NODE_TEST_CONTEXT']) delete clean[k];
  const server = spawn(process.execPath, [path.join(import.meta.dirname, '..', '..', 'server.js')], {
    cwd: dir, env: clean, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  server.stdout.on('data', (d) => { said += d; });
  server.stderr.on('data', (d) => { said += d; });
  const code = await new Promise((resolve) => server.on('exit', resolve));
  return { code, said };
}

test('the .env in the folder it starts from is read before the supervisor starts', async (t) => {
  const supervised = await startFrom(t, {});
  assert.equal(supervised.code, EXIT_CONFIG);
  assert.match(supervised.said, /Refusing to start/, 'the config directory named in .env, not the checkout\'s');
  assert.match(supervised.said, /\[supervisor\] the server cannot start with this configuration/);

  const direct = await startFrom(t, { LIGHTSHOW_SUPERVISOR: '0' });
  assert.equal(direct.code, EXIT_CONFIG);
  assert.match(direct.said, /Refusing to start/);
  assert.doesNotMatch(direct.said, /\[supervisor\]/, 'LIGHTSHOW_SUPERVISOR=0 in .env is heeded');
});
