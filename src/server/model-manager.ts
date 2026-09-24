/**
 * The analysis models from the server's side: which are on this machine, and
 * fetching the rest with the progress on screen.
 *
 * The knowledge of what each model is and where it lives is in one place,
 * scripts/download-models.py, which the operator can also run by hand. This
 * runs it: `--list --json` to ask what is here, and `--json --only …` to fetch,
 * reading its progress a line at a time. One download at a time — they share a
 * connection and a disk, and two would only each take twice as long.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';

import * as pythonEnv from '../python-env.ts';
import { messageOf } from '../errors.ts';

export type ModelTier = 'required' | 'recommended' | 'optional';

/** One model, as the script lists it. */
export interface ModelRow {
  id: string;
  name: string;
  purpose: string;
  tier: ModelTier;
  /** Roughly, in bytes: what the page shows before a download says exactly. */
  size: number;
  license: string;
  present: boolean;
  note?: string;
}

export interface ModelListing {
  root: string;
  models: ModelRow[];
}

export interface ModelProgress {
  state: 'queued' | 'downloading' | 'done' | 'error';
  bytes: number;
  total: number | null;
  message?: string;
}

export interface ModelJob {
  ids: string[];
  startedAt: number;
  finishedAt: number | null;
  /** Null while it runs. */
  ok: boolean | null;
  error: string | null;
  models: Record<string, ModelProgress>;
}

/** What a spawned process looks like, as far as this module is concerned. */
interface Child {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: 'close', fn: (code: number | null) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  kill(): unknown;
}

export interface ModelManagerOptions {
  python?: () => string;
  script?: string;
  spawner?: (exe: string, args: string[]) => Child;
  now?: () => number;
  /** How long a listing is trusted, ms. */
  listTtlMs?: number;
  /** How long a download may run, ms. */
  downloadTimeoutMs?: number;
}

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'download-models.py');
const ID_RE = /^[a-z0-9_-]{1,40}$/;

/** POST /api/models/download: which models to fetch. */
const modelDownloadSchema = z.object({
  ids: z.array(z.string().regex(ID_RE)).min(1).max(16),
}).strict();

function defaultPython(): string {
  return process.env.ARTNET_PYTHON || pythonEnv.resolve().executable || pythonEnv.resolve().exe || 'python';
}

function defaultSpawner(exe: string, args: string[]): Child {
  return spawn(exe, args, { env: process.env, windowsHide: true });
}

export interface ModelManager {
  list(opts?: { refresh?: boolean }): Promise<ModelListing>;
  download(ids: string[]): ModelJob;
  job(): ModelJob | null;
  onFinished(fn: ((job: ModelJob) => void) | null): void;
}

