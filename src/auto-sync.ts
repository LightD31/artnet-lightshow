/**
 * Auto-sync: a known track's show, lined up with what the room hears.
 *
 * A playback source says where the track is, and most say it roughly: Spotify
 * polls, the OS media session rounds, a browser buffers — hundreds of
 * milliseconds either way, and different for every track. The manual sync
 * offset could only take out the average. With the live input listening, the
 * error can be measured instead:
 *
 *   - the live input keeps the last seconds of the audio's onset strength, a
 *     value every hop (see live-input.ts);
 *   - the track's analysis has its onsets, found offline on the same song;
 *   - the show's position says where in the track each of those hops should
 *     have been.
 *
 * Sliding one against the other, the lag at which they agree best is how far
 * the show is off. A steady beat agrees with itself one beat along, so a lag is
 * only taken when it clearly beats every other that is not the same beat, and
 * only once two measurements in a row agree on it. The correction is its own
 * term in the show's position (AutoShow.autoSyncMs), alongside the manual
 * offset, which is left to say how late the lights themselves are.
 */

import type { LiveEnvelopePoint } from './live-input.ts';

// The grid both signals are laid on, ms.
const STEP_MS = 10;
// How much of the live history is compared each time, and the least that is
// worth comparing.
const WINDOW_SEC = 16;
const MIN_WINDOW_SEC = 8;
// The furthest a source is taken to be off.
const MAX_LAG_MS = 1500;
// An analysed onset is spread over this much either side: a live onset lands
// within a hop or two of it.
const SIGMA_MS = 15;
// What a match has to reach to count, and how far ahead of the best other
// lag — one at least RUNNER_UP_GAP_MS away — it has to be.
const MIN_PEAK = 0.2;
const MIN_MARGIN = 0.06;
const RUNNER_UP_GAP_MS = 100;
// Two measurements this close agree.
const AGREE_MS = 30;
// Smaller corrections are noise, not error.
const DEADBAND_MS = 12;

/** Where the show is off, and how sure the measurement is. */
export interface SyncEstimate {
  /** Add this to the show's position to line it up; positive when the show is late. */
  offsetMs: number;
  /** The correlation at that lag, -1..1. */
  peak: number;
  /** How far it beat the best lag that is not the same beat. */
  margin: number;
}

/** The analysed onsets from `fromMs`, `n` steps long, each a Gaussian. */
function onsetTrain(onsetsSec: readonly number[], fromMs: number, n: number, stepMs = STEP_MS): Float64Array {
  const out = new Float64Array(n);
  const reach = Math.ceil((3 * SIGMA_MS) / stepMs);
  const toMs = fromMs + n * stepMs;
  for (const s of onsetsSec) {
    const ms = s * 1000;
    if (ms < fromMs - 3 * SIGMA_MS || ms > toMs + 3 * SIGMA_MS) continue;
    const centre = (ms - fromMs) / stepMs;
    const lo = Math.max(0, Math.floor(centre) - reach);
    const hi = Math.min(n - 1, Math.ceil(centre) + reach);
    for (let i = lo; i <= hi; i++) {
      const d = ((i - centre) * stepMs) / SIGMA_MS;
      out[i] += Math.exp(-0.5 * d * d);
    }
  }
  return out;
}

/**
 * The live onset strength on the analysis's grid: each hop placed where the
 * show says it was in the track, compressed so a few loud hits do not decide
 * everything, gaps filled from the hop before.
 */
function liveTrain(envelope: readonly LiveEnvelopePoint[], trackMsAt: (streamSec: number) => number,
  fromMs: number, n: number, stepMs = STEP_MS): Float64Array {
  const out = new Float64Array(n);
  const filled = new Uint8Array(n);
  for (const e of envelope) {
    const i = Math.round((trackMsAt(e.t) - fromMs) / stepMs);
    if (i < 0 || i >= n) continue;
    const v = Math.sqrt(Math.max(0, e.flux));
    if (!filled[i] || v > out[i]) out[i] = v;
    filled[i] = 1;
  }
  for (let i = 1; i < n; i++) if (!filled[i]) out[i] = out[i - 1];
  return out;
}

/**
 * The correlation of `a` with `b` shifted by each lag, -maxLag..maxLag steps:
 * r[k] compares a[i] with b[i + k + maxLag]. `b` is `a`'s length plus both
 * margins.
 */
function laggedCorrelation(a: Float64Array, b: Float64Array, maxLag: number): Float64Array {
  const n = a.length;
  let meanA = 0;
  for (let i = 0; i < n; i++) meanA += a[i];
  meanA /= n;
  let varA = 0;
  for (let i = 0; i < n; i++) varA += (a[i] - meanA) ** 2;
  const out = new Float64Array(2 * maxLag + 1);
  if (varA <= 0) return out;
  for (let k = 0; k <= 2 * maxLag; k++) {
    let meanB = 0;
    for (let i = 0; i < n; i++) meanB += b[i + k];
    meanB /= n;
    let cov = 0;
    let varB = 0;
    for (let i = 0; i < n; i++) {
      const db = b[i + k] - meanB;
      cov += (a[i] - meanA) * db;
      varB += db * db;
    }
    out[k] = varB > 0 ? cov / Math.sqrt(varA * varB) : 0;
  }
  return out;
}

