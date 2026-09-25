import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import * as pythonEnv from '../python-env.ts';
import * as tools from '../tools.ts';
import * as ytdlp from '../ytdlp.ts';
import { appDir, venvDir, venvPython } from './config-dir.ts';
import { messageOf } from '../errors.ts';

/**
 * Setting the analysis environment up from the app: the uv bootstrap.
 *
 * The analysis is Python — torch, the models' code, librosa, yt-dlp, ffmpeg —
 * and the lockfile (pyproject.toml, uv.lock) pins every piece of it, with one
 * torch build per kind of graphics card. uv turns that into a working
 * environment with one command, including Python itself, which it downloads:
 * nothing has to be installed first. This runs that command —
 *
 *     uv sync --locked --extra <build> --python 3.12
 *
 * — in the app's folder, into the analysis environment (config-dir.ts: the
 * checkout's .venv, as `uv sync` by hand makes, or the packaged build's data
 * folder), with the progress on the page. The packaged build carries uv in
 * its `tools` folder; a checkout uses the uv on PATH or where uv's installer
 * puts it.
 *
 * Only uv's own Python is used (UV_PYTHON_PREFERENCE=only-managed): a Python
 * already on the machine is exactly what the interpreter probe exists to
 * second-guess (python-env.ts), and a Store stub or a conda base is no
 * foundation for a locked environment.
 */

/** The Python the environment is made with: in the lockfile's range, with wheels for everything in it. */
export const PYTHON_VERSION = '3.12';

export type Build = 'cpu' | 'cu128' | 'rocm';

export const BUILDS: Record<Build, { label: string; platforms: NodeJS.Platform[] }> = {
  cpu: { label: 'CPU', platforms: ['win32', 'linux', 'darwin'] },
  cu128: { label: 'NVIDIA (CUDA 12.8)', platforms: ['win32', 'linux'] },
  rocm: { label: 'AMD (ROCm 7.2)', platforms: ['linux'] },
};

/** POST /api/python/setup: which torch build to install. */
export const pythonSetupSchema = z.object({
  build: z.enum(['cpu', 'cu128', 'rocm']),
}).strict();

/** The builds this platform can install. */
export function buildsFor(platform: NodeJS.Platform = process.platform): Build[] {
  return (Object.keys(BUILDS) as Build[]).filter((b) => BUILDS[b].platforms.includes(platform));
}

// ─── Finding uv ───────────────────────────────────────────────────────────

export interface Uv {
  command: string;
  from: 'bundled' | 'path' | 'home';
}

export interface FindUvOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  app?: string;
  exists?: (file: string) => boolean;
}

/**
 * uv: the packaged build's own (its `tools` folder, beside `app`), else the
 * one on PATH, else where uv's installer puts it — a server started from a
 * shortcut may not have the PATH a terminal has.
 */
export function findUv({
  platform = process.platform, env = process.env, home = os.homedir(), app = appDir(), exists = fs.existsSync,
}: FindUvOptions = {}): Uv | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const exe = platform === 'win32' ? 'uv.exe' : 'uv';
  const bundled = p.join(app, '..', 'tools', exe);
  if (exists(bundled)) return { command: bundled, from: 'bundled' };
  const found = tools.onPath('uv', { env, platform, exists });
  if (found) return { command: found, from: 'path' };
  for (const dir of [p.join(home, '.local', 'bin'), p.join(home, '.cargo', 'bin')]) {
    const candidate = p.join(dir, exe);
    if (exists(candidate)) return { command: candidate, from: 'home' };
  }
  return null;
}

function capture(command: string, args: string[], timeout = 15000): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout || '').trim()));
    } catch (_) {
      resolve(null);
    }
  });
}

// ─── Which torch build ────────────────────────────────────────────────────

export interface Detected {
  build: Build;
  /** Why, in words. */
  why: string;
}

export interface DetectOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
  run?: (command: string, args: string[]) => Promise<string | null>;
}

/**
 * The torch build to suggest: CUDA for an NVIDIA card (its driver installs
 * nvidia-smi), ROCm where ROCm is installed on Linux, the CPU build otherwise.
 */
export async function detectBuild({
  platform = process.platform, env = process.env, exists = fs.existsSync, run = capture,
}: DetectOptions = {}): Promise<Detected> {
  if (platform === 'win32' || platform === 'linux') {
    const smi = tools.onPath('nvidia-smi', { env, platform, exists })
      || (platform === 'win32' && exists('C:\\Windows\\System32\\nvidia-smi.exe') ? 'C:\\Windows\\System32\\nvidia-smi.exe' : null);
    const name = smi ? await run(smi, ['--query-gpu=name', '--format=csv,noheader']) : null;
    const card = name ? name.split(/\r?\n/)[0].trim() : '';
    if (card) return { build: 'cu128', why: `found ${card}` };
  }
  if (platform === 'linux' && (exists('/dev/kfd') || exists('/opt/rocm'))) {
    return { build: 'rocm', why: 'ROCm is installed' };
  }
  if (platform === 'darwin') return { build: 'cpu', why: 'on a Mac the CPU build also runs on Apple\'s GPU' };
  return {
    build: 'cpu',
    why: platform === 'win32'
      ? 'no NVIDIA card found (an AMD card on Windows needs AMD\'s own torch: see requirements.txt)'
      : 'no NVIDIA card or ROCm found',
  };
}

