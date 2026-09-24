"""
The music at pixel rate: stem envelopes fifty times a second, and the kick,
snare and hat lanes read off the drum stem.

The lanes are checked against a kit whose every hit was placed by hand, so
"found" means within 30 ms of where it was put, and each lane is scored on both
what it found (recall) and what it made up (precision).
"""

import unittest

import synth
from support import AudioTestCase, analyse_track, needs_audio, needs_numpy

BPM = 128.0
BEAT = 60.0 / BPM


def _kit(sr=22050, bars=8, hats_on_beats=False):
    """Kick on every beat, snare on 2 and 4, a hat on every off-beat."""
    import numpy as np
    buf = np.zeros(int(sr * bars * 4 * BEAT) + sr)
    truth = {'kick': [], 'snare': [], 'hats': []}
    k, s, h = synth.kick(sr), synth.snare(sr), synth.hat(sr)
    for b in range(bars * 4):
        t = b * BEAT
        synth._place(buf, k, t, sr, gain=0.8)
        truth['kick'].append(t)
        if b % 2 == 1:
            synth._place(buf, s, t, sr, gain=0.55)
            truth['snare'].append(t)
        synth._place(buf, h, t + BEAT / 2, sr, gain=0.3)
        truth['hats'].append(t + BEAT / 2)
        if hats_on_beats:
            synth._place(buf, h, t, sr, gain=0.3)
    return buf.astype(np.float32), truth


def _score(found, wanted, tolerance=0.03):
    import numpy as np
    found, wanted = np.asarray(found), np.asarray(wanted)
    if not found.size:
        return 0.0, 0.0
    recall = np.mean([np.min(np.abs(found - w)) <= tolerance for w in wanted])
    precision = np.mean([np.min(np.abs(wanted - f)) <= tolerance for f in found])
    return float(recall), float(precision)


@needs_numpy
class Envelopes(unittest.TestCase):
    def test_fifty_points_a_second_on_a_perceptual_scale(self):
        import numpy as np
        from analysis import pulse
        sr = 22050
        t = np.arange(sr * 4) / sr
        tone = np.sin(2 * np.pi * 220 * t)
        # Two seconds loud, two seconds 18 dB down: half the range below.
        signal = np.concatenate([tone[:sr * 2], tone[sr * 2:] * 10 ** (-18 / 20)])
        env = pulse.envelope(signal, sr)
        self.assertEqual(env.dtype, np.uint8)
        self.assertAlmostEqual(env.size, 4 * pulse.RATE, delta=1)
        self.assertGreaterEqual(int(np.median(env[10:90])), 250)
        self.assertAlmostEqual(int(np.median(env[110:190])) / 255, 0.5, delta=0.05)

    def test_an_empty_stem_stays_dark(self):
        import numpy as np
        from analysis import pulse
        noise = np.random.default_rng(1).standard_normal(22050) * 1e-5
        self.assertEqual(int(pulse.envelope(noise, 22050).max()), 0,
                         'a stem that is only bleed does not light the bar')

    def test_the_wire_form_round_trips(self):
        import numpy as np
        from analysis import pulse
        values = np.arange(256, dtype=np.uint8)
        self.assertEqual(pulse.decode(pulse.encode(values)).tolist(), values.tolist())


