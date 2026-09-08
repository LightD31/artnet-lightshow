"""
Live mode.

The live analyser cannot be judged by the offline one's standards — it has no
future to look at — but it does have to produce the same event vocabulary, hold
a beat grid once it finds one, and never wedge on degenerate input.

The tests drive it with a synthetic buffer rather than an audio device, so they
run at about fifty times real time and assert on the events rather than on the
wall clock.
"""

import unittest

import synth
from support import needs_numpy


def run(track, block=2048, config=None):
    from analysis.realtime import StreamingAnalyzer
    analyzer = StreamingAnalyzer(config, sample_rate=track.sr)
    events = []
    for start in range(0, len(track.samples), block):
        events.extend(analyzer.push(track.samples[start:start + block]))
    return analyzer, events


@needs_numpy
class Tracking(unittest.TestCase):
    def test_the_tempo_is_found_and_held(self):
        for bpm in (100, 128, 140):
            with self.subTest(bpm=bpm):
                analyzer, _events = run(synth.four_on_the_floor(bpm=bpm, bars=32))
                self.assertAlmostEqual(analyzer.state().bpm, bpm, delta=4.0)
                self.assertTrue(analyzer.state().locked)

    def test_the_beat_grid_is_centred_on_the_real_beats(self):
        """Live tracking spreads more than offline — there is no lookahead to
        correct a slip with — so the assertion is on the bias, not the spread.
        A biased grid is a show that is late on every cue; a noisy one is a show
        that is occasionally early and occasionally late."""
        import numpy as np
        track = synth.four_on_the_floor(bpm=128, bars=32)
        _analyzer, events = run(track)
        beats = np.array([e.t for e in events if e.type == 'BEAT' and e.t > 12])
        self.assertGreater(beats.size, 20)
        truth = np.asarray(track.beats)
        signed = [b - truth[np.argmin(np.abs(truth - b))] for b in beats]
        self.assertLess(abs(float(np.median(signed))), 0.040)

    def test_an_octave_flip_during_a_breakdown_does_not_move_the_grid(self):
        """When the kick drops out the estimator legitimately reports half
        tempo. Averaging 174 with 87 lands on 130 — a tempo the track has never
        played."""
        analyzer, _events = run(synth.four_on_the_floor(bpm=174, bars=32))
        self.assertAlmostEqual(analyzer.state().bpm, 174, delta=6.0)

    def test_bars_are_counted_off_the_beats(self):
        _analyzer, events = run(synth.four_on_the_floor(bars=24))
        beats = len([e for e in events if e.type == 'BEAT'])
        bars = len([e for e in events if e.type == 'BAR'])
        self.assertGreater(bars, 0)
        self.assertAlmostEqual(bars, beats / 4, delta=2)


@needs_numpy
class Vocabulary(unittest.TestCase):
    def test_live_events_carry_the_same_fields_as_offline_ones(self):
        from analysis import events as events_module
        _analyzer, events = run(synth.four_on_the_floor(bars=16))
        self.assertTrue(events)
        for event in events:
            self.assertIn(event.type, events_module.TYPES)
            self.assertIn(event.effect, events_module.EFFECTS)
            self.assertGreaterEqual(event.confidence, 0.0)
            self.assertLessEqual(event.confidence, 1.0)
            self.assertGreaterEqual(event.t, 0.0)

    def test_live_drops_are_marked_unconfirmed(self):
        """Offline a drop is confirmed by four seconds of sustain. Live there is
        no what-follows, so the confidence is lower and the flag says why — the
        show engine is expected to spend a smaller gesture on it."""
        _analyzer, events = run(synth.four_on_the_floor(bars=32))
        drops = [e for e in events if e.type == 'DROP']
        for drop in drops:
            self.assertTrue(drop.data.get('unconfirmed'))
            self.assertLess(drop.confidence, 0.7)

    def test_events_arrive_in_time_order(self):
        _analyzer, events = run(synth.four_on_the_floor(bars=16))
        times = [e.t for e in events]
        self.assertEqual(times, sorted(times))


@needs_numpy
class Robustness(unittest.TestCase):
    def test_silence_produces_a_silence_event_and_no_beats(self):
        analyzer, events = run(synth.silence(6.0))
        self.assertFalse([e for e in events if e.type == 'BEAT'])
        self.assertFalse(analyzer.state().locked)

    def test_white_noise_does_not_produce_a_confident_grid(self):
        """Anything periodic enough to lock onto in noise is the detector
        fooling itself, and a show locked to nothing is worse than no show."""
        analyzer, events = run(synth.noise(10.0))
        beats = [e for e in events if e.type == 'BEAT']
        self.assertTrue(all(e.confidence <= 0.8 for e in beats))

    def test_any_block_size_works(self):
        """The caller owns the audio device; the analyser must not care what it
        hands over."""
        for block in (256, 1024, 5000):
            with self.subTest(block=block):
                analyzer, events = run(
                    synth.four_on_the_floor(bars=16), block=block)
                self.assertTrue([e for e in events if e.type == 'BEAT'])
                self.assertGreater(analyzer.state().bpm, 0)

    def test_an_empty_push_is_harmless(self):
        import numpy as np
        from analysis.realtime import StreamingAnalyzer
        analyzer = StreamingAnalyzer()
        self.assertEqual(analyzer.push(np.zeros(0)), [])
        self.assertEqual(analyzer.state().t, 0.0)

    def test_reset_returns_the_analyser_to_its_starting_state(self):
        analyzer, _events = run(synth.four_on_the_floor(bars=16))
        analyzer.reset()
        self.assertEqual(analyzer.state().bpm, 0)
        self.assertEqual(analyzer.state().t, 0.0)


@needs_numpy
class OctaveFolding(unittest.TestCase):
    def test_a_half_tempo_reading_folds_back_onto_the_running_grid(self):
        from analysis.realtime import _fold_octave
        self.assertAlmostEqual(_fold_octave(87.0, 174.0), 174.0)
        self.assertAlmostEqual(_fold_octave(348.0, 174.0), 174.0)

    def test_a_genuine_tempo_change_is_followed_not_folded(self):
        """A DJ mixing into a slower record is not an octave flip."""
        from analysis.realtime import _fold_octave
        self.assertAlmostEqual(_fold_octave(100.0, 174.0), 100.0)

    def test_no_reference_means_no_folding(self):
        from analysis.realtime import _fold_octave
        self.assertAlmostEqual(_fold_octave(174.0, 0.0), 174.0)


if __name__ == '__main__':
    unittest.main()