// ─── Running uv sync ──────────────────────────────────────────────────────

export interface Downloads {
  /** Bytes of the large downloads uv announced, and of those finished. */
  total: number;
  done: number;
  count: number;
  finished: number;
  current: string | null;
}

export interface SetupJob {
  build: Build;
  startedAt: number;
  finishedAt: number | null;
  /** Null while it runs. */
  ok: boolean | null;
  error: string | null;
  /** In words: what it is doing now. */
  phase: string;
  python: string | null;
  packages: number | null;
  downloads: Downloads;
  /** The last of what uv said. */
  lines: string[];
}

const UNITS: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
const KEEP_LINES = 200;

// Colour codes, should a uv ignore NO_COLOR.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

// Each announced download's size, by name, to count it done when uv says it is.
const sizesOf = new WeakMap<SetupJob, Map<string, number>>();

/** Read one line of `uv sync` into the job. */
export function applyLine(job: SetupJob, raw: string): void {
  const line = raw.replace(ANSI, '').replace(/\s+$/, '');
  if (!line.trim()) return;
  job.lines.push(line);
  if (job.lines.length > KEEP_LINES) job.lines.splice(0, job.lines.length - KEEP_LINES);
  const d = job.downloads;
  let m;
  if ((m = /^Downloading (.+?) \((\d+(?:\.\d+)?)(B|KiB|MiB|GiB)\)$/.exec(line))) {
    const bytes = Math.round(Number(m[2]) * UNITS[m[3]]);
    d.total += bytes;
    d.count += 1;
    d.current = m[1];
    if (!sizesOf.has(job)) sizesOf.set(job, new Map());
    sizesOf.get(job)?.set(m[1], bytes);
    job.phase = /^cpython-/.test(m[1]) ? 'Downloading Python' : `Downloading ${m[1]}`;
  } else if ((m = /^\s+Download(?:ing|ed) (.+)$/.exec(line))) {
    d.done += sizesOf.get(job)?.get(m[1]) || 0;
    d.finished += 1;
    if (d.current === m[1]) d.current = null;
  } else if ((m = /^Using CPython (\S+)/.exec(line))) {
    job.python = m[1];
  } else if (/^Creating virtual environment/.test(line)) {
    job.phase = 'Creating the environment';
  } else if ((m = /^Resolved (\d+) packages?/.exec(line))) {
    job.packages = Number(m[1]);
    job.phase = 'Fetching packages';
  } else if (/^Prepared \d+ packages?/.test(line)) {
    job.phase = 'Installing';
  } else if (/^(Installed|Audited) \d+ packages?/.test(line)) {
    job.phase = 'Finishing';
  } else if ((m = /^error: (.+)$/.exec(line))) {
    job.error = m[1];
  }
}

/** What a spawned process looks like, as far as this module is concerned. */
interface Child {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'close', fn: (code: number | null) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  kill(): unknown;
}

export type Spawner = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Child;

export interface SetupHooks {
  /** Before uv runs: stop what runs from the environment (on Windows a running Python locks its files). */
  before?: (reason: string) => void;
  /** After, however it went: start them again, on the environment as it now is. */
  after?: (job: SetupJob) => void;
}

export interface PythonSetupOptions {
  uv?: () => Uv | null;
  spawner?: Spawner;
  app?: string;
  venv?: () => string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => number;
  timeoutMs?: number;
}

/** What the environment was set up as: written beside it when a setup succeeds. */
export interface Marker {
  build: Build;
  python: string | null;
  at: string;
}

export const MARKER = 'lightshow-build.json';

export function readMarker(venv: string = venvDir()): Marker | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(venv, MARKER), 'utf8'));
    return parsed && typeof parsed.build === 'string' ? parsed : null;
  } catch (_) {
    return null;
  }
}

export interface SetupStatus {
  uv: (Uv & { version: string | null }) | null;
  environment: { dir: string; exists: boolean; marker: Marker | null };
  python: { ok: boolean; ready: boolean; executable: string; version: string; missing: string[]; source: string };
  detected: Detected;
  builds: { id: Build; label: string }[];
  pythonVersion: string;
  job: SetupJob | null;
}

export interface PythonSetup {
  status(): Promise<SetupStatus>;
  /** Start a setup; the job already running if there is one. */
  start(build: Build): SetupJob;
  cancel(): boolean;
  job(): SetupJob | null;
  onHooks(hooks: SetupHooks): void;
}

