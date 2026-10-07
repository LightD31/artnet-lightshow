export interface BeatGrid {
  beats: number[];
  interval: number;
}

export interface GridSource {
  beats?: unknown;
  downbeats?: unknown;
  meter?: unknown;
}

const FADE_BEATS = 8;

// Numeric slack for float noise: 3 × (1/3) must still floor to 1.
const EPS = 1e-9;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Discard duplicate beats to avoid zero-length intervals; extrapolate with the median interval.
function makeGrid(beatsSec: unknown): BeatGrid | null {
  if (!Array.isArray(beatsSec)) return null;
  const beats: number[] = [];
  for (const b of beatsSec) {
    const t = Number(b);
    if (!Number.isFinite(t)) continue;
    if (beats.length && t - beats[beats.length - 1] < 0.02) continue;
    beats.push(t);
  }
  if (beats.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < beats.length; i++) gaps.push(beats[i] - beats[i - 1]);
  return { beats, interval: median(gaps) as number };
}

function gridFromAnalysis(analysis: GridSource | null | undefined): BeatGrid | null {
  if (!analysis) return null;
  const direct = makeGrid(analysis.beats);
  if (direct) return direct;
  const downbeats = makeGrid(analysis.downbeats);
  if (!downbeats) return null;
  const meter = Math.max(1, Math.round(Number(analysis.meter) || 4));
  const beats: number[] = [];
  const d = downbeats.beats;
  for (let i = 0; i < d.length - 1; i++) {
    for (let k = 0; k < meter; k++) beats.push(d[i] + ((d[i + 1] - d[i]) * k) / meter);
  }
  beats.push(d[d.length - 1]);
  return makeGrid(beats);
}

function beatPositionAt(grid: BeatGrid, tMs: number): number;
function beatPositionAt(grid: BeatGrid | null | undefined, tMs: number): number | null;
function beatPositionAt(grid: BeatGrid | null | undefined, tMs: number): number | null {
  if (!grid) return null;
  const t = tMs / 1000;
  const b = grid.beats;
  const n = b.length;
  if (t <= b[0]) return (t - b[0]) / grid.interval;
  if (t >= b[n - 1]) return (n - 1) + (t - b[n - 1]) / grid.interval;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (b[mid] <= t) lo = mid; else hi = mid;
  }
  return lo + (t - b[lo]) / (b[hi] - b[lo]);
}

function trackMsAtBeat(grid: BeatGrid, beatPos: number): number;
function trackMsAtBeat(grid: BeatGrid | null | undefined, beatPos: number): number | null;
function trackMsAtBeat(grid: BeatGrid | null | undefined, beatPos: number): number | null {
  if (!grid) return null;
  const b = grid.beats;
  const n = b.length;
  if (beatPos <= 0) return (b[0] + beatPos * grid.interval) * 1000;
  if (beatPos >= n - 1) return (b[n - 1] + (beatPos - (n - 1)) * grid.interval) * 1000;
  const i = Math.floor(beatPos);
  return (b[i] + (beatPos - i) * (b[i + 1] - b[i])) * 1000;
}

// Median tempo over nine intervals keeps a single misplaced beat from moving the readout.
function localBpm(grid: BeatGrid, tMs: number): number;
function localBpm(grid: BeatGrid | null | undefined, tMs: number): number | null;
function localBpm(grid: BeatGrid | null | undefined, tMs: number): number | null {
  if (!grid) return null;
  const b = grid.beats;
  const at = Math.max(0, Math.min(b.length - 2, Math.floor(beatPositionAt(grid, tMs))));
  const gaps: number[] = [];
  for (let i = Math.max(0, at - 4); i <= Math.min(b.length - 2, at + 4); i++) gaps.push(b[i + 1] - b[i]);
  const gap = median(gaps) || grid.interval;
  return 60 / gap;
}

// Round the anchor so a scene firing slightly after a downbeat still starts on step zero.
function anchorStep(beatPos: number, division = 1): number {
  return Math.round(beatPos * Math.max(1, division));
}

function stepAt(beatPos: number, anchor: number, division = 1): number {
  return Math.max(0, Math.floor(beatPos * Math.max(1, division) + EPS) - anchor);
}

function hitPhase(beatPos: number, division = 1): number {
  const x = beatPos * Math.max(1, division);
  return Math.max(0, Math.min(1, x - Math.floor(x + EPS)));
}

function fadePhase(beatPos: number, anchor = 0, division = 1): number {
  const since = beatPos - anchor / Math.max(1, division);
  const p = (since / FADE_BEATS) % 1;
  return p < 0 ? p + 1 : p;
}

function motionAdvance(dBeats: number, motion = 0.3): number {
  const m = Math.max(0, Math.min(1, Number.isFinite(motion) ? motion : 0.3));
  return Math.max(0, dBeats) / (8 - 6 * m);
}

export {
  FADE_BEATS,
  makeGrid,
  gridFromAnalysis,
  beatPositionAt,
  trackMsAtBeat,
  localBpm,
  anchorStep,
  stepAt,
  hitPhase,
  fadePhase,
  motionAdvance,
};
