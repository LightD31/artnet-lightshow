"""
Stage 5 — where the song changes, and what each part of it is.

Two questions, answered separately, because they need different evidence.

**Where the boundaries are** comes from self-similarity. Build a feature
sequence over beats (harmony, timbre, band balance), compare every beat to
every other, and the resulting matrix has visible block structure wherever the
music repeats. Spectral clustering of that matrix's Laplacian recovers the
blocks — this is McFee & Ellis (2014), and it is the standard because it finds
*repetition*, which is what a section boundary actually is, rather than finding
loud/quiet changes, which is what energy thresholding finds.

**What each section is** cannot come from self-similarity, which only knows
that section 2 and section 5 are the same, never that they are the chorus. That
needs the arrangement conventions the music was written to: the first section
is an intro, the loudest repeated one is the chorus, the quietest one in the
middle is the breakdown, and so on. Those rules are in `assign_roles` below,
stated explicitly so they can be argued with and adjusted per genre, rather
than buried in a threshold.

The show engine uses both: boundaries decide *when* to change the look, roles
decide *what to change it to*, and a section labelled `chorus` gets the same
look every time it comes back because the label, not the clock, drives it.
"""

from dataclasses import dataclass, field
from typing import List

import numpy as np

from . import dsp
from .config import StructureConfig


ROLES = ('intro', 'verse', 'chorus', 'drop', 'bridge', 'breakdown', 'outro')


@dataclass
class Section:
    start: float
    end: float
    #: Cluster identity — sections with the same label are musically similar.
    label: str
    role: str = 'verse'
    energy: float = 0.0
    brightness: float = 0.0
    bass: float = 0.0
    rhythmic: float = 0.0
    vocal: float = 0.0
    #: 'low' | 'mid' | 'high' — coarse level, kept for the show engine.
    level: str = 'mid'
    confidence: float = 0.0

    @property
    def duration(self):
        return max(0.0, self.end - self.start)

    def to_dict(self):
        return {
            'start': round(self.start, 3),
            'end': round(self.end, 3),
            'label': self.label,
            'role': self.role,
            'energy': round(self.energy, 3),
            'brightness': round(self.brightness, 3),
            'bass': round(self.bass, 3),
            'rhythmic': round(self.rhythmic, 3),
            'vocal': round(self.vocal, 3),
            'level': self.level,
            'confidence': round(self.confidence, 3),
        }


# ── Boundaries ──────────────────────────────────────────────────────────────

def beat_synchronous_features(features, beat_frames):
    """
    Stack harmony, timbre and band balance, aggregated per beat.

    Beat synchronisation matters more than it looks: it removes tempo from the
    comparison entirely, so a chorus at the start and the same chorus at the
    end line up even if the second one is a few milliseconds off the grid.
    """
    import librosa

    if beat_frames is None or len(beat_frames) < 4:
        return None

    chroma = features.chroma
    try:
        mfcc = librosa.feature.mfcc(S=librosa.power_to_db(
            librosa.feature.melspectrogram(S=features.magnitude ** 2,
                                           sr=features.sample_rate)), n_mfcc=13)
    except Exception:
        mfcc = np.zeros((13, features.n_frames))

    from .config import BANDS
    band_rows = []
    for low, high in BANDS.values():
        mask = (features.frequencies >= low) & (features.frequencies < high)
        if np.any(mask):
            band_rows.append(dsp.robust_norm(
                np.sqrt(np.mean(features.magnitude[mask] ** 2, axis=0))))
        else:
            band_rows.append(np.zeros(features.n_frames))
    bands_matrix = np.vstack(band_rows)

    frames = np.asarray(beat_frames, dtype=int)
    frames = frames[frames < features.n_frames]
    if frames.size < 4:
        return None

    def sync(matrix):
        try:
            out = librosa.util.sync(matrix, frames, aggregate=np.median)
        except Exception:
            return None
        # librosa.util.sync emits one extra leading bucket for the interval
        # before the first beat; drop it so column i is beat i.
        if out.shape[1] == frames.size + 1:
            out = out[:, 1:]
        return out[:, :frames.size]

    parts = [sync(chroma), sync(mfcc), sync(bands_matrix)]
    parts = [p for p in parts if p is not None and p.size]
    if not parts:
        return None
    n = min(p.shape[1] for p in parts)
    # Normalise each block to unit scale so timbre does not swamp harmony
    # purely because MFCCs have a bigger numeric range.
    normalised = []
    for p in parts:
        p = p[:, :n]
        scale = np.max(np.abs(p)) or 1.0
        normalised.append(p / scale)
    return np.vstack(normalised)


