"""
Stage 8 — the musical event stream.

This is the interface between everything above and everything the lighting side
does. Nothing downstream reads a spectrogram; it reads events.

    audio -> analysis -> MUSICAL EVENTS -> lighting intent -> DMX

The indirection is the point. A direct audio-to-DMX mapping can only express
"louder means brighter", and it has to re-derive the same facts in every effect
it implements. An event stream lets the show engine reason about *music*: it can
decide to ignore three of the next four bars because a drop is coming, or to
hold a colour through a vocal phrase, because those are statements about events,
not about samples.

Every event carries the same five fields, so the show engine can treat an
unfamiliar type generically rather than crashing on it:

    t           when it happens, in seconds from the start of the track
    confidence  0..1, how sure the analyser is that this is real
    intensity   0..1, how big it is musically — *not* how bright to make it
    duration    how long it lasts, in seconds (0 for instantaneous)
    effect      the recommended gesture, as a hint the director may override

`effect` is advice, not instruction. The director owns pacing and contrast and
will refuse events that would break either; see `show/director.js`.
"""

from dataclasses import dataclass, asdict

import numpy as np

from . import dsp
from .config import EventConfig


# The event vocabulary. Anything not in here is a bug in this module.
BEAT = 'BEAT'
BAR = 'BAR'
DROP = 'DROP'
BUILDUP = 'BUILDUP'
ENERGY_SPIKE = 'ENERGY_SPIKE'
BASS_HIT = 'BASS_HIT'
VOCAL_SECTION = 'VOCAL_SECTION'
MELODY_CHANGE = 'MELODY_CHANGE'
SILENCE = 'SILENCE'
TRANSITION = 'TRANSITION'
BREAK = 'BREAK'
SECTION = 'SECTION'

TYPES = (BEAT, BAR, DROP, BUILDUP, ENERGY_SPIKE, BASS_HIT, VOCAL_SECTION,
         MELODY_CHANGE, SILENCE, TRANSITION, BREAK, SECTION)

# Recommended gestures. The renderer maps these onto whatever the rig can do.
EFFECTS = ('accent', 'pulse', 'flash', 'strobe', 'blinder', 'chase', 'sweep',
           'fade', 'wash', 'hold', 'blackout', 'color-shift', 'scene-change',
           'ramp')


@dataclass
class Event:
    t: float
    type: str
    confidence: float = 1.0
    intensity: float = 0.5
    duration: float = 0.0
    effect: str = 'accent'
    data: dict = None

    def to_dict(self):
        out = {
            't': round(float(self.t), 3),
            'type': self.type,
            'confidence': round(float(self.confidence), 3),
            'intensity': round(float(self.intensity), 3),
            'duration': round(float(self.duration), 3),
            'effect': self.effect,
        }
        if self.data:
            out['data'] = self.data
        return out


# ── Generators, one per event type ──────────────────────────────────────────

def beat_events(rhythm, config: EventConfig):
    """
    One event per tracked beat, carrying its position in the bar.

    Emitted for *every* beat, not only the strong ones, and left to the director
    to thin out. The show needs the full grid to be able to count bars and to
    place a cue on beat three of the fourth bar; an already-thinned stream
    cannot be counted.
    """
    events = []
    downbeat_set = set(int(i) for i in np.asarray(rhythm.downbeat_indices).tolist())
    meter = max(1, rhythm.meter)
    for i, t in enumerate(rhythm.beats):
        confidence = float(rhythm.confidences[i]) if i < rhythm.confidences.size else 0.5
        if confidence < config.beat_min_confidence:
            continue
        strength = float(rhythm.strengths[i]) if i < rhythm.strengths.size else 0.5
        position = _bar_position(i, rhythm, meter)
        events.append(Event(
            t=float(t), type=BEAT, confidence=confidence, intensity=strength,
            effect='pulse' if i in downbeat_set else 'accent',
            data={'index': i, 'inBar': position, 'downbeat': i in downbeat_set}))
    return events


def _bar_position(index, rhythm, meter):
    if rhythm.downbeat_indices.size == 0:
        return index % meter
    first = int(rhythm.downbeat_indices[0])
    return int((index - first) % meter)


def bar_events(rhythm):
    """
    One event per bar, with the bar's number inside its phrase.

    `phrase` counts bars modulo four and `phraseStart` marks every fourth one,
    because popular music is built in four-bar phrases and a scene change on
    bar three of a phrase reads as a mistake even when the energy justified it.
    """
    events = []
    for n, t in enumerate(rhythm.downbeats):
        events.append(Event(
            t=float(t), type=BAR,
            confidence=float(rhythm.downbeat_confidence),
            intensity=0.5, effect='pulse',
            data={'index': n, 'phrase': n % 4, 'phraseStart': n % 4 == 0,
                  'meter': rhythm.meter}))
    return events


