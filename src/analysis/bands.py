"""
Stage 3 — seven perceptual bands, and what each one is doing musically.

The point of this stage is the second half of that sentence. A band's *level*
is the least interesting thing about it: mapping level to brightness is exactly
the naive volume-reactive behaviour the show engine is meant to replace. What a
lighting designer actually reads off a mix is character —

  is the low end punching (kick) or sustaining (bass line)?
  is the top end ticking (hats) or washing (cymbals, reverb)?
  is the middle carrying a voice, or a pad?

so each band is described by an envelope plus four shape measurements:

  attack      how fast it rises into a hit, in milliseconds. Short = percussive.
  decay       how fast it falls after one. Short = tight, long = sustained.
  variation   how much it moves relative to its own average. A pad sits still;
              a kick pattern swings the whole way every bar.
  rhythmic    how well the envelope correlates with the beat grid. This is what
              separates "there is bass energy" from "the bass is the groove".

Those four combine into an `importance` score — how much of the track's
identity this band carries — which is what the show engine uses to decide which
band drives which fixture group, instead of always driving everything from the
kick.
"""

from dataclasses import dataclass, field

import numpy as np

from . import dsp
from .config import BANDS, BAND_ORDER


@dataclass
class Band:
    name: str
    low_hz: float
    high_hz: float
    #: Normalised envelope on the frame grid.
    envelope: np.ndarray = field(default_factory=lambda: np.zeros(0))
    #: Raw RMS envelope, before normalisation.
    raw: np.ndarray = field(default_factory=lambda: np.zeros(0))
    #: Half-wave rectified difference of the envelope — the band's own onsets.
    flux: np.ndarray = field(default_factory=lambda: np.zeros(0))
    #: Onset times detected within this band alone, seconds.
    onsets: np.ndarray = field(default_factory=lambda: np.zeros(0))
    energy: float = 0.0
    attack_ms: float = 0.0
    decay_ms: float = 0.0
    variation: float = 0.0
    rhythmic: float = 0.0
    percussive_ratio: float = 0.0
    importance: float = 0.0

    def to_dict(self, curve_step=0.5, times=None, duration=None):
        out = {
            'name': self.name,
            'range': [self.low_hz, self.high_hz],
            'energy': round(self.energy, 4),
            'attackMs': round(self.attack_ms, 1),
            'decayMs': round(self.decay_ms, 1),
            'variation': round(self.variation, 4),
            'rhythmic': round(self.rhythmic, 4),
            'percussive': round(self.percussive_ratio, 4),
            'importance': round(self.importance, 4),
        }
        if times is not None:
            out['curve'] = dsp.resample_curve(self.envelope, times, curve_step, duration)
        return out


def _band_mask(frequencies, low, high):
    return (frequencies >= low) & (frequencies < high)


def _band_rms(magnitude, mask):
    if not np.any(mask):
        return np.zeros(magnitude.shape[1])
    return np.sqrt(np.mean(magnitude[mask] ** 2, axis=0))


def _attack_decay_ms(envelope, frame_rate):
    """
    Median 10→90 % rise time and 90→10 % fall time around the envelope's own
    peaks, in milliseconds.

    Measured around real peaks rather than as a global average because the
    average of a kick band is dominated by the gaps between kicks, and those
    have no attack at all.
    """
    env = np.asarray(envelope, dtype=float)
    if env.size < 8 or frame_rate <= 0:
        return 0.0, 0.0
    peaks = dsp.adaptive_peaks(env, pre=int(frame_rate), post=int(frame_rate),
                               delta=0.2, wait=max(2, int(frame_rate * 0.08)))
    if peaks.size == 0:
        return 0.0, 0.0

    frame_ms = 1000.0 / frame_rate
    attacks, decays = [], []
    span = max(2, int(frame_rate * 0.5))
    for p in peaks[:200]:
        peak = env[p]
        if peak <= 1e-6:
            continue
        lo, hi = 0.1 * peak, 0.9 * peak

        start = p
        while start > 0 and start > p - span and env[start] > lo:
            start -= 1
        cross_hi = p
        while cross_hi > start and env[cross_hi] > hi:
            cross_hi -= 1
        if cross_hi > start:
            attacks.append((p - start) * frame_ms)

        end = p
        n = env.size
        while end < n - 1 and end < p + span and env[end] > lo:
            end += 1
        if end > p:
            decays.append((end - p) * frame_ms)

    attack = float(np.median(attacks)) if attacks else 0.0
    decay = float(np.median(decays)) if decays else 0.0
    return attack, decay


