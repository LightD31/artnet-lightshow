#!/usr/bin/env python3
"""
Audio analysis bridge for artnet-lightshow auto mode.
Uses librosa + scipy for cross-platform music information retrieval.

Usage: python essentia-analyze.py <audio_file_or_url>
Output: JSON analysis to stdout.

Pipeline:
  - Harmonic/percussive separation
  - Beat tracking (with tempo prior) + PLP tempogram for time-varying tempo
  - Key/scale via Krumhansl-Schmuckler on CQT chromagram
  - Multi-band energy (kick / bass / mid / high) with percentile normalization
  - Mood: valence + arousal from tempo, loudness, brightness, harmony
  - Structural segmentation via Laplacian (McFee & Ellis 2014)
  - Drop detection: kick-onset novelty + adaptive peak pick + breakdown/sustain
                    validation + beat snap + continuous confidence score
  - Build-up detection: rising RMS/centroid/flux before each drop
"""

import sys
import json
import os
import tempfile


def download_audio(url):
    """Download audio from URL to a temp file, return path."""
    import urllib.request
    ext = '.mp3' if '.mp3' in url else '.ogg'
    fd, filepath = tempfile.mkstemp(suffix=ext)
    os.close(fd)
    urllib.request.urlretrieve(url, filepath)
    return filepath


# ── Key estimation (Krumhansl-Schmuckler) ────────────────────────────────────

MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


_PANNS_AT = None  # cached AudioTagging instance (PyTorch model is heavy)


