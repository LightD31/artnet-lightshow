"""
ITU-R BS.1770-4 loudness measurement (the LUFS scale broadcasters use).

Why this and not RMS: RMS says how big the numbers are, LUFS says how loud it
sounds. K-weighting rolls off the sub bass and lifts the presence region the
way an ear does, and the gating throws away the silence between phrases so a
sparse track is not measured as quiet just because it has gaps in it. The
lighting engine wants the perceptual number — that is what "this section is
louder" has to mean for a cue to feel right.

Implemented directly rather than pulled in as a dependency: it is two biquads
and a gated mean, and the analyser already carries enough install weight.
"""

import numpy as np


ABSOLUTE_GATE_LUFS = -70.0
RELATIVE_GATE_LU = -10.0
BLOCK_SEC = 0.400
BLOCK_OVERLAP = 0.75
SHORT_TERM_SEC = 3.0


def _biquad_high_shelf(gain_db, q, fc, rate):
    a_gain = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * np.pi * (fc / rate)
    alpha = np.sin(w0) / (2.0 * q)
    cos_w0 = np.cos(w0)
    sqrt_a = np.sqrt(a_gain)

    b = np.array([
        a_gain * ((a_gain + 1) + (a_gain - 1) * cos_w0 + 2 * sqrt_a * alpha),
        -2 * a_gain * ((a_gain - 1) + (a_gain + 1) * cos_w0),
        a_gain * ((a_gain + 1) + (a_gain - 1) * cos_w0 - 2 * sqrt_a * alpha),
    ])
    a = np.array([
        (a_gain + 1) - (a_gain - 1) * cos_w0 + 2 * sqrt_a * alpha,
        2 * ((a_gain - 1) - (a_gain + 1) * cos_w0),
        (a_gain + 1) - (a_gain - 1) * cos_w0 - 2 * sqrt_a * alpha,
    ])
    return b / a[0], a / a[0]


def _biquad_high_pass(q, fc, rate):
    w0 = 2.0 * np.pi * (fc / rate)
    alpha = np.sin(w0) / (2.0 * q)
    cos_w0 = np.cos(w0)
    b = np.array([(1 + cos_w0) / 2.0, -(1 + cos_w0), (1 + cos_w0) / 2.0])
    a = np.array([1 + alpha, -2 * cos_w0, 1 - alpha])
    return b / a[0], a / a[0]


def k_weighting_filters(rate):
    """
    The two stages of the K-weighting curve, as (b, a) coefficient pairs.

    The spec tabulates coefficients at 48 kHz only. Re-deriving the same
    prototype at the actual sample rate is what every real implementation does;
    using the 48 kHz numbers at 22.05 kHz would put the shelf an octave off.
    """
    shelf = _biquad_high_shelf(3.99984385397, 0.7071752369554193,
                               1681.9744509555319, rate)
    hp = _biquad_high_pass(0.5003270373238773, 38.13547087602444, rate)
    return shelf, hp


def _lfilter(b, a, x):
    try:
        from scipy.signal import lfilter
        return lfilter(b, a, x)
    except Exception:
        # Direct form II transposed, so the module still works without scipy.
        y = np.zeros_like(x)
        z1 = z2 = 0.0
        for i, xi in enumerate(x):
            yi = b[0] * xi + z1
            z1 = b[1] * xi - a[1] * yi + z2
            z2 = b[2] * xi - a[2] * yi
            y[i] = yi
        return y


def k_weight(channels, rate):
    """Apply K-weighting to an array shaped (n_channels, n_samples)."""
    channels = np.atleast_2d(np.asarray(channels, dtype=float))
    (b1, a1), (b2, a2) = k_weighting_filters(rate)
    out = np.empty_like(channels)
    for i, ch in enumerate(channels):
        out[i] = _lfilter(b2, a2, _lfilter(b1, a1, ch))
    return out


