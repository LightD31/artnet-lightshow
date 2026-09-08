"""
Stage 1: the guarantees every threshold downstream depends on.

If loudness normalisation is wrong, every "energy above 0.55" in the pipeline is
measuring the mastering engineer rather than the music.
"""

import unittest

import synth
from support import AudioTestCase, needs_audio, needs_numpy


@needs_audio
class Normalisation(AudioTestCase):
    def test_a_quiet_master_and_a_loud_one_arrive_at_the_same_level(self):
        """The point of the stage: a quiet bounce and a loudness-war master
        must reach the analysis at one scale. The gap here is 20 dB, inside the
        make-up cap — past the cap the quiet one stays quiet on purpose, which
        the next test covers."""
        from analysis import preprocess, loudness

        loud = preprocess.prepare(self.write(synth.four_on_the_floor(bars=8), 'loud.wav'))
        quiet = preprocess.prepare(self.write(synth.quiet_track(bars=8, level_db=-20.0),
                                              'quiet.wav'))
        after_loud = loudness.integrated_lufs(loud.mono, loud.sample_rate)
        after_quiet = loudness.integrated_lufs(quiet.mono, quiet.sample_rate)
        self.assertAlmostEqual(after_loud, after_quiet, delta=2.0)

    def test_make_up_gain_is_capped(self):
        """Amplifying near-silence 40 dB amplifies the noise floor, and every
        onset detector on earth will then find a beat in it."""
        from analysis import preprocess
        audio = preprocess.prepare(
            self.write(synth.quiet_track(bars=6, level_db=-70.0), 'verysoft.wav'))
        self.assertLessEqual(audio.applied_gain_db,
                             preprocess.PreprocessConfig().max_gain_db + 0.01)

    def test_silence_is_not_amplified_at_all(self):
        import numpy as np
        from analysis import preprocess
        audio = preprocess.prepare(self.write(synth.silence(3.0), 'silence.wav'))
        self.assertEqual(audio.applied_gain_db, 0.0)
        self.assertLess(float(np.max(np.abs(audio.mono))), 1e-6)


@needs_audio
class Denoising(AudioTestCase):
    def test_clean_audio_is_left_alone_even_when_its_snr_looks_poor(self):
        """A track with no silence in it has no quiet frames to estimate a noise
        floor from, so its measured SNR comes out low while the audio is
        perfectly clean. The flatness test is what separates the two."""
        from analysis import preprocess
        audio = preprocess.prepare(self.write(synth.four_on_the_floor(bars=8), 'clean.wav'))
        self.assertFalse(audio.denoised)

    def test_genuinely_noisy_audio_is_subtracted(self):
        import numpy as np
        from analysis import preprocess
        track = synth.four_on_the_floor(bars=8)
        rng = np.random.default_rng(5)
        track.samples = (track.samples * 0.5
                         + rng.standard_normal(len(track.samples)).astype(np.float32) * 0.05)
        audio = preprocess.prepare(self.write(track, 'noisy.wav'))
        self.assertTrue(audio.denoised)


@needs_audio
class Separation(AudioTestCase):
    def test_harmonic_and_percussive_parts_are_produced_and_differ(self):
        import numpy as np
        from analysis import preprocess
        audio = preprocess.prepare(self.write(synth.four_on_the_floor(bars=8), 'hpss.wav'))
        self.assertEqual(audio.harmonic.shape, audio.mono.shape)
        self.assertEqual(audio.percussive.shape, audio.mono.shape)
        self.assertGreater(float(np.mean(np.abs(audio.harmonic - audio.percussive))), 1e-4)

    def test_the_levelled_copy_flattens_section_dynamics(self):
        """Rhythm stages read this copy so a quiet intro gives up its beats as
        readily as the chorus. Feature stages must not: the difference between
        the two *is* the information there."""
        import numpy as np
        from analysis import preprocess

        track = synth.four_on_the_floor(bars=16)
        half = len(track.samples) // 2
        track.samples[:half] *= 0.15
        audio = preprocess.prepare(self.write(track, 'dynamic.wav'))

        def ratio(signal):
            quiet = float(np.sqrt(np.mean(signal[:half] ** 2)))
            loud = float(np.sqrt(np.mean(signal[half:] ** 2)))
            return quiet / max(1e-9, loud)

        self.assertLess(ratio(audio.mono), 0.4, 'the reference signal keeps its dynamics')
        self.assertGreater(ratio(audio.levelled), ratio(audio.mono) * 1.5,
                           'the levelled copy evens the two halves out')


@needs_audio
class Trimming(AudioTestCase):
    def test_a_silent_lead_in_is_removed_when_the_real_length_is_known(self):
        """A half-second offset here is a half-second of every cue landing late
        for the whole song."""
        import numpy as np
        from analysis import preprocess

        track = synth.four_on_the_floor(bars=12)
        real_duration = track.duration
        padded = np.concatenate([
            np.zeros(int(3.0 * track.sr), dtype=np.float32), track.samples])
        track.samples = padded
        audio = preprocess.prepare(self.write(track, 'padded.wav'),
                                   target_duration_sec=real_duration)
        self.assertAlmostEqual(audio.duration, real_duration, delta=1.5)
        self.assertGreater(audio.trim_offset, 1.5)

    def test_audio_that_matches_its_target_is_not_touched(self):
        from analysis import preprocess
        track = synth.four_on_the_floor(bars=12)
        audio = preprocess.prepare(self.write(track, 'exact.wav'),
                                   target_duration_sec=track.duration)
        self.assertEqual(audio.trim_offset, 0.0)


@needs_numpy
class AdaptiveGain(unittest.TestCase):
    def test_gain_control_is_slow_enough_to_leave_transients_alone(self):
        """A fast AGC flattens the very transients the rhythm stage is looking
        for — the classic way to make a beat tracker worse by helping it."""
        import numpy as np
        from analysis import preprocess

        sr = 22050
        signal = np.zeros(sr * 8, dtype=np.float32)
        signal[::sr // 2] = 1.0                      # a click every half second
        levelled = preprocess.adaptive_gain(signal, sr)
        peaks = levelled[::sr // 2]
        self.assertGreater(float(np.min(np.abs(peaks))), 0.05,
                           'the clicks survive')


if __name__ == '__main__':
    unittest.main()