def drop_events(drops):
    """The biggest gesture the rig has. `kind` decides how big."""
    return [
        Event(t=d.t, type=DROP, confidence=d.confidence,
              intensity=dsp.clamp01(0.6 + 0.4 * d.confidence),
              duration=0.0,
              effect='blinder' if d.kind == 'proper' else 'flash',
              data={'kind': d.kind, 'breakdown': round(d.breakdown, 3),
                    'sustain': round(d.sustain, 3), 'snapTo': d.snap})
        for d in drops
    ]


def buildup_events(buildups):
    """Tension spans. `subdivision` is how far the roll actually doubles."""
    return [
        Event(t=b.start, type=BUILDUP, confidence=0.8, intensity=b.intensity,
              duration=max(0.0, b.end - b.start), effect='ramp',
              data={'end': round(b.end, 3), 'subdivision': b.subdivision})
        for b in buildups
    ]


def break_events(breaks):
    """Where the show should pull back. Contrast is made here, not at the drop."""
    return [
        Event(t=b.start, type=BREAK, confidence=0.7, intensity=b.intensity,
              duration=max(0.0, b.end - b.start), effect='fade',
              data={'end': round(b.end, 3)})
        for b in breaks
    ]


def silence_events(silences):
    return [
        Event(t=s.start, type=SILENCE, confidence=0.95, intensity=0.0,
              duration=max(0.0, s.end - s.start), effect='blackout',
              data={'end': round(s.end, 3)})
        for s in silences
    ]


def spike_events(spikes):
    return [
        Event(t=s.start, type=ENERGY_SPIKE, confidence=0.6, intensity=s.intensity,
              duration=max(0.0, s.end - s.start), effect='flash')
        for s in spikes
    ]


def bass_hit_events(roles, features, rhythm, config: EventConfig):
    """
    Individual low-end hits, above the local baseline.

    Distinct from BEAT: a bass hit is where the low end actually moves, which in
    half-time or syncopated music is emphatically not every beat. This is the
    stream to drive impact effects from — a rig pulsing on BEAT in a half-time
    section pulses twice as often as the music does.
    """
    curve = roles.curve('kick')
    if curve.size == 0:
        return []
    baseline = dsp.moving_average(curve, max(3, int(features.frame_rate * 4.0)))
    excess = curve - baseline
    peaks = dsp.adaptive_peaks(
        np.maximum(excess, 0.0),
        pre=int(features.frame_rate), post=int(features.frame_rate), delta=0.4,
        wait=max(1, int(config.bass_hit_min_gap_sec * features.frame_rate)))

    events, last = [], -1e9
    for i in peaks:
        if curve[i] < config.bass_hit_threshold:
            continue
        t = float(features.times[i])
        if t - last < config.bass_hit_min_gap_sec:
            continue
        on_beat = False
        if rhythm.beats.size:
            nearest = rhythm.beats[dsp.nearest_index(rhythm.beats, t)]
            on_beat = abs(nearest - t) < 0.08
        events.append(Event(
            t=t, type=BASS_HIT, confidence=dsp.clamp01(0.4 + curve[i] * 0.6),
            intensity=float(curve[i]), effect='pulse',
            data={'onBeat': on_beat}))
        last = t
    return events


def vocal_events(roles, features, config: EventConfig):
    """
    Spans where a voice is present.

    Vocals want *atmosphere*, not accents: a lighting designer's instinct
    through a sung phrase is to hold a wash and let the singer carry it. So the
    event is a span with a `wash` recommendation rather than a stream of hits.
    """
    curve = roles.curve('vocal')
    if curve.size == 0:
        return []
    smooth = dsp.moving_average(curve, max(3, int(features.frame_rate * 2.0)))
    active = smooth > config.vocal_threshold
    min_frames = max(1, int(config.vocal_min_sec * features.frame_rate))

    events, start = [], None
    for i, is_active in enumerate(active):
        if is_active and start is None:
            start = i
        elif not is_active and start is not None:
            if i - start >= min_frames:
                events.append(_vocal_span(features, smooth, start, i))
            start = None
    if start is not None and active.size - start >= min_frames:
        events.append(_vocal_span(features, smooth, start, active.size - 1))
    return events


