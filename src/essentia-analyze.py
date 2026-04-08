#!/usr/bin/env python3
"""
Audio analysis bridge for artnet-lightshow auto mode.
Uses librosa for cross-platform music information retrieval.

Usage: python essentia-analyze.py <audio_file_or_url>
Output: JSON analysis to stdout (segments, beats, BPM, key, energy, onsets,
                                 drops, buildups, band energies, beat strengths)
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


def estimate_key(chroma):
    import numpy as np

    chroma_avg = np.mean(chroma, axis=1)
    if np.max(chroma_avg) == 0:
        return 'C', 'major', 0.0

    best_corr = -2
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


def analyze(filepath):
    import librosa
    import numpy as np

    # Load audio (mono, 22050 Hz — good balance of speed/quality)
    y, sr = librosa.load(filepath, sr=22050, mono=True)
    duration = librosa.get_duration(y=y, sr=sr)

    # ── Harmonic / percussive separation (cheap, improves beat detection) ──
    try:
        y_harm, y_perc = librosa.effects.hpss(y, margin=3.0)
    except Exception:
        y_harm, y_perc = y, y

    # ── Rhythm (BPM + beats) — run on percussive component ─────────
    tempo, beat_frames = librosa.beat.beat_track(y=y_perc, sr=sr, trim=False)
    bpm = float(np.atleast_1d(tempo)[0])
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)

    # ── Key / Scale (chroma of harmonic component) ─────────────────
    chroma = librosa.feature.chroma_stft(y=y_harm, sr=sr)
    key, scale, key_strength = estimate_key(chroma)

    # ── Frame-level RMS (overall loudness) ─────────────────────────
    rms = librosa.feature.rms(y=y)[0]
    rms_times = librosa.times_like(rms, sr=sr)
    max_rms = float(np.max(rms)) if np.max(rms) > 0 else 1.0
    norm_rms = rms / max_rms

    # ── Multi-band energy via STFT (bass / mid / high) ─────────────
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=512))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    bass_mask = freqs < 250
    high_mask = freqs >= 4000
    bass_energy = np.sqrt(np.mean(S[bass_mask] ** 2, axis=0)) if np.any(bass_mask) else np.zeros(S.shape[1])
    high_energy = np.sqrt(np.mean(S[high_mask] ** 2, axis=0)) if np.any(high_mask) else np.zeros(S.shape[1])

    def _norm(arr):
        m = float(np.max(arr)) if arr.size and np.max(arr) > 0 else 1.0
        return (arr / m).astype(float)

    bass_n = _norm(bass_energy)
    high_n = _norm(high_energy)

    # Align rms to the STFT hop so the arrays share a time grid
    stft_times = librosa.frames_to_time(np.arange(S.shape[1]), sr=sr, hop_length=512)

    # ── Spectral centroid (brightness) ─────────────────────────────
    centroid = librosa.feature.spectral_centroid(S=S, sr=sr)[0]
    max_centroid = float(np.max(centroid)) if np.max(centroid) > 0 else 1.0
    norm_centroid = centroid / max_centroid

    # ── Spectral flux / novelty curve (for drop detection) ─────────
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=512)
    flux_n = _norm(onset_env)

    # ── Onset detection (all-band) ─────────────────────────────────
    onset_frames = librosa.onset.onset_detect(
        y=y, sr=sr, units='frames', hop_length=512, backtrack=False
    )
    onset_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=512)

    # ── Bass-specific onsets (kick hits) ───────────────────────────
    bass_env = librosa.onset.onset_strength(
        S=librosa.amplitude_to_db(S[bass_mask], ref=np.max) if np.any(bass_mask) else None,
        sr=sr,
        hop_length=512,
    ) if np.any(bass_mask) else np.zeros(S.shape[1])
    bass_onset_frames = librosa.onset.onset_detect(
        onset_envelope=bass_env, sr=sr, hop_length=512, units='frames', backtrack=False
    )
    bass_onset_times = librosa.frames_to_time(bass_onset_frames, sr=sr, hop_length=512)

    # ── Per-beat strength (sample flux at each beat frame) ─────────
    beat_strengths = []
    if len(beat_times) > 0 and len(flux_n) > 0:
        for bt in beat_times:
            idx = int(round(bt * sr / 512))
            if 0 <= idx < len(flux_n):
                beat_strengths.append(float(flux_n[idx]))
            else:
                beat_strengths.append(0.0)

    # ── Segmentation (energy + brightness change detection) ───────
    segments = compute_segments(
        norm_rms.tolist(),
        rms_times.tolist(),
        norm_rms.tolist(),
        norm_centroid.tolist(),
        bass_n.tolist() if len(bass_n) else [],
        stft_times.tolist() if len(stft_times) else [],
        sr,
    )

    # ── Drop / build-up detection ──────────────────────────────────
    drops, buildups = detect_drops(
        norm_rms, rms_times, bass_n, stft_times, flux_n, duration,
    )

    # ── Downsample energy curves (1 value per second) ──────────────
    energy_curve = downsample(norm_rms.tolist(), rms_times.tolist(), step=1.0)
    bass_curve   = downsample(bass_n.tolist(),  stft_times.tolist(), step=0.5) if len(bass_n) else []
    high_curve   = downsample(high_n.tolist(),  stft_times.tolist(), step=0.5) if len(high_n) else []

    return {
        'duration': round(float(duration), 3),
        'bpm': round(bpm, 1),
        'beats': [round(float(b), 3) for b in beat_times],
        'beatStrengths': [round(s, 3) for s in beat_strengths],
        'beatsConfidence': 1.0,
        'key': key,
        'scale': scale,
        'keyStrength': key_strength,
        'segments': segments,
        'onsets': [round(float(o), 3) for o in onset_times],
        'bassOnsets': [round(float(o), 3) for o in bass_onset_times],
        'drops': drops,
        'buildups': buildups,
        'energyCurve': energy_curve,
        'bassCurve': bass_curve,
        'highCurve': high_curve,
    }


def downsample(values, times, step=1.0):
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


def compute_segments(energy, times, loudness, spectral, bass, bass_times, sr):
    """Segment the track based on smoothed energy envelope changes."""
    import numpy as np

    if len(energy) < 50 or len(times) < 50:
        return [{
            'start': 0,
            'end': times[-1] if times else 0,
            'energy': 0.5,
            'loudness': 0.5,
            'spectralCentroid': 0.5,
            'bass': 0.5,
            'level': 'mid',
        }]

    energy = np.array(energy)
    loudness = np.array(loudness)
    spectral = np.array(spectral)
    bass = np.array(bass) if bass else None
    bass_times_arr = np.array(bass_times) if bass_times else None

    window = min(80, len(energy) // 4)
    kernel = np.ones(window) / window
    smoothed = np.convolve(energy, kernel, mode='same')

    fps = len(times) / (times[-1] if times[-1] > 0 else 1)
    min_frames = int(4.0 * fps)
    look = max(10, int(1.0 * fps))
    threshold = 0.08

    change_points = [0]
    last_cp = 0

    for i in range(1, len(smoothed)):
        if i - last_cp < min_frames:
            continue
        prev_start = max(0, i - look)
        next_end = min(len(smoothed), i + look)
        prev_avg = float(np.mean(smoothed[prev_start:i]))
        next_avg = float(np.mean(smoothed[i:next_end]))
        if abs(next_avg - prev_avg) > threshold:
            change_points.append(i)
            last_cp = i

    change_points.append(len(energy) - 1)

    segments = []
    for j in range(len(change_points) - 1):
        s = change_points[j]
        e = change_points[j + 1]
        if e <= s:
            continue

        seg_energy = float(np.mean(energy[s:e]))
        seg_loudness = float(np.mean(loudness[s:e]))
        seg_spectral = float(np.mean(spectral[s:e]))

        # Sample bass curve over the same time range
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
            'start': round(times[s], 3),
            'end': round(times[e], 3),
            'energy': round(seg_energy, 3),
            'loudness': round(seg_loudness, 3),
            'spectralCentroid': round(seg_spectral, 6),
            'bass': round(seg_bass, 3),
            'level': level,
        })

    return segments


def detect_drops(rms, rms_times, bass, bass_times, flux, duration):
    """
    Detect drops and build-ups.

    A drop is a sudden, sustained jump in overall loudness + bass energy,
    usually preceded by a quieter build-up (low bass, rising flux).
    """
    import numpy as np

    drops = []
    buildups = []

    if len(rms) < 20 or len(rms_times) < 20:
        return drops, buildups

    rms = np.asarray(rms)
    rms_times = np.asarray(rms_times)
    fps_rms = len(rms) / (rms_times[-1] if rms_times[-1] > 0 else 1)

    # Smooth rms over ~1 second
    w = max(3, int(1.0 * fps_rms))
    kernel = np.ones(w) / w
    smooth = np.convolve(rms, kernel, mode='same')

    # Resample bass onto rms time base (nearest)
    bass_on_rms = np.zeros_like(smooth)
    if len(bass) and len(bass_times):
        bass = np.asarray(bass)
        bass_times = np.asarray(bass_times)
        # nearest-neighbour lookup
        idxs = np.searchsorted(bass_times, rms_times)
        idxs = np.clip(idxs, 0, len(bass) - 1)
        bass_on_rms = bass[idxs]
        bass_smooth = np.convolve(bass_on_rms, kernel, mode='same')
    else:
        bass_smooth = smooth

    # Resample flux similarly — flux uses stft hop 512 at 22050 → ~43 fps
    flux_fps = 22050 / 512
    flux_on_rms = np.zeros_like(smooth)
    if len(flux):
        flux = np.asarray(flux)
        flux_times = np.arange(len(flux)) / flux_fps
        idxs = np.searchsorted(flux_times, rms_times)
        idxs = np.clip(idxs, 0, len(flux) - 1)
        flux_on_rms = flux[idxs]

    # Compare a short "before" window to a short "after" window
    before_w = max(3, int(2.5 * fps_rms))  # ~2.5s lookback
    after_w  = max(3, int(2.5 * fps_rms))  # ~2.5s lookahead
    min_gap  = max(5, int(6.0 * fps_rms))  # drops at least 6s apart

    last_drop = -min_gap
    for i in range(before_w, len(smooth) - after_w):
        if i - last_drop < min_gap:
            continue
        before_rms  = float(np.mean(smooth[i - before_w:i]))
        after_rms   = float(np.mean(smooth[i:i + after_w]))
        before_bass = float(np.mean(bass_smooth[i - before_w:i]))
        after_bass  = float(np.mean(bass_smooth[i:i + after_w]))
        local_flux  = float(np.max(flux_on_rms[max(0, i - 2):i + 3]))

        rms_jump  = after_rms - before_rms
        bass_jump = after_bass - before_bass

        # A "drop" is: strong RMS jump, strong bass jump, after section is loud,
        # and there's a sharp novelty spike nearby.
        is_drop = (
            rms_jump  > 0.18 and
            bass_jump > 0.18 and
            after_rms > 0.45 and
            local_flux > 0.40
        )
        if is_drop:
            # Find precise drop time: peak of flux in a small window around i
            win_lo = max(0, i - 2)
            win_hi = min(len(flux_on_rms), i + 3)
            local = flux_on_rms[win_lo:win_hi]
            peak_offset = int(np.argmax(local))
            drop_idx = win_lo + peak_offset
            drop_t = float(rms_times[drop_idx])
            drops.append({
                't': round(drop_t, 3),
                'strength': round(min(1.0, rms_jump + bass_jump), 3),
                'energyAfter': round(after_rms, 3),
                'bassAfter': round(after_bass, 3),
            })
            last_drop = drop_idx

    # Build-ups: a sustained monotonic rise in flux/rms in the seconds before a drop.
    for drop in drops:
        dt = drop['t']
        end_idx = int(np.searchsorted(rms_times, dt))
        if end_idx < 4:
            continue
        # Look back up to ~8 seconds for a sustained rise
        start_idx = max(0, end_idx - int(8.0 * fps_rms))
        window = smooth[start_idx:end_idx]
        if len(window) < 4:
            continue
        # Check monotonic rise (at least 60% of consecutive diffs positive)
        diffs = np.diff(window)
        rising_ratio = float(np.sum(diffs > 0)) / max(1, len(diffs))
        total_rise = float(window[-1] - window[0])
        if rising_ratio > 0.55 and total_rise > 0.10:
            buildups.append({
                'start': round(float(rms_times[start_idx]), 3),
                'end': round(dt, 3),
                'strength': round(min(1.0, total_rise * 2), 3),
            })

    return drops, buildups


def main():
    if len(sys.argv) < 2:
        json.dump({'error': 'Usage: python essentia-analyze.py <audio_file_or_url>'}, sys.stdout)
        sys.exit(1)

    source = sys.argv[1]
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
        result = analyze(filepath)
        json.dump(result, sys.stdout)
    except Exception as exc:
        json.dump({'error': str(exc)}, sys.stdout)
        sys.exit(1)
    finally:
        if cleanup and os.path.exists(filepath):
            os.remove(filepath)


if __name__ == '__main__':
    main()
