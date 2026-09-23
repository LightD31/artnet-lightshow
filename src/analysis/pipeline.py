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

*The learned classifiers run in parallel with the DSP.* Neither needs anything
from the rest of the pipeline — the AudioSet tagger reads the file directly and
MuQ-MuLan needs only the decoded waveform — and on CPU both are several seconds.
Started as early as their input exists and collected just before the stage that
consumes them, they cost close to nothing.

The document it returns keeps every field name the previous analyser emitted,
at the top level, alongside the new structured sections. That is deliberate:
the web client, the timeline view and the cache all read those names, and a
schema change is not worth breaking them over. New consumers should read the
nested objects; the flat fields are a compatibility surface.
"""

import os
import sys
import time
import hashlib
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from . import (bands as bands_stage, dsp, dynamics as dynamics_stage,
               events as events_stage, features as features_stage,
               perception as perception_stage, preprocess as preprocess_stage,
               pulse as pulse_stage, rhythm as rhythm_stage, songformer,
               stems as stems_stage,
               structure as structure_stage, tagger)
from .config import AnalysisConfig, DEFAULT
from .version import SCHEMA_VERSION
from . import model_adapters, models


# The mood words MuQ-MuLan is asked about alongside the genre prompts. These
# are descriptions of a look rather than of a genre: the show engine reads them
# as colour and movement hints where the style only says how hard to push.
SEMANTIC_VOCABULARY = (
    'euphoric', 'dark', 'mechanical', 'organic', 'intimate', 'aggressive',
    'spacious', 'ceremonial', 'warm', 'cold', 'suspended', 'triumphant',
)


def _log(message):
    print(f'[pipeline] {message}', file=sys.stderr)


def analyze(path, target_duration_sec=None, config: AnalysisConfig = None):
    """Analyse one audio file and return the document as a plain dict."""
    config = config or DEFAULT
    started = time.time()

    if not os.path.isfile(path):
        raise FileNotFoundError(path)

    # Declared before the try so the `finally` can shut them down whichever
    # stage failed. The separation pool used to be declared inside it, and an
    # exception between its start and its collection left it behind.
    tag_pool, tag_future = None, None
    mulan_pool, mulan_future = None, None
    stem_pool, stem_future = None, None
    beat_pool, beat_turn = None, None
    key_pool, key_future = None, None
    form_pool, form_future = None, None
    # Only a tagger whose weights are already here. The analysis never
    # downloads: 310 MB fetched mid-track on venue wifi is a track that does
    # not get analysed, and possibly the one after it.
    tagging = config.enable_tagger and tagger.ready()

    # Import torch here, before the stage threads start. Left to them, the
    # separator's thread and this one import it for the first time at once,
    # and one of them gets a partially initialised module ("cannot import name
    # 'Buffer'"). The worker warms up first and never sees it; a one-shot
    # `analyze.py track.wav` did, and lost both its stems and its beats.
    import torch  # noqa: F401
    models.device()

    try:
        audio = preprocess_stage.prepare(path, config.preprocess, target_duration_sec)

        # The beat model first, on its own thread and first in line for the
        # card. Everything from the rhythm stage on waits for the grid, and it
        # needs nothing but the decoded audio — so it runs beside the feature
        # extraction instead of after it, and the separator and MuQ, started
        # next, queue behind it instead of in front of it.
        beat_turn = models.reserve_first_turn()
        beat_pool = ThreadPoolExecutor(max_workers=1)
        beat_future = beat_pool.submit(_beat_pass, audio, config.rhythm, beat_turn)

        # The tagger used to read the file itself, which let it start before
        # preprocessing — at the price of decoding and resampling the whole
        # track a second time. Preprocessing already produces exactly what it
        # wants: mono at 32 kHz, and loudness-normalised, so the same track
        # masters at two levels no longer tags differently. Waiting for that
        # costs less than the decode it saves, and it still overlaps every
        # stage after this one.
        if tagging:
            tag_pool = ThreadPoolExecutor(max_workers=1)
            tag_future = tag_pool.submit(_safe_tag, path, audio)

        # Separation is the most expensive stage and needs nothing but the
        # waveform, so it starts here and is collected as late as possible. On
        # a GPU it genuinely overlaps the feature extraction below; on a CPU it
        # queues behind it, which is no worse than running it in sequence.
        if config.separate_sources:
            stem_pool = ThreadPoolExecutor(max_workers=1)
            stem_future = stem_pool.submit(_safe_separate, audio)

        # MuQ-MuLan answers the genre question, so it has to be collected
        # before perception rather than tacked on after the document is built.
        # It wants the waveform rather than the file, which is why it starts
        # here and not alongside the AudioSet tagger. The timbre embeddings
        # ride along on the same thread: they share the resample, and nothing
        # in the pipeline reads them, so running them here rather than inline
        # at the end takes the slowest optional model off the critical path.
        if config.enable_semantics:
            mulan_pool = ThreadPoolExecutor(max_workers=1)
            mulan_future = mulan_pool.submit(_safe_muq, audio)

        # SongFormer names the sections (see songformer.py). The slowest model
        # here, and needed only by the structure stage, so it starts now and
        # is collected last.
        if songformer.wanted(config.structure_model):
            form_pool = ThreadPoolExecutor(max_workers=1)
            form_future = form_pool.submit(_safe_songformer, audio)

        # The key model reads the decoded file rather than decoding it again,
        # and nothing but the document waits for it.
        if model_adapters.skey_available():
            key_pool = ThreadPoolExecutor(max_workers=1)
            key_future = key_pool.submit(_safe_skey, audio)

        frames = features_stage.extract(audio, config.preprocess)

        rhythm = rhythm_stage.analyse(audio, frames, config.rhythm,
                                      model_result=beat_future.result)
        band_map = bands_stage.analyse(frames, rhythm.beats)

        tags = _collect(tag_future)
        stems = _collect(stem_future)
        muq = _collect(mulan_future) or {}
        mulan = muq.get('scores') or {}
        embeddings = muq.get('embeddings') or []
        roles = bands_stage.infer_roles(frames, band_map, stems, tags)

        dynamics = dynamics_stage.analyse(frames, band_map, rhythm, config.dynamics)
        model_sections = _collect(form_future) or None

        # Structure and perception are independent of each other and are the
        # two slowest remaining stages, so they run side by side.
        if config.parallel:
            with ThreadPoolExecutor(max_workers=2) as pool:
                sections_future = pool.submit(
                    structure_stage.analyse, frames, rhythm, roles,
                    [d.to_dict() for d in dynamics.drops], config.structure,
                    model_sections)
                perception_future = pool.submit(
                    perception_stage.analyse, frames, band_map, rhythm, roles,
                    tags, mulan.get('genre'))
                sections = sections_future.result()
                perception = perception_future.result()
        else:
            sections = structure_stage.analyse(
                frames, rhythm, roles, [d.to_dict() for d in dynamics.drops],
                config.structure, model_sections)
            perception = perception_stage.analyse(
                frames, band_map, rhythm, roles, tags, mulan.get('genre'))

        stream = events_stage.generate(frames, band_map, roles, rhythm, sections,
                                       dynamics, config.events)

        try:
            pulse = pulse_stage.analyse(audio, stems)
        except Exception as exc:
            _log(f'pixel envelopes unavailable ({exc})')
            pulse = None

        document = json_safe(build_document(
            audio, frames, rhythm, band_map, roles, sections, dynamics,
            perception, stream, stems, pulse))
        document['track']['hash'] = _file_hash(path)
        named_by_model = any(s.function for s in sections)
        document['sectionSource'] = 'songformer' if named_by_model else 'analysis'
        # Optional foundation-model passes are activated by local model
        # configuration and never block the deterministic core pipeline. Both
        # were collected above, off the critical path.
        document['embeddings'] = embeddings
        document['semantic_scores'] = mulan.get('semantic') or []
        document['meta']['modelUsage'] = {
            'rhythm': 'beat_this',
            'separation': getattr(stems, 'backend', 'none') if stems is not None else 'none',
            'key': 'internal_perception',
            # A successful model run can legitimately return no tags (for
            # silence), so use the submitted future rather than the result.
            'tagger': 'panns' if tag_future is not None else 'none',
            # What actually decided the show style, which is not the same as
            # what ran: a model that came back undecided loses to the signal.
            'genre': perception.genre_source,
            'skey': False,
            'structure': 'songformer' if named_by_model else 'laplacian',
            'muq': bool(document['embeddings']),
            'muqMulan': bool(document['semantic_scores']),
        }
        skey = _collect(key_future)
        if skey:
            document['key'] = skey['value']
            document['track']['key'] = skey['value']
            document['meta']['modelUsage']['key'] = 's-key'
            document['meta']['modelUsage']['skey'] = True
        document['meta']['elapsedSec'] = round(time.time() - started, 2)
        document['meta']['processingRatio'] = round(
            document['meta']['elapsedSec'] / max(0.001, audio.duration), 4)
        document['meta']['withinRealtimeBudget'] = (
            document['meta']['processingRatio'] < 1.0)
        # Once more over the finished document: the embeddings, the MuLan
        # scores and the S-KEY result were attached after the first pass, and
        # a NaN in any of them would reach the wire as a bare `NaN` that no
        # JSON parser accepts.
        document = json_safe(document)
        _log(f'{os.path.basename(path)}: {audio.duration:.1f}s analysed in '
             f'{document["meta"]["elapsedSec"]}s '
             f'({rhythm.bpm:.1f} BPM, {len(sections)} sections, '
             f'{len(dynamics.drops)} drops, {len(stream)} events)')
        return document
    finally:
        for pool in (beat_pool, stem_pool, tag_pool, mulan_pool, key_pool, form_pool):
            if pool is not None:
                pool.shutdown(wait=False)
        # A beat pass that never reached the card must not keep it from the
        # next track.
        models.cancel_turn(beat_turn)
        # The worker analyses one track after another for the life of the
        # show, so whatever this track reserved has to go back before the next
        # one asks for it — including on the failure path, where a half-built
        # stage is exactly the case that leaves the most behind.
        try:
            models.release_memory()
        except Exception:
            pass


def _beat_pass(audio, config, turn):
    """The beat model's pass; its reserved turn is given up if it never ran."""
    try:
        return rhythm_stage.model_beats(audio, config)
    finally:
        models.cancel_turn(turn)