def _vocal_span(features, curve, start, end):
    t0 = float(features.times[start])
    t1 = float(features.times[min(end, features.times.size - 1)])
    level = float(np.mean(curve[start:max(start + 1, end)]))
    return Event(t=t0, type=VOCAL_SECTION, confidence=dsp.clamp01(level * 1.6),
                 intensity=level, duration=max(0.0, t1 - t0), effect='wash',
                 data={'end': round(t1, 3)})


def melody_change_events(features, rhythm, config: EventConfig):
    """
    Where the harmony moves — chord changes, key changes, a new melodic phrase.

    Measured as cosine distance between the chroma averaged over one bar and the
    next. Bar-level rather than frame-level on purpose: a frame-level chroma
    distance fires on every passing note, and the show would change colour
    inside a single chord.
    """
    if features.chroma.size == 0 or rhythm.downbeats.size < 3:
        return []

    chroma = features.chroma
    events, last = [], -1e9
    for i in range(1, rhythm.downbeats.size - 1):
        prev_start, split, nxt_end = (rhythm.downbeats[i - 1], rhythm.downbeats[i],
                                      rhythm.downbeats[i + 1])
        a = _chroma_mean(chroma, features.times, prev_start, split)
        b = _chroma_mean(chroma, features.times, split, nxt_end)
        if a is None or b is None:
            continue
        distance = 1.0 - float(np.dot(a, b))
        if distance < config.melody_change_threshold:
            continue
        t = float(split)
        if t - last < config.melody_change_min_gap_sec:
            continue
        events.append(Event(
            t=t, type=MELODY_CHANGE,
            confidence=dsp.clamp01(distance / 0.8), intensity=dsp.clamp01(distance),
            effect='color-shift', data={'distance': round(distance, 3)}))
        last = t
    return events


def _chroma_mean(chroma, times, start, end):
    mask = (times >= start) & (times < end)
    if not np.any(mask):
        return None
    vector = np.mean(chroma[:, mask], axis=1)
    norm = float(np.linalg.norm(vector))
    if norm < 1e-9:
        return None
    return vector / norm


def transition_events(sections):
    """
    Section boundaries — the cue to change scene.

    Carries the role of the section being entered *and* the one being left, so
    the director can pick a transition that suits the pair: chorus into
    breakdown wants a fade, breakdown into drop wants a cut.
    """
    events = []
    for i, section in enumerate(sections):
        previous = sections[i - 1].role if i > 0 else None
        events.append(Event(
            t=section.start, type=TRANSITION, confidence=section.confidence,
            intensity=section.energy, duration=section.duration,
            effect='scene-change',
            data={'from': previous, 'to': section.role, 'label': section.label,
                  'level': section.level, 'end': round(section.end, 3),
                  'brightness': round(section.brightness, 3),
                  'energy': round(section.energy, 3)}))
    return events


def section_events(sections):
    """The same boundaries as a queryable timeline (start, end, role, level)."""
    return [
        Event(t=s.start, type=SECTION, confidence=s.confidence, intensity=s.energy,
              duration=s.duration, effect='hold',
              data={'role': s.role, 'label': s.label, 'level': s.level,
                    'end': round(s.end, 3)})
        for s in sections
    ]


# ── Entry point ─────────────────────────────────────────────────────────────

def generate(features, bands_map, roles, rhythm, structure_sections, dynamics,
             config: EventConfig = None):
    """
    Build the whole event stream, sorted by time.

    Ties are broken by a fixed priority so the show engine can process events in
    order and let later ones override earlier ones at the same instant: a
    section change and a drop on the same downbeat must resolve to the drop.
    """
    config = config or EventConfig()

    events = []
    events += transition_events(structure_sections)
    events += section_events(structure_sections)
    events += bar_events(rhythm)
    events += beat_events(rhythm, config)
    events += bass_hit_events(roles, features, rhythm, config)
    events += vocal_events(roles, features, config)
    events += melody_change_events(features, rhythm, config)
    events += buildup_events(dynamics.buildups)
    events += break_events(dynamics.breaks)
    events += silence_events(dynamics.silences)
    events += spike_events(dynamics.spikes)
    events += drop_events(dynamics.drops)

    priority = {t: i for i, t in enumerate(
        (SECTION, TRANSITION, BAR, BEAT, BASS_HIT, MELODY_CHANGE, VOCAL_SECTION,
         BREAK, SILENCE, ENERGY_SPIKE, BUILDUP, DROP))}
    events.sort(key=lambda e: (e.t, priority.get(e.type, 99)))
    return events
