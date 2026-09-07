'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const pythonEnv = require('../../src/python-env');

// Find a real interpreter to probe against; without one there is nothing
// meaningful to assert, so the suite skips rather than pretending to pass.
function realPython() {
  for (const exe of ['python3', 'python']) {
    try {
      execFileSync(exe, ['-c', 'pass'], { stdio: 'ignore' });
      return exe;
    } catch (_) { /* try the next */ }
  }
  return null;
}
const PY = realPython();
const noPython = { skip: PY ? false : 'no python interpreter available' };

test('probe reports the real interpreter behind a launcher name', noPython, () => {
  const info = pythonEnv.probe(PY);
  assert.ok(info, 'a working interpreter must probe');
  assert.match(info.version, /^\d+\.\d+/);
  // The whole point on Windows: `py` and `python` can be different installs, so
  // the resolved path matters more than the name that was invoked.
  assert.ok(path.isAbsolute(info.executable), 'reports an absolute executable path');
  assert.ok(Array.isArray(info.missing));
});

test('a name that is not an interpreter probes as null, not a crash', () => {
  assert.strictEqual(pythonEnv.probe('definitely-not-a-python-abc123'), null);
});

// The bug this guards: probing with `--version` alone picks whichever Python
// answers first, which on Windows is the launcher — while pip installed into a
// conda env. The server then starts clean and dies on the first track.
test('an interpreter that has the dependencies is preferred over one that does not', noPython, () => {
  // A directory of stub modules turns any interpreter into one that "has" them.
  const stubs = fs.mkdtempSync(path.join(os.tmpdir(), 'py-stubs-'));
  for (const mod of pythonEnv.REQUIRED_MODULES) {
    fs.writeFileSync(path.join(stubs, `${mod}.py`), '# stub\n');
  }

  const bare = pythonEnv.probe(PY);
  assert.ok(bare.missing.length > 0, 'the plain interpreter is missing the real deps');

  // Same interpreter, but able to resolve the modules.
  const withPath = (() => {
    const saved = process.env.PYTHONPATH;
    process.env.PYTHONPATH = stubs;
    try { return pythonEnv.probe(PY); } finally {
      if (saved === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = saved;
    }
  })();

  assert.deepStrictEqual(withPath.missing, [], 'sees the modules once they resolve');
  fs.rmSync(stubs, { recursive: true, force: true });
});

test('an explicit path wins over detection, and a broken one is reported not swallowed', noPython, () => {
  const { settings } = require('../../src/server/settings');
  const original = settings.get('analysis.pythonPath');

  // Reach past update() deliberately: this is about resolution, and update()
  // would persist to the real config file.
  settings._values.analysis.pythonPath = 'definitely-not-a-python-abc123';
  pythonEnv._reset();
  const broken = pythonEnv.resolve();
  assert.strictEqual(broken.source, 'configured');
  assert.strictEqual(broken.ok, false, 'a configured interpreter that cannot run is not silently replaced');

  const lines = [];
  pythonEnv.warnIfUnusable((m) => lines.push(m));
  assert.match(lines.join('\n'), /cannot be run/);

  settings._values.analysis.pythonPath = original;
  pythonEnv._reset();
});

test('describe names the interpreter and any missing modules', noPython, () => {
  pythonEnv._reset();
  const info = pythonEnv.resolve();
  const text = pythonEnv.describe();
  assert.ok(text.includes(info.exe) || text.includes(info.executable));
  if (info.missing.length) assert.match(text, /MISSING/);
});

test('a usable interpreter produces no warning', noPython, () => {
  pythonEnv._reset();
  const info = pythonEnv.resolve();
  const lines = [];
  const returned = pythonEnv.warnIfUnusable((m) => lines.push(m));
  if (info.ok && !info.missing.length) {
    assert.strictEqual(returned, null, 'nothing to warn about');
    assert.strictEqual(lines.length, 0);
  } else {
    assert.ok(lines.length > 0, 'an unusable interpreter must say so');
    assert.match(lines.join('\n'), /pip install -r requirements\.txt/, 'and say how to fix it');
  }
});

// The end-to-end version of the bug: two interpreters on PATH, the one that
// answers first has no dependencies, the second one does. Selecting by
// "responds to --version" picks the wrong one and the server dies on the first
// track; selecting by "can import the deps" picks the right one.
test('detection walks past a working-but-empty interpreter to a usable one',
  { skip: process.platform === 'win32' ? 'uses POSIX shell shims' : (PY ? false : 'no python interpreter available') },
  () => {
    const real = execFileSync(PY, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'py-sim-'));
    const bin = path.join(dir, 'bin');
    const stubs = path.join(dir, 'stubs');
    fs.mkdirSync(bin); fs.mkdirSync(stubs);
    for (const mod of pythonEnv.REQUIRED_MODULES) fs.writeFileSync(path.join(stubs, `${mod}.py`), '# stub\n');

    // `python3` is first in CANDIDATES and deliberately dependency-free (-E so
    // it ignores PYTHONPATH); `python` is the one that was pip-installed into.
    fs.writeFileSync(path.join(bin, 'python3'), `#!/bin/sh\nexec ${real} -E "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'python'), `#!/bin/sh\nPYTHONPATH=${stubs} exec ${real} "$@"\n`, { mode: 0o755 });

    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    try {
      pythonEnv._reset();
      const info = pythonEnv.resolve();
      assert.strictEqual(info.exe, 'python', 'must pick the interpreter that has the dependencies');
      assert.deepStrictEqual(info.missing, []);
      assert.strictEqual(pythonEnv.warnIfUnusable(() => {}), null, 'and not warn about it');

      const names = info.considered.map((c) => c.exe);
      assert.ok(names.includes('python3'), 'the empty one was considered and rejected');
    } finally {
      process.env.PATH = savedPath;
      pythonEnv._reset();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