def _rhythmic_correlation(envelope, times, beat_times):
    """
    How much of the band's movement lands on the beat.

    Comparison is against a shuffled-phase baseline: any energetic band
    correlates *somewhat* with any grid simply because both are busy. What
    matters is whether it correlates more at the true beat positions than at
    arbitrary ones, which is what the ratio below measures. 0.5 means "no better
    than chance", 1.0 means every movement is on a beat.
    """
    env = np.asarray(envelope, dtype=float)
    beats = np.asarray(beat_times, dtype=float)
    if env.size < 8 or beats.size < 4:
        return 0.0

    idx = np.searchsorted(times, beats)
    idx = idx[(idx > 0) & (idx < env.size)]
    if idx.size < 4:
        return 0.0

    on_beat = float(np.mean(env[idx]))
    overall = float(np.mean(env))
    if overall <= 1e-9:
        return 0.0

    # Offsets by a half beat: if the band is the groove, the half-beat sample
    # is markedly lower; if it is a pad, both are the same.
    period = float(np.median(np.diff(beats))) if beats.size > 1 else 0.0
    if period <= 0:
        return dsp.clamp01(on_beat / (2.0 * overall))
    off_beats = beats[:-1] + period * 0.5
    off_idx = np.searchsorted(times, off_beats)
    off_idx = off_idx[(off_idx > 0) & (off_idx < env.size)]
    off_beat = float(np.mean(env[off_idx])) if off_idx.size else overall

    total = on_beat + off_beat
    if total <= 1e-9:
        return 0.0
    return dsp.clamp01((on_beat / total - 0.5) * 2.0 + 0.5)


def _percussive_ratio(percussive_mag, harmonic_mag, mask):
    if not np.any(mask) or percussive_mag.size == 0 or harmonic_mag.size == 0:
        return 0.0
    perc = float(np.mean(percussive_mag[mask] ** 2))
    harm = float(np.mean(harmonic_mag[mask] ** 2))
    total = perc + harm
    if total <= 1e-15:
        return 0.0
    return dsp.clamp01(perc / total)