/**
 * How far the show is off, from the live envelope and the track's onsets.
 * `trackMsAt(streamSec)` is where the show says the track was at a moment of
 * the live stream. Null when there is too little to compare.
 */
function estimateOffset({ envelope, onsets, trackMsAt, maxLagMs = MAX_LAG_MS }: {
  envelope: readonly LiveEnvelopePoint[];
  onsets: readonly number[];
  trackMsAt: (streamSec: number) => number;
  maxLagMs?: number;
}): SyncEstimate | null {
  if (envelope.length < 2 || onsets.length < 8) return null;
  const first = trackMsAt(envelope[0].t);
  const last = trackMsAt(envelope[envelope.length - 1].t);
  if (!(last - first >= MIN_WINDOW_SEC * 1000)) return null;
  const n = Math.floor((last - first) / STEP_MS) + 1;
  const maxLag = Math.round(maxLagMs / STEP_MS);
  const live = liveTrain(envelope, trackMsAt, first, n);
  const analysed = onsetTrain(onsets, first - maxLag * STEP_MS, n + 2 * maxLag);
  const r = laggedCorrelation(live, analysed, maxLag);

  let best = 0;
  for (let k = 1; k < r.length; k++) if (r[k] > r[best]) best = k;
  const gap = Math.round(RUNNER_UP_GAP_MS / STEP_MS);
  let runnerUp = -1;
  for (let k = 0; k < r.length; k++) {
    if (Math.abs(k - best) >= gap && r[k] > runnerUp) runnerUp = r[k];
  }
  return {
    offsetMs: (best - maxLag) * STEP_MS,
    peak: r[best],
    margin: r[best] - Math.max(0, runnerUp),
  };
}

/** What auto-sync reads and moves. */
export interface SyncedShow {
  running: boolean;
  getPositionMs(): number;
  adjustAutoSync(deltaMs: number): void;
  autoSyncMs: number;
  analysis: { onsets?: number[] | null } | null;
}

export interface SyncListener {
  streamNowMs(): number | null;
  recentEnvelope(seconds?: number): LiveEnvelopePoint[];
}

/** The measurement loop: call tick() about once a second. */
class AutoSync {
  declare _show: SyncedShow;
  declare _live: SyncListener;
  declare _enabled: () => boolean;
  declare _pending: number | null;
  declare _last: SyncEstimate | null;
  declare _applied: number;

  constructor({ show, live, enabled = () => true }: { show: SyncedShow; live: SyncListener; enabled?: () => boolean }) {
    this._show = show;
    this._live = live;
    this._enabled = enabled;
    this._pending = null;
    this._last = null;
    this._applied = 0;
  }

  /** Measure once, and correct the show when two measurements agree. */
  tick(): SyncEstimate | null {
    const show = this._show;
    const onsets = show.analysis && Array.isArray(show.analysis.onsets) ? show.analysis.onsets : null;
    if (!show.running || !onsets || !this._enabled()) { this._pending = null; return null; }
    const streamNow = this._live.streamNowMs();
    if (streamNow === null) { this._pending = null; return null; }
    const envelope = this._live.recentEnvelope(WINDOW_SEC);
    const posNow = show.getPositionMs();
    // The show runs at the track's own speed, so over a window this short the
    // position at any moment of the stream is the position now, less the time
    // since.
    const trackMsAt = (streamSec: number) => posNow - (streamNow - streamSec * 1000);
    const est = estimateOffset({ envelope, onsets, trackMsAt });
    this._last = est;
    if (!est || est.peak < MIN_PEAK || est.margin < MIN_MARGIN) { this._pending = null; return est; }
    if (this._pending !== null && Math.abs(est.offsetMs - this._pending) <= AGREE_MS) {
      const delta = (est.offsetMs + this._pending) / 2;
      this._pending = null;
      if (Math.abs(delta) >= DEADBAND_MS) {
        show.adjustAutoSync(delta);
        this._applied++;
      }
    } else {
      this._pending = est.offsetMs;
    }
    return est;
  }

  /** For the UI. */
  status(): { correctionMs: number; peak: number | null; corrections: number } {
    return {
      correctionMs: Math.round(this._show.autoSyncMs || 0),
      peak: this._last ? Math.round(this._last.peak * 100) / 100 : null,
      corrections: this._applied,
    };
  }
}

export { AutoSync, estimateOffset, onsetTrain, liveTrain, laggedCorrelation };
