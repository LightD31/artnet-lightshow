"""
Offline orchestration: file in, analysis document out.

Stage order is fixed by data dependency, not by preference:

    preprocess -> features -> rhythm -> bands -> dynamics -> structure
                                  \\-> perception -> (tags feed bands' roles)
                                                  \\-> events

Two things are worth knowing about the shape of this function.

*Bands run twice.* The first pass has no beat grid, so it cannot measure
rhythmic correlation — but the rhythm stage does not need the bands. Once beats
exist, the bands are recomputed with the correlation term filled in. It costs
one extra pass over already-computed spectrograms and it is what makes the
`importance` score mean anything.

*The tagger runs in parallel from the very start.* It reads the file directly
and needs nothing from the rest of the pipeline, and on CPU it is several
seconds. Started first and collected last, it is effectively free.

The document it returns keeps every field name the previous analyser emitted,
at the top level, alongside the new structured sections. That is deliberate:
the web client, the timeline view and the cache all read those names, and a
schema change is not worth breaking them over. New consumers should read the
nested objects; the flat fields are a compatibility surface.
"""

import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from . import (bands as bands_stage, dsp, dynamics as dynamics_stage,
               events as events_stage, features as features_stage,
               perception as perception_stage, preprocess as preprocess_stage,
               rhythm as rhythm_stage, structure as structure_stage, tagger)
from .config import AnalysisConfig, DEFAULT
from .version import SCHEMA_VERSION


def _log(message):
    print(f'[pipeline] {message}', file=sys.stderr)


def analyze(path, target_duration_sec=None, config: AnalysisConfig = None):
    """Analyse one audio file and return the document as a plain dict."""
    config = config or DEFAULT
    started = time.time()

    if not os.path.isfile(path):
        raise FileNotFoundError(path)

    tag_pool, tag_future = None, None
    if config.enable_tagger and tagger.installed():
        tag_pool = ThreadPoolExecutor(max_workers=1)
        tag_future = tag_pool.submit(_safe_tag, path)

    try:
        audio = preprocess_stage.prepare(path, config.preprocess, target_duration_sec)
        frames = features_stage.extract(audio, config.preprocess)

        rhythm = rhythm_stage.analyse(audio, frames, config.rhythm)
        band_map = bands_stage.analyse(frames, rhythm.beats)

        tags = _collect(tag_future)
        roles = bands_stage.infer_roles(frames, band_map, tags)

        dynamics = dynamics_stage.analyse(frames, band_map, rhythm, config.dynamics)

        # Structure and perception are independent of each other and are the
        # two slowest remaining stages, so they run side by side.
        if config.parallel:
            with ThreadPoolExecutor(max_workers=2) as pool:
                sections_future = pool.submit(
                    structure_stage.analyse, frames, rhythm, roles,
                    [d.to_dict() for d in dynamics.drops], config.structure)
                perception_future = pool.submit(
                    perception_stage.analyse, frames, band_map, rhythm, roles, tags)
                sections = sections_future.result()
                perception = perception_future.result()
        else:
            sections = structure_stage.analyse(
                frames, rhythm, roles, [d.to_dict() for d in dynamics.drops],
                config.structure)
            perception = perception_stage.analyse(
                frames, band_map, rhythm, roles, tags)

        stream = events_stage.generate(frames, band_map, roles, rhythm, sections,
                                       dynamics, config.events)

        document = json_safe(build_document(
            audio, frames, rhythm, band_map, roles, sections, dynamics,
            perception, stream))
        document['meta']['elapsedSec'] = round(time.time() - started, 2)
        _log(f'{os.path.basename(path)}: {audio.duration:.1f}s analysed in '
             f'{document["meta"]["elapsedSec"]}s '
             f'({rhythm.bpm:.1f} BPM, {len(sections)} sections, '
             f'{len(dynamics.drops)} drops, {len(stream)} events)')
        return document
    finally:
        if tag_pool is not None:
            tag_pool.shutdown(wait=False)


def _safe_tag(path):
    try:
        return tagger.tag(path=path)
    except Exception as exc:
        _log(f'tagger failed: {exc}')
        return None


def _collect(future):
    if future is None:
        return None
    try:
        return future.result()
    except Exception:
        return None


def json_safe(value):
    """
    Convert numpy scalars and arrays to plain Python types, recursively.

    numpy's bool_, float64 and int64 are not JSON-serialisable, and they leak
    into the document anywhere a comparison result or an array element is put
    straight into a dict. Catching them here rather than at each site means a
    new field cannot reintroduce the problem — and the failure mode it prevents
    is the worker returning an error for a track it analysed perfectly.
    """
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if isinstance(value, np.ndarray):
        return [json_safe(v) for v in value.tolist()]
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        v = float(value)
        return v if np.isfinite(v) else None
    if isinstance(value, float) and not np.isfinite(value):
        return None
    return value


# ── Document assembly ───────────────────────────────────────────────────────

