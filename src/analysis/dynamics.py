"""
Stage 6 — the moments a show is built around.

Sections say what the music *is*; this stage says what it *does*: where it
falls away, where it climbs, where it lands. These are the events an operator
would put a marker on, and they are the ones worth spending the rig's biggest
gestures on.

  drop       energy transition that rises hard and then holds
  buildup    the rising tension immediately before one
  break      a sustained fall — the recovery a show needs to have contrast
  silence    genuine near-zero passages, which must be respected, not lit
  spike      a short excursion above the local baseline (a crash, a stab)

The recurring difficulty is that all five look alike in an energy curve if you
only measure the slope. What separates them is what happens *after*: a drop
sustains, a spike does not; a break sustains downwards, a dip does not. So
every detector here measures both sides of the transition and scores them
independently, and the confidence it reports is how well the two agree.
"""

from dataclasses import dataclass, field

import numpy as np

from . import dsp
from .config import DynamicsConfig


@dataclass
class Drop:
    t: float
    confidence: float
    rise: float
    breakdown: float
    sustain: float
    snap: str = 'raw'
    #: 'proper' (breakdown then sustained slam) or 'hype' (impact without one).
    kind: str = 'hype'

    def to_dict(self):
        return {
            't': round(self.t, 3),
            'confidence': round(self.confidence, 3),
            'rise': round(self.rise, 3),
            'breakdownScore': round(self.breakdown, 3),
            'sustainScore': round(self.sustain, 3),
            'snapTo': self.snap,
            'kind': self.kind,
        }


@dataclass
class Span:
    start: float
    end: float
    intensity: float = 0.0
    #: For build-ups: how far the roll subdivides by the end (1, 2, 4, 8...).
    subdivision: int = 1

    def to_dict(self):
        return {
            'start': round(self.start, 3),
            'end': round(self.end, 3),
            'intensity': round(self.intensity, 3),
            'subdivision': int(self.subdivision),
        }


@dataclass
class Dynamics:
    drops: list = field(default_factory=list)
    buildups: list = field(default_factory=list)
    breaks: list = field(default_factory=list)
    silences: list = field(default_factory=list)
    spikes: list = field(default_factory=list)
    #: Combined 0..1 impact curve on the frame grid — what the detectors read.
    impact: np.ndarray = field(default_factory=lambda: np.zeros(0))


# ── The curve the detectors read ────────────────────────────────────────────

def impact_curve(features, bands, rhythm):
    """
    One 0..1 curve standing for "how hard is this hitting".

    Energy alone is not it: a sustained wall of synth is loud and hits nothing.
    The mix below is weighted towards the things that make a moment land — the
    low end, and the rate of change — with overall loudness as the base.
    """
    if features.n_frames == 0:
        return np.zeros(0)

    energy = dsp.robust_norm(features.rms)
    low = bands['bass'].envelope if 'bass' in bands else np.zeros(features.n_frames)
    sub = bands['sub'].envelope if 'sub' in bands else np.zeros(features.n_frames)
    flux = dsp.robust_norm(features.flux)
    intensity = rhythm.intensity if rhythm.intensity.size == features.n_frames \
        else np.zeros(features.n_frames)

    curve = (0.40 * energy + 0.25 * low + 0.10 * sub
             + 0.10 * flux + 0.15 * intensity)
    smooth = dsp.moving_average(curve, max(3, int(features.frame_rate * 0.25)))
    return dsp.robust_norm(smooth)


# ── Drops ───────────────────────────────────────────────────────────────────

def _window_mean(curve, centre, span, before):
    lo = max(0, centre - span) if before else centre
    hi = centre if before else min(curve.size, centre + span)
    if hi <= lo:
        return 0.0
    return float(np.mean(curve[lo:hi]))


