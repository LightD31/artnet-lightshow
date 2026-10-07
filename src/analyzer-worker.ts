import { spawn } from 'node:child_process';

import { settings } from './server/settings.ts';
import { messageOf, cancelledError } from './errors.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Analysis } from './show/score.ts';

export type AnalysisPriority = 'current' | 'high' | 'normal';

export interface AnalyzeOptions {
  priority?: AnalysisPriority | string;
  tag?: string | null;
  queuePos?: number | null;
}

interface Request {
  id: number;
  source: unknown;
  targetDurationSec: number | null | undefined;
  priority: AnalysisPriority;
  tag: string | null;
  order: number;
  resolve: (analysis: Analysis) => void;
  reject: (err: Error) => void;
}

interface WorkerReply {
  id?: number;
  result?: Analysis;
  error?: string;
  recycle?: boolean;
}

function storedTimeoutMs(): number {
  return settings.get('analysis.analyzerTimeoutMs');
}

function workerEnv(): NodeJS.ProcessEnv {
  const bsRoformer = settings.get('analysis.separator') === 'bs-roformer';
  return {
    ...process.env,
    ARTNET_USE_BS_ROFORMER: bsRoformer ? '1' : '0',
    ARTNET_STRUCTURE_MODEL: settings.get('analysis.structureModel') || 'auto',
    ARTNET_GPU_MEMORY: settings.get('analysis.gpuMemory') || 'auto',
  };
}

const RANK: Record<string, number | undefined> = { current: 0, high: 1, normal: 2 };
const DEFAULT_PRIORITY: AnalysisPriority = 'normal';

function rankOf(priority: string): number {
  const rank = RANK[priority];
  return rank === undefined ? RANK[DEFAULT_PRIORITY] as number : rank;
}

const UNQUEUED = Infinity;

function compareSlots(a: Pick<Request, 'priority' | 'order'>, b: Pick<Request, 'priority' | 'order'>): number {
  const band = rankOf(a.priority) - rankOf(b.priority);
  if (band !== 0) return band;
  const ao = a.order === undefined ? UNQUEUED : a.order;
  const bo = b.order === undefined ? UNQUEUED : b.order;
  if (ao === bo) return 0;
  return ao < bo ? -1 : 1;
}

function looksLikeReply(line: string, id: number): boolean {
  return new RegExp(`^\\{\\s*"id"\\s*:\\s*${Number(id)}\\s*[,}]`).test(line);
}

function supersededError(): Error & { superseded: true } {
  return Object.assign(new Error('superseded by a newer current track'), { superseded: true as const });
}

class AnalyzerWorker {
  declare _resolvePython: () => string;
  declare _scriptPath: string;
  declare _timeoutMs: () => number;
  declare _proc: ChildProcessWithoutNullStreams | null;
  declare _pending: Request | null;
  declare _queue: Request[];
  declare _stdoutBuf: string;
  declare _nextId: number;
  declare _shuttingDown: boolean;
  declare _timeoutTimer: ReturnType<typeof setTimeout> | null;
  declare _recycleWhenIdle: string | null;
  declare _paused: string | null;

  constructor(pythonExe: string | (() => string), scriptPath: string,
    { timeoutMs }: { timeoutMs?: number | (() => number) } = {}) {
    this._resolvePython = typeof pythonExe === 'function' ? pythonExe : () => pythonExe;
    this._scriptPath = scriptPath;
    this._timeoutMs = timeoutMs === undefined
      ? storedTimeoutMs
      : (typeof timeoutMs === 'function' ? timeoutMs : () => timeoutMs);
    this._proc = null;
    this._pending = null;       // current in-flight { id, resolve, reject }
    this._queue = [];           // FIFO of waiting requests
    this._stdoutBuf = '';
    this._nextId = 1;
    this._shuttingDown = false;
    this._timeoutTimer = null;
    this._recycleWhenIdle = null;
    this._paused = null;
  }

  // Preload analysis imports during startup so the first track does not pay their cold-start cost.
  prewarm(): void {
    if (!this._proc && !this._shuttingDown && !this._paused) this._spawn();
  }

  pause(reason: string): void {
    if (this._paused || this._shuttingDown) return;
    this._paused = reason;
    console.log(`[analyzer] paused: ${reason}`);
    const running = this._pending;
    this._pending = null;
    this._clearTimeout();
    if (running) this._insertByPriority(running, { front: true });
    this._recycleWhenIdle = null;
    this._recycleProcess();
  }

  resume(): void {
    if (!this._paused) return;
    this._paused = null;
    console.log('[analyzer] resumed');
    this._tick();
  }

