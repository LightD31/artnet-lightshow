'use strict';

/**
 * Musical time: where in the music a moment falls, counted in beats.
 *
 * Every pattern used to keep its own time. The chase stepped on a setTimeout
 * grid that started whenever a patch happened to arrive and ran at a BPM
 * rounded to a whole number, so between two scene changes it drifted off the
 * music — about 75 ms every sixteen bars on a 123.7 BPM track — and the fade
 * and hit patterns integrated their own phases on top of that.
 *
 * Now there is one quantity, the beat position: a continuous number that is 0
 * on the first analysed beat, 1 on the second, 2.5 halfway between the third
 * and the fourth. It comes from the analysed beat grid when there is one, so
 * it follows a drummer who speeds up and a DJ who pitches the track, and every
 * pattern derives its step and its phase from it. Nothing accumulates, so
 * nothing can drift, and any moment can be computed directly — which is also
 * what lets the rehearsal preview land on exactly the step the rig will.
 *
 * Pure functions only: shared by the server engine and the browser preview.
 */

/** A fade breathes once every eight beats: two bars of four. */
const FADE_BEATS = 8;

// Numeric slack for float noise: 3 × (1/3) must still floor to 1.
const EPS = 1e-9;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * A beat grid ready for lookups, from beat times in seconds.
 *
 * Non-finite and out-of-order entries are dropped, and so is a beat that lands
 * on top of the previous one, which would otherwise be a zero-length beat. The
 * median interval is what the grid extrapolates with past either end. Returns
 * null for fewer than two usable beats: one beat has no tempo.
 */
function makeGrid(beatsSec) {
  if (!Array.isArray(beatsSec)) return null;
  const beats = [];
  for (const b of beatsSec) {
    const t = Number(b);
    if (!Number.isFinite(t)) continue;
    if (beats.length && t - beats[beats.length - 1] < 0.02) continue;
    beats.push(t);
  }
  if (beats.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < beats.length; i++) gaps.push(beats[i] - beats[i - 1]);
  return { beats, interval: median(gaps) };
}

/**
 * The grid for an analysis document: its beats, or — for a document that only
 * kept its downbeats — beats spread evenly across each bar.
 */
function gridFromAnalysis(analysis) {
  if (!analysis) return null;
  const direct = makeGrid(analysis.beats);
  if (direct) return direct;
  const downbeats = makeGrid(analysis.downbeats);
  if (!downbeats) return null;
  const meter = Math.max(1, Math.round(Number(analysis.meter) || 4));
  const beats = [];
  const d = downbeats.beats;
  for (let i = 0; i < d.length - 1; i++) {
    for (let k = 0; k < meter; k++) beats.push(d[i] + ((d[i + 1] - d[i]) * k) / meter);
  }
  beats.push(d[d.length - 1]);
  return makeGrid(beats);
}

/**
 * The beat position at a track time, in milliseconds.
 *
 * Linear between neighbouring beats, so it moves at exactly the local tempo;
 * before the first beat and after the last it carries on at the median
 * interval, so it never stalls or runs backwards at either end of a track.
 */
function beatPositionAt(grid, tMs) {
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

/** The track time, in milliseconds, of a beat position. The inverse of beatPositionAt. */
function trackMsAtBeat(grid, beatPos) {
  if (!grid) return null;
  const b = grid.beats;
  const n = b.length;
  if (beatPos <= 0) return (b[0] + beatPos * grid.interval) * 1000;
  if (beatPos >= n - 1) return (b[n - 1] + (beatPos - (n - 1)) * grid.interval) * 1000;
  const i = Math.floor(beatPos);
  return (b[i] + (beatPos - i) * (b[i + 1] - b[i])) * 1000;
}

/**
 * The tempo at a track time, from the beats around it: the median of the
 * nearest few intervals, so a single misplaced beat does not make the BPM
 * read-out jump.
 */
function localBpm(grid, tMs) {
  if (!grid) return null;
  const b = grid.beats;
  const at = Math.max(0, Math.min(b.length - 2, Math.floor(beatPositionAt(grid, tMs))));
  const gaps = [];
  for (let i = Math.max(0, at - 2); i <= Math.min(b.length - 2, at + 2); i++) gaps.push(b[i + 1] - b[i]);
  const gap = median(gaps) || grid.interval;
  return 60 / gap;
}

/**
 * Where a pattern starts counting its steps, on the step grid.
 *
 * Rounded rather than floored: a scene is placed on a downbeat and fires a
 * frame or so after it, and a scene that fired 10 ms late must still start on
 * step 0 of that beat, not wait for the next one.
 */
function anchorStep(beatPos, division = 1) {
  return Math.round(beatPos * Math.max(1, division));
}

/** The step a pattern is on: how many steps of the grid since its anchor. */
function stepAt(beatPos, anchor, division = 1) {
  return Math.max(0, Math.floor(beatPos * Math.max(1, division) + EPS) - anchor);
}

/** How far through its current step the beat position is, 0..1. */
function hitPhase(beatPos, division = 1) {
  const x = beatPos * Math.max(1, division);
  return Math.max(0, Math.min(1, x - Math.floor(x + EPS)));
}

/**
 * Where `fade` is in its eight-beat breath, 0..1, counted from the pattern's
 * anchor — so a fade starts from its trough when its scene starts, as it
 * always has.
 */
function fadePhase(beatPos, anchor = 0, division = 1) {
  const since = beatPos - anchor / Math.max(1, division);
  const p = (since / FADE_BEATS) % 1;
  return p < 0 ? p + 1 : p;
}

/**
 * How far the expressive patterns travel across the rig in `dBeats` beats.
 * One crossing takes eight beats when the music is barely moving and two when
 * it is driving — the same speeds as before, now counted in beats rather than
 * in seconds at a remembered BPM.
 */
function motionAdvance(dBeats, motion = 0.3) {
  const m = Math.max(0, Math.min(1, Number.isFinite(motion) ? motion : 0.3));
  return Math.max(0, dBeats) / (8 - 6 * m);
}

module.exports = {
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