def classify_panns(filepath):
    """
    Run PANNs (Pretrained Audio Neural Networks, Cnn14, AudioSet 527 classes)
    on a wav file and return aggregated genre scores + a coarse style tier.

    The CNN is trained on AudioSet, so its label space directly distinguishes
    "Electronic dance music", "Folk music", "Acoustic guitar", "Ambient music",
    etc. — the high-level signal that local DSP features can't reliably extract.

    Returns None if torch / panns_inference / the checkpoint aren't available
    (the rest of the pipeline still works, just without genre classification).
    """
    try:
        import warnings as _warn
        _warn.filterwarnings('ignore')
        import numpy as _np
        import librosa as _lr
        from panns_inference import AudioTagging, labels as _labels
    except Exception as exc:
        print(f'[panns] skipped: {exc}', file=sys.stderr)
        return None

    home = os.path.expanduser('~')
    ckpt = os.path.join(home, 'panns_data', 'Cnn14_mAP=0.431.pth')
    labels_csv = os.path.join(home, 'panns_data', 'class_labels_indices.csv')

    # Auto-bootstrap on first run: if torch/panns_inference are installed but
    # the model files aren't present, kick off scripts/setup-panns.py.
    needs_files = (
        not os.path.isfile(ckpt)
        or os.path.getsize(ckpt) < int(3e8)
        or not os.path.isfile(labels_csv)
    )
    if needs_files:
        setup = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            'scripts', 'setup-panns.py'
        )
        if os.path.isfile(setup):
            print(
                '[panns] model files missing — running setup-panns.py '
                '(one-time ~310 MB download)',
                file=sys.stderr,
            )
            import subprocess as _sp
            try:
                _sp.run(
                    [sys.executable, setup],
                    check=True,
                    stdout=sys.stderr,
                    stderr=sys.stderr,
                )
            except Exception as exc:
                print(f'[panns] setup failed: {exc}', file=sys.stderr)
                return None

    if not os.path.isfile(ckpt) or os.path.getsize(ckpt) < int(3e8):
        print('[panns] checkpoint still missing after setup — skipping',
              file=sys.stderr)
        return None

    global _PANNS_AT
    if _PANNS_AT is None:
        # PANNs prints "Checkpoint path: ..." and "Using CPU." to stdout
        # during construction, which would corrupt our JSON output. Redirect
        # those prints to stderr while the model loads.
        import contextlib as _ctx
        with _ctx.redirect_stdout(sys.stderr):
            _PANNS_AT = AudioTagging(checkpoint_path=ckpt, device='cpu')

    # PANNs expects 32 kHz mono. Average predictions over non-overlapping 10 s
    # chunks; the model is trained on ~10 s clips so this matches its design.
    y, _ = _lr.load(filepath, sr=32000, mono=True)
    chunk = 32000 * 10
    n_chunks = max(1, len(y) // chunk)
    probs_sum = None
    for i in range(n_chunks):
        c = y[i * chunk:(i + 1) * chunk]
        if len(c) < 32000:
            continue
        c = c[_np.newaxis, :].astype(_np.float32)
        clipwise, _emb = _PANNS_AT.inference(c)
        p = clipwise[0]
        probs_sum = p if probs_sum is None else probs_sum + p
    if probs_sum is None:
        return None
    probs = probs_sum / max(1, n_chunks)

    label_idx = {lab: i for i, lab in enumerate(_labels)}

    def bucket(names):
        return float(sum(probs[label_idx[n]] for n in names if n in label_idx))

    # Fine-grained subgenre buckets keyed to AudioSet labels PANNs was trained
    # on. Each entry is a list of labels that contribute to that subgenre; the
    # highest-scoring subgenre becomes `label` and drives genre-specific
    # palette/pattern selection in auto-show.js.
    SUBGENRES = {
        'edm':       ['Electronic dance music', 'House music', 'Techno',
                      'Dance music', 'Electronica', 'Electronic music'],
        'dubstep':   ['Dubstep', 'Drum and bass'],
        'trance':    ['Trance music'],
        'disco':     ['Disco'],
        'hiphop':    ['Hip hop music', 'Rapping'],
        'rock':      ['Rock music', 'Rock and roll', 'Progressive rock',
                      'Psychedelic rock', 'Grunge', 'Independent music'],
        'metal':     ['Heavy metal', 'Punk rock', 'Noise music'],
        'pop':       ['Pop music'],
        'funk':      ['Funk', 'Soul music', 'Rhythm and blues'],
        'reggae':    ['Reggae', 'Ska'],
        'country':   ['Country', 'Bluegrass'],
        'latin':     ['Music of Latin America', 'Salsa music', 'Cumbia, quebradita',
                      'Reggaeton', 'Bossa nova', 'Flamenco'],
        'jazz':      ['Jazz', 'Blues', 'Swing music'],
        'classical': ['Classical music', 'Opera', 'Choir', 'Orchestra'],
        'folk':      ['Folk music', 'Acoustic guitar', 'Traditional music',
                      'Middle Eastern music'],
        'ambient':   ['Ambient music', 'New-age music', 'Gospel music',
                      'Christian music', 'Piano'],
    }

    sub_scores = {name: bucket(names) for name, names in SUBGENRES.items()}

    # Pick the highest-scoring specific genre (with a minimum confidence floor
    # so weak/ambiguous tracks fall back to 'unknown').
    top_label, top_p = max(sub_scores.items(), key=lambda kv: kv[1])
    label = top_label if top_p >= 0.08 else 'unknown'

    top5 = sorted(enumerate(probs), key=lambda x: -float(x[1]))[:5]
    top_tags = [
        {'label': _labels[i], 'p': round(float(probs[i]), 3)}
        for i, _ in top5
    ]

    return {
        'label':     label,
        'labelConf': round(top_p, 3),
        'subScores': {k: round(v, 3) for k, v in sub_scores.items()},
        'topTags':   top_tags,
    }


def estimate_key(chroma):
    import numpy as np

    chroma_avg = np.mean(chroma, axis=1)
    if np.max(chroma_avg) == 0:
        return 'C', 'major', 0.0

    best_corr = -2.0
    best_key = 0
    best_scale = 'major'

    for shift in range(12):
        rolled = np.roll(chroma_avg, -shift)
        for profile, scale_name in [(MAJOR_PROFILE, 'major'), (MINOR_PROFILE, 'minor')]:
            corr = float(np.corrcoef(rolled, profile)[0, 1])
            if corr > best_corr:
                best_corr = corr
                best_key = shift
                best_scale = scale_name

    return KEY_NAMES[best_key], best_scale, round(best_corr, 3)


def robust_norm(arr, percentile=95):
    """Normalize to the 95th-percentile value — robust to single-sample spikes."""
    import numpy as np
    if arr is None or len(arr) == 0:
        return arr
    ref = float(np.percentile(arr, percentile))
    if ref <= 1e-9:
        ref = float(np.max(arr)) if np.max(arr) > 0 else 1.0
    return np.clip(arr / ref, 0.0, 1.0).astype(float)


def _tempo_stability(dom_tempos):
    """
    How steady is the per-frame dominant tempo?
    Returns 1.0 for rock-solid tempo, → 0 for chaotic tempo.

    Metric: 1 - (std / median). Robust to outliers via median reference.
    """
    import numpy as np
    if dom_tempos is None or len(dom_tempos) < 4:
        return 1.0
    v = np.asarray(dom_tempos, dtype=float)
    v = v[np.isfinite(v) & (v > 0)]
    if len(v) < 4:
        return 1.0
    med = float(np.median(v))
    if med <= 1e-9:
        return 1.0
    return float(np.clip(1.0 - (float(np.std(v)) / med), 0.0, 1.0))


def _plp_beats(onset_env, sr, hop_length=512, tempo_min=70, tempo_max=200):
    """
    Beat frame indices from PLP (Predominant Local Pulse).
    Better than beat_track for tracks with drifting tempo.
    """
    import librosa
    import numpy as np
    pulse = librosa.beat.plp(
        onset_envelope=onset_env, sr=sr, hop_length=hop_length,
        tempo_min=tempo_min, tempo_max=tempo_max,
    )
    # Local maxima of the pulse curve — threshold weakly to drop spurious hits.
    if pulse.size == 0:
        return np.array([], dtype=int)
    thr = float(np.percentile(pulse, 50))
    is_max = librosa.util.localmax(pulse) & (pulse > thr)
    beat_frames = np.flatnonzero(is_max).astype(int)
    return beat_frames


def estimate_downbeats(beat_times, beat_strengths):
    """
    Heuristic downbeat detector: assumes downbeats carry more onset energy
    than mid-bar beats, and searches for the (meter, phase) pair that best
    explains the observed beat-strength pattern.

    Tests meter 4 (common time) and meter 3 (waltz). Returns the combination
    with the strongest contrast between on-downbeat and off-downbeat strengths.

    Returns: (downbeat_times, downbeat_indices, meter, confidence)
    """
    import numpy as np
    if len(beat_times) < 12 or len(beat_strengths) < 12:
        return [], [], 4, 0.0

    n = min(len(beat_times), len(beat_strengths))
    bs = np.asarray(beat_strengths[:n], dtype=float)

    best = None  # (score, meter, phase)
    for meter in (4, 3):
        if n < meter * 3:
            continue
        for phase in range(meter):
            on_idx = np.arange(phase, n, meter)
            if len(on_idx) < 3:
                continue
            off_mask = np.ones(n, dtype=bool)
            off_mask[on_idx] = False
            if not np.any(off_mask):
                continue
            on_mean = float(np.mean(bs[on_idx]))
            off_mean = float(np.mean(bs[off_mask]))
            # Score: absolute contrast, with a mild preference for 4/4 when tied.
            score = (on_mean - off_mean) + (0.005 if meter == 4 else 0.0)
            if best is None or score > best[0]:
                best = (score, meter, phase)

    if best is None or best[0] <= 1e-6:
        return [], [], 4, 0.0

    _, meter, phase = best
    downbeat_indices = list(range(phase, n, meter))
    downbeat_times = [float(beat_times[i]) for i in downbeat_indices]

    # Confidence: normalised contrast scaled to [0, 1]
    on_idx = np.asarray(downbeat_indices)
    off_mask = np.ones(n, dtype=bool)
    off_mask[on_idx] = False
    on_mean = float(np.mean(bs[on_idx]))
    off_mean = float(np.mean(bs[off_mask])) if np.any(off_mask) else 0.0
    contrast = on_mean - off_mean
    # Scale: 0.15 contrast → ~0.75 confidence; 0.3 → 1.0
    confidence = float(np.clip(contrast / 0.3, 0.0, 1.0))
    return downbeat_times, downbeat_indices, meter, confidence


def _trim_to_target_duration(y, sr, target_sec):
    """
    Trim ``y`` to ``target_sec`` by removing beatless padding.

    Used whenever the Spotify track length differs from the downloaded audio
    length. Long intros, dead-air outros, applause, silent fade-ins, and
    remix/extended versions all push the downloaded length past the real
    song — if we analyzed the whole file, beat/drop/segment timestamps would
    drift relative to the Spotify position clock during playback.

    Runs any time ``len(y)/sr > target_sec``; the tolerance is zero because
    even a sub-second mismatch accumulates into visible drift over a full
    track. If the downloaded audio is shorter than the target we can't add
    audio back, so we no-op and let the analyzer work with what it has.

    Strategy:
      1. Compute the percussive onset envelope across the whole file.
      2. Threshold it to find the "musically active" region (frames where
         the beat is present).
      3. If the active region fits in target_sec, keep all of it and pad
         symmetrically with some of the leading/trailing non-active audio.
      4. If the active region itself is longer than target_sec (remix /
         extended / live version), drop equal amounts from the head and
         tail of the active region — preserves the middle (chorus) and only
         sacrifices the outer content.

    Returns:
      (y_trimmed, offset_sec) — offset is the number of seconds dropped from
      the head of the original, included mainly for logging.
    """
    import librosa
    import numpy as np

    duration = float(len(y)) / sr
    if target_sec is None or target_sec <= 0:
        return y, 0.0
    if duration <= target_sec:
        # Audio is shorter than (or exactly equal to) the target — nothing
        # to cut. Analyzer will work with the full length.
        return y, 0.0

    hop = 512
    # Use HPSS to isolate the percussive content so the "where are the beats"
    # detection isn't confused by a long sustained pad.
    try:
        _, y_perc = librosa.effects.hpss(y, margin=3.0)
        onset_env = librosa.onset.onset_strength(y=y_perc, sr=sr, hop_length=hop)
    except Exception:
        onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)

    frames_per_sec = sr / hop

    def _symmetric_trim():
        excess = duration - target_sec
        start_s = excess / 2.0
        end_s = start_s + target_sec
        return y[int(start_s * sr):int(end_s * sr)], start_s

    if onset_env is None or onset_env.size == 0:
        return _symmetric_trim()

    # Robust peak (90th percentile) so a single spike doesn't set the scale.
    import numpy as _np
    peak = float(_np.percentile(onset_env, 90))
    if peak <= 1e-6:
        peak = float(_np.max(onset_env)) or 1.0
    threshold = peak * 0.10

    active = onset_env > threshold
    active_frames = _np.where(active)[0]
    if active_frames.size == 0:
        return _symmetric_trim()

    first_active = float(active_frames[0]) / frames_per_sec
    last_active = float(active_frames[-1]) / frames_per_sec
    active_span = last_active - first_active

    if active_span <= target_sec:
        # Song fits inside target — keep all active content, pad symmetrically
        # into the head/tail silence until we hit target length.
        pad = (target_sec - active_span) / 2.0
        start_sec = max(0.0, first_active - pad)
        end_sec = start_sec + target_sec
        if end_sec > duration:
            end_sec = duration
            start_sec = max(0.0, end_sec - target_sec)
    else:
        # Musical content itself is longer than target (remix / extended).
        # Drop equal slices from the head and tail of the active region —
        # the middle (usually the main chorus) is preserved.
        excess = active_span - target_sec
        start_sec = first_active + excess / 2.0
        end_sec = start_sec + target_sec
        if end_sec > duration:
            end_sec = duration
            start_sec = max(0.0, end_sec - target_sec)

    start_sample = max(0, int(start_sec * sr))
    end_sample = min(len(y), int(end_sec * sr))
    if end_sample - start_sample < int(target_sec * sr * 0.5):
        # Something went sideways — fall back to symmetric trim rather than
        # returning a tiny slice.
        return _symmetric_trim()

    trimmed = y[start_sample:end_sample]
    print(
        f'[trim] {duration:.1f}s → {len(trimmed)/sr:.1f}s '
        f'(target {target_sec:.1f}s, dropped head {start_sec:.1f}s, '
        f'tail {duration - end_sec:.1f}s)',
        file=sys.stderr,
    )
    return trimmed, start_sec


