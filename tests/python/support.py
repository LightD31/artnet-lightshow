"""
Shared scaffolding for the analysis tests.

Two jobs. First, put `src/` on the path so `analysis` imports as a package.
Second, let the whole suite skip cleanly on a machine without the scientific
stack: a contributor working on the Node side should be able to run the tests
without a 300 MB install, and CI installs the dependencies so the real
assertions run there.
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'src'))
sys.path.insert(0, str(Path(__file__).resolve().parent))


def _importable(name):
    import importlib.util
    try:
        return importlib.util.find_spec(name) is not None
    except Exception:
        return False


HAS_NUMPY = _importable('numpy')
HAS_SCIPY = _importable('scipy')
HAS_LIBROSA = _importable('librosa')
HAS_SOUNDFILE = _importable('soundfile')
HAS_AUDIO = HAS_NUMPY and HAS_LIBROSA and HAS_SOUNDFILE

needs_numpy = unittest.skipUnless(HAS_NUMPY, 'numpy is not installed')
needs_scipy = unittest.skipUnless(HAS_NUMPY and HAS_SCIPY, 'scipy is not installed')
needs_audio = unittest.skipUnless(
    HAS_AUDIO, 'librosa/soundfile are not installed')


class AudioTestCase(unittest.TestCase):
    """Base class that writes synthetic tracks to a temp directory."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.tmpdir = cls._tmp.name

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def write(self, track, name='track.wav'):
        return track.write(os.path.join(self.tmpdir, name))


# Analysing a track is several seconds, and half the assertions in this suite
# want the same one. Cache per (generator arguments) so the whole file pays for
# each track once.
_ANALYSIS_CACHE = {}


def analyse_track(track, name, target_duration=None, separate=False):
    """
    Analyse a synthetic track, memoised across the suite.

    Source separation is off unless a test asks for it. Demucs runs at roughly
    0.6x realtime on CPU and nothing here except `Separation` is testing what it
    produces — paying two minutes of it per suite run to reach the section
    labeller is how a test suite stops being run.
    """
    key = (name, target_duration, separate)
    if key in _ANALYSIS_CACHE:
        return _ANALYSIS_CACHE[key]
    from analysis import pipeline
    from analysis.config import AnalysisConfig
    directory = tempfile.mkdtemp()
    path = track.write(os.path.join(directory, f'{name}.wav'))
    document = pipeline.analyze(path, target_duration_sec=target_duration,
                                config=AnalysisConfig(separate_sources=separate))
    _ANALYSIS_CACHE[key] = document
    return document


def nearest(values, target):
    """Closest entry in a list, or None when empty."""
    best = None
    for value in values:
        if best is None or abs(value - target) < abs(best - target):
            best = value
    return best
