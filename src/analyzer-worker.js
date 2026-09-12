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

// Priority bands, in served order. 'current' is the song the room is hearing
// right now: it outranks everything else, and it is the only band allowed to
// interrupt an analysis that has already started.
const RANK = { current: 0, high: 1, normal: 2 };
const DEFAULT_PRIORITY = 'normal';

function rankOf(priority) {
  const rank = RANK[priority];
  return rank === undefined ? RANK[DEFAULT_PRIORITY] : rank;
}

// Within a band, work is served in playback-queue order: the sooner the room
// will hear a track, the sooner it is analysed. `order` is that position, 0
// being the next song up. Work with no place in the queue — an operator's own
// file, a set-list warm job — carries UNQUEUED and waits behind every upcoming
// track, FIFO among its peers.
const UNQUEUED = Infinity;

/** Serving order: band first, then playback-queue position. Ties stay FIFO. */
function compareSlots(a, b) {
  const band = rankOf(a.priority) - rankOf(b.priority);
  if (band !== 0) return band;
  const ao = a.order === undefined ? UNQUEUED : a.order;
  const bo = b.order === undefined ? UNQUEUED : b.order;
  if (ao === bo) return 0;
  return ao < bo ? -1 : 1;
}

/** The track was left behind before its analysis finished. */
function supersededError() {
  const err = new Error('superseded by a newer current track');
  err.superseded = true;
  return err;
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
  analyze(source, targetDurationSec, options = {}) {
    if (this._shuttingDown) {
      return Promise.reject(new Error('AnalyzerWorker is shutting down'));
    }
    const priority = RANK[options.priority] === undefined ? DEFAULT_PRIORITY : options.priority;
    const tag = options.tag || null;
    const order = Number.isFinite(options.queuePos) && options.queuePos >= 0
      ? options.queuePos : UNQUEUED;
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const entry = { id, source, targetDurationSec, priority, tag, order, resolve, reject };
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
  promote(tag, priority = 'high') {
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
   * Queue by band then playback-queue position, FIFO among equals. `front`
   * puts the entry at the head of its own group instead of the tail — for work
   * that already ran once and was interrupted, so it does not lose its place
   * to its peers.
   */
  _insertByPriority(entry, { front = false } = {}) {
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
  setQueueOrder(tags) {
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
  _preempt() {
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
   */
  restart(reason = 'configuration changed') {
    if (!this._proc) return;                 // next spawn already picks it up
    console.log(`[analyzer] recycling worker: ${reason}`);
    this._recycleProcess();
  }

  /**
   * Drop the worker process without failing the queue behind it: the exit
   * handler recycles instead of rejecting, and the next _tick() spawns a
   * fresh process and carries on.
   */
  _recycleProcess() {
    if (!this._proc) return;
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
    this._recycleProcess();
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