def analyse(features, beat_times=None, config=None):
    """
    Build the seven bands from a `FrameFeatures`.

    `beat_times` is optional: without it the rhythmic-correlation term is zero
    and `importance` falls back to level and movement alone. The pipeline calls
    this after the rhythm stage so the correlation is available; the realtime
    path calls it without one on the first few seconds.
    """
    frequencies = features.frequencies
    frame_rate = features.frame_rate
    nyquist = features.sample_rate / 2.0

    bands = {}
    for name in BAND_ORDER:
        low, high = BANDS[name]
        # Bands that reach past the analysis Nyquist are measured off the
        # wideband pass instead; `air` is entirely above it.
        source, source_freqs = features.magnitude, frequencies
        if high > nyquist and features.wideband_magnitude.size:
            source = features.wideband_magnitude
            source_freqs = features.wideband_frequencies
        wb_nyquist = source_freqs[-1] if source_freqs.size else nyquist
        mask = _band_mask(source_freqs, low, min(high, wb_nyquist))
        raw = _band_rms(source, mask)
        envelope = dsp.robust_norm(raw)
        band_flux = np.maximum(np.diff(envelope, prepend=envelope[:1]), 0.0)

        onset_idx = dsp.adaptive_peaks(
            band_flux, pre=int(frame_rate), post=int(frame_rate * 0.5),
            delta=0.35, wait=max(1, int(frame_rate * 0.05)))

        attack_ms, decay_ms = _attack_decay_ms(envelope, frame_rate)
        band = Band(
            name=name,
            low_hz=low,
            high_hz=high,
            envelope=envelope,
            raw=raw,
            flux=band_flux,
            onsets=features.times[onset_idx] if onset_idx.size else np.zeros(0),
            energy=round(float(np.mean(envelope)), 4) if envelope.size else 0.0,
            attack_ms=attack_ms,
            decay_ms=decay_ms,
            variation=round(dsp.coefficient_of_variation(raw), 4),
            rhythmic=round(_rhythmic_correlation(
                envelope, features.times,
                beat_times if beat_times is not None else []), 4),
            percussive_ratio=round(_percussive_ratio(
                features.percussive_magnitude, features.harmonic_magnitude,
                _band_mask(frequencies, low, min(high, nyquist))), 4),
        )
        bands[name] = band

    _score_importance(bands)
    return bands


def _score_importance(bands):
    """
    Composite 0..1 score: how much this band defines the track.

    Weighted towards movement and rhythm rather than level, because level is
    already accounted for by the mix engineer — every mastered track has bass
    energy, and reading "lots of bass energy" as "important" would rank the
    bass band first on literally every song.
    """
    energies = np.array([b.energy for b in bands.values()])
    peak_energy = float(np.max(energies)) if energies.size else 0.0
    for band in bands.values():
        level = band.energy / peak_energy if peak_energy > 1e-9 else 0.0
        movement = dsp.clamp01(band.variation / 1.5)
        band.importance = round(dsp.clamp01(
            0.30 * level + 0.30 * movement + 0.40 * band.rhythmic), 4)


# ── Instrument roles ────────────────────────────────────────────────────────
#
# The band measurements above are enough to name what is playing, without a
# separate source-separation model. These are the rules a mix engineer would
# use by ear, written down:
#
#   kick    sub/bass, percussive, attack under ~40 ms, strongly on the grid
#   bassline sub/bass, harmonic or long-decay, moves with the harmony
#   snare   presence band, percussive, on the backbeat
#   hats    high/air, percussive, very short attack, dense
#   vocal   mid + presence, harmonic, moderate variation, not on the grid
#   synth   mid/lowmid harmonic with chroma movement
#
# Each role gets an activity curve on the frame grid, which the event stage
# turns into BASS_HIT / VOCAL_SECTION / MELODY_CHANGE events.

ROLES = ('kick', 'bassline', 'snare', 'hats', 'vocal', 'synth')


@dataclass
class InstrumentRoles:
    curves: dict = field(default_factory=dict)
    scores: dict = field(default_factory=dict)

    def curve(self, name):
        return self.curves.get(name, np.zeros(0))

    def to_dict(self, times=None, duration=None, curve_step=0.5):
        out = {'scores': {k: round(float(v), 4) for k, v in self.scores.items()}}
        if times is not None:
            out['curves'] = {
                name: dsp.resample_curve(curve, times, curve_step, duration)
                for name, curve in self.curves.items()
            }
        return out


