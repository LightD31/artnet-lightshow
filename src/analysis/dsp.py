"""
Small numeric primitives shared by the analysis stages.

Nothing here knows about music. Everything here is pure: same input, same
output, no globals, no I/O — which is what makes the stages above testable
with synthetic signals.
"""

import numpy as np


# ── Normalisation ───────────────────────────────────────────────────────────

def robust_norm(arr, percentile=95.0, floor_percentile=5.0):
    """
    Scale to 0..1 against the signal's own percentiles rather than its min and
    max. One cymbal crash at +12 dB would otherwise push the entire rest of the
    track into the bottom fifth of the range, and every threshold downstream
    would then be measuring the crash instead of the music.
    """
    arr = np.asarray(arr, dtype=float)
    if arr.size == 0:
        return arr
    lo = float(np.percentile(arr, floor_percentile))
    hi = float(np.percentile(arr, percentile))
    if not np.isfinite(lo) or not np.isfinite(hi) or hi - lo < 1e-9:
        peak = float(np.max(np.abs(arr))) if arr.size else 0.0
        if peak < 1e-9:
            return np.zeros_like(arr)
        return np.clip(arr / peak, 0.0, 1.0)
    return np.clip((arr - lo) / (hi - lo), 0.0, 1.0)


def unit_norm(arr):
    """Scale to 0..1 against min/max. For features that have no outliers."""
    arr = np.asarray(arr, dtype=float)
    if arr.size == 0:
        return arr
    lo, hi = float(np.min(arr)), float(np.max(arr))
    if hi - lo < 1e-12:
        return np.zeros_like(arr)
    return (arr - lo) / (hi - lo)


def safe_div(a, b, default=0.0):
    """Element-wise a/b with zeros where b is ~0, instead of inf/nan."""
    a = np.asarray(a, dtype=float)
    b = np.asarray(b, dtype=float)
    out = np.full(np.broadcast(a, b).shape, float(default))
    np.divide(a, b, out=out, where=np.abs(b) > 1e-12)
    return out


# ── Smoothing ───────────────────────────────────────────────────────────────

def moving_average(x, width):
    """Centred box filter with edge-preserving ends. `width` in samples."""
    x = np.asarray(x, dtype=float)
    width = max(1, int(width))
    if width <= 1 or x.size == 0:
        return x.copy()
    pad = width // 2
    padded = np.pad(x, (pad, pad), mode='edge')
    kernel = np.ones(width) / width
    return np.convolve(padded, kernel, mode='valid')[:x.size]


def median_smooth(x, width):
    """Median filter. Kills single-frame spikes without rounding real edges."""
    x = np.asarray(x, dtype=float)
    width = max(1, int(width) | 1)  # odd
    if width <= 1 or x.size == 0:
        return x.copy()
    try:
        from scipy.ndimage import median_filter
        return median_filter(x, size=width, mode='nearest')
    except Exception:
        pad = width // 2
        padded = np.pad(x, (pad, pad), mode='edge')
        strided = np.lib.stride_tricks.sliding_window_view(padded, width)
        return np.median(strided, axis=-1)


def envelope_follower(x, attack_frames, release_frames):
    """
    Asymmetric one-pole follower — the same thing a compressor's detector does.
    Rises in `attack_frames`, falls in `release_frames`. Used to measure how
    percussive a band is: a kick has a short attack and a short release, a pad
    has a long attack and a very long release.
    """
    x = np.asarray(x, dtype=float)
    if x.size == 0:
        return x.copy()
    a_att = np.exp(-1.0 / max(1e-6, float(attack_frames)))
    a_rel = np.exp(-1.0 / max(1e-6, float(release_frames)))
    out = np.empty_like(x)
    y = float(x[0])
    for i, v in enumerate(x):
        coeff = a_att if v > y else a_rel
        y = coeff * y + (1.0 - coeff) * v
        out[i] = y
    return out


# ── Peak picking ────────────────────────────────────────────────────────────

