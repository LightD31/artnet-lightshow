/**
 * The frame clock: when each frame is due, and how close to it it went out.
 *
 * The render loop used to be `setInterval(render, 25)`. An interval re-arms
 * from whenever its callback happened to run, so every late frame pushed all
 * the frames after it later too: the rig ran a little under forty frames a
 * second and drifted against anything counting real time. Here frame k is due
 * at `epoch + phase + k·period`, fixed in advance, and each timer is armed for
 * the next of those deadlines — a late frame costs that frame, not the rest.
 *
 * Forty-four a second: the fastest a full 512-slot DMX line refreshes, and the
 * most E1.31 lets a source send per universe.
 *
 * Time is `process.hrtime`, which is the same monotonic clock in every thread
 * of the process. The engine's worker and the main thread's control tick
 * share one frame grid through it (see engine.js), so the main thread can run
 * its tick a fixed few milliseconds ahead of every frame the worker renders.
 */

const FRAME_RATE = 44;
const FRAME_MS = 1000 / FRAME_RATE;

// Further behind than this and the missed frames are skipped rather than run
// back to back: a burst of catch-up frames after a stall would only put a
// second glitch on stage after the first.
const MAX_BEHIND_FRAMES = 2;

// How long a window the timing figures describe.
const STATS_WINDOW_S = 60;

/** Milliseconds on the process-wide monotonic clock. */
function hrtimeMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

/** The index of the first deadline at or after `t`. */
function nextIndex(t: number, epoch: number, phase: number, period: number): number {
  return Math.max(0, Math.ceil((t - epoch - phase) / period - 1e-9));
}

/** The value at fraction `q` of an ascending list. */
function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * How the frames have been going: how late each went out against its
 * deadline, and how long each took. A fixed ring, so a show that runs all
 * night costs the same as one that started a minute ago.
 */
/** Percentiles of a timing, in milliseconds. */
export interface Spread {
  p50: number;
  p95: number;
  max: number;
}

export interface FrameSummary {
  frames: number;
  lateMs: Spread;
  renderMs: Spread;
  lateFrames: number;
  skippedFrames: number;
}

class FrameStats {
  declare periodMs: number;
  declare _size: number;
  declare _late: Float64Array;
  declare _work: Float64Array;
  declare _count: number;
  declare _next: number;
  declare skipped: number;

  constructor(periodMs = FRAME_MS, windowS = STATS_WINDOW_S) {
    this.periodMs = periodMs;
    this._size = Math.max(1, Math.round((windowS * 1000) / periodMs));
    this._late = new Float64Array(this._size);
    this._work = new Float64Array(this._size);
    this._count = 0;
    this._next = 0;
    this.skipped = 0;
  }

  record(lateMs: number, workMs: number): void {
    this._late[this._next] = Math.max(0, lateMs);
    this._work[this._next] = Math.max(0, workMs);
    this._next = (this._next + 1) % this._size;
    this._count = Math.min(this._size, this._count + 1);
  }

  /** p50/p95/max of lateness and render time, and the frames that went out late. */
  summary(): FrameSummary {
    const n = this._count;
    const late = Array.from(this._late.subarray(0, n)).sort((a, b) => a - b);
    const work = Array.from(this._work.subarray(0, n)).sort((a, b) => a - b);
    // A frame half a period late is visibly off the grid; under that is the
    // ordinary jitter of an OS timer.
    let lateFrames = 0;
    for (const v of late) if (v > this.periodMs / 2) lateFrames++;
    return {
      frames: n,
      lateMs: { p50: round2(quantile(late, 0.5)), p95: round2(quantile(late, 0.95)), max: round2(late[n - 1] || 0) },
      renderMs: { p50: round2(quantile(work, 0.5)), p95: round2(quantile(work, 0.95)), max: round2(work[n - 1] || 0) },
      lateFrames,
      skippedFrames: this.skipped,
    };
  }
}

/**
 * Call `onTick(dueMs, nowMs)` once per frame, on the grid
 * `epochMs + phaseMs + k·periodMs`.
 *
 * Each timer is armed for the next deadline measured from the later of now
 * and the deadline just served. A timer that fires a hair early therefore
 * still arms the next one a full period on, and under mocked timers (where the
 * clock does not move while the test ticks) the loop runs at exactly the
 * period, as an interval would.
 */
/** A running frame loop (see createTicker). */
export interface Ticker {
  stats: FrameStats;
  periodMs: number;
  start(): void;
  stop(): void;
  readonly running: boolean;
}

function createTicker({
  onTick,
  periodMs = FRAME_MS,
  phaseMs = 0,
  epochMs = null,
  now = hrtimeMs,
  stats = new FrameStats(periodMs),
}: {
  onTick: (dueMs: number, nowMs: number) => void;
  periodMs?: number;
  phaseMs?: number;
  epochMs?: number | null;
  now?: () => number;
  stats?: FrameStats;
}): Ticker {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let index = 0;
  let epoch = 0;
  let running = false;

  function arm(from: number): void {
    const due = epoch + phaseMs + index * periodMs;
    timer = setTimeout(fire, Math.max(0, due - from));
  }

  function fire(): void {
    timer = null;
    let due = epoch + phaseMs + index * periodMs;
    const t = now();
    if (t - due > MAX_BEHIND_FRAMES * periodMs) {
      // Serve the latest deadline already passed and drop the ones before it.
      const caughtUp = Math.floor((t - epoch - phaseMs) / periodMs);
      stats.skipped += caughtUp - index;
      index = caughtUp;
      due = epoch + phaseMs + index * periodMs;
    }
    try {
      onTick(due, t);
    } finally {
      stats.record(t - due, now() - t);
      index++;
      // Stopped from inside the tick: nothing left to arm.
      if (running) arm(Math.max(now(), due));
    }
  }

  return {
    stats,
    periodMs,
    start() {
      if (running) return;
      running = true;
      const t = now();
      epoch = typeof epochMs === 'number' && Number.isFinite(epochMs) ? epochMs : t;
      index = nextIndex(t, epoch, phaseMs, periodMs);
      arm(t);
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    get running() { return running; },
  };
}

export {
  FRAME_RATE,
  FRAME_MS,
  MAX_BEHIND_FRAMES,
  hrtimeMs,
  nextIndex,
  FrameStats,
  createTicker,
};