def downsample(values, times, step=1.0):
    """Average values into fixed-width time buckets for UI curves."""
    if not values or not times:
        return []
    result = []
    t = 0.0
    end = times[-1]
    idx = 0
    while t <= end:
        bucket = []
        while idx < len(times) and times[idx] < t + step:
            bucket.append(values[idx])
            idx += 1
        if bucket:
            result.append({'t': round(t, 2), 'v': round(sum(bucket) / len(bucket), 3)})
        t += step
    return result


def analyze(filepath, target_duration_sec=None):
    import librosa
    import numpy as np

    # ── PANNs genre classification (high-level prior) ─────────────────────
    # Run this first so we can write its output into the result even on failure.
    # Skips silently if torch / panns_inference / checkpoint aren't available.
    # PANNs runs on the raw file (no trim) — a few seconds of intro silence
    # doesn't change the genre classification.
    genre = classify_panns(filepath)

    # Load audio (mono, 22050 Hz — good balance of speed/quality)
    y, sr = librosa.load(filepath, sr=22050, mono=True)

    # If a target duration was provided (Spotify track length) and the
    # downloaded audio is meaningfully longer than it, trim beatless padding
    # from the head/tail so segment/beat timestamps line up with the Spotify
    # position clock during playback.
    if target_duration_sec is not None and target_duration_sec > 0:
        y, _trim_offset = _trim_to_target_duration(y, sr, target_duration_sec)

    duration = float(librosa.get_duration(y=y, sr=sr))

    # ── Harmonic / percussive separation ──────────────────────────────────
    try:
        y_harm, y_perc = librosa.effects.hpss(y, margin=3.0)
    except Exception:
        y_harm, y_perc = y, y

    # ── Beat tracking ─────────────────────────────────────────────────────
    # Always run beat_track first — its global BPM anchors the tempogram
    # constraint below. We may later swap to PLP beats if the anchored tempo
    # curve shows genuine drift.
    hop_length = 512
    perc_onset = None
    try:
        perc_onset = librosa.onset.onset_strength(y=y_perc, sr=sr, hop_length=hop_length)
    except Exception:
        perc_onset = None

    tempo, beat_frames = librosa.beat.beat_track(
        y=y_perc, sr=sr, trim=False, start_bpm=120, tightness=100
    )
    bpm = float(np.atleast_1d(tempo)[0])
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    beat_source = 'beat_track'

    # ── Tempo curve (anchored to global BPM to kill octave errors) ────────
    # The raw tempogram dominant-bin jumps between 1×, 2×, and 3× of the true
    # tempo depending on the song. We constrain the search to a ±15 % window
    # around the beat_track global BPM so octave jumps can't leak into the
    # curve, then median-filter to smooth residual noise.
    tempo_curve = []
    tempo_stab = 1.0
    dom_tempos_full = None
    if perc_onset is not None:
        try:
            tempogram = librosa.feature.tempogram(
                onset_envelope=perc_onset, sr=sr, hop_length=hop_length
            )
            tg_tempos = librosa.tempo_frequencies(
                tempogram.shape[0], sr=sr, hop_length=hop_length
            )
            # Clamp to ±15 % of global BPM; fall back to a wide window if the
            # narrow window has no valid bins (extreme tempo).
            lo, hi = bpm * 0.85, bpm * 1.15
            valid = np.isfinite(tg_tempos) & (tg_tempos >= lo) & (tg_tempos <= hi)
            if not np.any(valid):
                valid = np.isfinite(tg_tempos) & (tg_tempos >= 50) & (tg_tempos <= 220)
            if np.any(valid):
                valid_idx = np.flatnonzero(valid)
                dom_local = np.argmax(tempogram[valid_idx], axis=0)
                dom_tempos_full = tg_tempos[valid_idx[dom_local]]
                # Median filter (~2 s window) to kill single-frame spikes.
                try:
                    from scipy.ndimage import median_filter as _mf
                    frame_rate = sr / hop_length
                    k = max(3, int(round(2.0 * frame_rate)) | 1)  # odd kernel
                    dom_tempos_full = _mf(dom_tempos_full, size=k)
                except Exception:
                    pass
                tg_times = librosa.times_like(tempogram, sr=sr, hop_length=hop_length)
                tempo_curve = downsample(
                    dom_tempos_full.tolist(), tg_times.tolist(), step=2.0
                )
                tempo_stab = _tempo_stability(dom_tempos_full)
        except Exception:
            pass

    # ── PLP fallback for *genuinely* drifting tempo ────────────────────────
    # Stricter threshold than before (0.75 → 0.60): with the octave-constraint
    # above, stability should only drop below 0.60 on tracks that really do
    # drift. Holocene-style ambient tracks now stay on beat_track.
    if tempo_stab < 0.60 and perc_onset is not None:
        try:
            plp_frames = _plp_beats(perc_onset, sr, hop_length=hop_length)
            if len(plp_frames) > 4:
                beat_frames = plp_frames
                beat_times = librosa.frames_to_time(
                    beat_frames, sr=sr, hop_length=hop_length
                )
                ibi = float(np.median(np.diff(beat_times))) if len(beat_times) > 1 else 0
                if ibi > 0:
                    bpm = 60.0 / ibi
                beat_source = 'plp'
        except Exception:
            pass

    # ── Key / scale (CQT chromagram of harmonic component) ────────────────
    chroma = librosa.feature.chroma_cqt(y=y_harm, sr=sr)
    key, scale, key_strength = estimate_key(chroma)

    # ── STFT & sub-band energies ──────────────────────────────────────────
    n_fft = 2048
    hop = 512
    S = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    stft_times = librosa.frames_to_time(np.arange(S.shape[1]), sr=sr, hop_length=hop)

    # Kick (40-120 Hz), bass-synth (120-250), low-mids already inside mid band
    kick_mask = (freqs >= 40) & (freqs < 120)
    bass_mask = (freqs >= 40) & (freqs < 250)   # wide low band, for UI + segment character
    high_mask = freqs >= 4000

    def band_energy(mask):
        if not np.any(mask):
            return np.zeros(S.shape[1])
        return np.sqrt(np.mean(S[mask] ** 2, axis=0))

    kick_energy = band_energy(kick_mask)
    bass_energy = band_energy(bass_mask)
    high_energy = band_energy(high_mask)

    kick_n = robust_norm(kick_energy)
    bass_n = robust_norm(bass_energy)
    high_n = robust_norm(high_energy)

    # ── Frame-level RMS (aligned to STFT grid) ────────────────────────────
    rms = librosa.feature.rms(y=y, frame_length=n_fft, hop_length=hop)[0]
    n = min(len(rms), S.shape[1])
    rms = rms[:n]
    rms_times = stft_times[:n]
    norm_rms = robust_norm(rms)

    # ── Spectral features ─────────────────────────────────────────────────
    centroid = librosa.feature.spectral_centroid(S=S, sr=sr)[0]
    norm_centroid = robust_norm(centroid)
    zcr = librosa.feature.zero_crossing_rate(y, hop_length=hop)[0]

    # ── Onset strength (full-band & kick-band) ────────────────────────────
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    flux_n = robust_norm(onset_env)

    onset_frames = librosa.onset.onset_detect(
        onset_envelope=onset_env, sr=sr, units='frames', hop_length=hop, backtrack=False
    )
    onset_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=hop)

    if np.any(kick_mask):
        kick_db = librosa.amplitude_to_db(S[kick_mask], ref=np.max)
        kick_onset_env = librosa.onset.onset_strength(S=kick_db, sr=sr, hop_length=hop)
    else:
        kick_onset_env = np.zeros(S.shape[1])
    kick_flux_n = robust_norm(kick_onset_env)

    kick_onset_frames = librosa.onset.onset_detect(
        onset_envelope=kick_onset_env, sr=sr, hop_length=hop, units='frames', backtrack=False
    )
    kick_onset_times = librosa.frames_to_time(kick_onset_frames, sr=sr, hop_length=hop)

    # ── Beat-synchronous onset-strength aggregation (proper beat strength) ─
    beat_strengths = []
    if len(beat_frames) and len(onset_env):
        try:
            sync = librosa.util.sync(
                onset_env[np.newaxis, :], beat_frames, aggregate=np.max
            )[0]
            # librosa.util.sync produces len(beat_frames)+1 buckets (it
            # includes the pre-first-beat interval). Drop the leading bucket
            # so sync[i] aligns with beat_times[i].
            n_beats = len(beat_frames)
            if len(sync) == n_beats + 1:
                sync = sync[1:]
            elif len(sync) > n_beats:
                sync = sync[:n_beats]
            p95 = float(np.percentile(sync, 95)) if sync.size else 1.0
            if p95 <= 1e-9:
                p95 = float(np.max(sync)) if sync.size and np.max(sync) > 0 else 1.0
            beat_strengths = np.clip(sync / p95, 0.0, 1.0).tolist()
        except Exception:
            beat_strengths = []

    # ── Downbeats (heuristic from beat strengths) ─────────────────────────
    downbeat_times, downbeat_idxs, meter, downbeat_confidence = estimate_downbeats(
        beat_times.tolist() if hasattr(beat_times, 'tolist') else list(beat_times),
        beat_strengths,
    )

    # ── Mood features ─────────────────────────────────────────────────────
    mood = compute_mood(
        bpm=bpm, scale=scale, key_strength=key_strength,
        rms=rms, centroid=centroid, onset_env=onset_env, zcr=zcr,
        beat_strengths=beat_strengths, y_harm=y_harm, sr=sr,
        onset_count=len(onset_times), duration=duration,
        kick_energy=kick_energy,
    )

    # ── Structural segmentation (Laplacian) ───────────────────────────────
    segments = compute_segments_laplacian(
        y=y, sr=sr, beat_frames=beat_frames, beat_times=beat_times,
        norm_rms=norm_rms, rms_times=rms_times,
        norm_centroid=norm_centroid, bass_n=bass_n, stft_times=stft_times,
    )

    # ── Drop & build-up detection ─────────────────────────────────────────
    drops, buildups = detect_drops(
        norm_rms=norm_rms, rms_times=rms_times,
        kick_n=kick_n, stft_times=stft_times,
        flux_n=flux_n, kick_flux_n=kick_flux_n,
        norm_centroid=norm_centroid,
        beat_times=beat_times,
        downbeat_idxs=downbeat_idxs,
    )

    # Cap drops by duration: a 2:30 pop song with 8 detected "drops" is the
    # detector firing on every chorus entry / snare buildup. Keep the most
    # confident max(2, ceil(duration / 50)) and re-sort chronologically.
    if drops:
        import math as _math
        max_drops = max(2, int(_math.ceil(duration / 50.0)))
        if len(drops) > max_drops:
            drops_sorted = sorted(drops, key=lambda d: -d.get('confidence', 0))
            keep = sorted(drops_sorted[:max_drops], key=lambda d: d['t'])
            drops = keep
            # Filter buildups to ones that still precede a kept drop
            kept_ts = {d['t'] for d in drops}
            buildups = [b for b in buildups if any(abs(b['end'] - t) < 1.0 for t in kept_ts)]

    # ── UI curves ─────────────────────────────────────────────────────────
    energy_curve = downsample(norm_rms.tolist(), rms_times.tolist(), step=1.0)
    bass_curve   = downsample(bass_n.tolist(),   stft_times.tolist(), step=0.5)
    kick_curve   = downsample(kick_n.tolist(),   stft_times.tolist(), step=0.5)
    high_curve   = downsample(high_n.tolist(),   stft_times.tolist(), step=0.5)

    return {
        'duration': round(duration, 3),
        'bpm': round(bpm, 1),
        'tempoCurve': tempo_curve,
        'tempoStability': round(tempo_stab, 3),
        'beatSource': beat_source,
        'beats': [round(float(b), 3) for b in beat_times],
        'beatStrengths': [round(float(s), 3) for s in beat_strengths],
        'downbeats': [round(float(d), 3) for d in downbeat_times],
        'meter': meter,
        'downbeatConfidence': round(downbeat_confidence, 3),
        'key': key,
        'scale': scale,
        'keyStrength': key_strength,
        'mood': mood,
        'genre': genre,
        'segments': segments,
        'onsets': [round(float(o), 3) for o in onset_times],
        'kickOnsets': [round(float(o), 3) for o in kick_onset_times],
        'drops': drops,
        'buildups': buildups,
        'energyCurve': energy_curve,
        'bassCurve': bass_curve,
        'kickCurve': kick_curve,
        'highCurve': high_curve,
    }


