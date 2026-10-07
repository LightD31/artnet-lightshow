// Anchor deadlines to one epoch so a late callback cannot shift every later frame.

const FRAME_RATE = 44;
const FRAME_MS = 1000 / FRAME_RATE;

// Skip excessive catch-up frames so a stall is not followed by a burst of stale output.
const MAX_BEHIND_FRAMES = 2;

const STATS_WINDOW_S = 60;

// Allow timer slack because Node truncates both delay and loop-clock readings to milliseconds.
const TIMER_SLACK_MS = 2;

function hrtimeMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

function nextIndex(t: number, epoch: number, phase: number, period: number): number {
  return Math.max(0, Math.ceil((t - epoch - phase) / period - 1e-9));
}

function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

// Use a fixed timing ring so monitoring memory does not grow with show duration.
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

  summary(): FrameSummary {
    const n = this._count;
    const late = Array.from(this._late.subarray(0, n)).sort((a, b) => a - b);
    const work = Array.from(this._work.subarray(0, n)).sort((a, b) => a - b);
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

// Schedule from the next absolute deadline so timer rounding cannot accumulate drift.
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
      if (running) arm(t < due - periodMs / 2 ? due : Math.max(now(), due - TIMER_SLACK_MS));
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