def infer_roles(features, bands, tags=None):
    """
    Derive per-role activity curves and confidence scores.

    `tags` is the optional AudioSet tag dictionary from the perception stage.
    When present it only ever *adjusts* the scores — the curves stay signal-
    derived, so a missing or wrong tag degrades the show's nuance rather than
    breaking its timing.
    """
    perc = features.percussive_magnitude
    harm = features.harmonic_magnitude
    freqs = features.frequencies
    n = features.n_frames
    if n == 0:
        return InstrumentRoles()

    def band_of(mag, low, high):
        mask = _band_mask(freqs, low, high)
        if not np.any(mask):
            return np.zeros(n)
        return dsp.robust_norm(np.sqrt(np.mean(mag[mask] ** 2, axis=0)))

    kick = band_of(perc, 35.0, 130.0)
    bassline = band_of(harm, 45.0, 250.0)
    snare = band_of(perc, 180.0, 400.0) * 0.4 + band_of(perc, 1800.0, 5500.0) * 0.6
    hats = band_of(perc, 6000.0, min(14000.0, features.sample_rate / 2.0))
    vocal = band_of(harm, 300.0, 3500.0)
    synth = band_of(harm, 500.0, 6000.0)

    # A vocal is a mid-band harmonic that *moves*: sustained pads sit at the
    # same level for bars at a time. Weight the curve by local movement so a
    # held pad does not read as a singer.
    vocal_motion = dsp.moving_average(
        np.abs(np.diff(vocal, prepend=vocal[:1])), max(3, int(features.frame_rate * 0.5)))
    vocal = dsp.robust_norm(vocal * dsp.unit_norm(vocal_motion + 0.15))

    # A synth line is defined by harmonic movement, which shows up in chroma.
    chroma_change = np.zeros(n)
    if features.chroma.size:
        c = features.chroma[:, :n]
        norm = np.linalg.norm(c, axis=0) + 1e-9
        unit = c / norm
        cos = np.sum(unit[:, 1:] * unit[:, :-1], axis=0)
        chroma_change = np.concatenate([[0.0], 1.0 - cos])
        chroma_change = dsp.moving_average(chroma_change, max(3, int(features.frame_rate)))
    synth = dsp.robust_norm(synth * (0.5 + dsp.unit_norm(chroma_change)))

    curves = {
        'kick': kick, 'bassline': bassline, 'snare': snare,
        'hats': hats, 'vocal': vocal, 'synth': synth,
    }

    scores = {
        'kick': dsp.clamp01(bands['bass'].importance * 0.5
                            + bands['sub'].importance * 0.2
                            + (1.0 if bands['bass'].attack_ms and bands['bass'].attack_ms < 45 else 0.0) * 0.3),
        'bassline': dsp.clamp01(bands['bass'].energy * 0.6
                                + (1.0 - bands['bass'].percussive_ratio) * 0.4),
        'snare': dsp.clamp01(bands['presence'].importance * 0.7
                             + bands['presence'].percussive_ratio * 0.3),
        'hats': dsp.clamp01(bands['high'].importance * 0.6
                            + bands['air'].importance * 0.2
                            + bands['high'].percussive_ratio * 0.2),
        'vocal': dsp.clamp01(float(np.mean(vocal)) * 1.4),
        'synth': dsp.clamp01(float(np.mean(synth)) * 1.2
                             + float(np.mean(chroma_change)) * 0.6),
    }

    if tags:
        # AudioSet labels are a strong prior on presence, a weak one on level.
        boost = {
            'vocal': max(tags.get('singing', 0.0), tags.get('speech', 0.0),
                         tags.get('female singing', 0.0), tags.get('male singing', 0.0)),
            'kick': max(tags.get('bass drum', 0.0), tags.get('drum kit', 0.0),
                        tags.get('drum', 0.0)),
            'hats': max(tags.get('hi-hat', 0.0), tags.get('cymbal', 0.0)),
            'snare': tags.get('snare drum', 0.0),
            'synth': max(tags.get('synthesizer', 0.0), tags.get('keyboard (musical)', 0.0)),
            'bassline': max(tags.get('bass guitar', 0.0), tags.get('bass (instrument)', 0.0)),
        }
        for role, prior in boost.items():
            if prior > 0:
                scores[role] = dsp.clamp01(0.7 * scores[role] + 0.3 * prior + 0.15 * prior)

    return InstrumentRoles(curves=curves, scores=scores)
