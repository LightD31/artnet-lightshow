"""
BS.1770 loudness, checked against the reference cases in the standard.

These numbers are not arbitrary: the spec defines a 1 kHz sine at -20 dBFS as
reading -20 LUFS, and defines two coherent channels as summing +3 LU. An
implementation that gets either wrong will normalise every track to the wrong
level, and every threshold in the pipeline is measured against that level.
"""

import unittest

from support import needs_numpy


@needs_numpy
class Calibration(unittest.TestCase):
    SR = 48000

    def sine(self, dbfs, seconds=5.0, freq=1000.0):
        import numpy as np
        t = np.arange(int(self.SR * seconds)) / self.SR
        amplitude = (10 ** (dbfs / 20.0)) * np.sqrt(2)   # dBFS is RMS here
        return amplitude * np.sin(2 * np.pi * freq * t)

    def test_a_1khz_sine_reads_its_own_level(self):
        from analysis import loudness
        measured = loudness.integrated_lufs(self.sine(-20.0), self.SR)
        self.assertAlmostEqual(measured, -20.0, delta=0.5)

    def test_two_coherent_channels_sum_to_plus_three(self):
        """Per the spec's channel weighting. Getting this wrong makes every
        stereo track read 3 dB quieter than it is."""
        import numpy as np
        from analysis import loudness
        mono = self.sine(-20.0)
        stereo = np.vstack([mono, mono])
        self.assertAlmostEqual(
            loudness.integrated_lufs(stereo, self.SR)
            - loudness.integrated_lufs(mono, self.SR), 3.0, delta=0.3)

    def test_digital_silence_is_negative_infinity_not_a_very_small_number(self):
        """Callers have to be able to tell 'no signal' from 'very quiet': one
        gets make-up gain applied and the other must not."""
        import numpy as np
        from analysis import loudness
        self.assertEqual(loudness.integrated_lufs(np.zeros(self.SR), self.SR),
                         -float('inf'))

    def test_gating_ignores_the_gaps_between_phrases(self):
        """A sparse track is not a quiet track. Without the relative gate, a
        signal that is silent half the time measures 3 LU lower than the same
        signal played continuously, and the show would drive it harder."""
        import numpy as np
        from analysis import loudness
        continuous = self.sine(-20.0, seconds=8.0)
        gapped = continuous.copy()
        gapped[len(gapped) // 2:] = 0.0
        self.assertAlmostEqual(
            loudness.integrated_lufs(gapped, self.SR),
            loudness.integrated_lufs(continuous, self.SR), delta=0.6)

    def test_the_k_weighting_lifts_presence_over_sub_bass(self):
        """The whole reason LUFS is used instead of RMS: equal-energy tones at
        50 Hz and 3 kHz do not sound equally loud."""
        from analysis import loudness
        low = loudness.integrated_lufs(self.sine(-20.0, freq=50.0), self.SR)
        high = loudness.integrated_lufs(self.sine(-20.0, freq=3000.0), self.SR)
        self.assertGreater(high, low + 3.0)


@needs_numpy
class Range(unittest.TestCase):
    SR = 48000

    def test_a_constant_signal_has_no_loudness_range(self):
        import numpy as np
        from analysis import loudness
        t = np.arange(self.SR * 12) / self.SR
        tone = 0.1 * np.sin(2 * np.pi * 1000 * t)
        _times, values = loudness.short_term_curve(tone, self.SR)
        self.assertLess(loudness.loudness_range(values), 0.5)

    def test_a_quiet_half_and_a_loud_half_produce_a_range(self):
        import numpy as np
        from analysis import loudness
        t = np.arange(self.SR * 20) / self.SR
        tone = 0.1 * np.sin(2 * np.pi * 1000 * t)
        tone[: len(tone) // 2] *= 0.1          # 20 dB quieter
        _times, values = loudness.short_term_curve(tone, self.SR)
        self.assertGreater(loudness.loudness_range(values), 10.0)


@needs_numpy
class TruePeak(unittest.TestCase):
    def test_an_inter_sample_peak_reads_above_the_sample_peak(self):
        """A signal can peak between two samples; a converter reconstructing it
        clips where the sample values say it did not."""
        import numpy as np
        from analysis import loudness
        sr = 48000
        t = np.arange(sr) / sr
        # A tone at a quarter of Nyquist, phase-offset so no sample lands on the
        # crest of the waveform.
        signal = 0.99 * np.sin(2 * np.pi * (sr / 4.0) * t + np.pi / 4)
        sample_peak = 20 * np.log10(float(np.max(np.abs(signal))))
        self.assertGreater(loudness.true_peak_dbfs(signal, sr), sample_peak)


if __name__ == '__main__':
    unittest.main()
