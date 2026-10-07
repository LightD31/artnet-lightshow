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


def run_service(track, bands=None):
    from analysis.live import LiveService, Emitter, HOP
    out = io.StringIO()
    service = LiveService(Emitter(out), sample_rate=track.sr, bands=bands)
    for start in range(0, len(track.samples), HOP):
        service.push(track.samples[start:start + HOP])
    return lines_of(out.getvalue())


def tone_track(freq, seconds, **kwargs):
    """`synth.tone` as a track, which is what `run_service` reads."""
    return synth.Track(synth.tone(freq, seconds, **kwargs), synth.SR, 0.0, [], [], [])


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
            # stdin empty: the service reads requests from it, and the runner's is not its.
            with mock.patch('sys.stdout', out), mock.patch('sys.stdin', io.StringIO()):
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
                mock.patch('sys.stdout', out), mock.patch('sys.stdin', io.StringIO()):
            self.assertEqual(live.main(['--source', 'loopback']), 2)
            listed = live.list_devices()
        [line] = lines_of(out.getvalue())
        self.assertEqual(line['type'], 'error')
        self.assertTrue(line['fatal'])
        self.assertIn('pip install soundcard', line['message'])
        self.assertEqual(listed['backend'], None)


def expected_spectrum(frame, bins, without_dc=True):
    """
    What the service should say about one 1024-sample frame, worked out apart
    from it: the frame's mean taken off, the Hamming window from its formula,
    the requested bins written out by hand, the total by Parseval in the time
    domain. `without_dc=False` keeps the mean in, as the spectrum was first
    worked out.
    """
    import numpy as np
    x = np.asarray(frame, dtype=np.float64)
    n = np.arange(x.size)
    x0 = x - x.mean() if without_dc else x
    xw = x0 * (0.54 - 0.46 * np.cos(2 * np.pi * n / (x.size - 1)))
    spectrum = np.fft.rfft(xw)
    power = spectrum.real ** 2 + spectrum.imag ** 2
    # One-sided: every bin but DC and Nyquist stands for two.
    nyquist = float(np.sum(xw * (-1.0) ** n))
    total = (x.size * float(np.sum(xw ** 2)) + float(np.sum(xw)) ** 2 + nyquist ** 2) / 2.0
    above_dc = power[1:93]
    return {
        'power': float(np.sum(x ** 2)),
        'rms': float(np.sqrt(np.mean(x ** 2))),
        'dominantHz': float(np.argmax(above_dc) + 1) * 22050 / 1024 if above_dc.max() > 0 else None,
        'bands': [float(power[a:b + 1].sum()) for a, b in bins],
        'fftPower': total,
    }