def laplacian_labels(feature_stack, config: StructureConfig):
    """
    Spectral clustering of the beat-similarity graph. Returns one integer label
    per beat, or None when the decomposition does not converge.
    """
    import librosa
    from scipy import linalg

    n_beats = feature_stack.shape[1]
    if n_beats < config.min_clusters * 4:
        return None

    recurrence = librosa.segment.recurrence_matrix(
        feature_stack, width=min(config.recurrence_width, max(1, n_beats // 4)),
        mode='affinity', sym=True)
    # Path enhancement: smooth along the diagonals so a repeat that drifts a
    # beat out of alignment still reads as a repeat.
    recurrence = librosa.segment.path_enhance(recurrence, n=9)

    # Local connectivity: neighbouring beats are similar by construction, which
    # is what keeps clusters contiguous in time instead of scattering.
    path = np.diag(np.ones(n_beats - 1), 1) + np.diag(np.ones(n_beats - 1), -1)
    # Balance the two graphs by their own scale, per McFee & Ellis.
    mu = float(np.mean(recurrence)) if recurrence.size else 0.0
    balance = np.clip(mu, 0.05, 0.95)
    combined = balance * recurrence + (1.0 - balance) * path

    degree = np.sum(combined, axis=1)
    degree[degree <= 0] = 1e-9
    d_inv_sqrt = np.diag(degree ** -0.5)
    laplacian = np.eye(n_beats) - d_inv_sqrt @ combined @ d_inv_sqrt

    try:
        values, vectors = linalg.eigh(laplacian)
    except Exception:
        return None

    max_k = min(config.max_clusters, n_beats // 4)
    if max_k < config.min_clusters:
        return None

    # Eigengap heuristic: the number of clusters is where the eigenvalues jump.
    gaps = np.diff(values[:max_k + 1])
    search = gaps[config.min_clusters - 1:max_k]
    k = config.min_clusters + int(np.argmax(search)) if search.size else config.min_clusters
    k = int(np.clip(k, config.min_clusters, max_k))

    embedding = vectors[:, :k]
    norms = np.linalg.norm(embedding, axis=1, keepdims=True)
    embedding = embedding / np.maximum(norms, 1e-9)

    try:
        from scipy.cluster.vq import kmeans2
        _, labels = kmeans2(embedding, k, minit='++', seed=0, missing='warn')
    except Exception:
        return None
    labels = np.asarray(labels)
    if labels.size != n_beats or not np.all(np.isfinite(labels)):
        return None
    return smooth_labels(labels.astype(int), width=config.label_smoothing_beats)


def smooth_labels(labels, width):
    """
    Rolling-mode filter over the beat labels.

    k-means classifies each beat independently, so its output flickers between
    two similar clusters bar by bar — twenty label changes in a minute on a
    track that has four sections. Taking the mode over a window of beats keeps
    the block structure and throws away the flicker, and it has to happen here
    rather than in the merge step: merging away twenty fragments cascades, and
    the whole track ends up as two sections.
    """
    labels = np.asarray(labels, dtype=int)
    width = int(width)
    if labels.size < 3 or width < 3:
        return labels
    half = width // 2
    out = labels.copy()
    for i in range(labels.size):
        window = labels[max(0, i - half):min(labels.size, i + half + 1)]
        counts = np.bincount(window)
        out[i] = int(np.argmax(counts))
    return out


def novelty_curve(feature_stack, kernel_beats):
    """
    Foote's checkerboard novelty. Peaks where the self-similarity matrix
    changes block — an independent boundary opinion, used here to score how
    confident each boundary the clustering found actually is.
    """
    n = feature_stack.shape[1]
    if n < kernel_beats * 2 + 4:
        return np.zeros(n)

    normed = feature_stack / (np.linalg.norm(feature_stack, axis=0, keepdims=True) + 1e-9)
    similarity = normed.T @ normed

    size = kernel_beats * 2
    axis = np.arange(-kernel_beats, kernel_beats)
    gaussian = np.exp(-0.5 * (axis / (kernel_beats / 2.0)) ** 2)
    checker = np.outer(np.sign(axis + 0.5), np.sign(axis + 0.5))
    kernel = checker * np.outer(gaussian, gaussian)

    novelty = np.zeros(n)
    for i in range(kernel_beats, n - kernel_beats):
        block = similarity[i - kernel_beats:i + kernel_beats,
                           i - kernel_beats:i + kernel_beats]
        if block.shape != (size, size):
            continue
        novelty[i] = float(np.sum(block * kernel))
    return dsp.unit_norm(np.maximum(novelty, 0.0))


def _add_novelty_boundaries(change_beats, novelty, beats, n_beats, config):
    """
    Top up the clustering's boundaries with the strongest novelty peaks.

    Spectral clustering is conservative: on a track built from one loop it will
    happily report two sections for four minutes, because structurally that is
    what it is. The novelty curve disagrees at the points where the arrangement
    changes without the harmony changing — the drums dropping out, the pad
    coming in — and those are exactly the moments a lighting show has to
    acknowledge.

    Rather than thresholding novelty (whose scale is meaningless across tracks),
    aim at a *section count*: popular music runs roughly one section per
    twenty-five seconds, so when the clustering comes back well under that, the
    strongest peaks that respect the minimum section length are promoted until
    it does. When the clustering already found enough, nothing is added.
    """
    edges = sorted({0, int(n_beats)} | {int(c) for c in change_beats})
    if novelty is None or novelty.size == 0 or beats.size < 4:
        return np.asarray(edges, dtype=int)

    beat_period = float(np.median(np.diff(beats))) if beats.size > 1 else 0.5
    if beat_period <= 0:
        return np.asarray(edges, dtype=int)
    duration = float(beats[-1] - beats[0])
    min_gap_beats = max(4, int(config.min_section_sec / beat_period))

    target = int(np.clip(round(duration / 25.0), 3, 12))
    if len(edges) - 1 >= target:
        return np.asarray(edges, dtype=int)

    peaks = dsp.adaptive_peaks(novelty, pre=min_gap_beats, post=min_gap_beats,
                               delta=0.5, wait=min_gap_beats)
    ranked = sorted((int(p) for p in peaks if 0 < p < n_beats),
                    key=lambda p: -float(novelty[p]))
    for peak in ranked:
        if len(edges) - 1 >= target:
            break
        if min(abs(peak - e) for e in edges) < min_gap_beats:
            continue
        edges.append(peak)
        edges.sort()
    return np.asarray(sorted(set(edges)), dtype=int)


# ── Section assembly ────────────────────────────────────────────────────────

def _measure(section, features, rhythm_intensity, vocal_curve):
    times = features.times
    mask = (times >= section.start) & (times < section.end)
    if not np.any(mask):
        return
    section.energy = float(np.mean(features.energy[mask]))
    section.brightness = float(np.mean(dsp.robust_norm(features.centroid)[mask]))
    low = (features.frequencies >= 30) & (features.frequencies < 250)
    if np.any(low):
        bass = dsp.robust_norm(np.sqrt(np.mean(features.magnitude[low] ** 2, axis=0)))
        section.bass = float(np.mean(bass[mask]))
    if rhythm_intensity is not None and rhythm_intensity.size == times.size:
        section.rhythmic = float(np.mean(rhythm_intensity[mask]))
    if vocal_curve is not None and vocal_curve.size == times.size:
        section.vocal = float(np.mean(vocal_curve[mask]))


def _merge_short(sections: List[Section], min_seconds):
    """
    Fold anything shorter than `min_seconds` into a neighbour.

    A four-second block is a fill or a turnaround, not a section, and changing
    the whole look for it is the single most common way an automatic show ends
    up looking twitchy. Prefer merging into a neighbour with the same label
    (it is the same music); otherwise into the longer neighbour.
    """
    if not sections:
        return sections
    changed = True
    while changed and len(sections) > 1:
        changed = False
        for i, section in enumerate(sections):
            if section.duration >= min_seconds:
                continue
            prev = sections[i - 1] if i > 0 else None
            nxt = sections[i + 1] if i + 1 < len(sections) else None
            target = None
            if prev is not None and prev.label == section.label:
                target = prev
            elif nxt is not None and nxt.label == section.label:
                target = nxt
            elif prev is not None and nxt is not None:
                target = prev if prev.duration >= nxt.duration else nxt
            else:
                target = prev or nxt
            if target is None:
                continue
            target.start = min(target.start, section.start)
            target.end = max(target.end, section.end)
            sections.pop(i)
            changed = True
            break
    return sections


def _level(energy, energies):
    """Coarse level, measured against the *track's own* distribution."""
    if not energies:
        return 'mid'
    high = float(np.percentile(energies, 66))
    low = float(np.percentile(energies, 33))
    if energy >= high:
        return 'high'
    if energy <= low:
        return 'low'
    return 'mid'


# ── Roles ───────────────────────────────────────────────────────────────────

def assign_roles(sections: List[Section], duration, drops=(), config=None):
    """
    Name each section. The rules, in the order they are applied:

    1. A section containing a detected drop is a `drop`. This overrides
       everything: a drop is the loudest thing in the track and the show must
       treat it as one even if the clustering merged it into the chorus.
    2. The first section is an `intro` when it is quieter than the track's
       median or short. A track that opens at full tilt has no intro, and
       pretending otherwise costs the show the first thirty seconds.
    3. The last section is an `outro` when it is quieter than what precedes it.
    4. Of the labels that repeat, the one with the highest mean energy is the
       `chorus`; every section carrying that label becomes one.
    5. A low-energy section in the middle third, at least eight seconds long,
       is a `breakdown`.
    6. A label that appears exactly once, past the first third, is a `bridge`.
    7. Everything else is a `verse`.

    Sections sharing a cluster label are then reconciled to a single role by
    majority, because a chorus that lights differently on its second appearance
    reads as a mistake rather than as variety.
    """
    if not sections:
        return sections

    energies = [s.energy for s in sections]
    median_energy = float(np.median(energies))
    label_counts = {}
    for s in sections:
        label_counts[s.label] = label_counts.get(s.label, 0) + 1

    repeat_threshold = (config.repeat_threshold if config else 2)
    repeated = {lab for lab, count in label_counts.items() if count >= repeat_threshold}
    chorus_label = None
    if repeated:
        by_label = {
            lab: float(np.mean([s.energy for s in sections if s.label == lab]))
            for lab in repeated
        }
        chorus_label = max(by_label, key=by_label.get)

    drop_times = [d['t'] if isinstance(d, dict) else float(d) for d in (drops or [])]

    for i, section in enumerate(sections):
        role = 'verse'
        in_drop = any(section.start - 0.5 <= t < section.end for t in drop_times)
        first_third = section.start < duration / 3.0
        last_third = section.end > duration * 2.0 / 3.0

        if i == 0 and (section.energy <= median_energy or section.duration < 20.0):
            role = 'intro'
        elif i == len(sections) - 1 and section.energy <= median_energy:
            role = 'outro'
        elif in_drop:
            role = 'drop'
        elif chorus_label is not None and section.label == chorus_label:
            role = 'chorus'
        elif (section.energy < median_energy * 0.7 and not first_third
                and not last_third and section.duration >= 8.0):
            role = 'breakdown'
        elif label_counts[section.label] == 1 and not first_third:
            role = 'bridge'
        section.role = role

    # Reconcile by label, but never overwrite the structural roles: intro,
    # outro and drop are defined by position and by the drop detector, and a
    # majority vote from elsewhere in the track has nothing to say about them.
    structural = {'intro', 'outro', 'drop'}
    by_label = {}
    for s in sections:
        if s.role in structural:
            continue
        by_label.setdefault(s.label, []).append(s.role)
    for label, roles in by_label.items():
        winner = max(set(roles), key=roles.count)
        for s in sections:
            if s.label == label and s.role not in structural:
                s.role = winner

    return sections


# ── Fallback ────────────────────────────────────────────────────────────────

def energy_sections(features, rhythm_intensity, vocal_curve, config: StructureConfig):
    """
    Boundaries from the energy curve alone, for tracks where the clustering
    cannot run (too short, too few beats, decomposition failed).

    Deliberately crude — it exists so the show still has *some* structure to
    work with rather than one section for the whole song, and the confidence it
    reports says as much.
    """
    times = features.times
    if times.size < 8:
        return []
    energy = dsp.moving_average(features.energy, max(3, int(features.frame_rate * 4)))
    smooth = dsp.median_smooth(energy, max(3, int(features.frame_rate * 6)))
    change = np.abs(np.diff(smooth, prepend=smooth[:1]))
    peaks = dsp.adaptive_peaks(
        change, pre=int(features.frame_rate * 8), post=int(features.frame_rate * 8),
        delta=0.6, wait=int(features.frame_rate * config.min_section_sec))

    edges = [0.0] + [float(times[i]) for i in peaks] + [float(times[-1])]
    sections = []
    for i in range(len(edges) - 1):
        if edges[i + 1] - edges[i] < 1.0:
            continue
        sections.append(Section(start=edges[i], end=edges[i + 1],
                                label=chr(ord('A') + i % 26), confidence=0.25))
    for s in sections:
        _measure(s, features, rhythm_intensity, vocal_curve)
    energies = [s.energy for s in sections]
    for s in sections:
        s.level = _level(s.energy, energies)
    return _merge_short(sections, config.min_section_sec)


# ── Entry point ─────────────────────────────────────────────────────────────

def analyse(features, rhythm, roles=None, drops=(), config: StructureConfig = None):
    """Segment the track and name the sections. Returns a list of `Section`."""
    import librosa

    config = config or StructureConfig()
    vocal_curve = roles.curve('vocal') if roles is not None else None
    duration = float(features.times[-1]) if features.times.size else 0.0

    beat_frames = librosa.time_to_frames(
        rhythm.beats, sr=features.sample_rate, hop_length=features.hop_length) \
        if rhythm.beats.size else np.zeros(0, dtype=int)

    stack = beat_synchronous_features(features, beat_frames)
    labels = laplacian_labels(stack, config) if stack is not None else None

    if labels is None:
        sections = energy_sections(features, rhythm.intensity, vocal_curve, config)
        sections = assign_roles(sections, duration, drops, config)
        return sections

    novelty = novelty_curve(stack, min(config.novelty_kernel_beats,
                                       max(2, stack.shape[1] // 6)))

    beats = rhythm.beats[:labels.size]
    change = 1 + np.flatnonzero(labels[:-1] != labels[1:])
    edges = _add_novelty_boundaries(change, novelty, beats, labels.size, config)

    sections = []
    for i in range(len(edges) - 1):
        b0, b1 = int(edges[i]), int(edges[i + 1])
        if b1 <= b0 or b0 >= beats.size:
            continue
        start = float(beats[b0])
        if b1 < beats.size:
            end = float(beats[b1])
        else:
            end = float(beats[-1])
            if beats.size > 1:
                end += float(beats[-1] - beats[-2])
        if end <= start:
            continue
        confidence = float(novelty[b0]) if b0 < novelty.size else 0.0
        sections.append(Section(
            start=start, end=end,
            label=chr(ord('A') + int(labels[b0]) % 26),
            confidence=dsp.clamp01(0.4 + 0.6 * confidence)))

    sections = _merge_short(sections, config.min_section_sec)
    for s in sections:
        _measure(s, features, rhythm.intensity, vocal_curve)
    energies = [s.energy for s in sections]
    for s in sections:
        s.level = _level(s.energy, energies)

    return assign_roles(sections, duration, drops, config)