function defaultSpawner(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Child {
  return spawn(command, args, { ...options, windowsHide: true });
}

export function createPythonSetup({
  uv = () => findUv(),
  spawner = defaultSpawner,
  app = appDir(),
  venv = venvDir,
  env = process.env,
  platform = process.platform,
  now = () => Date.now(),
  timeoutMs = 2 * 60 * 60 * 1000,
}: PythonSetupOptions = {}): PythonSetup {
  let current: SetupJob | null = null;
  let child: Child | null = null;
  let cancelled = false;
  let hooks: SetupHooks = {};

  async function status(): Promise<SetupStatus> {
    const found = uv();
    const info = pythonEnv.resolve();
    const dir = venv();
    return {
      uv: found ? { ...found, version: await capture(found.command, ['--version']) } : null,
      environment: { dir, exists: fs.existsSync(venvPython(dir, platform)), marker: readMarker(dir) },
      python: {
        ok: info.ok,
        ready: info.ok && !info.missing.length,
        executable: info.executable || info.exe,
        version: info.version,
        missing: info.missing,
        source: info.source,
      },
      detected: await detectBuild({ platform, env }),
      builds: buildsFor(platform).map((id) => ({ id, label: BUILDS[id].label })),
      pythonVersion: PYTHON_VERSION,
      job: current,
    };
  }

  function start(build: Build): SetupJob {
    if (current && current.ok === null) return current;
    const job: SetupJob = {
      build,
      startedAt: now(),
      finishedAt: null,
      ok: null,
      error: null,
      phase: 'Starting',
      python: null,
      packages: null,
      downloads: { total: 0, done: 0, count: 0, finished: 0, current: null },
      lines: [],
    };
    current = job;
    cancelled = false;

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const end = (ok: boolean, error: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child = null;
      job.ok = ok;
      job.error = ok ? null : (error || job.error || 'failed');
      job.phase = ok ? 'Done' : cancelled ? 'Cancelled' : 'Failed';
      job.finishedAt = now();
      if (ok) {
        try {
          const marker: Marker = { build, python: job.python, at: new Date(now()).toISOString() };
          fs.writeFileSync(path.join(venv(), MARKER), `${JSON.stringify(marker, null, 2)}\n`);
        } catch (err) {
          console.warn(`[python] could not note the build: ${messageOf(err)}`);
        }
      }
      // What was found before may be what this replaced.
      pythonEnv.resolve({ refresh: true });
      tools._reset();
      ytdlp._reset();
      console.log(ok ? `[python] the analysis environment is set up (${BUILDS[build].label})` : `[python] setting up the analysis environment failed: ${job.error}`);
      if (hooks.after) {
        try { hooks.after(job); } catch (err) { console.warn(`[python] after the setup: ${messageOf(err)}`); }
      }
    };

    if (!buildsFor(platform).includes(build)) {
      end(false, `the ${BUILDS[build].label} build is not available on this system`);
      return job;
    }
    const found = uv();
    if (!found) {
      end(false, 'uv is not installed — see https://docs.astral.sh/uv/getting-started/installation/');
      return job;
    }

    if (hooks.before) {
      try { hooks.before('the analysis environment is being set up'); } catch (err) { console.warn(`[python] before the setup: ${messageOf(err)}`); }
    }
    const args = ['sync', '--locked', '--extra', build, '--python', PYTHON_VERSION, '--project', app];
    console.log(`[python] setting up the analysis environment in ${venv()}: ${path.basename(found.command)} ${args.join(' ')}`);
    try {
      child = spawner(found.command, args, {
        cwd: app,
        env: {
          ...env,
          UV_PROJECT_ENVIRONMENT: venv(),
          UV_PYTHON_PREFERENCE: 'only-managed',
          NO_COLOR: '1',
        },
      });
    } catch (err) {
      end(false, messageOf(err));
      return job;
    }
    const read = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return;
      let buffer = '';
      stream.on('data', (chunk: Buffer | string) => {
        buffer += String(chunk);
        let nl;
        while ((nl = buffer.search(/\r?\n|\r/)) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + (buffer[nl] === '\r' && buffer[nl + 1] === '\n' ? 2 : 1));
          applyLine(job, line);
        }
      });
      stream.on('end', () => { if (buffer) applyLine(job, buffer); });
    };
    read(child.stdout);
    read(child.stderr);
    child.on('error', (err) => end(false, messageOf(err)));
    child.on('close', (code) => {
      if (cancelled) end(false, 'cancelled');
      else end(code === 0, code === 0 ? null : (job.error || `uv exited with code ${code}`));
    });
    timer = setTimeout(() => {
      end(false, `timed out after ${Math.round(timeoutMs / 60000)} minutes`);
      try { child?.kill(); } catch (_) { /* gone */ }
    }, timeoutMs);
    timer.unref?.();
    return job;
  }

  function cancel(): boolean {
    if (!current || current.ok !== null || !child) return false;
    cancelled = true;
    try { child.kill(); } catch (_) { /* gone */ }
    return true;
  }

  return {
    status,
    start,
    cancel,
    job: () => current,
    onHooks(h) { hooks = h || {}; },
  };
}

/** The server's one. */
export const pythonSetup = createPythonSetup();