@needs_numpy
class BandsTest(unittest.TestCase):
    def test_bands_emitted_for_a_tone(self):
        # A 1 kHz tone: the 750–2000 band carries nearly all the power; 0–160 and 3000–9000 next to nothing.
        track = tone_track(1000.0, seconds=2.0, harmonics=1)   # synth.tone adds harmonics by default; a pure tone keeps the band ratio clean
        lines = run_service(track, bands=[(0, 160), (750, 2000), (3000, 9000)])
        states = [m for m in lines if m.get('type') == 'state']
        s = states[len(states) // 2]['spectrum']
        self.assertEqual(len(s['bands']), 3)
        self.assertGreater(s['bands'][1], 50 * max(s['bands'][0], s['bands'][2]))
        self.assertTrue(900 < s['dominantHz'] < 1100)
        self.assertGreater(s['power'], 0)
        self.assertGreater(s['rms'], 0)

    def test_full_scale_sine_power_scale(self):
        # |X|² of a Hamming-windowed 1024-point FFT of a full-scale sine peaks near (N/2 · 0.54)² ≈ 7.6e4 in its bin.
        track = tone_track(1000.0, seconds=1.0, amplitude=1.0, harmonics=1)
        lines = run_service(track, bands=[(900, 1100)])
        s = [m for m in lines if m.get('type') == 'state'][-5]['spectrum']
        self.assertTrue(3e4 < s['bands'][0] < 1.5e5, s['bands'][0])

    def test_a_bin_centred_sine_lands_on_the_window_gain(self):
        # Bin 64 exactly: |X|² = (A/2 · Σw)² in its own bin, (A/2 · 0.23 N)² in each neighbour.
        import numpy as np
        hz = 64 * 22050 / 1024
        track = synth.Track((0.5 * np.sin(2 * np.pi * hz * np.arange(22050) / 22050)).astype(np.float32),
                            22050, 0.0, [], [], [])
        s = [m for m in run_service(track, bands=[(hz, hz + 1), (hz - 10, hz + 30)])
             if m['type'] == 'state'][-1]['spectrum']
        peak = (0.25 * (0.54 * 1024 - 0.46)) ** 2
        side = (0.25 * 0.23 * 1024) ** 2
        self.assertAlmostEqual(s['bands'][0] / (peak + side), 1.0, delta=0.005)
        self.assertAlmostEqual(s['bands'][1] / (peak + 2 * side), 1.0, delta=0.005)
        self.assertAlmostEqual(s['dominantHz'], hz, places=6)
        # Σx² of a 0.5 sine over the frame, not the FFT's total: the two scales differ by ~N·Σw²/N.
        self.assertAlmostEqual(s['power'], 0.125 * 1024, delta=1.0)
        self.assertAlmostEqual(s['rms'], 0.5 / np.sqrt(2), delta=1e-3)
        self.assertGreater(s['fftPower'], 100 * s['power'])

    def test_the_newest_frame_whatever_the_block_sizes(self):
        # Uneven blocks, several frames to some of them: each state describes
        # the last whole frame, bins as asked, both edges of the spectrum
        # summing two bins.
        import numpy as np
        from analysis.live import LiveService, Emitter
        rng = np.random.default_rng(5)
        n = np.arange(30000)
        samples = (0.2 * rng.standard_normal(n.size) + 0.3 * np.sin(2 * np.pi * 440 * n / 22050)).astype(np.float32)
        bands = [(0, 1), (0, 160), (750, 2000), (3000, 9000), (11024, 11025)]
        bins = [(0, 1), (0, 7), (34, 92), (139, 417), (511, 512)]
        out = io.StringIO()
        service = LiveService(Emitter(out), sample_rate=22050, bands=bands)
        at = frames = checked = 0
        for size in [700, 200, 1500, 37, 4096, 256, 3, 2900, 9000, 11308]:
            out.seek(0)
            out.truncate()
            service.push(samples[at:at + size])
            at += size
            states = [m for m in lines_of(out.getvalue()) if m['type'] == 'state']
            before, frames = frames, 0 if at < 1024 else (at - 1024) // 256 + 1
            if frames == before:
                self.assertEqual(states, [])
                continue
            self.assertEqual(len(states), 1, 'one state for the newest frame')
            newest = frames - 1
            want = expected_spectrum(samples[newest * 256:newest * 256 + 1024], bins)
            got = states[0]['spectrum']
            for key in ('power', 'rms', 'fftPower'):
                self.assertAlmostEqual(got[key] / want[key], 1.0, delta=1e-9, msg=key)
            for g, w in zip(got['bands'], want['bands']):
                self.assertAlmostEqual(g / w, 1.0, delta=1e-9)
            self.assertAlmostEqual(got['dominantHz'], want['dominantHz'], places=9)
            checked += 1
        self.assertEqual(checked, 6)

    def test_silence_reads_zero_and_has_no_dominant_frequency(self):
        lines = run_service(synth.silence(seconds=0.5), bands=[(0, 160)])
        s = [m for m in lines if m['type'] == 'state'][-1]['spectrum']
        self.assertEqual(s, {'power': 0.0, 'rms': 0.0, 'dominantHz': None, 'bands': [0.0], 'fftPower': 0.0})

    def test_dc_names_no_frequency(self):
        # An offset under a tone: DC is the frame's strongest bin, but 0 Hz is
        # no pitch for the effects to follow, so the tone dominates.
        import numpy as np
        hz = 46 * 22050 / 1024
        n = np.arange(4096)
        samples = (0.3 + 0.4 * np.sin(2 * np.pi * hz * n / 22050)).astype(np.float32)
        track = synth.Track(samples, 22050, 0.0, [], [], [])
        s = [m for m in run_service(track, bands=[(0, 160)]) if m['type'] == 'state'][-1]['spectrum']
        newest = samples[-1024:].astype(np.float64)
        power = np.abs(np.fft.rfft(newest * np.hamming(1024))) ** 2
        self.assertEqual(int(np.argmax(power[:93])), 0, 'DC is the strongest bin')
        self.assertAlmostEqual(s['dominantHz'], hz, places=6)

    def test_a_frame_of_nothing_but_an_offset_has_no_dominant_frequency(self):
        # The window would spread the offset into the bins above DC; the
        # frame's mean is taken off first, so nothing is left in them.
        import numpy as np
        for offset in (0.3, -0.02, 1e-4):
            with self.subTest(offset=offset):
                track = synth.Track(np.full(4096, offset, dtype=np.float32), 22050, 0.0, [], [], [])
                s = [m for m in run_service(track, bands=[(0, 160), (750, 2000)]) if m['type'] == 'state'][-1]['spectrum']
                self.assertIsNone(s['dominantHz'])
                self.assertEqual(s['bands'], [0.0, 0.0])
                self.assertEqual(s['fftPower'], 0.0)
                self.assertAlmostEqual(s['power'], 1024 * float(np.float32(offset)) ** 2, delta=1e-9 * max(1.0, s['power']))

    def test_an_offset_under_a_quiet_tone_leaves_the_tone_dominant(self):
        # An offset ten times the tone: its window skirt in the first bins
        # would outweigh the tone, were the mean not taken off.
        import numpy as np
        n = np.arange(8192)
        samples = (0.5 + 0.05 * np.sin(2 * np.pi * 440 * n / 22050)).astype(np.float32)
        s = [m for m in run_service(synth.Track(samples, 22050, 0.0, [], [], []), bands=[(0, 160)])
             if m['type'] == 'state'][-1]['spectrum']
        self.assertLessEqual(abs(s['dominantHz'] - 440), 22050 / 1024)

    def test_a_tone_with_no_offset_has_the_band_powers_it_always_had(self):
        # Sixteen samples a period, a whole number of periods in every frame:
        # its mean is nil, and taking it off changes nothing.
        import numpy as np
        period = np.sin(2 * np.pi * np.arange(16) / 16).astype(np.float32)
        samples = np.tile(period, 22050 // 16)
        hz = 22050 / 16
        bands = [(0, 160), (hz - 10, hz + 30), (3000, 9000)]
        s = [m for m in run_service(synth.Track(samples, 22050, 0.0, [], [], []), bands=bands)
             if m['type'] == 'state'][-1]['spectrum']
        frames = (samples.size - 1024) // 256 + 1
        newest = samples[(frames - 1) * 256:(frames - 1) * 256 + 1024]
        was = expected_spectrum(newest, [(0, 7), (63, 65), (139, 417)], without_dc=False)
        for got, want in zip(s['bands'], was['bands']):
            self.assertAlmostEqual(got / want, 1.0, delta=1e-9)
        self.assertAlmostEqual(s['fftPower'] / was['fftPower'], 1.0, delta=1e-9)
        self.assertAlmostEqual(s['dominantHz'], hz, places=6)

    def test_nothing_above_dc_is_no_dominant_frequency(self):
        import numpy as np
        from analysis.live import dominant_hz
        bin_hz = 22050 / 1024
        only_dc = np.zeros(513)
        only_dc[0] = 4.0
        self.assertIsNone(dominant_hz(only_dc, bin_hz))
        # Above 2 kHz is not looked at: bin 93 is 2002.6 Hz.
        high = only_dc.copy()
        high[93] = 9.0
        self.assertIsNone(dominant_hz(high, bin_hz))
        # Ties go to the lower bin.
        self.assertEqual(dominant_hz(np.array([4.0, 1.0, 3.0, 3.0]), 10.0), 20.0)

    def test_without_bands_the_lines_are_as_they_were(self):
        # The band powers are a second window beside the analyser's own, not a
        # change to it: every other field and every event is the same.
        track = synth.four_on_the_floor(bpm=128, bars=4)
        plain = run_service(track)
        banded = run_service(track, bands=[(0, 160), (750, 2000)])
        self.assertTrue(all('spectrum' not in m for m in plain))
        self.assertEqual(len(plain), len(banded))
        for a, b in zip(plain, banded):
            if b['type'] == 'state':
                self.assertEqual(len(b['spectrum']['bands']), 2)
                b = {k: v for k, v in b.items() if k != 'spectrum'}
            self.assertEqual(a, b)

    def test_no_spectrum_before_the_first_whole_frame(self):
        from analysis.live import LiveService, Emitter
        out = io.StringIO()
        service = LiveService(Emitter(out), sample_rate=22050, bands=[(0, 160)])
        service.push([0.1] * 1000)
        self.assertEqual(out.getvalue(), '')
        self.assertNotIn('spectrum', service.state())

    def test_bands_the_rate_cannot_carry_are_refused(self):
        from analysis.live import LiveService, Emitter
        for bands in ([(0, 8001)], [(160, 0)], [(100, 100)], [(-1, 100)], [(0, float('nan'))],
                      [(0, 100)] * 13):
            with self.subTest(bands=bands), self.assertRaises(ValueError):
                LiveService(Emitter(io.StringIO()), sample_rate=16000, bands=bands)
        LiveService(Emitter(io.StringIO()), sample_rate=16000, bands=[(0, 8000)] * 12)


@needs_numpy
class BandsArgument(unittest.TestCase):
    def test_parsed_and_handed_to_the_service(self):
        from analysis import live
        self.assertEqual(live.parse_bands('0-160,750-2000,3000-9000'),
                         [(0.0, 160.0), (750.0, 2000.0), (3000.0, 9000.0)])
        # How JavaScript writes a very small edge.
        self.assertEqual(live.parse_bands('1e-7-160,20.5-11025'), [(1e-7, 160.0), (20.5, 11025.0)])
        made = []
        out = io.StringIO()
        with mock.patch.object(live, 'LiveService', lambda emitter, **kw: made.append(kw)), \
                mock.patch.object(live, '_soundcard', return_value=None), \
                mock.patch.object(live, '_sounddevice', return_value=None), \
                mock.patch('sys.stdout', out), mock.patch('sys.stdin', io.StringIO()):
            live.main(['--source', 'loopback', '--bands', '0-160,750-2000'])
        self.assertEqual(made, [{'bands': [(0.0, 160.0), (750.0, 2000.0)]}])

    def test_a_bad_list_is_a_usage_error_before_any_device_is_opened(self):
        from analysis import live
        bad = ['0-12000', '160-0', '100-100', '', 'abc', '0-160,,750-2000', '0-160-200', '-5-100',
               'nan-100', '0-inf', ','.join(['0-100'] * 13)]
        for text in bad:
            with self.subTest(bands=text):
                err = io.StringIO()
                with mock.patch.object(live, '_soundcard', side_effect=AssertionError('device opened')), \
                        mock.patch('sys.stderr', err), self.assertRaises(SystemExit) as exit_:
                    live.main(['--source', 'loopback', '--bands', text])
                self.assertEqual(exit_.exception.code, 2)
                self.assertIn('--bands', err.getvalue())


def push_track(service, track, ask_at=None, requests=()):
    """`track` a hop at a time; at sample `ask_at` the server's `requests` reach the service."""
    from analysis.live import HOP
    for start in range(0, len(track.samples), HOP):
        if start == ask_at:
            for request in requests:
                service.ask(request)
        service.push(track.samples[start:start + HOP])


@needs_numpy
class BandsRequest(unittest.TestCase):
    """Other bands asked for on stdin while the service runs: taken between two hops, the stream going on."""

    def run_asking(self, track, bands, requests):
        from analysis.live import LiveService, Emitter, HOP
        out = io.StringIO()
        service = LiveService(Emitter(out), sample_rate=track.sr, bands=bands)
        push_track(service, track, ask_at=(len(track.samples) // HOP // 2) * HOP, requests=requests)
        return lines_of(out.getvalue())

    def test_a_new_list_is_summed_from_the_next_hop_on_in_the_same_stream(self):
        # Before the word, every line is the old list's; after it, the new
        # list's; and the rest of each line is what an uninterrupted service
        # writes: the same beat, clock and levels, no hop missing.
        track = synth.four_on_the_floor(bpm=128, bars=4)
        old, new = [(0, 160), (750, 2000)], [(20, 250), (250, 3000), (3000, 9000)]
        lines = self.run_asking(track, old, [json.dumps({'type': 'bands', 'bands': '20-250,250-3000,3000-9000'})])
        [taken] = [i for i, m in enumerate(lines) if m['type'] == 'bands']
        self.assertEqual(lines[taken], {'type': 'bands', 'bands': '20-250,250-3000,3000-9000'})
        before = [m for m in lines[:taken] if m['type'] == 'state']
        after = [m for m in lines[taken + 1:] if m['type'] == 'state']
        self.assertTrue(before and after)
        on_old = [m for m in run_service(track, bands=old) if m['type'] == 'state']
        on_new = [m for m in run_service(track, bands=new) if m['type'] == 'state']
        self.assertEqual(len(before) + len(after), len(on_old))
        self.assertEqual(before, on_old[:len(before)])
        self.assertEqual(after, on_new[len(before):])

    def test_an_empty_list_sums_none_and_a_list_after_it_sums_again(self):
        track = synth.four_on_the_floor(bpm=128, bars=2)
        lines = self.run_asking(track, [(0, 160)], [json.dumps({'type': 'bands', 'bands': ''}),
                                                    json.dumps({'type': 'bands', 'bands': '750-2000'})])
        words = [m for m in lines if m['type'] == 'bands']
        self.assertEqual(words, [{'type': 'bands', 'bands': ''}, {'type': 'bands', 'bands': '750-2000'}])
        taken = max(i for i, m in enumerate(lines) if m['type'] == 'bands')
        after = [m for m in lines[taken + 1:] if m['type'] == 'state']
        self.assertTrue(after and all(len(m['spectrum']['bands']) == 1 for m in after))
        # And from nothing at the start.
        lines = self.run_asking(track, None, [json.dumps({'type': 'bands', 'bands': '750-2000'})])
        taken = [i for i, m in enumerate(lines) if m['type'] == 'bands'][0]
        self.assertTrue(all('spectrum' not in m for m in lines[:taken]))
        self.assertTrue(all(len(m['spectrum']['bands']) == 1 for m in lines[taken + 1:] if m['type'] == 'state'))

    def test_a_request_it_cannot_take_is_an_error_and_the_bands_stay(self):
        track = synth.four_on_the_floor(bpm=128, bars=2)
        bad = ['not json', '[]', json.dumps({'type': 'other', 'bands': '0-160'}), json.dumps({'type': 'bands', 'bands': [[0, 160]]}),
               json.dumps({'type': 'bands', 'bands': '0-12000'}), json.dumps({'type': 'bands', 'bands': '160-0'}),
               json.dumps({'type': 'bands', 'bands': ','.join(['0-100'] * 13)})]
        lines = self.run_asking(track, [(0, 160), (750, 2000)], bad)
        errors = [m for m in lines if m['type'] == 'error']
        self.assertEqual(len(errors), len(bad))
        self.assertTrue(all(m['fatal'] is False for m in errors))
        self.assertFalse(any(m['type'] == 'bands' for m in lines))
        self.assertEqual([m for m in lines if m['type'] == 'state'],
                         [m for m in run_service(track, bands=[(0, 160), (750, 2000)]) if m['type'] == 'state'])

    def test_the_service_reads_its_stdin_while_it_captures(self):
        import threading
        from analysis import live
        track = synth.four_on_the_floor(bpm=128, bars=4)
        # The request arrives on a pipe a hundred hops in, and is in by the next.
        r, w = os.pipe()
        read = threading.Event()
        reader = live.read_requests

        def reading(stream, service):
            reader(stream, service)
            read.set()

        class Recorder:
            at = 0

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def record(self, numframes):
                if self.at == 100 * numframes:
                    os.write(w, (json.dumps({'type': 'bands', 'bands': '750-2000'}) + '\n').encode())
                    os.close(w)
                    self.assertion = read.wait(5)
                if self.at >= 200 * numframes:
                    raise KeyboardInterrupt
                block = track.samples[self.at:self.at + numframes]
                self.at += numframes
                return block

        recorder = Recorder()

        class Mic:
            name = 'Speakers'

            def recorder(self, samplerate, blocksize):
                return recorder

        class FakeSoundcard:
            @staticmethod
            def default_speaker():
                return Mic()

            @staticmethod
            def get_microphone(id, include_loopback=False):
                return Mic()

        out = io.StringIO()
        with os.fdopen(r) as stdin, mock.patch.object(live, '_soundcard', return_value=FakeSoundcard), \
                mock.patch.object(live, 'read_requests', reading), \
                mock.patch('sys.stdin', stdin), mock.patch('sys.stdout', out):
            self.assertEqual(live.main(['--source', 'loopback', '--bands', '0-160,750-2000']), 0)
        self.assertTrue(recorder.assertion, 'stdin was read')
        lines = lines_of(out.getvalue())
        [taken] = [i for i, m in enumerate(lines) if m['type'] == 'bands']
        self.assertEqual(lines[taken], {'type': 'bands', 'bands': '750-2000'})
        before = [m for m in lines[:taken] if m['type'] == 'state']
        after = [m for m in lines[taken + 1:] if m['type'] == 'state']
        self.assertTrue(before and after)
        self.assertTrue(all(len(m['spectrum']['bands']) == 2 for m in before if 'spectrum' in m))
        self.assertTrue(all(len(m['spectrum']['bands']) == 1 for m in after))
        self.assertEqual(len([m for m in lines if m['type'] == 'ready']), 1, 'one capture throughout')


if __name__ == '__main__':
    unittest.main()