# ── Mood ─────────────────────────────────────────────────────────────────────

def compute_mood(bpm, scale, key_strength, rms, centroid, onset_env, zcr,
                 beat_strengths, y_harm, sr, onset_count=0, duration=0.0,
                 kick_energy=None):
    """
    Track mood as (valence, arousal) in [0, 1], plus loudness/brightness/
    danceability/kickiness.

    Arousal  = loudness + tempo + brightness + onset density + kickiness
    Valence  = mode + harmonic stability + tonal clarity
    Danceability = 1 - variance of beat strengths
    Kickiness = kick-band (40-120 Hz) RMS — separates EDM/dance music from
                acoustic/orchestral recordings that have similar overall RMS
                but no four-on-the-floor low end. Loaded heavily into arousal
                because it's the cleanest "wants strobes vs doesn't" signal.

    Earlier versions weighted loudness most heavily, but a well-mastered
    Buena Vista Social Club recording has high RMS while not wanting strobes
    at all. Kick-band energy fixes that misclassification.
    """
    import numpy as np
    import librosa

    def _mean(x):
        return float(np.mean(x)) if len(x) else 0.0

    # Loudness: *median* raw RMS against 0.12 reference.
    # - Median is robust to silent intros/outros which a mean would drag down.
    # - 0.12 is empirically around the mid-point between loud mastered music
    #   (~0.15-0.20) and quiet dynamic material (~0.04-0.08).
    # Loudness is the dominant arousal signal because it's the only metric
    # that cleanly separates ambient/dynamic music from compressed EDM. Tempo
    # and onset count are both unreliable (half/double-time errors; librosa's
    # onset detector fires on acoustic guitar picks as densely as on EDM kicks).
    if len(rms):
        rms_ref = 0.12
        loud_med = float(np.median(rms))
        loudness = float(np.clip(loud_med / rms_ref, 0.0, 1.0))
    else:
        loudness = 0.0

    # Tempo: 60→0, 180→1. Kept as a minor signal — beat_track doubles slow
    # tempos fairly often, so we don't trust it heavily.
    tempo_norm = float(np.clip((bpm - 60.0) / 120.0, 0.0, 1.0))

    # Brightness: centroid scaled against 40 % of Nyquist (~4.4 kHz @ 22050)
    nyq = sr / 2.0
    brightness = float(np.clip(_mean(centroid) / (nyq * 0.4), 0.0, 1.0))

    # Onset density: onsets per second against 4 ops reference. Unreliable on
    # ambient music (textural micro-onsets get detected), so weighted lightly.
    if duration > 0:
        onset_density = float(np.clip((onset_count / duration) / 4.0, 0.0, 1.0))
    else:
        onset_density = 0.0

    # Kickiness: median raw kick-band (40-120 Hz) energy against 0.012 ref.
    # That reference puts well-produced EDM (with kick on every beat) at
    # ~1.0 and acoustic/orchestral material at ~0.1-0.4.
    if kick_energy is not None and len(kick_energy):
        kick_med = float(np.median(kick_energy))
        kickiness = float(np.clip(kick_med / 0.012, 0.0, 1.0))
    else:
        kickiness = 0.5

    # Arousal weighting:
    #   - kickiness is the dominant signal because it's the cleanest
    #     dance-vs-non-dance discriminator.
    #   - loudness still contributes meaningfully — louder tracks feel more
    #     intense than quieter ones at the same kickiness.
    #   - tempo and brightness contribute lightly (both are noisy signals
    #     subject to BPM doubling and timbre quirks).
    arousal = float(np.clip(
        0.45 * kickiness +
        0.25 * loudness +
        0.10 * tempo_norm +
        0.10 * brightness +
        0.10 * onset_density,
        0.0, 1.0
    ))

    # Valence: scale (major/minor) is the dominant cue
    mode_bias = 0.65 if scale == 'major' else 0.35

    # Tonality: low ZCR → more tonal/pleasant
    zcr_mean = _mean(zcr)
    tonality = float(np.clip(1.0 - zcr_mean * 8.0, 0.0, 1.0))

    # Harmonic stability from tonnetz std
    try:
        tonnetz = librosa.feature.tonnetz(y=y_harm, sr=sr)
        tonnetz_std = float(np.mean(np.std(tonnetz, axis=1)))
        harmonic_stability = float(np.clip(1.0 - tonnetz_std * 3.0, 0.0, 1.0))
    except Exception:
        harmonic_stability = 0.5

    valence = float(np.clip(
        0.45 * mode_bias +
        0.25 * tonality +
        0.15 * float(np.clip(key_strength, 0.0, 1.0)) +
        0.15 * harmonic_stability,
        0.0, 1.0
    ))

    # Danceability: consistent beat strengths → steady pulse
    if beat_strengths:
        bs = np.asarray(beat_strengths)
        danceability = float(np.clip(1.0 - float(np.std(bs)) * 2.0, 0.0, 1.0))
    else:
        danceability = 0.5

    return {
        'valence':      round(valence, 3),
        'arousal':      round(arousal, 3),
        'loudness':     round(loudness, 3),
        'brightness':   round(brightness, 3),
        'danceability': round(danceability, 3),
        'kickiness':    round(kickiness, 3),
    }


