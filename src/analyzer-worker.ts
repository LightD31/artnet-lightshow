import { spawn } from 'node:child_process';

// Hard ceiling on a single analysis. Without one, a wedged Python process
// leaves _pending unsettled forever and every queued prefetch waits behind it —
// the auto-show silently stops picking up new tracks with no error anywhere.
// Generous by design: a cold start plus a long track is well
// under this, so hitting it means something is genuinely stuck.
import { settings } from './server/settings.ts';
import { messageOf, cancelledError } from './errors.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Analysis } from './show/score.ts';

/** How urgently an analysis is wanted (see analyze). */
export type AnalysisPriority = 'current' | 'high' | 'normal';

export interface AnalyzeOptions {
  priority?: AnalysisPriority | string;
  /** Names the work, so a later caller can find and promote it. */
  tag?: string | null;
  /** The track's place in the playback queue, 0 being next. */
  queuePos?: number | null;
}

/** One request, waiting or in flight. */
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

/** A line the Python worker answers with. */
interface WorkerReply {
  id?: number;
  result?: Analysis;
  error?: string;
  recycle?: boolean;
}

// Read per call, not once at load: the operator can change it in the settings
// page and the next analysis should honour the new value without a restart.
function storedTimeoutMs(): number {
  return settings.get('analysis.analyzerTimeoutMs');
}

/**
 * The worker's environment: this process's, plus the separator and the
 * structure model the operator chose. Read at spawn, so a change applies
 * to the next worker — and changing either restarts the worker (see apply.ts).
 */
function workerEnv(): NodeJS.ProcessEnv {
  const bsRoformer = settings.get('analysis.separator') === 'bs-roformer';
  return {
    ...process.env,
    ARTNET_USE_BS_ROFORMER: bsRoformer ? '1' : '0',
    ARTNET_STRUCTURE_MODEL: settings.get('analysis.structureModel') || 'auto',
  };
}

// Priority bands, in served order. 'current' is the song the room is hearing
// right now: it outranks everything else, and it is the only band allowed to
// interrupt an analysis that has already started.
const RANK: Record<string, number | undefined> = { current: 0, high: 1, normal: 2 };
const DEFAULT_PRIORITY: AnalysisPriority = 'normal';

function rankOf(priority: string): number {
  const rank = RANK[priority];
  return rank === undefined ? RANK[DEFAULT_PRIORITY] as number : rank;
}

// Within a band, work is served in playback-queue order: the sooner the room
// will hear a track, the sooner it is analysed. `order` is that position, 0
// being the next song up. Work with no place in the queue — an operator's own
// file, a set-list warm job — carries UNQUEUED and waits behind every upcoming
// track, FIFO among its peers.
const UNQUEUED = Infinity;

/** Serving order: band first, then playback-queue position. Ties stay FIFO. */
function compareSlots(a: Pick<Request, 'priority' | 'order'>, b: Pick<Request, 'priority' | 'order'>): number {
  const band = rankOf(a.priority) - rankOf(b.priority);
  if (band !== 0) return band;
  const ao = a.order === undefined ? UNQUEUED : a.order;
  const bo = b.order === undefined ? UNQUEUED : b.order;
  if (ao === bo) return 0;
  return ao < bo ? -1 : 1;
}

/**
 * Is this unparsable stdout line the worker's reply to request `id`, rather
 * than a library's progress output? Replies are a single JSON object that
 * starts with the id (see cli.py).
 */
function looksLikeReply(line: string, id: number): boolean {
  return new RegExp(`^\\{\\s*"id"\\s*:\\s*${Number(id)}\\s*[,}]`).test(line);
}

/** The track was left behind before its analysis finished. */
function supersededError(): Error & { superseded: true } {
  return Object.assign(new Error('superseded by a newer current track'), { superseded: true as const });
}

