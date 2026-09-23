"""
The live input service.

What the server reads from it is a line a hop: the analyser's continuous beat
position, tempo, levels and events. These tests push synthetic tracks through
it as fast as they will go, through a file and through a stand-in sound card,
and judge the lines the server would get: that the grid sits on the real beats,
that it runs on without jumping, and that a machine without a sound card
library says so instead of hanging.
"""

import io
import json
import os
import tempfile
import unittest
from unittest import mock

import synth
from support import needs_audio, needs_numpy


def lines_of(text):
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def run_service(track):
    from analysis.live import LiveService, Emitter, HOP
    out = io.StringIO()
    service = LiveService(Emitter(out), sample_rate=track.sr)
    for start in range(0, len(track.samples), HOP):
        service.push(track.samples[start:start + HOP])
    return lines_of(out.getvalue())


def beat_errors(lines, track, after=12.0):
    """Where each state's grid puts the nearest beat, against the real beats, ms."""
    import numpy as np
    truth = np.asarray(track.beats)
    states = [s for s in lines if s['type'] == 'state' and s['beat'] is not None
              and s['locked'] and s['t'] > after]
    errors = []
    for s in states[::10]:
        period = 60.0 / s['bpm']
        predicted = s['t'] + (round(s['beat']) - s['beat']) * period
        errors.append(1000.0 * (predicted - truth[np.argmin(np.abs(truth - predicted))]))
    return np.asarray(errors)


@needs_numpy
class Grid(unittest.TestCase):
    def test_the_grid_sits_on_the_real_beats(self):
        import numpy as np
        for bpm in (100, 128, 174):
            with self.subTest(bpm=bpm):
                track = synth.four_on_the_floor(bpm=bpm, bars=32)
                lines = run_service(track)
                errors = beat_errors(lines, track)
                self.assertGreater(errors.size, 100)
                self.assertLess(abs(float(np.median(errors))), 20.0, 'no lead or lag to speak of')
                self.assertLess(float(np.percentile(np.abs(errors), 90)), 60.0, 'and not scattered')
                last = [s for s in lines if s['type'] == 'state'][-1]
                self.assertAlmostEqual(last['bpm'], bpm, delta=2.0)

    def test_a_state_every_hop_and_a_beat_position_that_runs_on(self):
        track = synth.four_on_the_floor(bpm=128, bars=24)
        lines = run_service(track)
        states = [s for s in lines if s['type'] == 'state']
        seconds = len(track.samples) / float(track.sr)
        self.assertAlmostEqual(len(states) / seconds, 86.1, delta=1.0, msg='22050 / 256 a second')
        # Hop to hop, wherever the grid holds: no jumps back, none forward.
        steps = [b['beat'] - a['beat'] for a, b in zip(states, states[1:])
                 if a['t'] > 8 and a['locked'] and b['locked'] and a['beat'] is not None and b['beat'] is not None]
        self.assertGreater(len(steps), 1000)
        hop_beats = 256 / 22050.0 * 128 / 60.0
        self.assertTrue(all(-0.05 < d < 4 * hop_beats for d in steps),
                        f'steps from {min(steps):.3f} to {max(steps):.3f} beats')
        for s in states[-5:]:
            self.assertGreaterEqual(s['captured'], s['t'] - 0.1)
            for key in ('energy', 'onset', 'flux', 'rms', 'tension', 'bands', 'phase'):
                self.assertIn(key, s)

    def test_events_carry_the_offline_vocabulary(self):
        from analysis import events as events_module
        lines = run_service(synth.four_on_the_floor(bpm=128, bars=16))
        events = [line['event'] for line in lines if line['type'] == 'event']
        self.assertTrue(any(e['type'] == 'BEAT' for e in events))
        for e in events:
            self.assertIn(e['type'], events_module.TYPES)


@needs_numpy
class Sources(unittest.TestCase):
    @needs_audio
    def test_a_file_plays_through_and_says_when_it_ends(self):
        import soundfile
        from analysis import live
        track = synth.four_on_the_floor(bpm=128, bars=4)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'track.wav')
            soundfile.write(path, track.samples, track.sr)
            out = io.StringIO()
            with mock.patch('sys.stdout', out):
                self.assertEqual(live.main(['--file', path]), 0)
        lines = lines_of(out.getvalue())
        self.assertEqual(lines[0]['type'], 'ready')
        self.assertEqual((lines[0]['backend'], lines[0]['hop']), ('file', 256))
        self.assertEqual(lines[-1], {'type': 'end'})
        self.assertGreater(len([x for x in lines if x['type'] == 'state']), 500)

    def test_a_sound_card_is_read_a_hop_at_a_time(self):
        from analysis import live
        track = synth.four_on_the_floor(bpm=128, bars=4)
        asked = []

        class Recorder:
            def __init__(self):
                self.at = 0

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def record(self, numframes):
                block = track.samples[self.at:self.at + numframes].reshape(-1, 1).repeat(2, axis=1)
                self.at += numframes
                return block

        class Mic:
            name = 'Speakers (loopback)'

            def recorder(self, samplerate, blocksize):
                asked.append((samplerate, blocksize))
                return Recorder()

        class Speaker:
            name = 'Speakers'

        class FakeSoundcard:
            @staticmethod
            def default_speaker():
                return Speaker()

            @staticmethod
            def get_microphone(id, include_loopback=False):
                asked.append((id, include_loopback))
                return Mic()

        out = io.StringIO()
        service = live.LiveService(live.Emitter(out), sample_rate=track.sr)
        reads = iter(range(200))
        live.capture_soundcard(FakeSoundcard, 'loopback', '', service, live.Emitter(out),
                               lambda: next(reads, None) is None)
        self.assertEqual(asked, [('Speakers', True), (22050, 256)])
        lines = lines_of(out.getvalue())
        self.assertEqual(lines[0]['device'], 'Speakers')
        states = [x for x in lines if x['type'] == 'state']
        self.assertAlmostEqual(states[-1]['captured'], 200 * 256 / 22050.0, places=3)

    def test_no_sound_card_library_is_an_error_not_a_hang(self):
        from analysis import live
        out = io.StringIO()
        with mock.patch.object(live, '_soundcard', return_value=None), \
                mock.patch.object(live, '_sounddevice', return_value=None), \
                mock.patch('sys.stdout', out):
            self.assertEqual(live.main(['--source', 'loopback']), 2)
            listed = live.list_devices()
        [line] = lines_of(out.getvalue())
        self.assertEqual(line['type'], 'error')
        self.assertTrue(line['fatal'])
        self.assertIn('pip install soundcard', line['message'])
        self.assertEqual(listed['backend'], None)


if __name__ == '__main__':
    unittest.main()
