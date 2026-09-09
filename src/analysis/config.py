"""
Every tuning constant in the analysis pipeline, in one place.

Stages import from here rather than hard-coding numbers so a value can be
traced from the show back to the thing it controls, and so the whole pipeline
can be re-tuned for an unusual rig or an unusual genre by passing a modified
`AnalysisConfig` into `pipeline.analyze()`.

Units are stated on every field. Seconds are seconds, Hz are Hz, and anything
named `*_ratio` or `*_score` is a 0..1 fraction.
"""

from dataclasses import dataclass, field, replace
from typing import Dict, Tuple


# ── Frequency bands ─────────────────────────────────────────────────────────
# Seven perceptual bands rather than the usual three. The split points are the
# ones mixing engineers use, because the lighting decisions downstream are the
# same ones a mix engineer makes: "is the kick carrying this", "is there air".
BANDS: Dict[str, Tuple[float, float]] = {
    'sub':      (20.0, 60.0),      # felt more than heard; 808s, sub drops
    'bass':     (60.0, 250.0),     # kick body, bass guitar, bass synth
    'lowmid':   (250.0, 500.0),    # warmth, low vocals, guitar body
    'mid':      (500.0, 2000.0),   # vocal fundamentals, most melody
    'presence': (2000.0, 5000.0),  # snare crack, vocal intelligibility
    'high':     (5000.0, 12000.0), # hats, cymbals, transient detail
    'air':      (12000.0, 20000.0) # shimmer, reverb tails, "expensive" top
}

BAND_ORDER = list(BANDS.keys())


@dataclass(frozen=True)
class PreprocessConfig:
    #: Analysis sample rate. 22.05 kHz keeps everything up to 11 kHz, which
    #: covers all seven bands except the top of `air`; `air` is measured from a
    #: second, higher-rate pass only when the source has the bandwidth.
    sample_rate: int = 22050
    #: Sample rate used for the wideband pass that feeds the `air` band and the
    #: genre classifier. 32 kHz is what PANNs wants, and Nyquist at 16 kHz is
    #: enough for a 12 kHz+ band.
    wideband_rate: int = 32000
    #: Rumble / DC filter. Below this is subsonic noise, not music.
    highpass_hz: float = 18.0
    #: Target integrated loudness for the analysis copy of the audio, LUFS.
    #: Normalising here means every threshold downstream sees the same scale
    #: whether the source is a -20 LUFS master or a -6 LUFS loudness-war one.
    target_lufs: float = -18.0
    #: Never apply more than this much make-up gain, dB. A near-silent file
    #: amplified 40 dB is amplified noise, and every onset detector on earth
    #: will find a beat in it.
    max_gain_db: float = 24.0
    #: Noise floor estimate percentile. Frames below this are treated as the
    #: room, not the music.
    noise_floor_percentile: float = 5.0
    #: Spectral subtraction strength, 0 disables. Kept gentle: over-subtracting
    #: eats the reverb tails that `air` and the structure stage read.
    noise_reduction: float = 0.5
    #: Margin for harmonic/percussive separation. Higher separates harder and
    #: costs more; 3.0 is the point where hats stop leaking into `harmonic`.
    hpss_margin: float = 3.0
    #: STFT geometry for the main analysis grid.
    n_fft: int = 2048
    hop_length: int = 512


@dataclass(frozen=True)
class RhythmConfig:
    #: Plausible tempo range, BPM. Anything outside is an octave error.
    tempo_min: float = 55.0
    tempo_max: float = 200.0
    #: Centre and width of the log-normal tempo prior used to resolve octave
    #: ambiguity (Klapuri's prior; 120 BPM is where listeners perceive tactus).
    tempo_prior_bpm: float = 120.0
    tempo_prior_std: float = 1.0
    #: Window over which local tempo is measured, seconds.
    tempo_window_sec: float = 8.0
    #: Onset picking: a peak must exceed the local median by this much of the
    #: local standard deviation.
    onset_delta: float = 0.07
    #: Minimum gap between onsets, seconds. Two hits closer than this are one.
    onset_min_gap_sec: float = 0.03
    #: How far a downbeat candidate may be from a beat before it is discarded.
    downbeat_tolerance_ratio: float = 0.25
    #: Meters the downbeat search considers, in beats per bar.
    meters: Tuple[int, ...] = (4, 3)


@dataclass(frozen=True)
class StructureConfig:
    #: Number of nearest neighbours in the recurrence matrix.
    recurrence_width: int = 9
    #: Sections shorter than this are merged into a neighbour, seconds. Eight
    #: seconds is about four bars at 120 BPM — below that it is a fill, not a
    #: section, and the lighting should not change scene for it.
    min_section_sec: float = 8.0
    #: Bounds on how many clusters the Laplacian segmentation looks for. The
    #: actual count is chosen by eigengap inside these bounds.
    min_clusters: int = 3
    max_clusters: int = 10
    #: Half-width of the Foote checkerboard novelty kernel, in beats.
    novelty_kernel_beats: int = 16
    #: Width, in beats, of the rolling-mode filter applied to the per-beat
    #: cluster labels. Roughly four bars — long enough to remove the bar-by-bar
    #: flicker k-means produces, short enough to keep a real eight-bar section.
    label_smoothing_beats: int = 17
    #: A section is "repeated" (chorus-like) when its label occurs at least
    #: this many times.
    repeat_threshold: int = 2