def build_document(audio, frames, rhythm, band_map, roles, sections, dynamics,
                   perception, stream):
    """
    Assemble the analysis document.

    Curves are decimated before they go in. A four-minute track holds ten
    thousand frames per curve, and eleven curves of that size is a 40 MB JSON
    document travelling over a socket to a browser that draws it 900 pixels
    wide. One point every half second is more resolution than the timeline view
    can show.
    """
    times = frames.times
    duration = audio.duration

    energy_curve = dsp.resample_curve(frames.energy, times, 1.0, duration)
    band_curves = {
        name: band.to_dict(curve_step=0.5, times=times, duration=duration)
        for name, band in band_map.items()
    }

    document = {
        'schemaVersion': SCHEMA_VERSION,

        # ── Compatibility surface ──
        # Flat field names the previous analyser emitted. The web client, the
        # timeline view and the cache all read these; new code should prefer
        # the nested objects below.
        'duration': round(duration, 3),
        'bpm': round(rhythm.bpm, 1),
        'tempoCurve': dsp.resample_curve(rhythm.tempo_values, rhythm.tempo_times,
                                         2.0, duration),
        'tempoStability': round(rhythm.stability, 3),
        'beatSource': rhythm.source,
        'beats': _round_list(rhythm.beats),
        'beatStrengths': _round_list(rhythm.strengths),
        'downbeats': _round_list(rhythm.downbeats),
        'meter': rhythm.meter,
        'downbeatConfidence': round(rhythm.downbeat_confidence, 3),
        'key': perception.key,
        'scale': perception.scale,
        'keyStrength': perception.key_strength,
        'mood': perception.to_dict()['mood'],
        'genre': perception.to_dict()['genre'],
        'segments': [s.to_dict() for s in sections],
        'onsets': _round_list(rhythm.onsets),
        'kickOnsets': _round_list(_role_onsets(roles, frames, 'kick')),
        'drops': [d.to_dict() for d in dynamics.drops],
        'buildups': [b.to_dict() for b in dynamics.buildups],
        'energyCurve': energy_curve,
        'bassCurve': band_curves['bass']['curve'],
        'kickCurve': band_curves['sub']['curve'],
        'highCurve': band_curves['high']['curve'],

        # ── Structured document ──
        'loudness': {
            'integratedLufs': _finite(audio.integrated_lufs),
            'range': round(audio.loudness_range, 2),
            'truePeakDb': _finite(audio.true_peak_db),
            'appliedGainDb': round(audio.applied_gain_db, 2),
            'noiseFloorDb': _finite(audio.noise_floor_db),
            'snrDb': _finite(audio.snr_db),
            'denoised': audio.denoised,
        },
        'stereo': {
            'width': audio.width,
            'correlation': audio.correlation,
        },
        'rhythm': {
            'bpm': round(rhythm.bpm, 2),
            'beatPeriod': round(rhythm.beat_period, 4),
            'barPeriod': round(rhythm.bar_period, 4),
            'meter': rhythm.meter,
            'stability': round(rhythm.stability, 3),
            'source': rhythm.source,
            'downbeatConfidence': round(rhythm.downbeat_confidence, 3),
            'beatConfidences': _round_list(rhythm.confidences),
            'onsetStrengths': _round_list(rhythm.onset_strengths),
            'intensityCurve': dsp.resample_curve(rhythm.intensity, times, 0.5, duration),
        },
        'bands': band_curves,
        'instruments': roles.to_dict(times=times, duration=duration, curve_step=0.5),
        'structure': {
            'sections': [s.to_dict() for s in sections],
            'roles': sorted({s.role for s in sections}),
        },
        'dynamics': {
            'drops': [d.to_dict() for d in dynamics.drops],
            'buildups': [b.to_dict() for b in dynamics.buildups],
            'breaks': [b.to_dict() for b in dynamics.breaks],
            'silences': [s.to_dict() for s in dynamics.silences],
            'spikes': [s.to_dict() for s in dynamics.spikes],
            'impactCurve': dsp.resample_curve(dynamics.impact, times, 0.5, duration),
        },
        'perception': perception.to_dict(),
        'features': features_stage.summarise(frames),
        'events': [e.to_dict() for e in stream],
        'meta': {
            'sampleRate': frames.sample_rate,
            'hopLength': frames.hop_length,
            'nFft': frames.n_fft,
            'frames': frames.n_frames,
            'trimOffset': round(audio.trim_offset, 3),
            'taggerUsed': bool(perception.tags),
        },
    }
    return document


def _role_onsets(roles, frames, name):
    """Onset times for one instrument role, derived from its activity curve."""
    curve = roles.curve(name)
    if curve.size == 0:
        return np.zeros(0)
    flux = np.maximum(np.diff(curve, prepend=curve[:1]), 0.0)
    idx = dsp.adaptive_peaks(flux, pre=int(frames.frame_rate),
                             post=int(frames.frame_rate), delta=0.4,
                             wait=max(1, int(0.12 * frames.frame_rate)))
    return frames.times[idx] if idx.size else np.zeros(0)


def _round_list(values, digits=3):
    return [round(float(v), digits) for v in np.asarray(values).ravel()]


def _finite(value, digits=2):
    value = float(value)
    return round(value, digits) if np.isfinite(value) else None
