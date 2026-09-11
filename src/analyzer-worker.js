'use strict';

const { spawn } = require('child_process');

// Hard ceiling on a single analysis. Without one, a wedged Python process
// leaves _pending unsettled forever and every queued prefetch waits behind it —
// the auto-show silently stops picking up new tracks with no error anywhere.
// Generous by design: a cold start plus a long track is well
// under this, so hitting it means something is genuinely stuck.
const { settings } = require('./server/settings');

// Read per call, not once at load: the operator can change it in the settings
// page and the next analysis should honour the new value without a restart.
function storedTimeoutMs() {
  return settings.get('analysis.analyzerTimeoutMs');
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
 * and are dispatched FIFO. The Python pipeline already saturates the CPU
 * (BLAS + numba), so running multiple analyses in parallel would just thrash.
 *
 * Lifecycle: the process is spawned lazily on the first analyze() call.
 * Crashes/exits reject pending requests and clear state; the next analyze()
 * respawns. shutdown() ends stdin and lets the worker exit naturally.
 */
class AnalyzerWorker {
  /**
   * `pythonExe` may be a string or a function returning one. As a function it
   * is called at spawn time, so changing the interpreter in the settings page
   * takes effect on the next worker rather than needing a server restart.
   *
   * `timeoutMs` overrides the configured analysis timeout — a number, or a
   * function returning one. Left unset it follows the settings page, read per
   * request so a change applies to the next analysis without a restart.
   */
  constructor(pythonExe, scriptPath, { timeoutMs } = {}) {
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
    // Set while we deliberately kill a wedged worker, so the exit handler
    // recycles the process instead of failing the whole queue with it.
    this._recycling = false;
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

  /**
   * Drop the current worker process so the next analysis spawns a fresh one.
   * Used when the interpreter changes under us — the running process is still
   * the old Python, and nothing else would replace it.
   */
  restart(reason = 'configuration changed') {
    if (!this._proc) return;                 // next spawn already picks it up
    console.log(`[analyzer] recycling worker: ${reason}`);
    this._recycling = true;
    const proc = this._proc;
    this._proc = null;
    this._stdoutBuf = '';
    try { proc.kill(); } catch (_) { /* already gone */ }
  }

  shutdown() {
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

  _spawn() {
    const proc = spawn(this._resolvePython(), [this._scriptPath, '--worker'], {
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
      if (line) console.log(line.startsWith('[analyzer]') ? line : `[analyzer] ${line}`);
    }
  }

  _onExit(reason) {
    // Deliberate recycle after a timeout: the pending request was already
    // rejected and the queue is intentionally preserved.
    if (this._recycling) {
      this._recycling = false;
      return;
    }
    if (!this._proc) return;
    this._proc = null;
    this._stdoutBuf = '';
    if (!this._shuttingDown && this._pending) {
      console.warn(`[analyzer] ${reason} — pending request will be rejected`);
    }
    this._failPending(reason);
  }

  _clearTimeout() {
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
  _onTimeout() {
    const p = this._pending;
    this._pending = null;
    this._timeoutTimer = null;
    if (p) {
      console.warn(`[analyzer] request ${p.id} exceeded ${Math.round(this._timeoutMs() / 1000)}s — killing worker`);
      p.reject(new Error(`analysis timed out after ${Math.round(this._timeoutMs() / 1000)}s`));
    }
    if (this._proc) {
      this._recycling = true;
      const proc = this._proc;
      this._proc = null;
      this._stdoutBuf = '';
      try { proc.kill(); } catch (_) { /* already gone */ }
    }
    // Fresh process, continue with whatever is queued.
    this._tick();
  }

  _failPending(reason) {
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

  _deliver(line) {
    let resp;
    try {
      resp = JSON.parse(line);
    } catch (e) {
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
      this._clearTimeout();
      this._timeoutTimer = setTimeout(() => this._onTimeout(), this._timeoutMs());
      if (this._timeoutTimer.unref) this._timeoutTimer.unref();
    } catch (err) {
      this._pending = null;
      next.reject(new Error(`failed to send to worker: ${err.message}`));
    }
  }
}

module.exports = AnalyzerWorker;