def _safe_songformer(audio):
    """SongFormer's sections, from the decoded mix, on the analysis clock; or None."""
    try:
        head = int(round(audio.trim_offset * audio.source_rate))
        want = int(round(audio.duration * audio.source_rate))
        mix = np.mean(audio.source, axis=0)[head:head + want]
        return songformer.sections(mix, audio.source_rate)
    except Exception as exc:
        models.gpu_fault(exc)
        _log(f'SongFormer unavailable ({exc}); the sections come from self-similarity')
        return None


def _safe_skey(audio):
    try:
        return model_adapters.skey_key(audio.source_path, samples=audio.source,
                                       sample_rate=audio.source_rate)
    except Exception as exc:
        _log(f'optional S-KEY pass unavailable ({exc}); keeping internal key estimate')
        return None


def _safe_separate(audio):
    try:
        return stems_stage.separate(
            audio.mono, audio.sample_rate,
            stereo_loader=lambda rate: preprocess_stage.load_for_separation(audio, rate))
    except Exception as exc:
        _log(f'separation failed ({exc}); instrument roles fall back to bands')
        return None


def _file_hash(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_muq(audio):
    """Genre, mood and timbre in one MuQ visit, or `{}` when unavailable."""
    try:
        return model_adapters.muq_pass(audio.mono, audio.sample_rate, {
            'genre': perception_stage.genre_prompts(),
            'semantic': SEMANTIC_VOCABULARY,
        })
    except Exception as exc:
        _log(f'optional MuQ pass unavailable ({exc}); '
             f'genre falls back to the AudioSet tagger or the signal')
        return {}


def _safe_tag(path, audio=None):
    """
    Tag the already-decoded wideband signal, falling back to the file.

    `wideband` is None when the source had no bandwidth above the analysis
    rate. Resampling the mono signal up is still cheaper than decoding the file
    again, and the model is robust to the missing top octave — it is the same
    signal every other stage reads.
    """
    try:
        if audio is not None:
            if audio.wideband is not None and audio.wideband_rate:
                return tagger.tag(samples=audio.wideband, sample_rate=audio.wideband_rate)
            return tagger.tag(samples=audio.mono, sample_rate=audio.sample_rate)
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
                   perception, stream, stems=None, pulse=None):
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
        'track': {
            'hash': '',
            'duration': round(duration, 3),
            'bpm': round(rhythm.bpm, 2),
            'key': perception.key,
            'mode': perception.scale,
        },

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
        # What the track is made of, as shares of total energy. Measured from
        # the separated sources rather than inferred from the spectrum.
        'sources': (stems.energies() if stems is not None else None),
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
        # The music at pixel rate, for the LED bars (see pulse.py).
        **({'pulse': pulse} if pulse else {}),
        'meta': {
            'sampleRate': frames.sample_rate,
            'hopLength': frames.hop_length,
            'nFft': frames.n_fft,
            'frames': frames.n_frames,
            'trimOffset': round(audio.trim_offset, 3),
            'taggerUsed': bool(perception.tags),
            'beatSource': rhythm.source,
            'separated': stems is not None,
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
