"""
Stage 4 — onsets, tempo, beats, bars, downbeats.

The old engine thresholded energy and called the crossings beats. That fails in
the two places it matters most: it finds beats in a sustained pad, and it loses
them the moment a track ducks the kick for a bar. This stage instead follows
the standard MIR chain —

    onset envelope  ->  tempo  ->  beat grid  ->  metre  ->  downbeats

— where each step constrains the next, so a missing kick costs a *confidence*
rather than a lost beat, and the grid keeps running through a breakdown.

Three things here are worth calling out as deliberate:

* Tempo is chosen with a log-normal prior around 120 BPM. Autocorrelation is
  fundamentally ambiguous between a tempo and its double, and every "the show
  ran at half speed" bug is that ambiguity resolved the wrong way. The prior is
  the standard fix and it is why the tempo curve below is clamped to the global
  estimate rather than trusted frame by frame.

* Beat confidence is per beat, not per track. A show that knows *which* beats
  it is sure of can accent those and let the rest pass, which is exactly what a
  human operator does when the mix gets muddy.

* Downbeats are found by scoring every (metre, phase) hypothesis against the
  low end, the spectral novelty and the harmonic change, rather than by
  assuming beat one is the loudest. Beat one is often *not* the loudest — in
  most dance music the loudest beat is wherever the snare is.
"""

from dataclasses import dataclass, field

import numpy as np

from . import dsp
from .config import RhythmConfig


@dataclass
class Rhythm:
    bpm: float = 120.0
    #: 0..1 — how steady the tempo is across the track.
    stability: float = 1.0
    #: Which tracker produced the grid: 'dp' or 'plp'.
    source: str = 'dp'
    beats: np.ndarray = field(default_factory=lambda: np.zeros(0))
    #: Per-beat 0..1 strength (normalised onset energy at the beat).
    strengths: np.ndarray = field(default_factory=lambda: np.zeros(0))
    #: Per-beat 0..1 confidence (strength × how well it fits the grid).
    confidences: np.ndarray = field(default_factory=lambda: np.zeros(0))
    onsets: np.ndarray = field(default_factory=lambda: np.zeros(0))
    onset_strengths: np.ndarray = field(default_factory=lambda: np.zeros(0))
    downbeats: np.ndarray = field(default_factory=lambda: np.zeros(0))
    #: Index into `beats` of each downbeat.
    downbeat_indices: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=int))
    meter: int = 4
    downbeat_confidence: float = 0.0
    #: Local tempo over time as (times, bpm).
    tempo_times: np.ndarray = field(default_factory=lambda: np.zeros(0))
    tempo_values: np.ndarray = field(default_factory=lambda: np.zeros(0))
    #: 0..1 curve on the frame grid: how much rhythmic activity is happening.
    intensity: np.ndarray = field(default_factory=lambda: np.zeros(0))

    @property
    def beat_period(self):
        if self.beats.size < 2:
            return 60.0 / max(1e-6, self.bpm)
        return float(np.median(np.diff(self.beats)))

    @property
    def bar_period(self):
        return self.beat_period * self.meter

    def phase_at(self, t):
        """Position within the current bar at time `t`, as 0..1. -1 when the
        grid has not been established."""
        if self.downbeats.size == 0:
            return -1.0
        i = int(np.searchsorted(self.downbeats, t, side='right')) - 1
        if i < 0:
            return -1.0
        start = self.downbeats[i]
        end = self.downbeats[i + 1] if i + 1 < self.downbeats.size else start + self.bar_period
        span = max(1e-6, end - start)
        return float(np.clip((t - start) / span, 0.0, 1.0))


# ── Tempo ───────────────────────────────────────────────────────────────────

def tempo_prior(bpms, centre, std):
    """
    Log-normal weight over candidate tempi. Perceived tempo clusters around
    120 BPM on a log scale; this is the weighting Klapuri and later librosa use
    to break the octave tie in favour of what a listener would tap.
    """
    bpms = np.asarray(bpms, dtype=float)
    weights = np.zeros_like(bpms)
    valid = bpms > 0
    weights[valid] = np.exp(
        -0.5 * ((np.log2(bpms[valid]) - np.log2(centre)) / std) ** 2)
    return weights


