import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { settings } from './server/settings.ts';

/** What probing one interpreter found. */
export interface PythonProbe {
  exe: string;
  ok: boolean;
  version: string;
  executable: string;
  missing: string[];
}

/** The interpreter the analyser will run, and how it was chosen. */
export interface PythonInfo extends PythonProbe {
  source: 'configured' | 'detected' | 'fallback';
  considered?: PythonProbe[];
}

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

// The analyzer cannot run without these. The beat grid comes from a model and
// has no signal-processing fallback, so torch and Beat This! are as required
// as librosa. panns_inference and the MuQ packages stay out: everything they
// feed degrades gracefully without them.
const REQUIRED_MODULES = ['librosa', 'numpy', 'soundfile', 'torch', 'beat_this'];

// The environment `uv sync` makes in the repository comes first: it was built
// for this project from its lockfile, which no other interpreter on the
// machine can say.
const PROJECT_VENV = process.platform === 'win32'
  ? path.join(import.meta.dirname, '..', '.venv', 'Scripts', 'python.exe')
  : path.join(import.meta.dirname, '..', '.venv', 'bin', 'python');

const CANDIDATES = process.platform === 'win32'
  ? ['py', 'python3', 'python']
  : ['python3', 'python'];

let projectVenv: string | null = PROJECT_VENV;

/** Where to look, in order: the project's environment when there is one, then PATH. */
function candidates(): string[] {
  return [...(projectVenv && fs.existsSync(projectVenv) ? [projectVenv] : []), ...CANDIDATES];
}

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
function probe(exe: string): PythonProbe | null {
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

let cached: PythonInfo | null = null;

/**
 * Resolve the interpreter to use, with the reasoning behind the choice.
 *
 * An explicit path from the settings always wins — it is the operator
 * saying "use this one", and second-guessing it would just hide their mistake.
 */
function resolve({ refresh = false } = {}): PythonInfo {
  if (cached && !refresh) return cached;

  const configured = settings.get('analysis.pythonPath');
  if (configured) {
    const info = probe(configured);
    cached = info
      ? { ...info, source: 'configured' }
      : { exe: configured, ok: false, version: '', executable: '', missing: REQUIRED_MODULES, source: 'configured' };
    return cached;
  }

  const probed: PythonProbe[] = [];
  for (const name of candidates()) {
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
function pythonExe(): string {
  return resolve().exe;
}

/** One line for the startup banner. */
function describe(): string {
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
function warnIfUnusable(log: (line: string) => void = console.warn): PythonInfo | null {
  const info = resolve();
  if (info.ok && !info.missing.length) return null;

  const lines: string[] = [];
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

  lines.push('[python] Fix: from the project folder, make its locked environment with');
  lines.push('[python]   uv sync --extra cpu      (or --extra cu128 for NVIDIA, --extra rocm for AMD on Linux)');
  lines.push(`[python] or install into this interpreter with`);
  lines.push(`[python]   "${info.executable || info.exe}" -m pip install -r requirements.txt`);
  lines.push('[python] or set a specific interpreter in the app under Sources → Analysis.');

  for (const line of lines) log(line);
  return info;
}

/** What importing the model stack for real found (see `verify`). */
export interface StackReport {
  ok: boolean;
  python: string;
  torch?: string;
  torchaudio?: string;
  torchvision?: string;
  /** 'cuda', 'rocm' or 'cpu', and the card's name when there is one. */
  accelerator?: string;
  device?: string;
  /** Module → the error importing it raised. */
  errors: Record<string, string>;
}

// Imports the stack rather than finding it. `find_spec` says a package is
// installed; only importing it says its native half loads — a torchvision
// built for another torch installs cleanly and then fails every model with
// "operator torchvision::nms does not exist". Seconds, not milliseconds, so it
// runs for the pre-show check, not on every start.
const VERIFY = `
import importlib, importlib.util as u, json, sys
out = {"python": sys.version.split()[0], "errors": {}}
for name in ("torch", "torchaudio", "torchvision", "beat_this", "demucs"):
    if name in ("torchvision", "demucs") and u.find_spec(name) is None:
        continue
    try:
        module = importlib.import_module(name)
        if name.startswith("torch"):
            out[name] = getattr(module, "__version__", "?")
        if name == "beat_this":
            importlib.import_module("beat_this.inference")
        if name == "torchvision":
            import torchvision.ops  # the native ops are what a mismatch breaks
    except Exception as exc:
        out["errors"][name] = (str(exc) or type(exc).__name__).splitlines()[0][:300]
try:
    import torch
    if torch.cuda.is_available():
        out["accelerator"] = "rocm" if getattr(torch.version, "hip", None) else "cuda"
        out["device"] = torch.cuda.get_device_name(0)
    else:
        out["accelerator"] = "cpu"
except Exception:
    pass
print(json.dumps(out))
`.trim();

const verified = new Map<string, { at: number; report: Promise<StackReport> }>();
const VERIFY_TTL_MS = 10 * 60 * 1000;

/**
 * Import the model stack in `exe` and report what loaded, and on what device.
 * Cached per interpreter for ten minutes.
 */
function verify(exe: string = resolve().executable || resolve().exe,
  { refresh = false, spawner = spawn, timeoutMs = 120000 }:
  { refresh?: boolean; spawner?: typeof spawn; timeoutMs?: number } = {}): Promise<StackReport> {
  const hit = verified.get(exe);
  if (hit && !refresh && Date.now() - hit.at < VERIFY_TTL_MS) return hit.report;
  const report = new Promise<StackReport>((done) => {
    const failed = (message: string): void => done({ ok: false, python: '', errors: { python: message } });
    let child;
    try {
      child = spawner(exe, ['-c', VERIFY], { windowsHide: true });
    } catch (err) {
      failed(err instanceof Error ? err.message : String(err));
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); failed(`timed out after ${timeoutMs / 1000} s`); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr = (stderr + String(d)).slice(-2000); });
    child.on('error', (err) => { clearTimeout(timer); failed(err.message); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = stdout.trim().split(/\r?\n/).pop() || '';
      try {
        const parsed = JSON.parse(line);
        const errors: Record<string, string> = parsed.errors || {};
        done({ ...parsed, errors, ok: !Object.keys(errors).length });
      } catch {
        failed(stderr.trim().split(/\r?\n/).pop() || `exit ${code}`);
      }
    });
  });
  verified.set(exe, { at: Date.now(), report });
  return report;
}

export const _reset = () => { cached = null; verified.clear(); };
/** Tests: point the project environment elsewhere, or nowhere. */
export const _setProjectVenv = (venv: string | null) => { projectVenv = venv; };

export {
  REQUIRED_MODULES,
  CANDIDATES,
  PROJECT_VENV,
  verify,
  probe,
  resolve,
  pythonExe,
  describe,
  warnIfUnusable,
};