# ── Segmentation ─────────────────────────────────────────────────────────────

def compute_segments_laplacian(y, sr, beat_frames, beat_times,
                               norm_rms, rms_times,
                               norm_centroid, bass_n, stft_times):
    """
    Beat-synchronous Laplacian segmentation (McFee & Ellis 2014).
    Repeated sections share a label, which the auto-show uses for coherence.
    Falls back to an energy-change segmenter when the track is too short or
    the CQT path fails.
    """
    import numpy as np
    import sys as _sys

    if beat_frames is None or len(beat_frames) < 10 or len(beat_times) < 10:
        return _segments_energy_fallback(norm_rms, rms_times, norm_centroid, bass_n, stft_times)

    try:
        import librosa
        import scipy.linalg
        import scipy.ndimage
        from scipy.sparse.csgraph import laplacian as csgraph_laplacian

        BINS_PER_OCTAVE = 12 * 3
        N_OCTAVES = 6
        C = librosa.amplitude_to_db(
            np.abs(librosa.cqt(
                y=y, sr=sr,
                bins_per_octave=BINS_PER_OCTAVE,
                n_bins=N_OCTAVES * BINS_PER_OCTAVE,
            )),
            ref=np.max,
        )

        # Guard: make sure beat_frames don't over-run the CQT frame grid.
        # Can happen if HPSS shaved the tail or if beat_frames came from PLP
        # on a slightly different onset-envelope grid.
        cqt_len = C.shape[1]
        bf = np.asarray(beat_frames, dtype=int)
        bf = bf[(bf >= 0) & (bf < cqt_len)]
        if len(bf) < 8:
            raise ValueError('insufficient beats within CQT range')

        Csync = librosa.util.sync(C, bf, aggregate=np.median)

        mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
        mfcc_len = mfcc.shape[1]
        bf_mfcc = bf[(bf >= 0) & (bf < mfcc_len)]
        if len(bf_mfcc) < 8:
            raise ValueError('insufficient beats within MFCC range')
        Msync = librosa.util.sync(mfcc, bf_mfcc, aggregate=np.mean)

        # Align both syncs to the same length (defensive — they should match)
        n_beats = min(Csync.shape[1], Msync.shape[1])
        if n_beats < 8:
            raise ValueError('too few beats for laplacian segmentation')
        Csync = Csync[:, :n_beats]
        Msync = Msync[:, :n_beats]

        # Recurrence affinity from CQT, median-filtered along time-lag diagonals
        R = librosa.segment.recurrence_matrix(
            Csync, width=3, mode='affinity', sym=True
        )
        df = librosa.segment.timelag_filter(scipy.ndimage.median_filter)
        Rf = df(R, size=(1, 7))

        # Sequential path similarity from MFCC (local continuity)
        path_distance = np.sum(np.diff(Msync, axis=1) ** 2, axis=0)
        sigma = float(np.median(path_distance)) if path_distance.size else 1.0
        sigma = sigma if sigma > 1e-9 else 1.0
        path_sim = np.exp(-path_distance / sigma)
        R_path = np.diag(path_sim, k=1) + np.diag(path_sim, k=-1)

        # Weight the two affinities by degree so neither dominates
        deg_path = np.sum(R_path, axis=1)
        deg_rec = np.sum(Rf, axis=1)
        denom = float(np.sum((deg_path + deg_rec) ** 2))
        mu = float(deg_path.dot(deg_path + deg_rec) / denom) if denom > 1e-9 else 0.5
        A = mu * Rf + (1 - mu) * R_path

        # Normalized Laplacian spectral embedding
        L = csgraph_laplacian(A, normed=True)
        # eigh can return NaN rows if A has isolated nodes — guard for that.
        _, evecs = scipy.linalg.eigh(L)
        if not np.all(np.isfinite(evecs)):
            raise ValueError('non-finite eigenvectors')
        evecs = scipy.ndimage.median_filter(evecs, size=(9, 1))
        Cnorm = np.cumsum(evecs ** 2, axis=1) ** 0.5

        # Pick k ≈ 1 cluster per ~40 s, clamp [3, 7]. Larger period than the
        # librosa gallery example because too many clusters shatter calm
        # tracks (recurrence matrix looks near-uniform → Laplacian ping-pongs
        # between labels, producing 40+ tiny segments).
        track_len = float(beat_times[-1]) if len(beat_times) else 60.0
        k = int(max(3, min(7, round(track_len / 40.0))))
        k = min(k, n_beats - 1)
        if k < 2:
            raise ValueError('not enough beats for clustering')

        X = evecs[:, :k] / (Cnorm[:, k - 1:k] + 1e-9)
        if not np.all(np.isfinite(X)):
            raise ValueError('non-finite embedding')

        seg_ids = None
        try:
            from sklearn.cluster import KMeans
            seg_ids = KMeans(n_clusters=k, n_init=10, random_state=0).fit_predict(X)
        except Exception:
            try:
                from scipy.cluster.vq import kmeans2
                _, seg_ids = kmeans2(X, k, minit='++', seed=0)
            except Exception:
                raise
        seg_ids = np.asarray(seg_ids)
        if seg_ids.size != n_beats or not np.all(np.isfinite(seg_ids)):
            raise ValueError('kmeans produced invalid labels')

        # Boundary beats are label-change positions
        change_beats = 1 + np.flatnonzero(seg_ids[:-1] != seg_ids[1:])
        change_beats = np.concatenate([[0], change_beats, [n_beats]])

        segments = []
        for j in range(len(change_beats) - 1):
            b_start = int(change_beats[j])
            b_end = int(change_beats[j + 1])
            if b_end <= b_start:
                continue

            t_start = float(beat_times[min(b_start, len(beat_times) - 1)])
            if b_end < len(beat_times):
                t_end = float(beat_times[b_end])
            else:
                t_end = float(beat_times[-1])
                if len(beat_times) > 1:
                    t_end += float(beat_times[-1] - beat_times[-2])
            if t_end <= t_start:
                continue

            rms_mask = (rms_times >= t_start) & (rms_times < t_end)
            stft_mask = (stft_times >= t_start) & (stft_times < t_end)

            seg_energy = float(np.mean(norm_rms[rms_mask])) if np.any(rms_mask) else 0.0
            seg_spectral = float(np.mean(norm_centroid[stft_mask])) if np.any(stft_mask) else 0.0
            seg_bass = float(np.mean(bass_n[stft_mask])) if np.any(stft_mask) else 0.0

            if seg_energy > 0.55:
                level = 'high'
            elif seg_energy > 0.25:
                level = 'mid'
            else:
                level = 'low'

            label = chr(ord('A') + (int(seg_ids[b_start]) % 26))
            segments.append({
                'start': round(t_start, 3),
                'end': round(t_end, 3),
                'energy': round(seg_energy, 3),
                'brightness': round(seg_spectral, 3),
                'bass': round(seg_bass, 3),
                'level': level,
                'label': label,
            })

        segments = _merge_short_segments(segments, min_seconds=8.0)
        if segments:
            return segments
    except Exception as exc:
        # Log to stderr so we know when the fallback kicks in. stdout is
        # reserved for JSON.
        print(f'[essentia-analyze] laplacian segmentation fell back: {exc}', file=_sys.stderr)

    return _segments_energy_fallback(norm_rms, rms_times, norm_centroid, bass_n, stft_times)


