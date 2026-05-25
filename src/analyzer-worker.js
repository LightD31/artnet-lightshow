'use strict';

const { spawn } = require('child_process');

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
 * and are dispatched FIFO. The Python pipeline already saturates the CPU
 * (BLAS + numba), so running multiple analyses in parallel would just thrash.
 *
 * Lifecycle: the process is spawned lazily on the first analyze() call.
 * Crashes/exits reject pending requests and clear state; the next analyze()
 * respawns. shutdown() ends stdin and lets the worker exit naturally.
 */
class AnalyzerWorker {
  constructor(pythonExe, scriptPath) {
    this._pythonExe = pythonExe;
    this._scriptPath = scriptPath;
    this._proc = null;
    this._pending = null;       // current in-flight { id, resolve, reject }
    this._queue = [];           // FIFO of waiting requests
    this._stdoutBuf = '';
    this._nextId = 1;
    this._shuttingDown = false;
  }

  /**
   * Spawn the worker process now so its 5-10s of librosa/torch imports +
   * PANNs preload happens during server startup instead of on the first
   * analyze() call. Safe to call multiple times — no-ops if already spawned.
   */
  prewarm() {
    if (!this._proc && !this._shuttingDown) this._spawn();
  }

  /**
   * Submit an analysis. `options.priority`:
   *   - 'high'   — the "next song" path: jumps ahead of any pending normal
   *                items so deeper-queue prefetches can't block the song the
   *                user is about to hear. High requests still queue FIFO
   *                among themselves and never preempt the in-flight task.
   *   - 'normal' — default. Background prefetches deeper than slot 0.
   */
  analyze(source, targetDurationSec, options = {}) {
    if (this._shuttingDown) {
      return Promise.reject(new Error('AnalyzerWorker is shutting down'));
    }
    const priority = options.priority === 'high' ? 'high' : 'normal';
    const tag = options.tag || null;
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const entry = { id, source, targetDurationSec, priority, tag, resolve, reject };
      this._insertByPriority(entry);
      this._tick();
    });
  }

  /**
   * Promote a pending (not yet in-flight) request to high priority, moving
   * it ahead of any normal-priority items currently in the queue. No-op when
   * the request is already running (can't preempt the in-flight task) or
   * when no entry matches the tag.
   */
  bumpToHigh(tag) {
    if (!tag) return;
    const idx = this._queue.findIndex((e) => e.tag === tag);
    if (idx < 0) return;
    const entry = this._queue[idx];
    if (entry.priority === 'high') return;
    this._queue.splice(idx, 1);
    entry.priority = 'high';
    this._insertByPriority(entry);
  }

  _insertByPriority(entry) {
    if (entry.priority === 'high') {
      // Insert after all other high-priority entries, before all normal ones.
      let i = 0;
      while (i < this._queue.length && this._queue[i].priority === 'high') i++;
      this._queue.splice(i, 0, entry);
    } else {
      this._queue.push(entry);
    }
  }

  shutdown() {
    this._shuttingDown = true;
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

  _spawn() {
    const proc = spawn(this._pythonExe, [this._scriptPath, '--worker'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    proc.stderr.on('data', (chunk) => this._onStderr(chunk));
    proc.on('error', (err) => this._onExit(`spawn error: ${err.message}`));
    proc.on('close', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      this._onExit(`worker exited (${reason})`);
    });

    this._proc = proc;
  }

  _onStdout(chunk) {
    this._stdoutBuf += chunk;
    let nl;
    while ((nl = this._stdoutBuf.indexOf('\n')) >= 0) {
      const line = this._stdoutBuf.slice(0, nl).trim();
      this._stdoutBuf = this._stdoutBuf.slice(nl + 1);
      if (!line) continue;
      this._deliver(line);
    }
  }

  _onStderr(chunk) {
    // Surface analyzer log lines (`[panns] skipped: …`, `[trim] …s → …s`,
    // tracebacks) to the Node console with a consistent prefix.
    for (const raw of chunk.split(/\r?\n/)) {
      const line = raw.trim();
      if (line) console.log(`[analyzer] ${line}`);
    }
  }

  _onExit(reason) {
    if (!this._proc) return;
    this._proc = null;
    this._stdoutBuf = '';
    if (!this._shuttingDown && this._pending) {
      console.warn(`[analyzer] ${reason} — pending request will be rejected`);
    }
    this._failPending(reason);
  }

  _failPending(reason) {
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

  _deliver(line) {
    let resp;
    try {
      resp = JSON.parse(line);
    } catch (e) {
      console.warn(`[analyzer] bad worker output: ${line.slice(0, 200)}`);
      return;
    }
    if (!this._pending) {
      console.warn('[analyzer] unsolicited response from worker');
      return;
    }
    if (resp.id !== this._pending.id) {
      console.warn(`[analyzer] response id mismatch: got ${resp.id}, expected ${this._pending.id}`);
    }
    const p = this._pending;
    this._pending = null;
    if (resp.error) p.reject(new Error(resp.error));
    else p.resolve(resp.result);
    this._tick();
  }

  _tick() {
    if (this._pending || !this._queue.length) return;
    if (!this._proc) this._spawn();
    const next = this._queue.shift();
    this._pending = next;
    const msg = JSON.stringify({
      id: next.id,
      source: next.source,
      targetDurationSec: Number.isFinite(next.targetDurationSec) ? next.targetDurationSec : null,
    });
    try {
      this._proc.stdin.write(msg + '\n');
    } catch (err) {
      this._pending = null;
      next.reject(new Error(`failed to send to worker: ${err.message}`));
    }
  }
}

module.exports = AnalyzerWorker;
