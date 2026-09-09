"""
Synthetic audio for the analysis tests.

Real music cannot be checked into a repository and cannot be asserted against:
there is no ground truth for where the chorus of a licensed track begins. So
the tests build tracks whose ground truth is known by construction — this
module knows exactly where every kick lands, where the drop is, and which bars
are the chorus, and hands that back alongside the samples.

The signals are crude on purpose. A test that only passes on a convincing
synthetic mix is a test of the mix, not of the analyser.
"""

import numpy as np


SR = 22050


def _env(n, attack, decay):
    """Percussive amplitude envelope: near-instant attack, exponential decay."""
    t = np.arange(n) / float(n)
    a = np.clip(t / max(1e-6, attack), 0.0, 1.0)
    d = np.exp(-t / max(1e-6, decay))
    return a * d


def kick(sr=SR, duration=0.18, f_start=110.0, f_end=45.0):
    """A pitch-swept sine — the standard synthesised kick."""
    n = int(sr * duration)
    t = np.arange(n) / sr
    freq = f_end + (f_start - f_end) * np.exp(-t * 28.0)
    phase = 2 * np.pi * np.cumsum(freq) / sr
    return (np.sin(phase) * _env(n, 0.005, 0.18)).astype(np.float32)


def snare(sr=SR, duration=0.16):
    n = int(sr * duration)
    rng = np.random.default_rng(7)
    noise = rng.standard_normal(n)
    t = np.arange(n) / sr
    body = np.sin(2 * np.pi * 190.0 * t)
    return ((0.7 * noise + 0.3 * body) * _env(n, 0.002, 0.12)).astype(np.float32)


def hat(sr=SR, duration=0.05):
    n = int(sr * duration)
    rng = np.random.default_rng(11)
    noise = rng.standard_normal(n)
    # Crude high-pass: difference the noise twice.
    noise = np.diff(np.diff(noise, prepend=noise[:1]), prepend=[0.0])
    return (noise * _env(n, 0.001, 0.05) * 0.5).astype(np.float32)


