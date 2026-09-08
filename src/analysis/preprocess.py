"""
Stage 1 — turn an arbitrary audio file into the signals the rest of the
pipeline is allowed to assume.

Everything downstream reads thresholds off absolute numbers ("energy above
0.55", "a rise of 0.22"). Those numbers only mean anything if the input has
been put on a known scale first, which is what this stage is for:

  * decode and resample to the analysis rate, keeping both channels
  * measure real loudness (BS.1770 LUFS) and normalise to a fixed target
  * remove subsonic rumble and, when the recording needs it, broadband noise
  * derive a separate gain-levelled copy for the rhythm stage only
  * split harmonic from percussive content

The gain-levelled copy deserves a note. Onset and beat tracking work better on
a signal with a constant level — a quiet intro should give up its beats as
readily as the chorus. Feature extraction wants the opposite: the difference
between the intro and the chorus *is* the information. So this stage produces
both and hands each stage the one it needs, rather than picking one compromise.
"""

import os
import sys
from dataclasses import dataclass, field

import numpy as np

from . import loudness as loudness_mod
from .config import PreprocessConfig


@dataclass
class PreparedAudio:
    """Everything the later stages are allowed to read about the audio."""

    #: Mono, loudness-normalised, filtered. The reference signal for features.
    mono: np.ndarray
    #: Same signal with slow gain levelling applied. Rhythm stages only.
    levelled: np.ndarray
    #: Harmonic and percussive components of `mono`.
    harmonic: np.ndarray
    percussive: np.ndarray
    sample_rate: int
    duration: float
    #: Wideband mono at `wideband_rate`, for the `air` band and the tagger.
    #: None when the source had no usable bandwidth above the analysis rate.
    wideband: np.ndarray = None
    wideband_rate: int = 0
    #: Stereo measurements. `width` is 0 for a mono source.
    width: float = 0.0
    correlation: float = 1.0
    side_curve: np.ndarray = field(default_factory=lambda: np.zeros(0))
    #: Loudness report, in LUFS / LU / dBFS.
    integrated_lufs: float = -np.inf
    loudness_range: float = 0.0
    true_peak_db: float = -np.inf
    applied_gain_db: float = 0.0
    #: Estimated broadband noise floor and the signal-to-noise ratio measured
    #: against it, both in dB on the spectrogram's own scale, plus whether
    #: spectral subtraction was applied.
    noise_floor_db: float = -np.inf
    snr_db: float = np.inf
    denoised: bool = False
    #: Seconds trimmed from the head when aligning to a known track length.
    trim_offset: float = 0.0


def _log(msg):
    print(f'[preprocess] {msg}', file=sys.stderr)


# ── Loading ─────────────────────────────────────────────────────────────────

def _load_stereo(path, target_sr):
    """
    Decode to (channels, samples) at `target_sr`, keeping up to two channels.

    librosa resamples with a high-quality polyphase filter by default, so
    "automatic resampling" here is genuinely band-limited rather than the
    nearest-neighbour drop that a naive decoder does.
    """
    import librosa
    y, sr = librosa.load(path, sr=target_sr, mono=False)
    y = np.atleast_2d(np.asarray(y, dtype=np.float32))
    if y.shape[0] > 2:
        y = y[:2]
    return y, int(sr)


def _source_bandwidth(path):
    """Native sample rate of the file, or 0 when it cannot be read cheaply."""
    try:
        import soundfile as sf
        info = sf.info(path)
        return int(info.samplerate)
    except Exception:
        return 0


# ── Filtering ───────────────────────────────────────────────────────────────

def highpass(x, sr, cutoff_hz, order=2):
    """Butterworth high-pass. Removes DC offset and subsonic rumble, both of
    which otherwise show up as a large constant in the `sub` band."""
    try:
        from scipy.signal import butter, sosfilt
        nyq = sr / 2.0
        wn = min(0.99, max(1e-4, cutoff_hz / nyq))
        sos = butter(order, wn, btype='highpass', output='sos')
        return sosfilt(sos, x, axis=-1).astype(np.float32)
    except Exception:
        return (x - np.mean(x, axis=-1, keepdims=True)).astype(np.float32)