def _merge_short_segments(segments, min_seconds=8.0):
    """
    Merge any segment shorter than `min_seconds` into a neighbour. Prefer
    merging into an adjacent segment that shares the same label; otherwise
    merge into whichever neighbour is longer.

    This exists because Laplacian segmentation on gentle / ambient tracks can
    produce 1-3 s sliver segments as the clustering ping-pongs between close
    cluster centroids. Those slivers cause pattern thrashing in the show.
    """
    if not segments:
        return segments

    segs = [dict(s) for s in segments]  # work on copies

    # Iterate until no more slivers remain
    changed = True
    while changed and len(segs) > 1:
        changed = False
        for i, s in enumerate(segs):
            dur = s['end'] - s['start']
            if dur >= min_seconds:
                continue
            # Decide target neighbour
            prev_seg = segs[i - 1] if i > 0 else None
            next_seg = segs[i + 1] if i + 1 < len(segs) else None

            target = None
            if prev_seg and next_seg:
                if prev_seg.get('label') == s.get('label'):
                    target = prev_seg
                elif next_seg.get('label') == s.get('label'):
                    target = next_seg
                else:
                    # Merge into the longer neighbour so we don't chain
                    # slivers into each other.
                    prev_dur = prev_seg['end'] - prev_seg['start']
                    next_dur = next_seg['end'] - next_seg['start']
                    target = prev_seg if prev_dur >= next_dur else next_seg
            elif prev_seg:
                target = prev_seg
            elif next_seg:
                target = next_seg
            else:
                break

            # Extend the target's time range to include the sliver.
            # Keep the target's label/level; they represent the dominant
            # section. Energy / brightness / bass are duration-weighted means.
            tdur = target['end'] - target['start']
            sdur = dur
            total = max(tdur + sdur, 1e-6)
            for key in ('energy', 'brightness', 'bass'):
                if key in target and key in s:
                    target[key] = round(
                        (target[key] * tdur + s[key] * sdur) / total, 3
                    )
            if target is prev_seg:
                target['end'] = s['end']
            else:
                target['start'] = s['start']
            segs.pop(i)
            changed = True
            break

    return segs