@needs_audio
class Lanes(AudioTestCase):
    def test_kick_snare_and_hats_from_a_drum_stem(self):
        from analysis import pulse
        drums, truth = _kit()
        lanes = pulse.lanes(drums, 22050)
        for name in ('kick', 'snare', 'hats'):
            recall, precision = _score(lanes[name]['t'], truth[name])
            self.assertGreaterEqual(recall, 0.95, f'{name} recall')
            self.assertGreaterEqual(precision, 0.95, f'{name} precision')
            self.assertEqual(len(lanes[name]['s']), len(lanes[name]['t']))
            self.assertTrue(all(0 <= s <= 1 for s in lanes[name]['s']))

    def test_a_hat_under_a_snare_is_the_snare_s(self):
        """Its noise reaches up into the hats' band; counted twice, a snare
        would sparkle the bar as well as crack it."""
        from analysis import pulse
        drums, truth = _kit(hats_on_beats=True)
        lanes = pulse.lanes(drums, 22050)
        _, precision = _score(lanes['snare']['t'], truth['snare'])
        self.assertGreaterEqual(precision, 0.95)
        snares = set(round(t, 2) for t in truth['snare'])
        self.assertFalse(any(round(t, 2) in snares for t in lanes['hats']['t']))

    def test_a_snare_s_body_is_not_a_kick(self):
        """A real snare rings below 150 Hz as well; on MDB Drums that low end
        was most of the kick lane's false hits. A rock beat — kick on one
        and three, a snare with a body on two and four — has kicks on one and
        three only."""
        import numpy as np
        from analysis import pulse
        sr = 22050
        snare = synth.snare(sr)
        t = np.arange(snare.size) / sr
        snare = snare + 0.6 * np.sin(2 * np.pi * 120 * t) * np.exp(-t / 0.04)
        buf = np.zeros(int(sr * (32 * BEAT + 1)))
        kicks, snares = [], []
        for b in range(32):
            at = 0.25 + b * BEAT
            if b % 2 == 0:
                synth._place(buf, synth.kick(sr), at, sr, gain=0.8)
                kicks.append(at)
            else:
                synth._place(buf, snare, at, sr, gain=0.6)
                snares.append(at)
        lanes = pulse.lanes(buf.astype(np.float32), sr)
        recall, precision = _score(lanes['kick']['t'], kicks)
        self.assertGreaterEqual(recall, 0.95)
        self.assertGreaterEqual(precision, 0.95, 'the body of a snare is not a kick')
        recall, _ = _score(lanes['snare']['t'], snares)
        self.assertGreaterEqual(recall, 0.95)

    def test_without_stems_the_percussive_half_of_the_mix_still_works(self):
        from analysis import preprocess, pulse
        track = synth.four_on_the_floor(bpm=BPM, bars=16)
        audio = preprocess.prepare(self.write(track, 'mix.wav'))
        block = pulse.analyse(audio)
        self.assertEqual(block['source'], 'mix')
        self.assertEqual(set(block['envelopes']), {'mix'})
        kicks = [t for t in track.beats]
        recall, precision = _score(block['lanes']['kick']['t'], kicks, tolerance=0.035)
        self.assertGreaterEqual(recall, 0.9)
        self.assertGreaterEqual(precision, 0.9)

    def test_silence_has_no_hits(self):
        import numpy as np
        from analysis import pulse
        lanes = pulse.lanes(np.zeros(22050 * 3, dtype=np.float32), 22050)
        self.assertEqual({name: lane['t'] for name, lane in lanes.items()},
                         {'kick': [], 'snare': [], 'hats': []})


@needs_audio
class InTheDocument(AudioTestCase):
    def test_separated_stems_each_get_an_envelope(self):
        import numpy as np
        from analysis import preprocess, pulse
        from analysis.stems import Stems
        track = synth.four_on_the_floor(bpm=BPM, bars=8)
        audio = preprocess.prepare(self.write(track, 'stems.wav'))
        drums, _ = _kit(bars=8)
        n = audio.mono.size
        stems = Stems(drums=np.resize(drums, n), bass=audio.mono * 0.5,
                      vocals=np.zeros(n, np.float32), other=audio.mono * 0.2,
                      sample_rate=audio.sample_rate)
        block = pulse.analyse(audio, stems)
        self.assertEqual(block['source'], 'stems')
        self.assertEqual(set(block['envelopes']), {'mix', 'drums', 'bass', 'vocals', 'other'})
        self.assertEqual(int(pulse.decode(block['envelopes']['vocals']).max()), 0)
        self.assertGreater(len(block['lanes']['kick']['t']), 20)

    def test_the_pipeline_writes_it_and_the_schema_takes_it(self):
        from analysis import pulse, schema
        doc = analyse_track(synth.four_on_the_floor(bpm=BPM, bars=16), 'pulse-doc')
        block = doc['pulse']
        self.assertEqual(block['rate'], pulse.RATE)
        points = pulse.decode(block['envelopes']['mix']).size
        self.assertAlmostEqual(points / pulse.RATE, doc['duration'], delta=0.1)
        self.assertEqual(schema.errors(doc), [])
        self.assertEqual(block['detector'], pulse.DETECTOR)
        self.assertEqual(doc['schemaVersion'], '2.2')


if __name__ == '__main__':
    unittest.main()