def adaptive_peaks(x, pre=30, post=30, delta=0.07, wait=10, floor_ratio=0.02):
    """
    Local-maximum picking against an adaptive threshold (median + delta*std of
    a sliding window). This is the standard onset peak-picker; a fixed
    threshold cannot work because a track's dynamic range moves under it.

    `floor_ratio` is the one absolute rule on top: a peak must also clear this
    fraction of the signal's own maximum. Without it a silent passage — where
    the local median and standard deviation are both zero — reports a peak on
    every frame, and the show fires a cue per frame through the quiet part.

    Returns integer indices.
    """
    x = np.asarray(x, dtype=float)
    n = x.size
    if n == 0:
        return np.array([], dtype=int)
    global_floor = floor_ratio * float(np.max(x)) if np.max(x) > 0 else 0.0
    peaks = []
    last = -10 ** 9
    for i in range(n):
        if x[i] <= global_floor:
            continue
        lo = max(0, i - pre)
        hi = min(n, i + post + 1)
        window = x[lo:hi]
        thresh = float(np.median(window)) + delta * float(np.std(window))
        if x[i] <= thresh:
            continue
        if i > 0 and x[i] < x[i - 1]:
            continue
        if i + 1 < n and x[i] < x[i + 1]:
            continue
        if i - last < wait:
            # Keep the taller of the two when they collide.
            if peaks and x[i] > x[peaks[-1]]:
                peaks[-1] = i
                last = i
            continue
        peaks.append(i)
        last = i
    return np.asarray(peaks, dtype=int)


# ── Resampling helpers ──────────────────────────────────────────────────────

def resample_curve(values, times, step=1.0, duration=None):
    """
    Downsample a frame-rate curve onto a fixed grid for transport to the UI.
    A four-minute track at 512-sample hops is ~10k frames per curve; the
    timeline view needs one point per second, not ten thousand.

    Returns a list of {'t': seconds, 'v': value} with values rounded, which is
    the shape the web client's charts already read.
    """
    values = np.asarray(values, dtype=float)
    times = np.asarray(times, dtype=float)
    if values.size == 0 or times.size == 0:
        return []
    n = min(values.size, times.size)
    values, times = values[:n], times[:n]
    end = float(duration if duration is not None else times[-1])
    if end <= 0:
        return []
    grid = np.arange(0.0, end + step * 0.5, step)
    out = []
    for i, t0 in enumerate(grid):
        t1 = t0 + step
        mask = (times >= t0) & (times < t1)
        if not np.any(mask):
            continue
        out.append({'t': round(float(t0), 3), 'v': round(float(np.mean(values[mask])), 4)})
    return out


def frames_to_times(n_frames, sr, hop_length):
    return np.arange(n_frames, dtype=float) * (hop_length / float(sr))


def nearest_index(sorted_values, target):
    """Index of the closest entry in an ascending array. -1 when empty."""
    arr = np.asarray(sorted_values, dtype=float)
    if arr.size == 0:
        return -1
    i = int(np.searchsorted(arr, target))
    if i <= 0:
        return 0
    if i >= arr.size:
        return arr.size - 1
    return i if abs(arr[i] - target) < abs(arr[i - 1] - target) else i - 1


# ── Statistics ──────────────────────────────────────────────────────────────

def autocorrelation(x, max_lag=None):
    """Normalised autocorrelation of a mean-removed signal, lags 0..max_lag."""
    x = np.asarray(x, dtype=float)
    if x.size < 2:
        return np.zeros(1)
    x = x - float(np.mean(x))
    n = x.size
    max_lag = int(max_lag if max_lag is not None else n - 1)
    max_lag = max(1, min(max_lag, n - 1))
    size = 1 << int(np.ceil(np.log2(2 * n)))
    spec = np.fft.rfft(x, size)
    ac = np.fft.irfft(spec * np.conj(spec), size)[: max_lag + 1]
    if ac[0] > 1e-12:
        ac = ac / ac[0]
    return np.real(ac)


def coefficient_of_variation(x):
    """std/mean — how much a curve moves relative to how loud it is."""
    x = np.asarray(x, dtype=float)
    if x.size == 0:
        return 0.0
    mean = float(np.mean(x))
    if abs(mean) < 1e-9:
        return 0.0
    return float(np.std(x) / abs(mean))


def clamp01(v):
    if not np.isfinite(v):
        return 0.0
    return float(min(1.0, max(0.0, v)))
