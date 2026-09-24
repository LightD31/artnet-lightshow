"""
SongFormer's sections, and how they become the show's.

The model itself is 2.7 GB and is not downloaded here: its answer is stood in
for by rows shaped exactly like the ones it returns, placed where it put them
on this synthetic track when it was run for real — within a fifth of a second
of each written section, off the bar line either way.
"""

import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import synth
from support import AudioTestCase, needs_audio
from analysis import models, songformer


def _provision(directory):
    for name in songformer.REQUIRED_FILES:
        (Path(directory) / name).write_text('{}')


class WhenItRuns(unittest.TestCase):
    def test_the_mode_decides_and_auto_wants_a_card(self):
        with tempfile.TemporaryDirectory() as directory:
            _provision(directory)
            with patch.dict(os.environ, {'ARTNET_SONGFORMER_MODEL': directory}), \
                 patch.object(songformer, 'REQUIRED_PACKAGES', ('json',)):
                self.assertTrue(songformer.available())
                with patch.object(models, 'on_gpu', return_value=False):
                    self.assertFalse(songformer.wanted('auto'), 'too slow and too big on a CPU')
                    self.assertTrue(songformer.wanted('songformer'), 'unless asked for')
                    self.assertFalse(songformer.wanted('off'))
                with patch.object(models, 'on_gpu', return_value=True):
                    self.assertTrue(songformer.wanted('auto'))
                    self.assertTrue(songformer.wanted('nonsense'), 'an unknown mode is auto')

    def test_missing_weights_or_packages_are_named_and_it_never_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {'ARTNET_SONGFORMER_MODEL': directory}), \
                 patch.object(models, 'on_gpu', return_value=True):
                gaps = songformer.missing()
                self.assertTrue(any(g.endswith('model.safetensors') for g in gaps))
                self.assertFalse(songformer.wanted('songformer'))
                _provision(directory)
                with patch.object(songformer, 'REQUIRED_PACKAGES', ('json', 'no_such_package_here')):
                    self.assertEqual(songformer.missing(), ['python package no_such_package_here'])

    def test_msaf_is_stood_in_for_rather_than_installed(self):
        """msaf pins enum34, which breaks the standard library on Python 3;
        the model imports it only for evaluation metrics."""
        saved = {k: sys.modules.pop(k) for k in ('msaf', 'msaf.eval') if k in sys.modules}
        try:
            with patch('importlib.util.find_spec', return_value=None):
                songformer._stub_msaf()
            from msaf.eval import compute_results
            with self.assertRaisesRegex(RuntimeError, 'msaf is not installed'):
                compute_results()
        finally:
            for k in ('msaf', 'msaf.eval'):
                sys.modules.pop(k, None)
            sys.modules.update(saved)

    def test_a_tail_that_would_hang_the_window_loop_is_trimmed(self):
        import numpy as np
        step = songformer.WINDOW_SEC * songformer.RATE
        self.assertEqual(songformer._fit_windows(np.zeros(step + 1000)).size, step)
        self.assertEqual(songformer._fit_windows(np.zeros(step + 5000)).size, step + 5000)
        self.assertEqual(songformer._fit_windows(np.zeros(1000)).size, 1000)


@needs_audio
class FakeModel:
    """Stands in for SongFormer: records what it was given and how it was set."""

    def __init__(self, rows):
        self.rows = rows
        self.config = types.SimpleNamespace(win_size=420, hop_size=420)
        self.seen = {}

    def parameters(self):
        import torch
        return iter([torch.zeros(1)])

    def __call__(self, audio):
        self.seen = {'length': len(audio), 'window': (self.config.win_size, self.config.hop_size)}
        return self.rows


class Inference(unittest.TestCase):
    def test_the_mix_goes_in_at_24_khz_and_the_rows_come_back_on_the_track(self):
        import numpy as np
        model = FakeModel([{'label': 'intro', 'start': 0.0, 'end': 4.2},
                           {'label': 'chorus', 'start': 4.2, 'end': 12.9}])  # past the end
        stereo = np.zeros((2, 44100 * 10), dtype=np.float32)
        with patch.object(songformer, 'load', return_value=model), \
             patch.object(songformer, 'available_gb', return_value=30.0):
            rows = songformer.sections(stereo, 44100)
        self.assertAlmostEqual(model.seen['length'], 24000 * 10, delta=2)
        self.assertEqual(rows, [{'start': 0.0, 'end': 4.2, 'label': 'intro'},
                                {'start': 4.2, 'end': 10.0, 'label': 'chorus'}])

    def test_short_of_memory_it_reads_in_shorter_windows_or_not_at_all(self):
        """Read whole, a five-minute track took SongFormer past 14 GB on a
        16 GB machine, and the kernel killed the worker — the track lost its
        analysis instead of falling back to the labeller."""
        import numpy as np
        model = FakeModel([{'label': 'verse', 'start': 0.0, 'end': 311.0}])
        track = np.zeros(311 * 24000, dtype=np.float32)
        with patch.object(songformer, 'load', return_value=model), \
             patch.object(songformer, 'available_gb', return_value=10.0):
            songformer.sections(track, 24000)
        self.assertEqual(model.seen['window'], (180, 180), 'two equal windows')
        with patch.object(songformer, 'load', return_value=model), \
             patch.object(songformer, 'available_gb', return_value=0.5):
            with self.assertRaises(MemoryError):
                songformer.sections(track, 24000)