def _segments_energy_fallback(norm_rms, rms_times, norm_centroid, bass_n, stft_times):
    """Energy change-point segmentation — used when Laplacian path can't run."""
    import numpy as np

    energy = np.asarray(norm_rms)
    times = np.asarray(rms_times)
    spectral = np.asarray(norm_centroid)
    bass = np.asarray(bass_n) if len(bass_n) else None
    bass_times_arr = np.asarray(stft_times) if len(stft_times) else None

    if len(energy) < 50 or len(times) < 50:
        return [{
            'start': 0.0,
            'end': float(times[-1]) if len(times) else 0.0,
            'energy': 0.5, 'brightness': 0.5, 'bass': 0.5,
            'level': 'mid', 'label': 'A',
        }]

    window = min(80, len(energy) // 4)
    kernel = np.ones(window) / window
    smoothed = np.convolve(energy, kernel, mode='same')

    fps = len(times) / (float(times[-1]) if times[-1] > 0 else 1.0)
    min_frames = int(4.0 * fps)
    look = max(10, int(1.0 * fps))
    threshold = 0.08

    change_points = [0]
    last_cp = 0
    for i in range(1, len(smoothed)):
        if i - last_cp < min_frames:
            continue
        prev_avg = float(np.mean(smoothed[max(0, i - look):i]))
        next_avg = float(np.mean(smoothed[i:min(len(smoothed), i + look)]))
        if abs(next_avg - prev_avg) > threshold:
            change_points.append(i)
            last_cp = i
    change_points.append(len(energy) - 1)

    segments = []
    for j in range(len(change_points) - 1):
        s, e = change_points[j], change_points[j + 1]
        if e <= s:
            continue
        seg_energy = float(np.mean(energy[s:e]))
        seg_spectral = float(np.mean(spectral[s:e]))
        seg_bass = 0.0
        if bass is not None and bass_times_arr is not None and len(bass):
            t_lo, t_hi = times[s], times[e]
            mask = (bass_times_arr >= t_lo) & (bass_times_arr < t_hi)
            if np.any(mask):
                seg_bass = float(np.mean(bass[mask]))
        if seg_energy > 0.55:
            level = 'high'
        elif seg_energy > 0.25:
            level = 'mid'
        else:
            level = 'low'
        segments.append({
            'start': round(float(times[s]), 3),
            'end': round(float(times[e]), 3),
            'energy': round(seg_energy, 3),
            'brightness': round(seg_spectral, 3),
            'bass': round(seg_bass, 3),
            'level': level,
            'label': 'A',
        })
    return segments


# ── Drop & build-up detection ────────────────────────────────────────────────

def detect_drops(norm_rms, rms_times, kick_n, stft_times,
                 flux_n, kick_flux_n, norm_centroid, beat_times,
                 downbeat_idxs=None):
    """
    Drop detector:
      1. Build weighted novelty = kick-flux + RMS-delta + full flux + centroid-jump
      2. Adaptive peak pick with local mean thresholding (librosa.util.peak_pick)
      3. Validate EDM drop shape:
          • preceding breakdown (RMS below track median for several seconds)
          • sustained post-drop loudness (stays near max for ≥ 4 s)
          • kick reactivation (after-kick > 1.8× before-kick)
      4. Snap to nearest beat (or downbeat if one is that nearest beat)
      5. Continuous confidence score = geometric mean of component scores
    """
    import numpy as np

    drops = []
    buildups = []

    n = len(rms_times)
    if n < 40:
        return drops, buildups

    rms_arr = np.asarray(norm_rms)
    rms_t = np.asarray(rms_times)
    track_len = float(rms_t[-1]) if rms_t[-1] > 0 else 1.0
    fps = n / track_len

    # Resample STFT-rate features onto the RMS time base
    def to_rms_grid(values, value_times):
        if values is None or len(values) == 0 or value_times is None or len(value_times) == 0:
            return np.zeros(n)
        vt = np.asarray(value_times)
        va = np.asarray(values)
        idxs = np.clip(np.searchsorted(vt, rms_t), 0, len(va) - 1)
        return va[idxs]

    kick_r        = to_rms_grid(kick_n,        stft_times)
    flux_r        = to_rms_grid(flux_n,        stft_times[:len(flux_n)])
    kick_flux_r   = to_rms_grid(kick_flux_n,   stft_times[:len(kick_flux_n)])
    centroid_r    = to_rms_grid(norm_centroid, stft_times)

    # Short smoothing (~0.5 s) for novelty components
    w_smooth = max(3, int(0.5 * fps))
    kernel = np.ones(w_smooth) / w_smooth
    def smooth(x): return np.convolve(x, kernel, mode='same')

    rms_s        = smooth(rms_arr)
    kick_s       = smooth(kick_r)
    flux_s       = smooth(flux_r)
    kick_flux_s  = smooth(kick_flux_r)
    centroid_s   = smooth(centroid_r)

    # 2 s delta features (how much did X rise across this instant)
    delta_w = max(3, int(2.0 * fps))
    def delta(x):
        d = np.zeros_like(x)
        for i in range(delta_w, len(x) - delta_w):
            d[i] = float(np.mean(x[i:i + delta_w])) - float(np.mean(x[i - delta_w:i]))
        return d

    rms_delta      = delta(rms_s)
    kick_delta     = delta(kick_s)
    centroid_delta = delta(centroid_s)

    # Weighted drop novelty — only positive jumps matter
    novelty = (
        0.40 * np.clip(kick_flux_s,          0.0, 1.0) +
        0.25 * np.clip(rms_delta      * 2.5, 0.0, 1.0) +
        0.20 * np.clip(flux_s,               0.0, 1.0) +
        0.10 * np.clip(kick_delta     * 2.5, 0.0, 1.0) +
        0.05 * np.clip(centroid_delta * 2.5, 0.0, 1.0)
    )
    novelty = smooth(novelty)

    # Adaptive peak picking with a 6 s refractory period
    try:
        import librosa
        peaks = librosa.util.peak_pick(
            novelty.astype(float),
            pre_max=int(0.5 * fps), post_max=int(0.5 * fps),
            pre_avg=int(3.0 * fps), post_avg=int(3.0 * fps),
            delta=0.15,
            wait=int(6.0 * fps),
        )
    except Exception:
        peaks = np.array([], dtype=int)

    breakdown_w = max(int(4.0 * fps), 10)
    sustain_w   = max(int(4.0 * fps), 10)
    kick_win    = max(int(2.0 * fps), 5)

    track_median_rms = float(np.median(rms_s))
    novelty_p99 = float(np.percentile(novelty, 99)) if novelty.size else 1.0
    novelty_p99 = novelty_p99 if novelty_p99 > 1e-9 else 1.0

    downbeat_idx_set = set(downbeat_idxs) if downbeat_idxs else set()

    for p in peaks:
        if p < breakdown_w or p + sustain_w >= len(rms_s):
            continue

        before_win  = rms_s[p - breakdown_w:p]
        after_win   = rms_s[p:p + sustain_w]
        kick_before = kick_s[max(0, p - kick_win):p]
        kick_after  = kick_s[p:p + kick_win]

        before_rms  = float(np.mean(before_win))
        after_rms   = float(np.mean(after_win))
        after_max   = float(np.max(after_win))
        before_kick = float(np.mean(kick_before))
        after_kick  = float(np.mean(kick_after))

        # 1. Preceding breakdown: before window sits below track median
        breakdown_score = float(np.clip(
            (track_median_rms - before_rms) / max(track_median_rms, 0.2) + 0.2,
            0.0, 1.0
        ))

        # 2. Sustained post-drop: stays above 0.7 × peak for most of the window
        sustain_ratio = float(np.mean(after_win > 0.7 * after_max)) if after_max > 1e-3 else 0.0

        # 3. Kick reactivation
        kick_ratio = after_kick / (before_kick + 0.05)
        kick_score = float(np.clip((kick_ratio - 1.0) / 1.5, 0.0, 1.0))

        # 4. Novelty peak strength
        nov_score = float(np.clip(novelty[p] / novelty_p99, 0.0, 1.0))

        # 5. Post-drop absolute loudness
        loud_score = float(np.clip((after_rms - 0.35) / 0.3, 0.0, 1.0))

        # Geometric-mean confidence (all factors must contribute)
        confidence = (
            max(breakdown_score, 0.1) *
            max(sustain_ratio,   0.1) *
            max(kick_score,      0.1) *
            max(nov_score,       0.1) *
            max(loud_score,      0.1)
        ) ** (1.0 / 5.0)

        if confidence < 0.55:
            continue

        # Snap to nearest beat if within half a beat (~0.35 s @ 100 BPM).
        # If that beat is also a downbeat, upgrade snapTo to 'downbeat'.
        drop_t = float(rms_t[p])
        snap_to = None
        if len(beat_times):
            beat_arr = np.asarray(beat_times)
            nearest_idx = int(np.argmin(np.abs(beat_arr - drop_t)))
            nearest = float(beat_arr[nearest_idx])
            if abs(nearest - drop_t) < 0.35:
                drop_t = nearest
                if downbeat_idx_set and nearest_idx in downbeat_idx_set:
                    snap_to = 'downbeat'
                else:
                    snap_to = 'beat'

        drops.append({
            't': round(drop_t, 3),
            'confidence': round(float(confidence), 3),
            'energyAfter': round(after_rms, 3),
            'kickAfter': round(after_kick, 3),
            'breakdownScore': round(breakdown_score, 3),
            'sustainScore': round(sustain_ratio, 3),
            'snapTo': snap_to,
        })

    # ── Build-ups: rising energy/brightness/flux in the ~8 s before a drop ─
    for drop in drops:
        dt = drop['t']
        end_idx = int(np.searchsorted(rms_t, dt))
        if end_idx < 4:
            continue
        start_idx = max(0, end_idx - int(8.0 * fps))
        rms_win      = rms_s[start_idx:end_idx]
        centroid_win = centroid_s[start_idx:end_idx]
        flux_win     = flux_s[start_idx:end_idx]
        if len(rms_win) < 4:
            continue

        rms_rise      = float(rms_win[-1] - rms_win[0])
        centroid_rise = float(centroid_win[-1] - centroid_win[0])
        tail = max(2, len(flux_win) // 3)
        flux_rise     = float(np.mean(flux_win[-tail:]) - np.mean(flux_win[:tail]))

        rising_ratio = float(np.sum(np.diff(rms_win) > 0)) / max(1, len(rms_win) - 1)

        if (rms_rise > 0.10 or centroid_rise > 0.15) and rising_ratio > 0.5:
            strength = float(np.clip(
                0.5 * rms_rise * 2.0 +
                0.3 * centroid_rise * 2.0 +
                0.2 * flux_rise * 2.0,
                0.0, 1.0
            ))
            buildups.append({
                'start': round(float(rms_t[start_idx]), 3),
                'end': round(dt, 3),
                'strength': round(strength, 3),
            })

    return drops, buildups


# ── Entry point ──────────────────────────────────────────────────────────────

def main():
    # Usage:
    #   python essentia-analyze.py <audio_file_or_url>
    #   python essentia-analyze.py <audio_file_or_url> --target-duration <sec>
    argv = sys.argv[1:]
    if not argv:
        json.dump({'error': 'Usage: python essentia-analyze.py <audio_file_or_url> [--target-duration <sec>]'}, sys.stdout)
        sys.exit(1)

    target_duration_sec = None
    positional = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--target-duration' and i + 1 < len(argv):
            try:
                target_duration_sec = float(argv[i + 1])
            except ValueError:
                json.dump({'error': f'Invalid --target-duration: {argv[i + 1]}'}, sys.stdout)
                sys.exit(1)
            i += 2
            continue
        positional.append(a)
        i += 1

    if not positional:
        json.dump({'error': 'Missing audio file or URL'}, sys.stdout)
        sys.exit(1)

    source = positional[0]
    filepath = source
    cleanup = False

    if source.startswith('http://') or source.startswith('https://'):
        try:
            filepath = download_audio(source)
            cleanup = True
        except Exception as exc:
            json.dump({'error': f'Failed to download audio: {exc}'}, sys.stdout)
            sys.exit(1)

    if not os.path.isfile(filepath):
        json.dump({'error': f'File not found: {filepath}'}, sys.stdout)
        sys.exit(1)

    try:
        result = analyze(filepath, target_duration_sec=target_duration_sec)
        json.dump(result, sys.stdout)
    except Exception as exc:
        json.dump({'error': str(exc)}, sys.stdout)
        sys.exit(1)
    finally:
        if cleanup and os.path.exists(filepath):
            os.remove(filepath)


if __name__ == '__main__':
    main()