function createModelManager({
  python = defaultPython,
  script = SCRIPT,
  spawner = defaultSpawner,
  now = () => Date.now(),
  listTtlMs = 15000,
  downloadTimeoutMs = 2 * 60 * 60 * 1000,
}: ModelManagerOptions = {}): ModelManager {
  let listing: { at: number; value: ModelListing } | null = null;
  let listing$: Promise<ModelListing> | null = null;
  let current: ModelJob | null = null;
  let finished: ((job: ModelJob) => void) | null = null;

  function run(args: string[], onLine: (line: string) => void,
    onSpawn?: (child: Child) => void): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      let child: Child;
      try {
        child = spawner(python(), [script, ...args]);
      } catch (err) {
        reject(err);
        return;
      }
      if (onSpawn) onSpawn(child);
      let buffer = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer | string) => {
        buffer += String(chunk);
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) onLine(line);
        }
      });
      child.stderr.on('data', (chunk: Buffer | string) => { stderr = (stderr + String(chunk)).slice(-4000); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (buffer.trim()) onLine(buffer.trim());
        resolve({ code, stderr });
      });
    });
  }

  /** What is here and what is not, from the script. */
  async function list({ refresh = false } = {}): Promise<ModelListing> {
    if (!refresh && listing && now() - listing.at < listTtlMs) return listing.value;
    if (listing$) return listing$;
    listing$ = (async () => {
      let parsed: ModelListing | null = null;
      const { code, stderr } = await run(['--list', '--json'], (line) => {
        try {
          const value = JSON.parse(line);
          if (value && Array.isArray(value.models)) parsed = value;
        } catch { /* not the listing */ }
      });
      if (!parsed) {
        const why = stderr.trim().split(/\r?\n/).pop() || `exit ${code}`;
        throw new Error(`could not list the analysis models: ${why}`);
      }
      listing = { at: now(), value: parsed };
      return parsed;
    })();
    try {
      return await listing$;
    } finally {
      listing$ = null;
    }
  }

  function apply(job: ModelJob, line: string): void {
    let event: { event?: string; model?: string | null; bytes?: number; total?: number | null; message?: string; ok?: boolean };
    try { event = JSON.parse(line); } catch { return; }
    const entry = event.model ? job.models[event.model] : null;
    switch (event.event) {
      case 'start':
        if (entry) Object.assign(entry, { state: 'downloading', bytes: 0, total: event.total ?? null });
        break;
      case 'progress':
        if (entry) Object.assign(entry, { state: 'downloading', bytes: Number(event.bytes) || 0, total: event.total ?? entry.total });
        break;
      case 'done':
        if (entry) Object.assign(entry, { state: 'done', bytes: entry.total ?? entry.bytes });
        break;
      case 'error':
        if (entry) Object.assign(entry, { state: 'error', message: event.message || 'failed' });
        else job.error = event.message || 'failed';
        break;
      default:
        break;
    }
  }

  /**
   * Fetch `ids`. A download already running is returned as it is: the page
   * shows one job, and a second click does not start a second one.
   */
  function download(ids: string[]): ModelJob {
    if (current && current.ok === null) return current;
    const wanted = [...new Set(ids.filter((id) => ID_RE.test(id)))];
    const job: ModelJob = {
      ids: wanted,
      startedAt: now(),
      finishedAt: null,
      ok: null,
      error: null,
      models: Object.fromEntries(wanted.map((id) => [id, { state: 'queued', bytes: 0, total: null } as ModelProgress])),
    };
    current = job;
    const end = (ok: boolean, error: string | null) => {
      if (job.ok !== null) return;
      job.ok = ok;
      job.error = job.error || error;
      job.finishedAt = now();
      listing = null;
      console.log(ok ? `[models] downloaded ${wanted.join(', ')}` : `[models] download failed: ${job.error}`);
      if (finished) {
        try { finished(job); } catch (err) { console.warn(`[models] after the download: ${messageOf(err)}`); }
      }
    };
    if (!wanted.length) {
      end(true, null);
      return job;
    }
    console.log(`[models] downloading ${wanted.join(', ')}`);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let child: Child | null = null;
    run(['--json', '--only', wanted.join(',')], (line) => apply(job, line), (c) => { child = c; })
      .then(({ code, stderr }) => {
        const failed = Object.values(job.models).some((m) => m.state === 'error');
        const tail = stderr.trim().split(/\r?\n/).pop() || '';
        end(code === 0 && !failed, code === 0 && !failed ? null : (tail || `exit ${code}`));
      })
      .catch((err) => end(false, messageOf(err)))
      .finally(() => { if (timer) clearTimeout(timer); });
    timer = setTimeout(() => {
      end(false, `timed out after ${Math.round(downloadTimeoutMs / 60000)} minutes`);
      try { if (child) child.kill(); } catch { /* already gone */ }
    }, downloadTimeoutMs);
    if (timer.unref) timer.unref();
    return job;
  }

  return {
    list,
    download,
    job: () => current,
    onFinished(fn) { finished = typeof fn === 'function' ? fn : null; },
  };
}

/** The server's one manager. */
const modelManager = createModelManager();

export { createModelManager, modelManager, modelDownloadSchema };