class Windows(unittest.TestCase):
    def test_the_window_is_the_longest_that_fits(self):
        w = songformer.window_for
        self.assertEqual(w(250, 30.0), 360, 'plenty of room: the track is read whole')
        self.assertEqual(w(600, 60.0), 300, 'longer than 420 s: equal windows, not 420 and a scrap')
        self.assertEqual(w(311, 10.0), 180)
        self.assertEqual(w(180, 2.0), 90)
        self.assertEqual(w(420, None), 150, 'unknown memory is taken as 8 GB')
        for free in (1.0, 4.0, 10.0, 40.0):
            window = w(10_000, free)
            self.assertEqual(window % 30, 0, 'whole 30-second steps, which the model reads in')
            self.assertLessEqual(songformer.GB_PER_SECOND_SQUARED * window ** 2,
                                 free * songformer.MEMORY_SHARE + 1e-9)
        with self.assertRaises(MemoryError):
            w(200, 0.5)

    def test_the_tail_guard_follows_the_window(self):
        import numpy as np
        step = 180 * songformer.RATE
        self.assertEqual(songformer._fit_windows(np.zeros(2 * step + 500), 180).size, 2 * step)


# What SongFormer said about `four_on_the_floor(bars=48)` at 128 BPM, whose
# written plan is intro 0-7.5, verse -22.5, build-up -30, drop -45, breakdown
# -52.5, outro -90: every boundary a little off the bar line.
MODEL_ROWS = [
    {'start': 0.0, 'end': 7.32, 'label': 'intro'},
    {'start': 7.32, 'end': 22.38, 'label': 'verse'},
    {'start': 22.38, 'end': 30.12, 'label': 'pre-chorus'},
    {'start': 30.12, 'end': 44.88, 'label': 'chorus'},
    {'start': 44.88, 'end': 52.62, 'label': 'inst'},
    {'start': 52.62, 'end': 90.0, 'label': 'outro'},
]