def tone(freq, seconds, sr=SR, harmonics=3, amplitude=0.3):
    """A sustained harmonic tone — stands in for a bass line, pad or synth."""
    n = int(sr * seconds)
    t = np.arange(n) / sr
    out = np.zeros(n)
    for h in range(1, harmonics + 1):
        out += (amplitude / h) * np.sin(2 * np.pi * freq * h * t)
    fade = min(n // 20, int(0.05 * sr)) or 1
    ramp = np.ones(n)
    ramp[:fade] = np.linspace(0, 1, fade)
    ramp[-fade:] = np.linspace(1, 0, fade)
    return (out * ramp).astype(np.float32)


def noise_riser(seconds, sr=SR, amplitude=0.4):
    """White noise ramping up — the build-up cue every producer uses."""
    n = int(sr * seconds)
    rng = np.random.default_rng(23)
    ramp = np.linspace(0.0, 1.0, n) ** 2
    return (rng.standard_normal(n) * ramp * amplitude).astype(np.float32)


def _place(buffer, sample, at_sec, sr=SR, gain=1.0):
    start = int(at_sec * sr)
    end = min(len(buffer), start + len(sample))
    if start >= len(buffer) or end <= start:
        return
    buffer[start:end] += gain * sample[:end - start]


class Track:
    """A synthetic track plus the ground truth used to assert against it."""

    def __init__(self, samples, sr, bpm, beats, downbeats, sections,
                 drops=(), buildups=()):
        self.samples = samples
        self.sr = sr
        self.bpm = bpm
        self.beats = np.asarray(beats, dtype=float)
        self.downbeats = np.asarray(downbeats, dtype=float)
        self.sections = list(sections)
        self.drops = list(drops)
        self.buildups = list(buildups)

    @property
    def duration(self):
        return len(self.samples) / float(self.sr)

    def write(self, path):
        import soundfile as sf
        sf.write(path, self.samples, self.sr)
        return path


def four_on_the_floor(bpm=128.0, bars=32, sr=SR, meter=4, with_structure=True):
    """
    A dance track: intro, build, drop, breakdown, outro, with a kick on every
    beat, a snare on 2 and 4, hats on eighths, and a bass note per bar.

    Ground truth is exact — the beat times are the times the kicks were placed.
    """
    beat_sec = 60.0 / bpm
    bar_sec = beat_sec * meter
    total_sec = bars * bar_sec
    n = int(total_sec * sr)
    buf = np.zeros(n, dtype=np.float64)

    k, s, h = kick(sr), snare(sr), hat(sr)
    beats, downbeats = [], []

    # Section plan, in bars.
    if with_structure:
        plan = [
            ('intro', 0, 4, dict(kick=True, snare=False, hats=False, bass=0.15)),
            ('verse', 4, 12, dict(kick=True, snare=True, hats=True, bass=0.35)),
            ('buildup', 12, 16, dict(kick=True, snare=True, hats=True, bass=0.4)),
            ('drop', 16, 24, dict(kick=True, snare=True, hats=True, bass=0.9)),
            ('breakdown', 24, 28, dict(kick=False, snare=False, hats=False, bass=0.2)),
            ('outro', 28, bars, dict(kick=True, snare=True, hats=True, bass=0.4)),
        ]
    else:
        plan = [('verse', 0, bars, dict(kick=True, snare=True, hats=True, bass=0.4))]

    for name, start_bar, end_bar, mix in plan:
        for bar in range(start_bar, min(end_bar, bars)):
            bar_t = bar * bar_sec
            downbeats.append(bar_t)
            for b in range(meter):
                t = bar_t + b * beat_sec
                beats.append(t)
                if mix['kick']:
                    _place(buf, k, t, sr, gain=0.9 if b == 0 else 0.75)
                if mix['snare'] and b % 2 == 1:
                    _place(buf, s, t, sr, gain=0.55)
                if mix['hats']:
                    _place(buf, h, t, sr, gain=0.3)
                    _place(buf, h, t + beat_sec / 2, sr, gain=0.22)
            freq = 55.0 * (2 ** ((bar % 4) / 12.0))
            _place(buf, tone(freq, bar_sec, sr, harmonics=4,
                             amplitude=mix['bass']), bar_t, sr)

    if with_structure:
        # Riser through the build-up bars, ending on the drop.
        _place(buf, noise_riser(4 * bar_sec, sr, 0.35), 12 * bar_sec, sr)
        # A pad through the drop, so it is brighter as well as louder.
        _place(buf, tone(440.0, 8 * bar_sec, sr, harmonics=6, amplitude=0.25),
               16 * bar_sec, sr)

    peak = float(np.max(np.abs(buf))) or 1.0
    samples = (buf / peak * 0.85).astype(np.float32)

    sections = [
        {'name': name, 'start': start * bar_sec, 'end': min(end, bars) * bar_sec}
        for name, start, end, _ in plan
    ]
    drops = [{'t': 16 * bar_sec}] if with_structure else []
    buildups = [{'start': 12 * bar_sec, 'end': 16 * bar_sec}] if with_structure else []
    return Track(samples, sr, bpm, beats, downbeats, sections, drops, buildups)


def waltz(bpm=150.0, bars=24, sr=SR):
    """
    Oom-pah-pah: a bass note on beat one, chords on two and three.

    Deliberately not `four_on_the_floor(meter=3)`. That put a kick on every
    beat and a snare on beat two, which carries no cue a listener would read as
    triple time — the metre only showed up in the bar-length bass note. The
    accompaniment pattern is what makes a waltz a waltz, so the fixture plays
    one.
    """
    beat_sec = 60.0 / bpm
    bar_sec = beat_sec * 3
    n = int(bars * bar_sec * sr)
    buf = np.zeros(n, dtype=np.float64)

    beats, downbeats = [], []
    # A slow I-vi-IV-V turn, so the harmony moves at bar rate like the real thing.
    roots = [110.0, 130.81, 146.83, 164.81]
    for bar in range(bars):
        bar_t = bar * bar_sec
        downbeats.append(bar_t)
        root = roots[bar % len(roots)]
        # Beat one: the bass, low and long.
        _place(buf, tone(root / 2.0, beat_sec * 0.9, sr, harmonics=3, amplitude=0.5),
               bar_t, sr)
        # Beats two and three: short chords an octave up, quieter than the bass.
        for b in (1, 2):
            for interval in (0, 4, 7):
                freq = root * 2.0 * (2 ** (interval / 12.0))
                _place(buf, tone(freq, beat_sec * 0.45, sr, harmonics=2,
                                 amplitude=0.16), bar_t + b * beat_sec, sr)
        for b in range(3):
            t = bar_t + b * beat_sec
            beats.append(t)
            # Kick on one, snare on two and three — the jazz-waltz pattern. The
            # drums carry the metre for a beat tracker; the harmony alone does
            # not, because a tracker keys off percussive onsets.
            if b == 0:
                _place(buf, kick(sr), t, sr, gain=0.9)
            else:
                _place(buf, snare(sr), t, sr, gain=0.4)
            _place(buf, hat(sr), t, sr, gain=0.3)

    peak = float(np.max(np.abs(buf))) or 1.0
    samples = (buf / peak * 0.85).astype(np.float32)
    sections = [{'name': 'verse', 'start': 0.0, 'end': bars * bar_sec}]
    return Track(samples, sr, bpm, beats, downbeats, sections)


def silence(seconds=5.0, sr=SR):
    return Track(np.zeros(int(seconds * sr), dtype=np.float32), sr, 0.0, [], [], [])


def noise(seconds=5.0, sr=SR, seed=3):
    rng = np.random.default_rng(seed)
    return Track((rng.standard_normal(int(seconds * sr)) * 0.1).astype(np.float32),
                 sr, 0.0, [], [], [])


def quiet_track(bpm=128.0, bars=16, sr=SR, level_db=-45.0):
    """A normal track at a very low level — exercises the loudness normalising."""
    t = four_on_the_floor(bpm=bpm, bars=bars, sr=sr)
    t.samples = (t.samples * (10 ** (level_db / 20.0))).astype(np.float32)
    return t