def pulse_score(onset_envelope, lag_frames, window=1, pulses_per_window=12):
    """
    How well a pulse train at `lag_frames` explains the onset envelope.
    Returns (score, phase_frames) where the phase is the best one in the first
    window.

    This is the step that resolves the ambiguities autocorrelation cannot.
    Autocorrelation asks "does the signal look like itself a beat later", which
    a hi-hat pattern answers yes to at every subdivision. A pulse train asks the
    better question: "if I put a light on every one of these instants, how much
    of the music do I hit, and how much of what I hit is loud?"

    Two terms, multiplied, because either alone picks the wrong answer:

      precision  mean envelope at the pulses over the overall mean. High when
                 the pulses land on transients — but a pulse train at half the
                 tempo scores just as well, since it lands on every other kick.
      recall     share of the envelope's total energy that falls near a pulse.
                 This is what half tempo cannot fake: it misses half the beats,
                 so it captures about half the energy.

    Scored over short windows and averaged, not over the whole track at once.
    A candidate lag is only accurate to a fraction of a frame, and over a
    three-minute track that error accumulates into hundreds of milliseconds of
    walk-off — which would score the *correct* tempo worse than a wrong one
    that happens to be closer to an exact number of frames. Re-phasing every
    dozen pulses measures the fit rather than the rounding.
    """
    env = np.asarray(onset_envelope, dtype=float)
    n = env.size
    if n < 8 or lag_frames <= 1:
        return 0.0, 0.0
    overall = float(np.mean(env))
    if overall <= 1e-9:
        return 0.0, 0.0

    step = float(lag_frames)
    span = max(8, int(round(step * pulses_per_window)))
    offsets = np.arange(-window, window + 1)

    scores, first_phase = [], 0.0
    for start in range(0, n, span):
        stop = min(n, start + span)
        segment = env[start:stop]
        if segment.size < step * 4:
            break
        seg_mean = float(np.mean(segment))
        seg_total = float(np.sum(segment))
        if seg_mean <= 1e-9 or seg_total <= 1e-9:
            continue
        count = int((segment.size - 1) // step) + 1
        best = (0.0, 0.0)
        for phase in range(max(1, int(round(step)))):
            centres = np.round(phase + np.arange(count) * step).astype(int)
            centres = centres[(centres >= 0) & (centres < segment.size)]
            if centres.size < 3:
                continue
            precision = float(np.mean(segment[centres])) / seg_mean
            covered = np.unique(np.clip(centres[:, None] + offsets[None, :],
                                        0, segment.size - 1))
            recall = float(np.sum(segment[covered])) / seg_total
            value = precision * recall
            if value > best[0]:
                best = (value, float(phase))
        if best[0] > 0:
            scores.append(best[0])
            if not scores[:-1]:
                first_phase = best[1]

    if not scores:
        return 0.0, 0.0
    return float(np.mean(scores)), first_phase


def estimate_tempo(onset_envelope, sr, hop_length, config: RhythmConfig):
    """
    Global tempo from the onset autocorrelation, weighted by the tempo prior,
    then re-ranked by how well each surviving candidate's pulse train actually
    lands on the music.

    Returns (bpm, confidence).
    """
    env = np.asarray(onset_envelope, dtype=float)
    if env.size < 16:
        return config.tempo_prior_bpm, 0.0

    frame_rate = sr / float(hop_length)
    max_lag = int(frame_rate * 60.0 / max(1.0, config.tempo_min * 0.5))
    ac = dsp.autocorrelation(env, max_lag=min(max_lag, env.size - 1))
    lags = np.arange(ac.size)
    with np.errstate(divide='ignore'):
        bpms = np.where(lags > 0, 60.0 * frame_rate / np.maximum(lags, 1), 0.0)

    in_range = (bpms >= config.tempo_min) & (bpms <= config.tempo_max)
    if not np.any(in_range):
        return config.tempo_prior_bpm, 0.0

    score = np.zeros_like(ac)
    score[in_range] = np.maximum(ac[in_range], 0.0) * tempo_prior(
        bpms[in_range], config.tempo_prior_bpm, config.tempo_prior_std)

    # Reinforce each candidate with its own harmonics: a true beat period also
    # shows a peak at 2× and 3× the lag. This is what stops a strong eighth-note
    # hat pattern from winning over the quarter-note pulse it sits on.
    reinforced = score.copy()
    for multiple in (2, 3, 4):
        idx = lags * multiple
        valid = idx < ac.size
        reinforced[valid] += 0.5 / multiple * np.maximum(ac[idx[valid]], 0.0) * \
            (score[valid] > 0)

    if not np.any(reinforced > 0):
        return config.tempo_prior_bpm, 0.0

    # Re-rank the strongest handful of candidates by pulse-train fit. Ten is
    # enough to hold the true tempo plus its half, double, and the 3:2 relative
    # that trips up triple metre, without paying for a full search.
    candidates = np.argsort(reinforced)[::-1][:10]
    candidates = [int(c) for c in candidates if reinforced[c] > 0 and c > 0]
    if not candidates:
        return config.tempo_prior_bpm, 0.0

    ranked = []
    for lag_idx in candidates:
        lag = _refine_peak(reinforced, lag_idx)
        if lag <= 0:
            continue
        bpm = 60.0 * frame_rate / lag
        if not (config.tempo_min <= bpm <= config.tempo_max):
            continue
        fit, _phase = pulse_score(env, lag)
        prior = float(tempo_prior([bpm], config.tempo_prior_bpm,
                                  config.tempo_prior_std)[0])
        # Autocorrelation contributes, but the pulse fit decides: the two
        # disagree exactly where autocorrelation is known to be wrong.
        ranked.append((fit * prior + 0.25 * float(reinforced[lag_idx]), bpm, fit))

    if not ranked:
        return config.tempo_prior_bpm, 0.0

    ranked.sort(reverse=True)
    top_score, bpm, fit = ranked[0]
    runner_up = ranked[1][0] if len(ranked) > 1 else 0.0
    margin = (top_score - runner_up) / (top_score + 1e-9)
    confidence = dsp.clamp01(0.5 * margin + 0.5 * dsp.clamp01((fit - 1.0) / 1.5))
    return float(bpm), float(confidence)


def _refine_peak(values, index):
    """Sub-sample peak position by fitting a parabola to the three points
    around `index`. Returns the interpolated index."""
    if index <= 0 or index >= len(values) - 1:
        return float(index)
    y0, y1, y2 = float(values[index - 1]), float(values[index]), float(values[index + 1])
    denom = y0 - 2.0 * y1 + y2
    if abs(denom) < 1e-12:
        return float(index)
    offset = 0.5 * (y0 - y2) / denom
    if not np.isfinite(offset) or abs(offset) > 1.0:
        return float(index)
    return float(index) + offset


def snap_beats_to_onsets(beat_times, onset_times, tolerance_sec):
    """
    Pull each beat onto the nearest detected onset when one is close enough.

    The DP tracker returns a perfectly regular grid, which is right about the
    tempo and about a frame out on the phase — and one frame is 23 ms, which is
    the difference between a cue landing on the kick and landing just after it.
    Onsets are where the transients actually are, so where an onset agrees with
    the grid to within a tolerance, it wins. Beats with no onset nearby (a
    ducked kick, a rest) keep the grid's own timing, so the phase never breaks.
    """
    beats = np.asarray(beat_times, dtype=float)
    onsets = np.asarray(onset_times, dtype=float)
    if beats.size == 0 or onsets.size == 0 or tolerance_sec <= 0:
        return beats
    snapped = beats.copy()
    idx = np.clip(np.searchsorted(onsets, beats), 0, onsets.size - 1)
    for i, beat in enumerate(beats):
        j = int(idx[i])
        candidates = [onsets[k] for k in (j - 1, j, j + 1) if 0 <= k < onsets.size]
        if not candidates:
            continue
        nearest = min(candidates, key=lambda o: abs(o - beat))
        if abs(nearest - beat) <= tolerance_sec:
            snapped[i] = nearest
    # Snapping must never reorder the grid.
    return np.maximum.accumulate(snapped)


def refine_period(beat_times):
    """
    Least-squares beat period from the whole grid, in seconds.

    Beat times land on STFT frames, so the interval between two of them is
    quantised to ~23 ms — at 140 BPM that is 3.5 BPM of error in the median
    interval alone, and the show's beat clock inherits it. Fitting a line
    through *every* beat recovers the sub-frame period, because the rounding
    pattern across a hundred beats carries the fraction the individual
    intervals throw away.

    Returns (period_seconds, r_squared). A low r² means the tempo is not
    constant and the caller should keep the local estimate instead.
    """
    beats = np.asarray(beat_times, dtype=float)
    if beats.size < 8:
        return 0.0, 0.0
    index = np.arange(beats.size, dtype=float)
    slope, intercept = np.polyfit(index, beats, 1)
    predicted = slope * index + intercept
    residual = float(np.sum((beats - predicted) ** 2))
    variance = float(np.sum((beats - np.mean(beats)) ** 2))
    r2 = 1.0 - residual / variance if variance > 1e-12 else 0.0
    return float(slope), float(max(0.0, r2))


def fine_onsets(percussive, sr, n_fft=512, hop_length=128, delta=0.10,
                min_gap_sec=0.03):
    """
    Onsets on a high-resolution grid, used to fix the *phase* of the beat grid.

    Tempo tracking wants a long window — it is measuring a periodicity of
    hundreds of milliseconds and a short window just adds noise. Phase wants
    the opposite: a 2048-sample window at 22 kHz smears a transient across
    93 ms and reports its onset around 25 ms late, every time, which is a
    systematic quarter-frame of DMX latency on every cue in the show. A 512
    sample window puts the same onsets within about 5 ms.

    Returns (times, strengths).
    """
    import librosa
    try:
        env = librosa.onset.onset_strength(
            y=percussive, sr=sr, n_fft=n_fft, hop_length=hop_length)
    except Exception:
        return np.zeros(0), np.zeros(0)
    if env.size == 0:
        return np.zeros(0), np.zeros(0)
    frame_rate = sr / float(hop_length)
    idx = dsp.adaptive_peaks(
        env, pre=int(frame_rate), post=int(frame_rate), delta=delta,
        wait=max(1, int(min_gap_sec * frame_rate)))
    if idx.size == 0:
        return np.zeros(0), np.zeros(0)
    return idx * (hop_length / float(sr)), dsp.robust_norm(env)[idx]


def tempo_curve(onset_envelope, sr, hop_length, global_bpm, config: RhythmConfig):
    """
    Local tempo over time, constrained to ±15 % of the global estimate.

    Unconstrained, the dominant tempogram bin hops between 1×, 2× and 3× from
    one window to the next, and a show that follows it changes its beat clock
    every few seconds for no musical reason. The constraint means this curve can
    only ever describe genuine drift.
    """
    import librosa

    env = np.asarray(onset_envelope, dtype=float)
    if env.size < 32:
        return np.zeros(0), np.zeros(0), 1.0

    try:
        tempogram = librosa.feature.tempogram(
            onset_envelope=env, sr=sr, hop_length=hop_length)
        tg_bpms = librosa.tempo_frequencies(tempogram.shape[0], sr=sr,
                                            hop_length=hop_length)
    except Exception:
        return np.zeros(0), np.zeros(0), 1.0

    lo, hi = global_bpm * 0.85, global_bpm * 1.15
    valid = np.isfinite(tg_bpms) & (tg_bpms >= lo) & (tg_bpms <= hi)
    if not np.any(valid):
        valid = np.isfinite(tg_bpms) & (tg_bpms >= config.tempo_min) & \
            (tg_bpms <= config.tempo_max)
    if not np.any(valid):
        return np.zeros(0), np.zeros(0), 1.0

    idx = np.flatnonzero(valid)
    dominant = tg_bpms[idx[np.argmax(tempogram[idx], axis=0)]]
    frame_rate = sr / float(hop_length)
    dominant = dsp.median_smooth(dominant, int(round(2.0 * frame_rate)))
    times = dsp.frames_to_times(dominant.size, sr, hop_length)
    return times, dominant, _stability(dominant)


def _stability(values):
    """
    1.0 when the tempo never moves, falling towards 0 as it wanders.

    Measured as the fraction of the track spent within 3 % of the median tempo,
    blended with the spread — a track that sits at 128 and then sits at 140 is
    less stable than one that sits at 128 throughout, even though neither is
    noisy frame to frame.
    """
    values = np.asarray(values, dtype=float)
    values = values[np.isfinite(values) & (values > 0)]
    if values.size < 4:
        return 1.0
    median = float(np.median(values))
    if median <= 0:
        return 1.0
    within = float(np.mean(np.abs(values - median) / median < 0.03))
    spread = float(np.std(values) / median)
    return dsp.clamp01(0.6 * within + 0.4 * np.exp(-6.0 * spread))


# ── Beats ───────────────────────────────────────────────────────────────────

def track_beats(percussive, onset_envelope, sr, hop_length, bpm, config: RhythmConfig):
    """Dynamic-programming beat tracking, seeded with our own tempo estimate."""
    import librosa
    try:
        _, frames = librosa.beat.beat_track(
            onset_envelope=onset_envelope, sr=sr, hop_length=hop_length,
            start_bpm=bpm, tightness=config.beat_tightness, trim=False)
        return np.asarray(frames, dtype=int)
    except Exception:
        return np.zeros(0, dtype=int)


def plp_beats(onset_envelope, sr, hop_length, config: RhythmConfig):
    """
    Predominant-local-pulse beats — a phase-continuous pulse that follows tempo
    drift instead of assuming a constant one. Used when the tempo curve says the
    track genuinely accelerates (live recordings, orchestral, DJ pitch rides).
    """
    import librosa
    try:
        pulse = librosa.beat.plp(
            onset_envelope=onset_envelope, sr=sr, hop_length=hop_length,
            tempo_min=config.tempo_min, tempo_max=config.tempo_max)
        return np.flatnonzero(librosa.util.localmax(pulse))
    except Exception:
        return np.zeros(0, dtype=int)


def beat_strengths(onset_envelope, beat_frames):
    """
    Per-beat onset energy, normalised against the track's own 95th percentile.

    Aggregated with a max over the beat's frame window rather than sampled at
    the frame itself: a beat marker is accurate to a frame or two, and sampling
    a single frame of a sharp transient misses it about half the time.
    """
    env = np.asarray(onset_envelope, dtype=float)
    frames = np.asarray(beat_frames, dtype=int)
    if env.size == 0 or frames.size == 0:
        return np.zeros(frames.size)
    half = max(1, int(np.median(np.diff(frames)) // 3)) if frames.size > 1 else 2
    values = np.zeros(frames.size)
    for i, f in enumerate(frames):
        window = env[max(0, int(f) - half):min(env.size, int(f) + half + 1)]
        values[i] = float(np.max(window)) if window.size else 0.0
    ref = float(np.percentile(values, 95)) if values.size else 0.0
    if ref <= 1e-9:
        ref = float(np.max(values)) if values.size and np.max(values) > 0 else 1.0
    return np.clip(values / ref, 0.0, 1.0)


def beat_confidences(beat_times, strengths):
    """
    Blend each beat's onset strength with how regular its spacing is.

    A strong hit that lands off the grid is a fill, not a beat; a weak beat that
    lands exactly where the grid predicted is still a beat, and the show can
    keep counting through it. Both facts have to be in one number for the show
    engine to be able to ask "should I accent this".
    """
    times = np.asarray(beat_times, dtype=float)
    strengths = np.asarray(strengths, dtype=float)
    if times.size < 3:
        return strengths.copy()
    intervals = np.diff(times)
    median = float(np.median(intervals)) if intervals.size else 0.0
    if median <= 0:
        return strengths.copy()
    # Deviation of the interval *into* each beat, as a fraction of the median.
    deviation = np.concatenate([[0.0], np.abs(intervals - median) / median])
    regularity = np.exp(-4.0 * deviation)
    n = min(times.size, strengths.size, regularity.size)
    return np.clip(0.6 * strengths[:n] + 0.4 * regularity[:n], 0.0, 1.0)


# ── Metre and downbeats ─────────────────────────────────────────────────────

def estimate_downbeats(beat_times, strengths, features, config: RhythmConfig):
    """
    Score every (metre, phase) hypothesis and keep the best.

    Three pieces of evidence, because no single one is reliable on its own:

      low-end energy   bar one usually lands on a kick — but not in tracks that
                       drop the kick for a bar, and not in half-time sections
      spectral novelty something new tends to start on the bar
      harmonic change  chord changes overwhelmingly land on the downbeat, and
                       this is the one cue that survives a kick-less bar

    Returns (downbeat_times, indices, metre, confidence).
    """
    beats = np.asarray(beat_times, dtype=float)
    if beats.size < 8:
        return np.zeros(0), np.zeros(0, dtype=int), 4, 0.0

    strengths = np.asarray(strengths, dtype=float)
    if strengths.size != beats.size:
        strengths = np.ones(beats.size)

    low_energy = _sample_at(features.times, _low_band(features), beats)
    novelty = _sample_at(features.times, dsp.robust_norm(features.flux), beats)
    harmonic = _sample_at(features.times, _chroma_change(features), beats)

    evidence = (0.40 * dsp.unit_norm(low_energy)
                + 0.25 * dsp.unit_norm(novelty)
                + 0.35 * dsp.unit_norm(harmonic))

    best = None
    for meter in config.meters:
        if beats.size < meter * 3:
            continue
        for phase in range(meter):
            idx = np.arange(phase, beats.size, meter)
            if idx.size < 3:
                continue
            on = float(np.mean(evidence[idx]))
            off_mask = np.ones(beats.size, dtype=bool)
            off_mask[idx] = False
            off = float(np.mean(evidence[off_mask])) if np.any(off_mask) else 0.0
            # Prefer 4/4 slightly: it is overwhelmingly more common, and a 3/4
            # hypothesis fits a 4/4 track's every-third-beat pattern often
            # enough to win a close contest on noise alone.
            bias = 1.0 if meter == 4 else 0.94
            score = (on - off) * bias
            if best is None or score > best[0]:
                best = (score, meter, phase, on, off)

    if best is None:
        return np.zeros(0), np.zeros(0, dtype=int), 4, 0.0

    score, meter, phase, on, off = best
    indices = np.arange(phase, beats.size, meter)
    total = on + off
    confidence = dsp.clamp01((on - off) / total * 2.0) if total > 1e-9 else 0.0
    return beats[indices], indices, meter, confidence


def _low_band(features):
    mask = (features.frequencies >= 30) & (features.frequencies < 160)
    if not np.any(mask):
        return np.zeros(features.n_frames)
    return dsp.robust_norm(np.sqrt(np.mean(features.magnitude[mask] ** 2, axis=0)))


def _chroma_change(features):
    """Cosine distance between successive chroma frames, smoothed."""
    c = features.chroma
    if c.size == 0 or c.shape[1] < 3:
        return np.zeros(features.n_frames)
    norm = np.linalg.norm(c, axis=0) + 1e-9
    unit = c / norm
    cos = np.sum(unit[:, 1:] * unit[:, :-1], axis=0)
    change = np.concatenate([[0.0], 1.0 - cos])
    return dsp.robust_norm(dsp.moving_average(change, 3))


def _sample_at(times, values, targets):
    times = np.asarray(times, dtype=float)
    values = np.asarray(values, dtype=float)
    if times.size == 0 or values.size == 0:
        return np.zeros(len(targets))
    n = min(times.size, values.size)
    idx = np.clip(np.searchsorted(times[:n], targets), 0, n - 1)
    return values[idx]


# ── Rhythmic intensity ──────────────────────────────────────────────────────

def rhythmic_intensity(features, beat_times, window_sec=2.0):
    """
    0..1 curve: how *busy* the rhythm is, independent of how loud it is.

    Onset density and onset strength, both smoothed over a couple of seconds.
    This is what tells a show the difference between a loud sustained chord and
    a loud drum fill — they have the same energy and want completely different
    lighting.
    """
    if features.n_frames == 0:
        return np.zeros(0)
    env = dsp.robust_norm(features.percussive_onset)
    width = max(3, int(window_sec * features.frame_rate))
    density = dsp.moving_average(env, width)
    peaks = np.zeros(features.n_frames)
    idx = dsp.adaptive_peaks(env, pre=int(features.frame_rate),
                             post=int(features.frame_rate), delta=0.3,
                             wait=max(1, int(features.frame_rate * 0.05)))
    if idx.size:
        peaks[idx] = 1.0
    rate = dsp.moving_average(peaks, width)
    return dsp.robust_norm(0.6 * dsp.unit_norm(density) + 0.4 * dsp.unit_norm(rate))


# ── Entry point ─────────────────────────────────────────────────────────────

def analyse(audio, features, config: RhythmConfig = None) -> Rhythm:
    import librosa

    config = config or RhythmConfig()
    sr, hop = features.sample_rate, features.hop_length

    # The rhythm stage reads the gain-levelled signal: a quiet intro should
    # give up its beats as readily as the chorus does.
    try:
        levelled_onset = librosa.onset.onset_strength(
            y=audio.levelled, sr=sr, hop_length=hop)
    except Exception:
        levelled_onset = features.percussive_onset

    n = min(levelled_onset.size, features.n_frames) or features.n_frames
    onset_env = np.zeros(features.n_frames)
    blend_len = min(n, features.percussive_onset.size)
    if blend_len:
        onset_env[:blend_len] = (0.6 * dsp.robust_norm(features.percussive_onset[:blend_len])
                                 + 0.4 * dsp.robust_norm(levelled_onset[:blend_len]))

    bpm, tempo_conf = estimate_tempo(onset_env, sr, hop, config)
    t_times, t_values, stability = tempo_curve(onset_env, sr, hop, bpm, config)

    frames = track_beats(audio.percussive, onset_env, sr, hop, bpm, config)
    source = 'dp'
    if stability < config.plp_stability_threshold:
        alt = plp_beats(onset_env, sr, hop, config)
        if alt.size > 4:
            frames, source = alt, 'plp'

    beats = librosa.frames_to_time(frames, sr=sr, hop_length=hop) if frames.size \
        else np.zeros(0)
    # The grid, not the seed, is the answer. `estimate_tempo` picks the octave
    # and gets the tracker started; the median interval of the beats it then
    # laid down is the tempo the show should run at, and reporting the seed
    # instead is how a correct grid ends up labelled with the wrong BPM.
    if beats.size > 4:
        period = float(np.median(np.diff(beats)))
        fitted, r2 = refine_period(beats)
        # A tight linear fit means the grid really is constant-tempo, and the
        # fitted slope is the better number. A loose one means the track moves,
        # and the median interval is the honest summary.
        if r2 > 0.999 and fitted > 0:
            period = fitted
        if period > 0 and config.tempo_min <= 60.0 / period <= config.tempo_max:
            bpm = 60.0 / period

    strengths = beat_strengths(onset_env, frames)

    onsets, onset_strengths = fine_onsets(
        audio.percussive, sr, delta=config.onset_delta,
        min_gap_sec=config.onset_min_gap_sec)
    if onsets.size == 0:
        onset_idx = dsp.adaptive_peaks(
            onset_env,
            pre=int(features.frame_rate), post=int(features.frame_rate),
            delta=config.onset_delta,
            wait=max(1, int(config.onset_min_gap_sec * features.frame_rate)))
        onsets = features.times[onset_idx] if onset_idx.size else np.zeros(0)
        onset_strengths = dsp.robust_norm(onset_env)[onset_idx] if onset_idx.size \
            else np.zeros(0)

    # Phase refinement, capped at a fifth of a beat so a stray onset can never
    # drag a beat onto a neighbouring subdivision.
    period = float(np.median(np.diff(beats))) if beats.size > 1 else 0.0
    if period > 0:
        beats = snap_beats_to_onsets(beats, onsets, tolerance_sec=period * 0.2)
    confidences = beat_confidences(beats, strengths)

    downbeats, db_idx, meter, db_conf = estimate_downbeats(
        beats, strengths, features, config)

    return Rhythm(
        bpm=float(bpm),
        stability=float(stability),
        source=source,
        beats=beats,
        strengths=strengths,
        confidences=confidences,
        onsets=onsets,
        onset_strengths=onset_strengths,
        downbeats=downbeats,
        downbeat_indices=db_idx,
        meter=int(meter),
        downbeat_confidence=float(db_conf),
        tempo_times=t_times,
        tempo_values=t_values,
        intensity=rhythmic_intensity(features, beats),
    )
