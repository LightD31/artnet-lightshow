// The analysis models from the server's side: the list comes from
// scripts/download-models.py, and a download is that script run in the
// background with its progress read a line at a time — one at a time, never
// in the foreground, and the analyser restarted afterwards to use what came.

import test from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { createModelManager, modelDownloadSchema } from '../../src/server/model-manager.ts';
import { checkAnalysisModels, checkModelStack } from '../../src/server/preflight.ts';
import { settings } from '../../src/server/settings.ts';
import * as pythonEnv from '../../src/python-env.ts';

const ROWS = [
  { id: 'beat_this', name: 'Beat This!', purpose: '', tier: 'required', size: 81e6, license: 'MIT', present: true },
  { id: 'htdemucs', name: 'Demucs v4', purpose: '', tier: 'required', size: 84e6, license: 'MIT', present: true },
  { id: 'muq', name: 'MuQ', purpose: '', tier: 'recommended', size: 1.27e9, license: 'CC BY-NC 4.0', present: false },
  { id: 'songformer', name: 'SongFormer', purpose: '', tier: 'optional', size: 2.86e9, license: 'CC BY 4.0', present: false },
];

/** A stand-in for the script: answers --list, and plays back a download on cue. */
function fakeScript({ rows = ROWS } = {}) {
  const calls = [];
  const running = [];
  const spawner = (exe, args) => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.killed = false;
    proc.kill = () => { proc.killed = true; proc.emit('close', null); };
    calls.push(args.slice(1));
    if (args.includes('--list')) {
      setImmediate(() => {
        proc.stdout.write(`${JSON.stringify({ root: '/models', models: rows })}\n`);
        proc.emit('close', 0);
      });
    } else {
      running.push(proc);
    }
    return proc;
  };
  const line = (proc, event) => proc.stdout.write(`${JSON.stringify(event)}\n`);
  return { calls, running, spawner, line };
}

const tick = () => new Promise((r) => setImmediate(r));

test('the list comes from the script and is trusted for a few seconds', async () => {
  let now = 0;
  const script = fakeScript();
  const manager = createModelManager({ python: () => 'py', spawner: script.spawner, now: () => now });
  const [a, b] = await Promise.all([manager.list(), manager.list()]);
  assert.strictEqual(a, b);
  assert.deepStrictEqual(a.models.map((m) => m.id), ['beat_this', 'htdemucs', 'muq', 'songformer']);
  assert.strictEqual(script.calls.length, 1, 'two askers, one process');
  now += 5000;
  await manager.list();
  assert.strictEqual(script.calls.length, 1);
  now += 20000;
  await manager.list();
  assert.strictEqual(script.calls.length, 2, 'asked again once it is stale');
  await manager.list({ refresh: true });
  assert.strictEqual(script.calls.length, 3);
});

test('a listing that fails says why', async () => {
  const spawner = () => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => {};
    setImmediate(() => { proc.stderr.write('ModuleNotFoundError: No module named torch\n'); proc.emit('close', 1); });
    return proc;
  };
  const manager = createModelManager({ python: () => 'py', spawner });
  await assert.rejects(manager.list(), /could not list the analysis models: ModuleNotFoundError: No module named torch/);
});

test('a download reports its progress model by model, and only one runs', async () => {
  const script = fakeScript();
  const manager = createModelManager({ python: () => 'py', spawner: script.spawner });
  const finished = [];
  manager.onFinished((job) => finished.push(job));

  const job = manager.download(['muq', 'songformer', 'muq', 'not a valid id!']);
  assert.deepStrictEqual(job.ids, ['muq', 'songformer'], 'deduplicated and checked');
  assert.deepStrictEqual(script.calls.at(-1), ['--json', '--only', 'muq,songformer']);
  assert.strictEqual(manager.download(['songformer']), job, 'a second request joins the first');
  assert.strictEqual(script.running.length, 1);

  const [proc] = script.running;
  script.line(proc, { event: 'start', model: 'muq', total: 1000 });
  script.line(proc, { event: 'progress', model: 'muq', bytes: 250, total: 1000 });
  await tick();
  assert.deepStrictEqual(job.models.muq, { state: 'downloading', bytes: 250, total: 1000 });
  assert.strictEqual(job.models.songformer.state, 'queued');

  proc.stdout.write('{"event": "done", "model": "muq"}\n{"event": "err');     // a line split across reads
  proc.stdout.write('or", "model": "songformer", "message": "disk full"}\n');
  proc.stdout.write('{"event": "finished", "ok": false}\n');
  proc.emit('close', 1);
  await tick();
  assert.deepStrictEqual(job.models.muq, { state: 'done', bytes: 1000, total: 1000 });
  assert.deepStrictEqual([job.models.songformer.state, job.models.songformer.message], ['error', 'disk full']);
  assert.strictEqual(job.ok, false);
  assert.strictEqual(finished.length, 1);

  const next = manager.download(['songformer']);
  assert.notStrictEqual(next, job, 'once it has finished, a new one can start');
});