@dataclass(frozen=True)
class DynamicsConfig:
    #: A drop candidate needs the energy to rise by at least this much of the
    #: track's full normalised range across the transition.
    drop_min_rise: float = 0.22
    #: ...and the bar or two before it must sit at least this far below the
    #: post-drop level (the breakdown that makes a drop a drop).
    drop_min_breakdown: float = 0.18
    #: How long after the transition the new level has to hold, seconds. A
    #: cymbal crash rises just as fast as a drop; only one of them sustains.
    drop_sustain_sec: float = 4.0
    #: Minimum gap between two accepted drops, seconds.
    drop_min_gap_sec: float = 12.0
    #: Roughly one drop per this many seconds of track is kept, most confident
    #: first. Pop songs do not have eight drops.
    drop_density_sec: float = 50.0
    #: Build-up search window before a drop, seconds.
    buildup_max_sec: float = 16.0
    buildup_min_sec: float = 1.5
    #: Minimum correlation between the tension curve and time across the
    #: build-up window. A fraction-of-rising-frames test does not work: flat
    #: material rises half the time by chance, so it swallows the whole section
    #: before the drop. Correlation asks whether the window trends *upwards*.
    buildup_trend: float = 0.80
    #: Frames below this normalised RMS count as silence.
    silence_threshold: float = 0.06
    silence_min_sec: float = 0.4
    #: An energy spike is a short excursion this far above the local baseline.
    spike_min_sigma: float = 2.2
    #: A break is a sustained fall of at least this much, held this long.
    break_min_fall: float = 0.25
    break_min_sec: float = 3.0


@dataclass(frozen=True)
class EventConfig:
    #: Beat events below this confidence are not emitted at all — the show
    #: engine should never be handed a beat the analyser does not believe in.
    beat_min_confidence: float = 0.10
    #: Bass-hit events need this much band energy above the local baseline.
    bass_hit_threshold: float = 0.55
    #: Minimum gap between successive bass-hit events, seconds.
    bass_hit_min_gap_sec: float = 0.18
    #: Vocal detection: mid/presence harmonic ratio above this reads as voice.
    vocal_threshold: float = 0.42
    vocal_min_sec: float = 4.0
    #: Melody-change events fire when the chroma vector rotates by more than
    #: this cosine distance across a bar boundary.
    melody_change_threshold: float = 0.34
    melody_change_min_gap_sec: float = 6.0


@dataclass(frozen=True)
class RealtimeConfig:
    sample_rate: int = 22050
    #: Frame the live analyser consumes per step. 1024 at 22.05 kHz is 46 ms,
    #: which is under the ~80 ms where a lighting cue starts to read as late.
    hop_length: int = 512
    n_fft: int = 1024
    #: Length of the rolling history used for adaptive thresholds, seconds.
    history_sec: float = 10.0
    #: Onset threshold is median + k*MAD over the history window.
    onset_k: float = 1.6
    #: Tempo is re-estimated this often, seconds.
    tempo_refresh_sec: float = 2.0
    #: How strongly a detected onset pulls the beat phase, 0..1. Low values
    #: ride through a missed beat; high values chase every stray hit.
    phase_lock_strength: float = 0.25
    #: The loop's frequency term: how much a phase error also adjusts the beat
    #: period. Much smaller than the phase term — this corrects a tempo that is
    #: slightly wrong, and at a larger value it would let a syncopated passage
    #: drag the tempo with it.
    frequency_lock_strength: float = 0.012


@dataclass(frozen=True)
class AnalysisConfig:
    preprocess: PreprocessConfig = field(default_factory=PreprocessConfig)
    rhythm: RhythmConfig = field(default_factory=RhythmConfig)
    structure: StructureConfig = field(default_factory=StructureConfig)
    dynamics: DynamicsConfig = field(default_factory=DynamicsConfig)
    events: EventConfig = field(default_factory=EventConfig)
    realtime: RealtimeConfig = field(default_factory=RealtimeConfig)
    #: Run the optional PANNs genre/instrument tagger when it is installed.
    enable_tagger: bool = True
    #: Separate the track into stems before measuring the instrument roles.
    #: On by default: it is what makes those roles measurements rather than
    #: guesses. Turning it off is a speed escape hatch — for a test that only
    #: cares about rhythm, or a machine too slow to keep up at load-in — and
    #: costs the nuance the stems provide, not the show.
    separate_sources: bool = True
    #: Fan stages out across threads. Off makes profiling and debugging sane.
    parallel: bool = True

    def tuned(self, **overrides) -> 'AnalysisConfig':
        """Return a copy with top-level fields replaced. Useful from tests."""
        return replace(self, **overrides)


DEFAULT = AnalysisConfig()
