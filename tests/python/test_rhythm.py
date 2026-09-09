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
    def test_a_waltz_keeps_its_pulse(self):
        """
        Triple metre is where a periodicity-based tracker classically lands on
        the wrong pulse, reading three beats as a bar of two plus a swung one.

        The metre itself is asserted in `DownbeatDecoding` rather than here.
        Beat This! places this fixture's beats to within a hop, but marks two
        thirds of them as downbeats — the fixture is additive synthesis and its
        downbeat head is out of its depth. That is a fact about a sine-wave
        waltz, not about the decoder, and the low confidence below is the
        pipeline reporting it honestly.
        """
        import numpy as np
        from analysis import preprocess, features, rhythm
        path = self.write(synth.waltz(bpm=150, bars=24), 'waltz.wav')
        audio = preprocess.prepare(path)
        result = rhythm.analyse(audio, features.extract(audio))
        self.assertAlmostEqual(result.bpm, 150, delta=2.0)
        truth = np.asarray(synth.waltz(bpm=150, bars=24).beats)
        errors = [abs(truth[np.argmin(np.abs(truth - b))] - b) for b in result.beats]
        self.assertLess(float(np.median(errors)), 0.025)
        self.assertLess(result.downbeat_confidence, 0.6)

    def test_four_four_is_recognised(self):
        from analysis import preprocess, features, rhythm
        path = self.write(synth.four_on_the_floor(bars=24), 'common.wav')
        audio = preprocess.prepare(path)
        result = rhythm.analyse(audio, features.extract(audio))
        self.assertEqual(result.meter, 4)
        self.assertGreater(result.downbeat_confidence, 0.15)


@needs_numpy
class DownbeatDecoding(unittest.TestCase):
    """
    `decode_downbeats` turns the model's per-frame downbeat marks into a bar
    grid. These drive it with activations instead of audio, so the metre is
    asserted against a known answer rather than against how convincing a
    synthetic waltz happens to be to a model trained on records.
    """

    def grid(self, count, period=0.5):
        import numpy as np
        return np.arange(count) * period

    def test_common_time_is_read_from_clean_marks(self):
        from analysis import rhythm
        beats = self.grid(64)
        result = rhythm.decode_downbeats(beats, beats[::4])
        self.assertEqual(result[2], 4)
        self.assertEqual(result[3], 1.0)
        self.assertEqual(list(result[1][:3]), [0, 4, 8])

    def test_triple_time_is_read_from_clean_marks(self):
        from analysis import rhythm
        beats = self.grid(63)
        self.assertEqual(rhythm.decode_downbeats(beats, beats[::3])[2], 3)

    def test_the_phase_follows_the_marks(self):
        """A bar line on beat two must not be rounded back to beat one: an
        entire show of bar cues would land a beat early."""
        from analysis import rhythm
        beats = self.grid(64)
        self.assertEqual(rhythm.decode_downbeats(beats, beats[1::4])[1][0], 1)

    def test_the_shortest_metre_does_not_win_by_default(self):
        """Bar lines every two beats contain every bar line every four, so
        recall alone always prefers two. Precision is what stops it."""
        from analysis import rhythm
        beats = self.grid(64)
        self.assertEqual(rhythm.decode_downbeats(beats, beats[::4],
                                                 meters=(4, 3, 2))[2], 4)

    def test_a_missed_bar_line_does_not_change_the_metre(self):
        from analysis import rhythm
        marks = list(self.grid(64)[::4])
        del marks[5]
        meter, confidence = rhythm.decode_downbeats(beats=self.grid(64),
                                                    activations=marks)[2:]
        self.assertEqual(meter, 4)
        self.assertGreater(confidence, 0.85)

    def test_saturated_marks_report_low_confidence(self):
        """When the model marks most beats as a downbeat it is guessing. The
        show engine reads this number to decide whether to accent bars at
        all, so it has to fall."""
        from analysis import rhythm
        beats = self.grid(64)
        confidence = rhythm.decode_downbeats(beats, beats)[3]
        self.assertLess(confidence, 0.5)

    def test_no_marks_leaves_a_usable_grid(self):
        from analysis import rhythm
        downbeats, indices, meter, confidence = rhythm.decode_downbeats(
            self.grid(64), [])
        self.assertEqual(meter, 4)
        self.assertEqual(confidence, 0.0)
        self.assertEqual(downbeats.size, indices.size)


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


if __name__ == '__main__':
    unittest.main()