test('a download that runs past its time is stopped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const script = fakeScript();
  const manager = createModelManager({ python: () => 'py', spawner: script.spawner, downloadTimeoutMs: 60000 });
  const job = manager.download(['muq']);
  t.mock.timers.tick(60000);
  assert.strictEqual(job.ok, false);
  assert.match(job.error, /timed out/);
  assert.ok(script.running[0].killed);
});

test('the route only takes model ids', () => {
  assert.ok(modelDownloadSchema.safeParse({ ids: ['songformer'] }).success);
  assert.ok(!modelDownloadSchema.safeParse({ ids: [] }).success);
  assert.ok(!modelDownloadSchema.safeParse({ ids: ['../../etc/passwd'] }).success);
  assert.ok(!modelDownloadSchema.safeParse({ ids: ['muq'], extra: 1 }).success);
});

// ── The pre-show check ──────────────────────────────────────────────────────

function stubManager(rows, job = null) {
  const started = [];
  return {
    started,
    list: async () => ({ root: '/models', models: rows }),
    job: () => job,
    download: (ids) => {
      started.push(ids);
      job = { ids, startedAt: Date.now(), finishedAt: null, ok: null, error: null,
        models: Object.fromEntries(ids.map((id) => [id, { state: 'downloading', bytes: 1e8, total: 1.27e9 }])) };
      return job;
    },
    onFinished() {},
  };
}

test('the check fetches what the show needs in the background, once', async () => {
  const manager = stubManager(ROWS);
  const first = await checkAnalysisModels({ download: true, manager });
  assert.strictEqual(first.status, 'warn');
  assert.match(first.detail, /Downloading muq in the background.*100 of 1270 MB/);
  assert.deepStrictEqual(manager.started, [['muq']], 'the optional SongFormer is not fetched unasked');
  await checkAnalysisModels({ download: true, manager });
  assert.strictEqual(manager.started.length, 1, 'not a second time while it runs');

  const quiet = await checkAnalysisModels({ download: false, manager: stubManager(ROWS) });
  assert.match(quiet.detail, /MuQ is not downloaded; the analysis falls back without it/);
});

test('a model the settings ask for is one the show needs', async () => {
  const saved = settings._values.analysis.structureModel;
  settings._values.analysis.structureModel = 'songformer';
  try {
    const manager = stubManager(ROWS);
    await checkAnalysisModels({ download: true, manager });
    assert.deepStrictEqual(manager.started, [['muq', 'songformer']]);
  } finally {
    settings._values.analysis.structureModel = saved;
  }
});

test('with everything here the check says so', async () => {
  const all = ROWS.map((m) => ({ ...m, present: true }));
  const r = await checkAnalysisModels({ download: true, manager: stubManager(all) });
  assert.strictEqual(r.status, 'ok');
  assert.match(r.detail, /Beat This!, Demucs v4, MuQ ready; also SongFormer\./);
});

test('the model stack check names a torch build mismatch and how to fix it', async () => {
  pythonEnv._reset();
  const saved = settings._values.analysis.pythonPath;
  // Whatever runs this test is a Python that resolves, with its missing list
  // emptied so the stack check is reached.
  const resolved = pythonEnv.resolve();
  resolved.ok = true;
  resolved.missing = [];
  try {
    const broken = await checkModelStack(async () => ({
      ok: false, python: '3.11', torch: '2.14.0+cpu',
      errors: { torchvision: 'operator torchvision::nms does not exist' },
    }));
    assert.strictEqual(broken.status, 'fail');
    assert.match(broken.detail, /torchvision: operator torchvision::nms does not exist/);
    assert.match(broken.fix, /same build/);

    const fine = await checkModelStack(async () => ({
      ok: true, python: '3.11', torch: '2.14.0+rocm7.2', torchaudio: '2.11.0', accelerator: 'rocm', device: 'AMD Radeon 890M', errors: {},
    }));
    assert.strictEqual(fine.status, 'ok');
    assert.match(fine.detail, /torch 2\.14\.0\+rocm7\.2, torchaudio 2\.11\.0; the models load and run on AMD Radeon 890M \(ROCm\)/);
  } finally {
    settings._values.analysis.pythonPath = saved;
    pythonEnv._reset();
  }
});

test('verify imports the stack in the interpreter and reads its answer', async () => {
  const spawner = (exe, args) => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => {};
    assert.strictEqual(args[0], '-c');
    assert.match(args[1], /import torchvision\.ops/);
    setImmediate(() => {
      proc.stdout.write('some library chatter\n');
      proc.stdout.write(`${JSON.stringify({ python: '3.11.9', torch: '2.14.0', errors: { beat_this: 'No module named einops' } })}\n`);
      proc.emit('close', 0);
    });
    return proc;
  };
  const report = await pythonEnv.verify('/opt/py', { refresh: true, spawner });
  assert.strictEqual(report.ok, false);
  assert.deepStrictEqual(report.errors, { beat_this: 'No module named einops' });
  const again = await pythonEnv.verify('/opt/py', { spawner: () => { throw new Error('not asked twice'); } });
  assert.strictEqual(again, report, 'cached for the interpreter');
  pythonEnv._reset();
});