def _block_powers(weighted, rate, block_sec=BLOCK_SEC, overlap=BLOCK_OVERLAP):
    """Mean square per channel for each overlapping gating block."""
    block = int(round(block_sec * rate))
    if block < 1:
        return np.zeros((0, weighted.shape[0]))
    step = max(1, int(round(block * (1.0 - overlap))))
    n = weighted.shape[1]
    if n < block:
        if n == 0:
            return np.zeros((0, weighted.shape[0]))
        return np.mean(weighted ** 2, axis=1)[None, :]
    starts = range(0, n - block + 1, step)
    return np.array([np.mean(weighted[:, s:s + block] ** 2, axis=1) for s in starts])


def _loudness_from_power(power, weights):
    total = float(np.sum(power * weights))
    if total <= 0:
        return -np.inf
    return -0.691 + 10.0 * np.log10(total)


def integrated_lufs(channels, rate):
    """
    Gated integrated loudness in LUFS. `channels` is (n_channels, n_samples);
    mono is accepted as a 1-D array.

    Returns -inf for digital silence, which callers must treat as "no signal"
    rather than "very quiet" — the difference matters when deciding whether to
    apply make-up gain.
    """
    channels = np.atleast_2d(np.asarray(channels, dtype=float))
    if channels.size == 0:
        return -np.inf
    weighted = k_weight(channels, rate)
    powers = _block_powers(weighted, rate)
    if powers.size == 0:
        return -np.inf
    weights = np.ones(channels.shape[0])

    block_loudness = np.array([_loudness_from_power(p, weights) for p in powers])
    above_absolute = block_loudness > ABSOLUTE_GATE_LUFS
    if not np.any(above_absolute):
        return -np.inf

    relative_ref = _loudness_from_power(np.mean(powers[above_absolute], axis=0), weights)
    gate = relative_ref + RELATIVE_GATE_LU
    keep = above_absolute & (block_loudness > gate)
    if not np.any(keep):
        keep = above_absolute
    return _loudness_from_power(np.mean(powers[keep], axis=0), weights)


def short_term_curve(channels, rate, window_sec=SHORT_TERM_SEC, hop_sec=0.5):
    """
    Short-term (3 s) loudness over time, as (times, lufs). This is the curve a
    mastering engineer watches, and it is what the show engine should compare
    sections against — a chorus is "louder" in this sense even when its peak
    sample values match the verse's.
    """
    channels = np.atleast_2d(np.asarray(channels, dtype=float))
    if channels.size == 0:
        return np.zeros(0), np.zeros(0)
    weighted = k_weight(channels, rate)
    win = max(1, int(round(window_sec * rate)))
    hop = max(1, int(round(hop_sec * rate)))
    n = weighted.shape[1]
    weights = np.ones(channels.shape[0])
    times, values = [], []
    for start in range(0, max(1, n - win + 1), hop):
        seg = weighted[:, start:start + win]
        if seg.shape[1] < win // 2:
            break
        power = np.mean(seg ** 2, axis=1)
        times.append((start + win / 2.0) / rate)
        values.append(_loudness_from_power(power, weights))
    return np.asarray(times), np.asarray(values)


def loudness_range(short_term_values):
    """
    Loudness range (LRA) in LU: the spread between the quiet and loud parts of
    a track, after gating. A big number means the track has real dynamics to
    light; a number near zero means it is squashed and the show has to create
    its own contrast.
    """
    values = np.asarray(short_term_values, dtype=float)
    values = values[np.isfinite(values) & (values > ABSOLUTE_GATE_LUFS)]
    if values.size < 2:
        return 0.0
    ref = float(np.mean(values))
    gated = values[values > ref - 20.0]
    if gated.size < 2:
        gated = values
    return float(np.percentile(gated, 95) - np.percentile(gated, 10))


def true_peak_dbfs(channels, rate, oversample=4):
    """
    Inter-sample peak in dBFS. Oversampled because a signal can peak between
    two samples; a converter reconstructing it will clip where the samples say
    it did not.
    """
    channels = np.atleast_2d(np.asarray(channels, dtype=float))
    if channels.size == 0:
        return -np.inf
    peak = 0.0
    try:
        from scipy.signal import resample_poly
        for ch in channels:
            up = resample_poly(ch, oversample, 1)
            peak = max(peak, float(np.max(np.abs(up))))
    except Exception:
        peak = float(np.max(np.abs(channels)))
    if peak <= 0:
        return -np.inf
    return 20.0 * np.log10(peak)