def estimate_noise_floor(mono, sr, n_fft, hop_length, percentile):
    """
    Median magnitude spectrum of the quietest frames — an estimate of what the
    recording sounds like when nothing is playing.

    Returns (spectrum, noise_dB, signal_dB). Both levels are measured off the
    same spectrogram so their difference is a real signal-to-noise ratio;
    comparing a spectral level against a waveform RMS would compare two
    different scales and report a negative SNR for perfectly clean audio.
    """
    import librosa
    spec = np.abs(librosa.stft(mono, n_fft=n_fft, hop_length=hop_length))
    if spec.size == 0:
        return np.zeros(0), -np.inf, -np.inf
    frame_energy = np.sqrt(np.mean(spec ** 2, axis=0))
    cutoff = np.percentile(frame_energy, percentile)
    quiet = spec[:, frame_energy <= cutoff]
    if quiet.shape[1] < 3:
        quiet = spec[:, np.argsort(frame_energy)[:max(3, spec.shape[1] // 20)]]
    noise = np.median(quiet, axis=1)
    noise_level = float(np.sqrt(np.mean(noise ** 2)))
    # The 75th percentile frame stands in for "the music": the mean is dragged
    # down by every gap between phrases.
    signal_level = float(np.percentile(frame_energy, 75))
    to_db = lambda v: 20.0 * np.log10(v) if v > 0 else -np.inf
    return noise, to_db(noise_level), to_db(signal_level)


def _should_denoise(snr_db, noise_spectrum, snr_threshold=20.0, flatness_threshold=0.40):
    """
    Two conditions, because a low SNR on its own does not mean noisy audio.

    On a track with no silence in it the "quietest frames" are still music, so
    the noise estimate comes out high and the SNR comes out low — on perfectly
    clean audio. The second condition separates the two cases: a real noise
    floor is broadband and roughly flat, while music masquerading as one has
    harmonic structure and a heavy low end. Spectral flatness (geometric over
    arithmetic mean) tells them apart in one number: clean material measures
    below 0.25 even when its SNR looks poor, hiss and room tone above 0.9.
    """
    if not np.isfinite(snr_db) or snr_db >= snr_threshold:
        return False
    spectrum = np.asarray(noise_spectrum, dtype=float)
    spectrum = spectrum[spectrum > 0]
    if spectrum.size < 8:
        return False
    geometric = float(np.exp(np.mean(np.log(spectrum))))
    arithmetic = float(np.mean(spectrum))
    if arithmetic <= 0:
        return False
    return (geometric / arithmetic) > flatness_threshold


def spectral_subtract(mono, sr, noise_spectrum, n_fft, hop_length, strength):
    """
    Gentle spectral subtraction. Only worth its cost on genuinely noisy sources
    (live recordings, vinyl rips, phone captures); on a clean master it would
    shave the reverb tails that the structure stage reads as section character,
    so the caller gates it on a measured signal-to-noise ratio.
    """
    import librosa
    stft = librosa.stft(mono, n_fft=n_fft, hop_length=hop_length)
    mag, phase = np.abs(stft), np.angle(stft)
    reduced = np.maximum(mag - strength * noise_spectrum[:, None], 0.05 * mag)
    out = librosa.istft(reduced * np.exp(1j * phase), hop_length=hop_length,
                        length=len(mono))
    return out.astype(np.float32)


# ── Gain ────────────────────────────────────────────────────────────────────

def normalise_loudness(channels, sr, target_lufs, max_gain_db):
    """
    Scale to `target_lufs`, capped at `max_gain_db`. Returns
    (channels, measured_lufs, applied_gain_db).
    """
    measured = loudness_mod.integrated_lufs(channels, sr)
    if not np.isfinite(measured):
        return channels, measured, 0.0
    gain_db = float(np.clip(target_lufs - measured, -max_gain_db, max_gain_db))
    return (channels * (10.0 ** (gain_db / 20.0))).astype(np.float32), measured, gain_db


def adaptive_gain(mono, sr, window_sec=3.0, floor_db=-45.0, max_boost_db=18.0):
    """
    Slow automatic gain control: divide out a smoothed envelope so a quiet
    intro and a loud chorus arrive at the onset detector at the same level.

    Deliberately slow (a multi-second window) so it levels *sections*, not
    beats. A fast AGC would flatten the very transients the rhythm stage is
    looking for, which is the classic way to make a beat tracker worse by
    trying to help it.
    """
    if mono.size == 0:
        return mono
    win = max(1, int(round(window_sec * sr)))
    # RMS envelope on a coarse grid, then interpolated back — a full-rate
    # rolling RMS over a 4-minute track is pure waste.
    step = max(1, win // 8)
    starts = np.arange(0, max(1, mono.size - win + 1), step)
    if starts.size < 2:
        return mono
    env = np.array([np.sqrt(np.mean(mono[s:s + win] ** 2)) for s in starts])
    centres = starts + win / 2.0
    env_full = np.interp(np.arange(mono.size), centres, env,
                         left=env[0], right=env[-1])

    reference = float(np.percentile(env, 75))
    if reference <= 0:
        return mono
    floor = reference * (10.0 ** (floor_db / 20.0))
    gain = reference / np.maximum(env_full, floor)
    gain = np.clip(gain, 10.0 ** (-max_boost_db / 20.0), 10.0 ** (max_boost_db / 20.0))
    out = mono * gain
    peak = float(np.max(np.abs(out))) if out.size else 0.0
    if peak > 1.0:
        out = out / peak
    return out.astype(np.float32)


# ── Alignment ───────────────────────────────────────────────────────────────

def trim_to_duration(mono, sr, target_sec, tolerance_sec=1.5):
    """
    Some sources hand back audio longer than the track: a download with a
    silent lead-in, or a stream that starts early. When the caller knows the
    real length (from a streaming service), trim the quiet head and tail so the
    analysis clock and the playback clock agree — a half-second offset here is
    a half-second of every cue landing late for the whole song.

    Returns (trimmed, head_offset_seconds).
    """
    if not target_sec or target_sec <= 0 or mono.size == 0:
        return mono, 0.0
    actual = mono.size / float(sr)
    excess = actual - target_sec
    if excess <= tolerance_sec:
        return mono, 0.0

    frame = max(1, int(0.05 * sr))
    n_frames = mono.size // frame
    if n_frames < 4:
        return mono, 0.0
    energy = np.sqrt(np.mean(mono[:n_frames * frame].reshape(n_frames, frame) ** 2, axis=1))
    threshold = max(1e-5, 0.02 * float(np.percentile(energy, 90)))
    loud = np.flatnonzero(energy > threshold)
    if loud.size == 0:
        return mono, 0.0

    head = int(loud[0]) * frame
    tail = min(mono.size, (int(loud[-1]) + 1) * frame)
    # Only trim what the excess allows, and never cut into the music itself.
    head = min(head, int(excess * sr))
    trimmed = mono[head:tail]
    wanted = int(round(target_sec * sr))
    if trimmed.size > wanted + int(tolerance_sec * sr):
        trimmed = trimmed[:wanted]
    _log(f'trimmed {actual:.1f}s -> {trimmed.size / sr:.1f}s (target {target_sec:.1f}s)')
    return trimmed.astype(np.float32), head / float(sr)


# ── Entry point ─────────────────────────────────────────────────────────────

def prepare(path, config: PreprocessConfig = None, target_duration_sec=None):
    """Run the whole preprocessing stage and return a `PreparedAudio`."""
    import librosa

    config = config or PreprocessConfig()
    if not os.path.isfile(path):
        raise FileNotFoundError(path)

    channels, sr = _load_stereo(path, config.sample_rate)

    # ── Stereo measurements, taken before anything is collapsed to mono ──
    if channels.shape[0] >= 2:
        left, right = channels[0], channels[1]
        mid = 0.5 * (left + right)
        side = 0.5 * (left - right)
        mid_rms = float(np.sqrt(np.mean(mid ** 2)))
        side_rms = float(np.sqrt(np.mean(side ** 2)))
        width = float(side_rms / mid_rms) if mid_rms > 1e-9 else 0.0
        denom = float(np.std(left) * np.std(right))
        correlation = float(np.corrcoef(left, right)[0, 1]) if denom > 1e-12 else 1.0
        if not np.isfinite(correlation):
            correlation = 1.0
    else:
        mid = channels[0]
        side = np.zeros_like(mid)
        width, correlation = 0.0, 1.0

    normalised, measured_lufs, gain_db = normalise_loudness(
        channels, sr, config.target_lufs, config.max_gain_db)
    mono = np.mean(normalised, axis=0).astype(np.float32)

    mono = highpass(mono, sr, config.highpass_hz)

    # ── Noise ──
    noise_spectrum, noise_db, signal_db = estimate_noise_floor(
        mono, sr, config.n_fft, config.hop_length, config.noise_floor_percentile)
    snr_db = signal_db - noise_db if np.isfinite(noise_db) and np.isfinite(signal_db) \
        else np.inf
    denoised = False
    if config.noise_reduction > 0 and _should_denoise(snr_db, noise_spectrum):
        mono = spectral_subtract(mono, sr, noise_spectrum, config.n_fft,
                                 config.hop_length, config.noise_reduction)
        denoised = True
        _log(f'denoised: SNR {snr_db:.1f} dB')

    mono, trim_offset = trim_to_duration(mono, sr, target_duration_sec)
    duration = float(mono.size) / sr

    if trim_offset > 0 or side.size != mono.size:
        head = int(round(trim_offset * sr))
        side = side[head:head + mono.size] if side.size else np.zeros(0, dtype=np.float32)

    st_times, st_values = loudness_mod.short_term_curve(mono, sr)
    lra = loudness_mod.loudness_range(st_values)
    true_peak = loudness_mod.true_peak_dbfs(mono, sr)

    levelled = adaptive_gain(mono, sr)

    try:
        harmonic, percussive = librosa.effects.hpss(mono, margin=config.hpss_margin)
    except Exception as exc:
        _log(f'HPSS unavailable ({exc}); falling back to the full signal')
        harmonic, percussive = mono, mono

    # ── Wideband pass for `air` and the tagger ──
    wideband, wb_rate = None, 0
    native = _source_bandwidth(path)
    if native == 0 or native > config.sample_rate:
        try:
            wideband, wb_rate = librosa.load(path, sr=config.wideband_rate, mono=True)
            wb_rate = int(wb_rate)
            if trim_offset > 0:
                head = int(round(trim_offset * wb_rate))
                want = int(round(duration * wb_rate))
                wideband = wideband[head:head + want]
            if gain_db:
                wideband = (wideband * (10.0 ** (gain_db / 20.0))).astype(np.float32)
        except Exception as exc:
            _log(f'wideband pass skipped: {exc}')
            wideband, wb_rate = None, 0

    return PreparedAudio(
        mono=mono,
        levelled=levelled,
        harmonic=np.asarray(harmonic, dtype=np.float32),
        percussive=np.asarray(percussive, dtype=np.float32),
        sample_rate=sr,
        duration=duration,
        wideband=wideband,
        wideband_rate=wb_rate,
        width=round(width, 4),
        correlation=round(correlation, 4),
        side_curve=side,
        integrated_lufs=float(measured_lufs),
        loudness_range=float(lra),
        true_peak_db=float(true_peak),
        applied_gain_db=float(gain_db),
        noise_floor_db=float(noise_db),
        snr_db=float(snr_db),
        denoised=denoised,
        trim_offset=float(trim_offset),
    )
