// The supervisor (src/supervisor.ts), driving real processes: a stand-in
// server (tests/helpers/fake-server.mjs) that crashes, hangs, asks to be
// restarted or will not start, as each test plans it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { supervise, deezerArlSet, describeExit } from '../../src/supervisor.ts';

const FAKE = path.join(import.meta.dirname, '..', 'helpers', 'fake-server.mjs');

function run(t, plan, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const record = path.join(dir, 'runs.jsonl');
  const said = [];
  const supervisor = supervise({
    script: FAKE,
    env: { ...process.env, FAKE_SERVER_PLAN: plan, FAKE_SERVER_RECORD: record },
    log: (m) => said.push(m),
    backoffMs: [20],
    hangMs: 300,
    startupMs: 5000,
    checkMs: 50,
    ...options,
  });
  const runs = () => fs.readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { supervisor, runs, said };
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

test('stopping the supervisor stops the server, and ends with it', async (t) => {
  const { supervisor, runs } = run(t, 'stay', { forwardSignals: true });
  await new Promise((r) => setTimeout(r, 300));
  supervisor.stop('SIGTERM');
  assert.equal(await supervisor.done, 0);
  assert.equal(runs().length, 1);
});

test('the legacy OpenSSL provider only when a Deezer ARL is set', async (t) => {
  const { supervisor, runs } = run(t, '0', { legacyProvider: () => true, execArgv: ['--openssl-legacy-provider', '--max-old-space-size=512'] });
  await supervisor.done;
  assert.deepEqual(runs()[0].execArgv, ['--max-old-space-size=512', '--openssl-legacy-provider'], 'once, not twice');
  const off = run(t, '0', { legacyProvider: () => false, execArgv: ['--openssl-legacy-provider'] });
  await off.supervisor.done;
  assert.deepEqual(off.runs()[0].execArgv, []);

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