def detect_drops(impact, times, frame_rate, beats, downbeats, config: DynamicsConfig):
    """
    Find energy transitions that rise hard and hold.

    Three scores per candidate, all 0..1:

      rise       how much the level jumps across the transition
      breakdown  how far the bar or two before it sat below the new level.
                 This is what makes a drop a drop rather than a crescendo, and
                 it is the term that keeps the detector off every chorus entry.
      sustain    whether the new level is still there four seconds later. A
                 cymbal crash rises exactly as fast as a drop and fails here.

    The transition is then snapped to the nearest downbeat within half a bar,
    because a drop is always written on one and the detector's own resolution
    is coarser than the bar.
    """
    if impact.size < 16:
        return []

    short = max(2, int(frame_rate * 1.0))
    long_span = max(4, int(frame_rate * 4.0))
    sustain_span = max(4, int(frame_rate * config.drop_sustain_sec))

    # Rise measured as the step between the second before and the second after.
    rise = np.zeros(impact.size)
    for i in range(short, impact.size - short):
        rise[i] = (_window_mean(impact, i, short, before=False)
                   - _window_mean(impact, i, short, before=True))

    candidates = dsp.adaptive_peaks(
        np.maximum(rise, 0.0),
        pre=int(frame_rate * 6), post=int(frame_rate * 6), delta=0.4,
        wait=max(1, int(frame_rate * config.drop_min_gap_sec * 0.5)))

    bar_seconds = 0.0
    if downbeats is not None and len(downbeats) >= 2:
        bar_seconds = float(np.median(np.diff(downbeats)))

    drops = []
    for i in candidates:
        rise_value = float(rise[i])
        if rise_value < config.drop_min_rise:
            continue
        after = _window_mean(impact, i, long_span, before=False)
        before = _window_mean(impact, i, long_span, before=True)
        breakdown = after - before
        if breakdown < config.drop_min_breakdown:
            continue

        held = _window_mean(impact, i + sustain_span // 2, sustain_span, before=False)
        peak = _window_mean(impact, i, short, before=False)
        sustain = dsp.clamp01(held / peak) if peak > 1e-6 else 0.0
        if sustain < 0.45:
            continue

        t = float(times[min(i, times.size - 1)])
        snap = 'raw'
        if bar_seconds > 0 and len(downbeats):
            nearest = downbeats[dsp.nearest_index(downbeats, t)]
            if abs(nearest - t) <= bar_seconds * 0.5:
                t, snap = float(nearest), 'downbeat'
        elif beats is not None and len(beats):
            nearest = beats[dsp.nearest_index(beats, t)]
            beat_period = float(np.median(np.diff(beats))) if len(beats) > 1 else 0.0
            if beat_period and abs(nearest - t) <= beat_period * 0.5:
                t, snap = float(nearest), 'beat'

        confidence = dsp.clamp01(
            0.35 * dsp.clamp01(rise_value / 0.5)
            + 0.35 * dsp.clamp01(breakdown / 0.45)
            + 0.30 * sustain)
        kind = 'proper' if (breakdown >= 0.28 and sustain >= 0.65) else 'hype'
        drops.append(Drop(t=t, confidence=confidence, rise=rise_value,
                          breakdown=dsp.clamp01(breakdown / 0.6),
                          sustain=sustain, snap=snap, kind=kind))

    return _thin_drops(drops, times, config)


def _thin_drops(drops, times, config: DynamicsConfig):
    """
    Enforce a minimum gap and a per-track budget, most confident first.

    A three-minute pop song does not have eight drops. When the detector says it
    does, it is firing on every chorus entry, and a show that treats all eight
    as the biggest moment of the track has no biggest moment at all.
    """
    if not drops:
        return []
    duration = float(times[-1]) if times.size else 0.0
    ordered = sorted(drops, key=lambda d: -d.confidence)

    kept = []
    for drop in ordered:
        if any(abs(drop.t - k.t) < config.drop_min_gap_sec for k in kept):
            continue
        kept.append(drop)

    budget = max(2, int(np.ceil(duration / config.drop_density_sec))) if duration else 2
    kept = kept[:budget]
    return sorted(kept, key=lambda d: d.t)


# ── Build-ups ───────────────────────────────────────────────────────────────

def detect_buildups(impact, features, times, frame_rate, drops, onsets,
                    config: DynamicsConfig):
    """
    The rising tension before each drop.

    Searched backwards from the drop rather than found independently: a rise
    that does not arrive anywhere is a crescendo, and lighting it like a
    build-up promises a payoff the track never delivers.

    `subdivision` records how far the drum roll actually subdivides by the end
    of the window — 1 for no roll, 2 for eighths, 4 for sixteenths, 8 for
    thirty-seconds. The show engine escalates its beat division to match, so a
    build-up that really does double twice gets a rig that doubles twice, and a
    flat one does not.
    """
    if impact.size < 8 or not drops:
        return []

    brightness = dsp.robust_norm(features.centroid)
    flux = dsp.robust_norm(features.flux)

    buildups = []
    for drop in drops:
        end_idx = int(np.clip(np.searchsorted(times, drop.t), 1, impact.size - 1))
        max_span = int(frame_rate * config.buildup_max_sec)
        min_span = int(frame_rate * config.buildup_min_sec)
        start_idx = max(0, end_idx - max_span)
        if end_idx - start_idx < min_span:
            continue

        window = slice(start_idx, end_idx)
        combined = (0.45 * impact[window] + 0.30 * brightness[window]
                    + 0.25 * flux[window])
        if combined.size < min_span:
            continue

        # The build-up starts where the music was quietest before the drop, not
        # wherever the slope last happened to be positive: walking back on the
        # slope alone keeps going through the whole preceding section, because
        # a verse rises gently too. Anchor on the minimum, then trim forward
        # until the stretch really is mostly rising.
        smooth = dsp.moving_average(combined, max(3, int(frame_rate * 0.5)))
        # Take the start that makes the window *most* like a ramp, not the
        # earliest one that merely passes. A window of "flat verse, then riser"
        # still correlates with time well enough to pass a threshold, so an
        # earliest-passing search hands back the verse as part of the build-up.
        anchor = int(np.argmin(smooth))
        step = max(1, int(frame_rate * 0.25))
        best_start, best_trend = None, config.buildup_trend
        for offset in range(anchor, smooth.size - min_span, step):
            trend = _trend(smooth[offset:])
            if trend >= best_trend:
                best_start, best_trend = offset, trend
        if best_start is None:
            continue

        start_time = float(times[start_idx + best_start])
        if drop.t - start_time < config.buildup_min_sec:
            continue

        lift = float(smooth[-1] - smooth[best_start])
        buildups.append(Span(
            start=start_time,
            end=float(drop.t),
            intensity=dsp.clamp01(lift / 0.5),
            subdivision=roll_subdivision(onsets, start_time, drop.t),
        ))

    return buildups


def _trend(values):
    """Pearson correlation between a curve and time — 1.0 for a clean ramp,
    0.0 for anything flat or noisy. This is the test for "is this rising"."""
    values = np.asarray(values, dtype=float)
    if values.size < 4:
        return 0.0
    ramp = np.arange(values.size, dtype=float)
    spread = float(np.std(values))
    if spread < 1e-9:
        return 0.0
    return float(np.corrcoef(ramp, values)[0, 1])


def roll_subdivision(onsets, start, end, base_divisions=(1, 2, 4, 8)):
    """
    How far the drum roll subdivides across a build-up.

    Compare the onset rate in the first third of the window with the last
    third; the ratio, rounded to the nearest power of two, is how many times
    the roll has doubled. Measured rather than assumed, because build-ups that
    stay flat are common and escalating the rig on one of those spends the
    show's biggest gesture on nothing.
    """
    onsets = np.asarray(onsets, dtype=float)
    if onsets.size < 4 or end <= start:
        return 1
    span = end - start
    third = span / 3.0
    early = np.sum((onsets >= start) & (onsets < start + third))
    late = np.sum((onsets >= end - third) & (onsets < end))
    if early < 2 or late < 2:
        return 1
    ratio = late / float(early)
    best = 1
    for division in base_divisions:
        if ratio >= division * 0.75:
            best = division
    return best


# ── Breaks, silences, spikes ────────────────────────────────────────────────

def detect_breaks(impact, times, frame_rate, config: DynamicsConfig):
    """Sustained falls — where the show should pull back and let the room breathe."""
    if impact.size < 16:
        return []
    span = max(2, int(frame_rate * 2.0))
    hold = max(2, int(frame_rate * config.break_min_sec))
    breaks = []
    i = span
    while i < impact.size - hold:
        before = float(np.mean(impact[i - span:i]))
        after = float(np.mean(impact[i:i + hold]))
        if before - after >= config.break_min_fall:
            end = i + hold
            while end < impact.size and impact[end] < before - config.break_min_fall * 0.6:
                end += 1
            breaks.append(Span(start=float(times[i]),
                               end=float(times[min(end, times.size - 1)]),
                               intensity=dsp.clamp01((before - after) / 0.6)))
            i = end + span
        else:
            i += max(1, span // 2)
    return breaks


def detect_silences(features, config: DynamicsConfig):
    """Contiguous near-silent passages. The show must go dark here, not idle."""
    if features.rms.size == 0:
        return []
    # Smoothed over a beat's worth of frames: the raw RMS curve dips to near
    # zero *between* kicks, and an unsmoothed test reports a silence in the
    # gaps of a four-on-the-floor track — several hundred of them.
    energy = dsp.robust_norm(
        dsp.moving_average(features.rms, max(3, int(features.frame_rate * 0.5))))
    quiet = energy < config.silence_threshold
    min_frames = max(1, int(config.silence_min_sec * features.frame_rate))
    spans, start = [], None
    for i, is_quiet in enumerate(quiet):
        if is_quiet and start is None:
            start = i
        elif not is_quiet and start is not None:
            if i - start >= min_frames:
                spans.append(Span(start=float(features.times[start]),
                                  end=float(features.times[i - 1]),
                                  intensity=0.0))
            start = None
    if start is not None and quiet.size - start >= min_frames:
        spans.append(Span(start=float(features.times[start]),
                          end=float(features.times[-1]), intensity=0.0))
    return spans


def detect_spikes(impact, times, frame_rate, config: DynamicsConfig):
    """
    Short excursions above the local baseline — crashes, stabs, risers landing.

    Kept separate from drops because they want a completely different gesture:
    a spike is a single accent, and treating one as a drop means the show
    changes scene for a cymbal.
    """
    if impact.size < 16:
        return []
    baseline = dsp.moving_average(impact, max(3, int(frame_rate * 6.0)))
    deviation = impact - baseline
    sigma = float(np.std(deviation)) or 1e-6
    peaks = dsp.adaptive_peaks(
        np.maximum(deviation, 0.0), pre=int(frame_rate * 2), post=int(frame_rate * 2),
        delta=0.5, wait=max(1, int(frame_rate * 0.5)))
    spikes = []
    for i in peaks:
        if deviation[i] / sigma < config.spike_min_sigma:
            continue
        spikes.append(Span(start=float(times[i]), end=float(times[min(i + int(frame_rate * 0.3),
                                                                     times.size - 1)]),
                           intensity=dsp.clamp01(deviation[i] / (4.0 * sigma))))
    return spikes


def _clip_breaks(breaks, drops):
    """
    End a break at the next drop inside it.

    The extension loop follows the energy back up, and after a breakdown the
    energy comes back up *at the drop* — so an unclipped break runs straight
    through the biggest moment in the track and tells the show to stay pulled
    back for it.
    """
    if not breaks or not drops:
        return breaks
    times = sorted(d.t for d in drops)
    clipped = []
    for span in breaks:
        for t in times:
            if span.start < t < span.end:
                span.end = t
                break
        if span.end > span.start:
            clipped.append(span)
    return clipped


# ── Entry point ─────────────────────────────────────────────────────────────

def analyse(features, bands, rhythm, config: DynamicsConfig = None) -> Dynamics:
    config = config or DynamicsConfig()
    impact = impact_curve(features, bands, rhythm)
    times = features.times
    frame_rate = features.frame_rate

    drops = detect_drops(impact, times, frame_rate, rhythm.beats,
                         rhythm.downbeats, config)
    buildups = detect_buildups(impact, features, times, frame_rate, drops,
                               rhythm.onsets, config)
    breaks = _clip_breaks(detect_breaks(impact, times, frame_rate, config), drops)
    return Dynamics(
        drops=drops,
        buildups=buildups,
        breaks=breaks,
        silences=detect_silences(features, config),
        spikes=detect_spikes(impact, times, frame_rate, config),
        impact=impact,
    )
