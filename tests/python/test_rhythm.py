"""
Tempo, beats and metre against tracks whose grid is known exactly.

The synthetic tracks in synth.py place every kick themselves, so the ground
truth is not an estimate — it is the list of times the samples were written to.
That makes it possible to assert on *timing accuracy* rather than only on
plausibility, which is what actually matters here: a beat grid 40 ms out is a
show where every cue lands late.
"""

import unittest

import synth
from support import AudioTestCase, needs_audio, needs_numpy


@needs_audio
class TempoAccuracy(AudioTestCase):
    """The whole tempo range, including the cases autocorrelation gets wrong."""

    def measure(self, track, name):
        from analysis import preprocess, features, rhythm
        path = self.write(track, f'{name}.wav')
        audio = preprocess.prepare(path)
        frames = features.extract(audio)
        return rhythm.analyse(audio, frames)

    def test_tempo_is_recovered_across_the_usable_range(self):
        for bpm in (90, 100, 128, 140, 174):
            with self.subTest(bpm=bpm):
                result = self.measure(
                    synth.four_on_the_floor(bpm=bpm, bars=24), f'tempo{bpm}')
                self.assertAlmostEqual(
                    result.bpm, bpm, delta=1.0,
                    msg=f'{bpm} BPM track reported as {result.bpm:.2f}')

    def test_the_beat_grid_lands_within_20ms_of_the_real_kicks(self):
        """The tolerance is not arbitrary: a DMX frame is 25 ms, so an error
        under 20 ms is one the rig physically cannot express."""
        import numpy as np
        track = synth.four_on_the_floor(bpm=128, bars=24)
        result = self.measure(track, 'phase')
        truth = np.asarray(track.beats)
        errors = [abs(truth[np.argmin(np.abs(truth - b))] - b) for b in result.beats]
        self.assertLess(float(np.median(errors)), 0.020)

    def test_every_beat_is_found(self):
        track = synth.four_on_the_floor(bpm=128, bars=24)
        result = self.measure(track, 'count')
        self.assertAlmostEqual(len(result.beats), len(track.beats), delta=2)


@needs_audio
class Metre(AudioTestCase):
    def test_a_waltz_is_recognised_as_three_four(self):
        """The 3:2 relative tempo of a triple-metre track is the classic
        autocorrelation failure — it scores as well as the true tempo and puts
        the whole show on the wrong pulse."""
        from analysis import preprocess, features, rhythm
        path = self.write(synth.waltz(bpm=150, bars=24), 'waltz.wav')
        audio = preprocess.prepare(path)
        result = rhythm.analyse(audio, features.extract(audio))
        self.assertEqual(result.meter, 3)
        self.assertAlmostEqual(result.bpm, 150, delta=2.0)

    def test_four_four_is_recognised(self):
        from analysis import preprocess, features, rhythm
        path = self.write(synth.four_on_the_floor(bars=24), 'common.wav')
        audio = preprocess.prepare(path)
        result = rhythm.analyse(audio, features.extract(audio))
        self.assertEqual(result.meter, 4)
        self.assertGreater(result.downbeat_confidence, 0.15)


@needs_numpy
class PulseScoring(unittest.TestCase):
    """The step that resolves what autocorrelation cannot."""

    def envelope(self, period, length=800, offbeat=0.0):
        import numpy as np
        signal = np.zeros(length)
        signal[::period] = 1.0
        if offbeat:
            signal[period // 2::period] = offbeat
        return signal

    def test_the_true_period_beats_half_the_period(self):
        """Half tempo lands on every other beat, so its precision is identical.
        Only recall separates them — and it must."""
        from analysis import rhythm
        env = self.envelope(20)
        true_fit, _ = rhythm.pulse_score(env, 20.0)
        half_fit, _ = rhythm.pulse_score(env, 40.0)
        self.assertGreater(true_fit, half_fit)

    def test_the_true_period_beats_a_three_to_two_relative(self):
        from analysis import rhythm
        env = self.envelope(20, offbeat=0.3)
        true_fit, _ = rhythm.pulse_score(env, 20.0)
        relative_fit, _ = rhythm.pulse_score(env, 30.0)
        self.assertGreater(true_fit, relative_fit)

    def test_a_flat_envelope_scores_nothing_in_particular(self):
        import numpy as np
        from analysis import rhythm
        fit, _ = rhythm.pulse_score(np.ones(400), 20.0)
        self.assertLess(fit, 0.5)


@needs_numpy
class PeriodRefinement(unittest.TestCase):
    def test_a_sub_frame_period_is_recovered_from_a_quantised_grid(self):
        """Beat times land on STFT frames, so the interval between two of them
        is quantised to ~23 ms — 3.5 BPM of error at 140. The rounding pattern
        across a hundred beats carries the fraction the intervals throw away."""
        import numpy as np
        from analysis import rhythm

        true_period = 0.42857        # 140 BPM
        frame = 512 / 22050.0
        beats = np.round(np.arange(120) * true_period / frame) * frame
        fitted, r2 = rhythm.refine_period(beats)
        self.assertAlmostEqual(fitted, true_period, places=4)
        self.assertGreater(r2, 0.999)
        median = float(np.median(np.diff(beats)))
        self.assertGreater(abs(60 / median - 140), 1.0,
                           'the median interval really is the worse estimate')


@needs_numpy
class BeatSnapping(unittest.TestCase):
    def test_beats_move_onto_nearby_onsets_but_never_reorder(self):
        import numpy as np
        from analysis import rhythm
        beats = np.array([1.0, 2.0, 3.0])
        onsets = np.array([1.02, 2.9, 5.0])
        snapped = rhythm.snap_beats_to_onsets(beats, onsets, tolerance_sec=0.15)
        self.assertAlmostEqual(snapped[0], 1.02)
        self.assertAlmostEqual(snapped[1], 2.0, msg='no onset within tolerance')
        self.assertAlmostEqual(snapped[2], 2.9)
        self.assertTrue(np.all(np.diff(snapped) >= 0))

    def test_a_beat_with_no_onset_nearby_keeps_the_grid(self):
        """A ducked kick must cost confidence, not the beat: the grid has to
        keep counting through a bar the drums sat out."""
        import numpy as np
        from analysis import rhythm
        beats = np.array([1.0, 2.0, 3.0])
        snapped = rhythm.snap_beats_to_onsets(beats, np.array([]), 0.15)
        self.assertTrue(np.allclose(snapped, beats))


if __name__ == '__main__':
    unittest.main()
