'use strict';

const { spawnSync } = require('child_process');
const { settings } = require('./server/settings');

/**
 * Pick the Python interpreter that runs the analyzer.
 *
 * The hard part on Windows is that having *a* Python is not the same as having
 * the right one. `py` (the python.org launcher) and `python` (whatever is first
 * on PATH — often a conda env) are routinely two different installations, and
 * `pip install -r requirements.txt` only ever populates one of them. Probing
 * with `--version` alone picks whichever answers first, which is how you end up
 * with a server that starts cleanly, downloads a track, and only then dies with
 * `ModuleNotFoundError: No module named 'librosa'`.
 *
 * So the probe asks the question that actually matters: can *this* interpreter
 * import the analyzer's dependencies? An interpreter that can beats one that
 * merely exists.
 */

// The analyzer cannot run without these. torch / panns_inference are
// deliberately absent: genre classification degrades gracefully without them
// (see the `[panns] skipped:` path in essentia-analyze.py).
const REQUIRED_MODULES = ['librosa', 'numpy', 'soundfile'];

const CANDIDATES = process.platform === 'win32'
  ? ['py', 'python3', 'python']
  : ['python3', 'python'];

// find_spec() resolves a module without importing it, so this stays a bare
// interpreter startup (~100ms) rather than the 5-10s librosa itself costs.
const PROBE = `
import sys, importlib.util as u
mods = ${JSON.stringify(REQUIRED_MODULES)}
print(sys.version.split()[0])
print(sys.executable)
print(','.join(m for m in mods if u.find_spec(m) is None))
`.trim();

/**
 * Interrogate one interpreter.
 * @returns {{exe, ok, version, executable, missing}|null} null if it won't run.
 */
function probe(exe) {
  let r;
  try {
    r = spawnSync(exe, ['-c', PROBE], { encoding: 'utf8', timeout: 30000 });
  } catch (_) {
    return null;
  }
  // The Microsoft Store stub exits non-zero and prints nothing useful.
  if (!r || r.error || r.status !== 0) return null;

  const [version = '', executable = '', missing = ''] = String(r.stdout || '').trim().split(/\r?\n/);
  return {
    exe,
    ok: true,
    version,
    executable,
    missing: missing ? missing.split(',').filter(Boolean) : [],
  };
}

let cached = null;

/**
 * Resolve the interpreter to use, with the reasoning behind the choice.
 *
 * An explicit path from the settings page always wins — it is the operator
 * saying "use this one", and second-guessing it would just hide their mistake.
 */
function resolve({ refresh = false } = {}) {
  if (cached && !refresh) return cached;

  const configured = settings.get('analysis.pythonPath');
  if (configured) {
    const info = probe(configured);
    cached = info
      ? { ...info, source: 'configured' }
      : { exe: configured, ok: false, version: '', executable: '', missing: REQUIRED_MODULES, source: 'configured' };
    return cached;
  }

  const probed = [];
  for (const name of CANDIDATES) {
    const info = probe(name);
    if (!info) continue;
    probed.push(info);
    // An interpreter with the dependencies wins outright — no need to look
    // further, and no need to prefer `py` just because it answered first.
    if (!info.missing.length) {
      cached = { ...info, source: 'detected', considered: probed };
      return cached;
    }
  }

  // Nothing has the dependencies. Fall back to the first that runs so the
  // eventual failure names a real interpreter, and let the caller warn.
  cached = probed.length
    ? { ...probed[0], source: 'detected', considered: probed }
    : { exe: 'python', ok: false, version: '', executable: '', missing: REQUIRED_MODULES, source: 'fallback', considered: [] };
  return cached;
}

/** Just the executable, for spawning. Resolved lazily and cached. */
function pythonExe() {
  return resolve().exe;
}

/** One line for the startup banner. */
function describe() {
  const info = resolve();
  if (!info.ok) return `${info.exe} — NOT RUNNABLE`;
  const where = info.executable && info.executable !== info.exe ? ` → ${info.executable}` : '';
  const deps = info.missing.length ? ` — MISSING ${info.missing.join(', ')}` : '';
  return `${info.exe}${where} (${info.version})${deps}`;
}

/**
 * Warn at startup rather than at the first track change. Without this the
 * failure surfaces minutes into a set, after a download, as a traceback.
 */
function warnIfUnusable(log = console.warn) {
  const info = resolve();
  if (info.ok && !info.missing.length) return null;

  const lines = [];
  if (!info.ok) {
    lines.push(`[python] "${info.exe}" cannot be run — audio analysis will fail.`);
  } else {
    lines.push(`[python] ${info.executable || info.exe} is missing: ${info.missing.join(', ')}`);
    lines.push('[python] Audio analysis will fail when a track is analysed.');
  }

  if (info.considered && info.considered.length > 1) {
    lines.push('[python] Interpreters found:');
    for (const c of info.considered) {
      const state = c.missing.length ? `missing ${c.missing.join(', ')}` : 'has everything';
      lines.push(`[python]   ${c.exe} → ${c.executable} (${c.version}) — ${state}`);
    }
  }

  lines.push(`[python] Fix: install into this interpreter with`);
  lines.push(`[python]   "${info.executable || info.exe}" -m pip install -r requirements.txt`);
  lines.push('[python] or set a specific interpreter in the settings page under Analysis.');

  for (const line of lines) log(line);
  return info;
}

module.exports = {
  REQUIRED_MODULES,
  CANDIDATES,
  probe,
  resolve,
  pythonExe,
  describe,
  warnIfUnusable,
  // Tests and the settings applier re-resolve after the configured path changes.
  _reset: () => { cached = null; },
};
