"""
The numeric primitives, checked against signals whose answers are known by
construction. Everything above them inherits these properties, so a regression
here is a regression everywhere.
"""

import unittest

from support import needs_numpy, needs_scipy


@needs_numpy
class RobustNorm(unittest.TestCase):
    def test_a_single_outlier_does_not_flatten_the_rest(self):
        """The reason percentiles are used instead of min/max.

        One cymbal crash 20 dB above everything else would push the whole track
        into the bottom of a min/max range, and every threshold downstream would
        then be measuring the crash.
        """
        import numpy as np
        from analysis import dsp

        signal = np.concatenate([np.linspace(0.0, 1.0, 200), [40.0]])
        scaled = dsp.robust_norm(signal)
        body = scaled[:200]
        self.assertGreater(float(np.mean(body)), 0.35,
                           'the body of the signal must keep its range')
        self.assertEqual(float(np.max(scaled)), 1.0)

    def test_a_flat_signal_normalises_without_dividing_by_zero(self):
        import numpy as np
        from analysis import dsp
        self.assertTrue(np.all(np.isfinite(dsp.robust_norm(np.ones(50)))))
        self.assertTrue(np.all(np.isfinite(dsp.robust_norm(np.zeros(50)))))

    def test_an_empty_signal_is_returned_unchanged(self):
        import numpy as np
        from analysis import dsp
        self.assertEqual(dsp.robust_norm(np.zeros(0)).size, 0)


@needs_numpy
class AdaptivePeaks(unittest.TestCase):
    def test_isolated_impulses_are_found_and_nothing_else_is(self):
        import numpy as np
        from analysis import dsp

        signal = np.zeros(400)
        expected = [40, 120, 210, 330]
        signal[expected] = 1.0
        found = dsp.adaptive_peaks(signal, wait=5)
        self.assertEqual(list(found), expected)

    def test_silence_produces_no_peaks(self):
        """A flat window has a zero median and a zero deviation, so an
        implementation that only compares against the local threshold reports a
        peak on every frame — and the show fires a cue per frame through the
        quiet part of the track."""
        import numpy as np
        from analysis import dsp
        self.assertEqual(dsp.adaptive_peaks(np.zeros(500)).size, 0)
        self.assertEqual(dsp.adaptive_peaks(np.full(500, 0.3)).size, 0)

    def test_the_wait_parameter_keeps_the_taller_of_two_close_peaks(self):
        import numpy as np
        from analysis import dsp
        signal = np.zeros(200)
        signal[100] = 0.5
        signal[103] = 1.0
        found = dsp.adaptive_peaks(signal, wait=10)
        self.assertEqual(list(found), [103])


@needs_numpy
class Envelope(unittest.TestCase):
    def test_attack_and_release_move_at_the_rates_they_are_given(self):
        import numpy as np
        from analysis import dsp

        step = np.concatenate([np.zeros(50), np.ones(50)])
        fast = dsp.envelope_follower(step, attack_frames=1, release_frames=100)
        slow = dsp.envelope_follower(step, attack_frames=20, release_frames=100)
        self.assertGreater(fast[55], slow[55], 'a short attack rises sooner')
        self.assertAlmostEqual(fast[-1], 1.0, delta=0.05)


@needs_numpy
class Autocorrelation(unittest.TestCase):
    def test_a_periodic_signal_peaks_at_its_own_period(self):
        import numpy as np
        from analysis import dsp

        period = 37
        signal = np.zeros(1000)
        signal[::period] = 1.0
        correlation = dsp.autocorrelation(signal, max_lag=200)
        peak = int(np.argmax(correlation[10:])) + 10
        self.assertEqual(peak, period)
        self.assertAlmostEqual(correlation[0], 1.0, places=6)


@needs_numpy
class Curves(unittest.TestCase):
    def test_resampling_puts_one_point_per_step_and_averages_within_it(self):
        import numpy as np
        from analysis import dsp

        times = np.arange(0, 10, 0.1)
        values = np.ones_like(times) * 0.5
        curve = dsp.resample_curve(values, times, step=1.0)
        self.assertEqual(len(curve), 10)
        self.assertTrue(all(abs(point['v'] - 0.5) < 1e-6 for point in curve))
        self.assertEqual([point['t'] for point in curve[:3]], [0.0, 1.0, 2.0])

    def test_an_empty_curve_survives(self):
        import numpy as np
        from analysis import dsp
        self.assertEqual(dsp.resample_curve(np.zeros(0), np.zeros(0)), [])


@needs_scipy
class Smoothing(unittest.TestCase):
    def test_the_median_filter_removes_a_spike_and_keeps_an_edge(self):
        import numpy as np
        from analysis import dsp

        signal = np.concatenate([np.zeros(50), np.ones(50)])
        spiked = signal.copy()
        spiked[20] = 5.0
        smoothed = dsp.median_smooth(spiked, 5)
        self.assertLess(smoothed[20], 0.1, 'the spike is gone')
        self.assertLess(smoothed[45], 0.5)
        self.assertGreater(smoothed[55], 0.5, 'the edge survives')


if __name__ == '__main__':
    unittest.main()