  analyze(source: unknown, targetDurationSec: number | null | undefined, options: AnalyzeOptions = {}): Promise<Analysis> {
    if (this._shuttingDown) {
      return Promise.reject(new Error('AnalyzerWorker is shutting down'));
    }
    const priority = (options.priority === undefined || RANK[options.priority] === undefined
      ? DEFAULT_PRIORITY : options.priority) as AnalysisPriority;
    const tag = options.tag || null;
    const queuePos = options.queuePos;
    const order = typeof queuePos === 'number' && Number.isFinite(queuePos) && queuePos >= 0
      ? queuePos : UNQUEUED;
    return new Promise<Analysis>((resolve, reject) => {
      const id = this._nextId++;
      const entry: Request = { id, source, targetDurationSec, priority, tag, order, resolve, reject };
      this._insertByPriority(entry);
      this._preempt();
      this._tick();
    });
  }

  promote(tag: string | null | undefined, priority: AnalysisPriority = 'high'): void {
    if (!tag || RANK[priority] === undefined) return;
    const idx = this._queue.findIndex((e) => e.tag === tag);
    if (idx < 0) return;
    const entry = this._queue[idx];
    if (rankOf(entry.priority) <= rankOf(priority)) return;
    this._queue.splice(idx, 1);
    entry.priority = priority;
    this._insertByPriority(entry);
    this._preempt();
  }

  cancel(tag: string | null | undefined): boolean {
    if (!tag) return false;
    let found = false;
    this._queue = this._queue.filter((entry) => {
      if (entry.tag !== tag) return true;
      entry.reject(cancelledError());
      found = true;
      return false;
    });
    if (this._pending && this._pending.tag === tag) {
      const running = this._pending;
      this._pending = null;
      this._clearTimeout();
      console.log(`[analyzer] request ${running.id} cancelled`);
      running.reject(cancelledError());
      this._recycleProcess();
      this._tick();
      found = true;
    }
    return found;
  }

  _insertByPriority(entry: Request, { front = false } = {}): void {
    let i = 0;
    while (i < this._queue.length) {
      const cmp = compareSlots(this._queue[i], entry);
      if (cmp > 0 || (cmp === 0 && front)) break;
      i++;
    }
    this._queue.splice(i, 0, entry);
  }

  // Re-rank queued prefetches so a reshaped playback queue cannot delay the next track.
  setQueueOrder(tags: unknown): void {
    if (!Array.isArray(tags) || !this._queue.length) return;
    for (const entry of this._queue) {
      if (entry.priority === 'current') continue;
      const idx = entry.tag ? tags.indexOf(entry.tag) : -1;
      entry.order = idx < 0 ? UNQUEUED : idx;
    }
    this._queue.sort(compareSlots);
  }

  // Preempt prefetch work for the current track; requeue useful prefetches and reject obsolete current jobs.
  _preempt(): void {
    const waiting = this._queue[0];
    if (!this._pending || !waiting || waiting.priority !== 'current') return;
    if (waiting.tag && waiting.tag === this._pending.tag) return;
    const victim = this._pending;
    this._pending = null;
    this._clearTimeout();
    if (victim.priority === 'current') {
      console.log(`[analyzer] request ${victim.id} superseded — its track is no longer playing`);
      victim.reject(supersededError());
    } else {
      console.log(`[analyzer] pausing request ${victim.id} for the track now playing`);
      this._insertByPriority(victim, { front: true });
    }
    this._recycleProcess();
    this._tick();
  }

  restart(reason = 'configuration changed', { whenIdle = false }: { whenIdle?: boolean } = {}): void {
    if (!this._proc) return;                 // next spawn already picks it up
    if (whenIdle && this._pending) {
      this._recycleWhenIdle = reason;
      return;
    }
    this._recycleWhenIdle = null;
    console.log(`[analyzer] recycling worker: ${reason}`);
    const running = this._pending;
    this._pending = null;
    this._clearTimeout();
    if (running) this._insertByPriority(running, { front: true });
    this._recycleProcess();
    this._tick();
  }

  // Recycle without rejecting pending jobs so a replacement process can continue the queue.
  _recycleProcess(): void {
    if (!this._proc) return;
    // Detach the old process first so late exit handlers cannot reject the replacement’s queue.
    const proc = this._proc;
    this._proc = null;
    this._stdoutBuf = '';
    try { proc.kill(); } catch (_) { /* already gone */ }
  }

  shutdown(): void {
    this._shuttingDown = true;
    this._clearTimeout();
    this._failPending('worker shutting down');
    if (this._proc) {
      try { this._proc.stdin.end(); } catch (_) { /* ignore */ }
      const proc = this._proc;
      setTimeout(() => {
        try { if (!proc.killed) proc.kill(); } catch (_) { /* ignore */ }
      }, 2000).unref();
      this._proc = null;
    }
  }