/**
 * Long-lived Python analyzer process. Holds numba JIT caches and the PANNs
 * PyTorch model in memory between requests so we only pay the multi-second
 * cold-start cost once per server lifetime instead of once per track.
 *
 * Wire protocol (NDJSON, one message per line in each direction):
 *   → {"id": <n>, "source": "<wav path>", "targetDurationSec": <num|null>}
 *   ← {"id": <n>, "result": {...}}   on success
 *   ← {"id": <n>, "error": "..."}    on failure
 *
 * Concurrency: one request in flight at a time. Concurrent callers queue up
 * and are dispatched by priority, FIFO within a band. The Python pipeline
 * already saturates the CPU (BLAS + numba), so running multiple analyses in
 * parallel would just thrash. The song playing right now is the one exception
 * to waiting your turn: it interrupts whatever is running (see _preempt).
 *
 * Lifecycle: the process is spawned lazily on the first analyze() call.
 * Crashes/exits reject pending requests and clear state; the next analyze()
 * respawns. shutdown() ends stdin and lets the worker exit naturally.
 */
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

  /**
   * `pythonExe` may be a string or a function returning one. As a function it
   * is called at spawn time, so changing the interpreter in the settings
   * takes effect on the next worker rather than needing a server restart.
   *
   * `timeoutMs` overrides the configured analysis timeout — a number, or a
   * function returning one. Left unset it follows the settings, read per
   * request so a change applies to the next analysis without a restart.
   */
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
  }

  /**
   * Spawn the worker process now so its 5-10s of librosa/torch imports +
   * PANNs preload happens during server startup instead of on the first
   * analyze() call. Safe to call multiple times — no-ops if already spawned.
   */
  prewarm(): void {
    if (!this._proc && !this._shuttingDown) this._spawn();
  }

  /**
   * Submit an analysis. `options.priority`:
   *   - 'current' — the song playing right now. Served before everything else,
   *                 and it does not wait for work already in flight: a running
   *                 prefetch is paused and requeued, a running 'current' whose
   *                 track has been left behind is rejected.
   *   - 'high'    — the "next song" path: jumps ahead of any pending normal
   *                 items so deeper-queue prefetches can't block the song the
   *                 user is about to hear. High requests still queue FIFO
   *                 among themselves and wait for the in-flight task.
   *   - 'normal'  — default. Background prefetches deeper than slot 0.
   *
   * `options.tag` names the work (auto-show passes the cache key) so a later
   * caller can find this request and promote it.
   *
   * `options.queuePos` is the track's position in the playback queue, 0 being
   * the next song up. Lower positions are served first within a band, so the
   * order the listener will hear the tracks in is the order they are analysed
   * in. Omit it for work that has no place in the queue.
   */
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

  /**
   * Raise a pending (not yet in-flight) request to `priority`, moving it ahead
   * of every lower-priority item in the queue. Used when a background prefetch
   * turns out to be for the track that just started playing.
   *
   * A request that is already running is left alone: it is the work we wanted
   * anyway, and restarting it would throw away everything it has done. No-op
   * when no entry matches the tag, or when it already ranks that high.
   */
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

  /**
   * Drop the work tagged `tag`: out of the queue if it is waiting, and the
   * process recycled if it is running — the operator has given up on that
   * track, and minutes of CPU spent on it would only hold up the next one.
   * Its caller is rejected with `cancelled` set (errors.ts). True if there
   * was any.
   */
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

  /**
   * Queue by band then playback-queue position, FIFO among equals. `front`
   * puts the entry at the head of its own group instead of the tail — for work
   * that already ran once and was interrupted, so it does not lose its place
   * to its peers.
   */
  _insertByPriority(entry: Request, { front = false } = {}): void {
    let i = 0;
    while (i < this._queue.length) {
      const cmp = compareSlots(this._queue[i], entry);
      if (cmp > 0 || (cmp === 0 && front)) break;
      i++;
    }
    this._queue.splice(i, 0, entry);
  }

  /**
   * Re-rank pending work to the playback queue as it stands now. The queue
   * reshapes while prefetches wait — the listener queues a song, skips one,
   * lets a radio reshuffle the tail — and an entry submitted when its track
   * was fourth in line must not hold up the track that is now next.
   *
   * `tags` is the upcoming tracks' tags in queue order. Pending work that is
   * no longer in the queue falls behind all of it rather than keeping the good
   * position it was given earlier.
   *
   * Bands still win, so the song playing right now keeps the head of the queue
   * even though it is not an upcoming track. Work already in flight is left
   * alone: only the current track is worth interrupting (see _preempt).
   */
  setQueueOrder(tags: unknown): void {
    if (!Array.isArray(tags) || !this._queue.length) return;
    for (const entry of this._queue) {
      if (entry.priority === 'current') continue;
      const idx = entry.tag ? tags.indexOf(entry.tag) : -1;
      entry.order = idx < 0 ? UNQUEUED : idx;
    }
    // Stable in Node, so entries that tie keep the order they arrived in.
    this._queue.sort(compareSlots);
  }

  /**
   * Clear the way for the song that is playing right now.
   *
   * The analyser serves one request at a time and a track takes tens of
   * seconds, so without this a prefetch that started moments before the track
   * changed would hold the current song's show behind it — the one case where
   * waiting your turn is the wrong answer.
   *
   * A preempted prefetch is requeued rather than failed: its audio is still on
   * disk and its caller is still waiting, so it restarts once the current
   * track is served. An older 'current' request is rejected instead — only one
   * song plays at a time, so its track has already been left behind and its
   * show would never be used.
   */
  _preempt(): void {
    const waiting = this._queue[0];
    if (!this._pending || !waiting || waiting.priority !== 'current') return;
    // Already analysing this very track: let it run.
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

  /**
   * Drop the current worker process so the next analysis spawns a fresh one.
   * Used when the interpreter changes under us — the running process is still
   * the old Python, and nothing else would replace it.
   *
   * `whenIdle` lets an analysis already running finish on the old process
   * first: right for new model weights, which only add to what the next
   * track gets, where starting the running one over would throw minutes of
   * work away. Without it, the running analysis starts again on the new one.
   */
  restart(reason = 'configuration changed', { whenIdle = false }: { whenIdle?: boolean } = {}): void {
    if (!this._proc) return;                 // next spawn already picks it up
    if (whenIdle && this._pending) {
      this._recycleWhenIdle = reason;
      return;
    }
    this._recycleWhenIdle = null;
    console.log(`[analyzer] recycling worker: ${reason}`);
    // Work in flight starts again on the new worker, at the head of its band.
    // Left pending, it sat on a killed process until the timeout.
    const running = this._pending;
    this._pending = null;
    this._clearTimeout();
    if (running) this._insertByPriority(running, { front: true });
    this._recycleProcess();
    this._tick();
  }

  /**
   * Drop the worker process without failing the queue behind it: the exit
   * handler recycles instead of rejecting, and the next _tick() spawns a
   * fresh process and carries on.
   */
  _recycleProcess(): void {
    if (!this._proc) return;
    // Forgetting the process first is what makes this a recycle rather than a
    // crash: its handlers only act while it is still `this._proc`, so its exit
    // cannot fail the queue — however many recycles happen before it closes.
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
      // Give it a moment to exit cleanly before killing.
      const proc = this._proc;
      setTimeout(() => {
        try { if (!proc.killed) proc.kill(); } catch (_) { /* ignore */ }
      }, 2000).unref();
      this._proc = null;
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  _spawn(): void {
    const proc = spawn(this._resolvePython(), [this._scriptPath, '--worker'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: workerEnv(),
    });

    // Every handler is bound to *this* process. A recycled worker takes a
    // moment to die, and in that moment a new one is already running: a
    // single "recycling" flag let the second of two quick recycles clear the
    // new process on the old one's exit, orphaning it with its GPU memory
    // and rejecting its whole queue. Output from a retired process could also
    // be parsed as the new one's reply.
    const current = () => proc === this._proc;

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => { if (current()) this._onStdout(chunk); });
    // A retiring worker's log lines are still worth seeing.
    proc.stderr.on('data', (chunk: string) => this._onStderr(chunk));
    // Writing to a worker that has just died fails asynchronously with EPIPE.
    // Unhandled, that 'error' event takes the whole server down; the 'close'
    // that follows is what deals with the dead worker.
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
    // Surface analyzer log lines (`[panns] skipped: …`, `[trim] …s → …s`,
    // tracebacks) to the Node console with a consistent prefix.
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

  /**
   * The in-flight request exceeded the configured analysis timeout. Reject
   * just that caller and recycle the worker — the queue behind it is still
   * good work and gets re-dispatched to the fresh process.
   */
  _onTimeout(): void {
    const p = this._pending;
    this._pending = null;
    this._timeoutTimer = null;
    if (p) {
      console.warn(`[analyzer] request ${p.id} exceeded ${Math.round(this._timeoutMs() / 1000)}s — killing worker`);
      p.reject(new Error(`analysis timed out after ${Math.round(this._timeoutMs() / 1000)}s`));
    }
    this._recycleProcess();
    // Fresh process, continue with whatever is queued.
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
      // The worker's reply that did not parse — a NaN slipped into it, or it
      // was truncated. Waiting would hold this request, and every one queued
      // behind it, until the timeout ten minutes later. The worker has
      // finished with it either way, so fail it now and move on.
      if (this._pending && looksLikeReply(line, this._pending.id)) {
        console.warn(`[analyzer] unreadable reply to request ${this._pending.id}: ${messageOf(e)}`);
        const p = this._pending;
        this._pending = null;
        this._clearTimeout();
        p.reject(new Error(`the analyser returned an unreadable result (${messageOf(e)})`));
        this._tick();
        return;
      }
      // A few third-party audio libraries print progress to stdout despite
      // the NDJSON contract. It is diagnostic output, not a protocol error.
      // Keep it visible without alarming the operator or disrupting the
      // request currently in flight.
      console.log(line.startsWith('[analyzer]') ? line : `[analyzer] ${line.slice(0, 200)}`);
      return;
    }
    if (!this._pending) {
      console.warn('[analyzer] unsolicited response from worker');
      return;
    }
    if (resp.id !== this._pending.id) {
      // A stale reply (e.g. from a worker that was recycled mid-request).
      // Resolving the current caller with it would hand one track's analysis to
      // a different track's request.
      console.warn(`[analyzer] discarding stale response: got id ${resp.id}, awaiting ${this._pending.id}`);
      return;
    }
    const p = this._pending;
    this._pending = null;
    this._clearTimeout();
    if (resp.error) p.reject(new Error(resp.error));
    else p.resolve(resp.result as Analysis);
    // The worker's GPU has faulted and stays broken for that process (see
    // models.gpu_fault). Replace it before the next request goes out, the way
    // a timeout does, so the queue carries on rather than failing with it.
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
    if (this._pending || !this._queue.length) return;
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