@needs_audio
class Fusion(AudioTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from analysis import preprocess, features, rhythm, bands, dynamics, structure
        track = synth.four_on_the_floor(bpm=128, bars=48)
        audio = preprocess.prepare(track.write(f'{cls.tmpdir}/fusion.wav'))
        cls.frames = features.extract(audio)
        cls.rhythm = rhythm.analyse(audio, cls.frames)
        band_map = bands.analyse(cls.frames, cls.rhythm.beats)
        cls.roles = bands.infer_roles(cls.frames, band_map)
        cls.drops = [d.to_dict() for d in dynamics.analyse(cls.frames, band_map, cls.rhythm).drops]
        cls.sections = structure.analyse(cls.frames, cls.rhythm, cls.roles, cls.drops,
                                         model_sections=MODEL_ROWS)

    def test_boundaries_land_on_the_bar_line(self):
        starts = [round(s.start, 2) for s in self.sections]
        self.assertEqual(len(starts), 6)
        for found, written in zip(starts, (0.0, 7.5, 22.5, 30.0, 45.0, 52.5)):
            self.assertAlmostEqual(found, written, delta=0.06)

    def test_the_sections_cover_the_whole_track(self):
        self.assertEqual(self.sections[0].start, 0.0)
        self.assertAlmostEqual(self.sections[-1].end, float(self.frames.times[-1]), delta=0.01)
        for previous, section in zip(self.sections, self.sections[1:]):
            self.assertEqual(previous.end, section.start)

    def test_the_functions_become_the_show_s_roles(self):
        from analysis import structure
        roles = [s.role for s in self.sections]
        self.assertEqual(roles[:3], ['intro', 'verse', 'prechorus'])
        self.assertEqual(roles[4], 'breakdown', 'a quiet instrumental in the middle')
        self.assertEqual(roles[5], 'outro')
        # The chorus starts on the drop the dynamics stage found, when it
        # found one there; either way it is one of the loud roles.
        on_drop = any(abs(d['t'] - 30.0) < 2.0 and d.get('kind', 'proper') == 'proper'
                      for d in self.drops)
        self.assertEqual(roles[3], 'drop' if on_drop else 'chorus')
        for section in self.sections:
            self.assertIn(section.role, structure.ROLES)

    def test_a_detected_drop_makes_a_chorus_or_an_instrumental_a_drop_not_a_verse(self):
        """SongFormer has no drop label: a drop section comes back as a chorus
        or an instrumental, and the detector names it. It does not overrule a
        verse — on ten human-annotated live recordings (SALAMI) the detector
        fired on rock, and letting it turned correctly named verses into drops."""
        from analysis import structure
        on_drop = any(abs(d['t'] - 30.0) < 2.0 and d.get('kind', 'proper') == 'proper'
                      for d in self.drops)
        if not on_drop:
            self.skipTest('the dynamics stage found no proper drop at 30 s on this run')
        for label, role in (('chorus', 'drop'), ('inst', 'drop'), ('verse', 'verse')):
            rows = [dict(r) for r in MODEL_ROWS]
            rows[3]['label'] = label
            sections = structure.analyse(self.frames, self.rhythm, self.roles, self.drops,
                                         model_sections=rows)
            self.assertEqual(sections[3].role, role, label)
            self.assertEqual(sections[3].function, label)
            self.assertEqual(sections[2].role, 'prechorus', 'the build into it is not the drop')

    def test_a_loud_instrumental_keeps_its_own_role(self):
        """Folded into the chorus or the verse by how loud it was, SongFormer's
        instrumental lost what it got right about the music."""
        from analysis import structure
        rows = [dict(r) for r in MODEL_ROWS]
        rows[3]['label'] = 'inst'
        sections = structure.analyse(self.frames, self.rhythm, self.roles, [], model_sections=rows)
        self.assertEqual(sections[3].role, 'instrumental')
        self.assertEqual(sections[4].role, 'breakdown', 'a quiet one is still a breakdown')
        self.assertIn('instrumental', structure.ROLES)

    def test_the_model_s_names_are_kept(self):
        self.assertEqual([s.function for s in self.sections],
                         ['intro', 'verse', 'pre-chorus', 'chorus', 'inst', 'outro'])
        self.assertEqual(self.sections[2].to_dict()['function'], 'pre-chorus')

    def test_a_short_breakdown_the_model_found_is_not_folded_away(self):
        self.assertAlmostEqual(self.sections[4].duration, 7.5, delta=0.1)

    def test_without_an_answer_the_labeller_answers(self):
        from analysis import structure
        sections = structure.analyse(self.frames, self.rhythm, self.roles, self.drops,
                                     model_sections=[])
        self.assertTrue(sections)
        self.assertTrue(all(s.function is None for s in sections))
        self.assertNotIn('function', sections[0].to_dict())


@needs_audio
class Labeller(AudioTestCase):
    def test_the_first_and_last_sections_reach_the_ends_of_the_track(self):
        """Sections are built on the beat grid, so the seconds before the first
        beat and after the last were in no section at all, and the show had
        nothing to say about them."""
        import numpy as np
        from analysis import preprocess, features, rhythm, structure
        track = synth.four_on_the_floor(bpm=128, bars=32)
        # A lead-in and a tail. Beat This! carries its pulse into silence,
        # but not all the way to the ends of it.
        quiet = np.zeros(int(6.0 * track.sr), dtype=np.float32)
        track.samples = np.concatenate([quiet, track.samples, quiet]).astype(np.float32)
        audio = preprocess.prepare(track.write(f'{self.tmpdir}/lead-in.wav'))
        frames = features.extract(audio)
        grid = rhythm.analyse(audio, frames)
        self.assertGreater(float(grid.beats[0]), 0.1, 'the grid starts after the track does')
        sections = structure.analyse(frames, grid)
        self.assertEqual(sections[0].start, 0.0)
        self.assertGreaterEqual(sections[-1].end, float(frames.times[-1]))


@needs_audio
class Pipeline(AudioTestCase):
    def test_the_document_says_where_its_sections_came_from(self):
        from analysis import pipeline, schema
        from analysis.config import AnalysisConfig
        path = self.write(synth.four_on_the_floor(bpm=128, bars=48), 'named.wav')
        config = AnalysisConfig(separate_sources=False, enable_semantics=False,
                                enable_tagger=False, structure_model='songformer')
        with patch.object(songformer, 'available', return_value=True), \
             patch.object(songformer, 'sections', return_value=MODEL_ROWS) as run:
            document = pipeline.analyze(path, config=config)
        mix, rate = run.call_args.args
        self.assertEqual(rate, 22050)
        self.assertAlmostEqual(len(mix) / rate, document['duration'], delta=0.05)
        self.assertEqual(document['sectionSource'], 'songformer')
        self.assertEqual(document['meta']['modelUsage']['structure'], 'songformer')
        self.assertEqual(document['segments'][2]['function'], 'pre-chorus')
        self.assertEqual(schema.errors(document), [])

        with patch.object(songformer, 'available', return_value=True), \
             patch.object(songformer, 'sections', side_effect=RuntimeError('out of memory')):
            document = pipeline.analyze(path, config=config)
        self.assertEqual(document['sectionSource'], 'analysis', 'a failure costs only the names')
        self.assertEqual(document['meta']['modelUsage']['structure'], 'laplacian')


if __name__ == '__main__':
    unittest.main()