  _spawn(): void {
    const proc = spawn(this._resolvePython(), [this._scriptPath, '--worker'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: workerEnv(),
    });

    const current = () => proc === this._proc;

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => { if (current()) this._onStdout(chunk); });
    proc.stderr.on('data', (chunk: string) => this._onStderr(chunk));
    proc.stdin.on('error', (err) => {
      if (current()) console.warn(`[analyzer] could not write to the worker: ${err.message}`);
    });
    proc.on('error', (err) => { if (current()) this._onExit(`spawn error: ${err.message}`); });
    proc.on('close', (code, signal) => {
      if (!current()) return;
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      this._onExit(`worker exited (${reason})`);
    });

    this._proc = proc;
  }

  _onStdout(chunk: string): void {
    this._stdoutBuf += chunk;
    let nl;
    while ((nl = this._stdoutBuf.indexOf('\n')) >= 0) {
      const line = this._stdoutBuf.slice(0, nl).trim();
      this._stdoutBuf = this._stdoutBuf.slice(nl + 1);
      if (!line) continue;
      this._deliver(line);
    }
  }

  _onStderr(chunk: string): void {
    for (const raw of chunk.split(/\r?\n/)) {
      const line = raw.trim();
      if (line) console.log(line.startsWith('[analyzer]') ? line : `[analyzer] ${line}`);
    }
  }

  _onExit(reason: string): void {
    if (!this._proc) return;
    this._proc = null;
    this._stdoutBuf = '';
    if (!this._shuttingDown && this._pending) {
      console.warn(`[analyzer] ${reason} — pending request will be rejected`);
    }
    this._failPending(reason);
  }

  _clearTimeout(): void {
    if (this._timeoutTimer) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = null;
    }
  }

  _onTimeout(): void {
    const p = this._pending;
    this._pending = null;
    this._timeoutTimer = null;
    if (p) {
      console.warn(`[analyzer] request ${p.id} exceeded ${Math.round(this._timeoutMs() / 1000)}s — killing worker`);
      p.reject(new Error(`analysis timed out after ${Math.round(this._timeoutMs() / 1000)}s`));
    }
    this._recycleProcess();
    this._tick();
  }

  _failPending(reason: string): void {
    this._clearTimeout();
    if (this._pending) {
      const p = this._pending;
      this._pending = null;
      p.reject(new Error(reason));
    }
    if (this._queue.length) {
      const q = this._queue;
      this._queue = [];
      for (const req of q) req.reject(new Error(reason));
    }
  }

  _deliver(line: string): void {
    let resp: WorkerReply;
    try {
      resp = JSON.parse(line);
    } catch (e) {
      if (this._pending && looksLikeReply(line, this._pending.id)) {
        console.warn(`[analyzer] unreadable reply to request ${this._pending.id}: ${messageOf(e)}`);
        const p = this._pending;
        this._pending = null;
        this._clearTimeout();
        p.reject(new Error(`the analyser returned an unreadable result (${messageOf(e)})`));
        this._tick();
        return;
      }
      console.log(line.startsWith('[analyzer]') ? line : `[analyzer] ${line.slice(0, 200)}`);
      return;
    }
    if (!this._pending) {
      console.warn('[analyzer] unsolicited response from worker');
      return;
    }
    if (resp.id !== this._pending.id) {
      console.warn(`[analyzer] discarding stale response: got id ${resp.id}, awaiting ${this._pending.id}`);
      return;
    }
    const p = this._pending;
    this._pending = null;
    this._clearTimeout();
    if (resp.error) p.reject(new Error(resp.error));
    else p.resolve(resp.result as Analysis);
    // Recycle after GPU faults because that process cannot recover for later requests.
    if (resp.recycle) {
      console.warn('[analyzer] worker asked to be replaced (GPU fault); restarting it');
      this._recycleProcess();
    } else if (this._recycleWhenIdle) {
      console.log(`[analyzer] recycling worker: ${this._recycleWhenIdle}`);
      this._recycleProcess();
    }
    this._recycleWhenIdle = null;
    this._tick();
  }

  _tick(): void {
    if (this._paused || this._pending || !this._queue.length) return;
    if (!this._proc) this._spawn();
    const next = this._queue.shift() as Request;
    this._pending = next;
    const msg = JSON.stringify({
      id: next.id,
      source: next.source,
      targetDurationSec: typeof next.targetDurationSec === 'number' && Number.isFinite(next.targetDurationSec)
        ? next.targetDurationSec : null,
    });
    try {
      (this._proc as ChildProcessWithoutNullStreams).stdin.write(msg + '\n');
      this._clearTimeout();
      const timer = setTimeout(() => this._onTimeout(), this._timeoutMs());
      if (timer.unref) timer.unref();
      this._timeoutTimer = timer;
    } catch (err) {
      this._pending = null;
      next.reject(new Error(`failed to send to worker: ${messageOf(err)}`));
    }
  }
}

export default AnalyzerWorker;