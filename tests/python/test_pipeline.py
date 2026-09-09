"""
The analysis document: its shape, its size, and the compatibility surface.

The document crosses two boundaries — a JSON pipe to the Node server, and a
socket to a browser — and both have opinions. It has to serialise (no numpy
scalars, no NaN), it has to stay small enough to send, and it has to keep the
field names the existing web client reads.
"""

import json
import unittest

import synth
from support import AudioTestCase, analyse_track, needs_audio


# Field names the web client, the timeline view and the on-disk cache all read.
# Removing one is a UI regression that no test of the analyser would otherwise
# catch, because the analyser would still be perfectly correct.
COMPATIBILITY_FIELDS = [
    'duration', 'bpm', 'tempoCurve', 'tempoStability', 'beatSource', 'beats',
    'beatStrengths', 'downbeats', 'meter', 'downbeatConfidence', 'key', 'scale',
    'keyStrength', 'mood', 'genre', 'segments', 'onsets', 'kickOnsets', 'drops',
    'buildups', 'energyCurve', 'bassCurve', 'kickCurve', 'highCurve',
]


@needs_audio
class Document(AudioTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.doc = analyse_track(synth.four_on_the_floor(bpm=128, bars=48), 'document')

    def test_it_serialises_without_a_custom_encoder(self):
        """numpy's bool_, float64 and int64 are not JSON-serialisable and leak
        in wherever a comparison result reaches a dict. The failure mode is the
        worker returning an error for a track it analysed perfectly."""
        json.dumps(self.doc, allow_nan=False)

    def test_every_field_the_client_reads_is_still_there(self):
        for field in COMPATIBILITY_FIELDS:
            self.assertIn(field, self.doc)

    def test_the_structured_sections_are_present(self):
        for field in ('schemaVersion', 'loudness', 'rhythm', 'bands',
                      'instruments', 'structure', 'dynamics', 'perception',
                      'events', 'features', 'meta', 'stereo'):
            self.assertIn(field, self.doc)

    def test_it_is_small_enough_to_send_over_a_socket(self):
        """Eleven undecimated curves on a four-minute track is tens of
        megabytes of JSON travelling to a browser that draws it 900 pixels
        wide."""
        size = len(json.dumps(self.doc))
        per_minute = size / max(1.0, self.doc['duration'] / 60.0)
        self.assertLess(per_minute, 400_000,
                        f'{per_minute / 1024:.0f} KB per minute of audio')

    def test_all_seven_bands_are_described(self):
        from analysis.config import BAND_ORDER
        self.assertEqual(list(self.doc['bands'].keys()), BAND_ORDER)
        for band in self.doc['bands'].values():
            for field in ('energy', 'attackMs', 'decayMs', 'variation',
                          'rhythmic', 'percussive', 'importance', 'curve'):
                self.assertIn(field, band)

    def test_the_percussive_bands_are_measured_as_more_percussive(self):
        """A four-on-the-floor track with hats: the top of the spectrum is
        transients, the bottom is a sustained bass tone."""
        bands = self.doc['bands']
        self.assertGreater(bands['high']['percussive'], bands['bass']['percussive'])

    def test_the_percussive_bands_have_shorter_attacks(self):
        bands = self.doc['bands']
        self.assertLess(bands['high']['attackMs'], bands['bass']['attackMs'])

    def test_instrument_roles_are_scored(self):
        from analysis.bands import ROLES
        scores = self.doc['instruments']['scores']
        for role in ROLES:
            self.assertIn(role, scores)
            self.assertGreaterEqual(scores[role], 0.0)
            self.assertLessEqual(scores[role], 1.0)

    def test_mood_is_reported_as_fractions(self):
        for key in ('valence', 'arousal', 'danceability', 'kickiness', 'tension'):
            value = self.doc['mood'][key]
            self.assertGreaterEqual(value, 0.0)
            self.assertLessEqual(value, 1.0)

    def test_a_four_on_the_floor_track_reads_as_danceable(self):
        self.assertGreater(self.doc['mood']['danceability'], 0.6)

    def test_the_style_is_one_the_show_engine_knows(self):
        self.assertIn(self.doc['genre']['style'],
                      ('dance', 'moderate', 'rock', 'calm', 'unknown'))

    def test_loudness_is_reported_on_the_lufs_scale(self):
        loudness = self.doc['loudness']
        self.assertLess(loudness['integratedLufs'], 0.0)
        self.assertGreater(loudness['integratedLufs'], -60.0)
        self.assertGreaterEqual(loudness['range'], 0.0)

    def test_the_meta_block_records_how_the_analysis_was_run(self):
        meta = self.doc['meta']
        self.assertEqual(meta['sampleRate'], 22050)
        self.assertGreater(meta['frames'], 0)
        self.assertIn('elapsedSec', meta)


@needs_audio
class Degenerate(AudioTestCase):
    """Input that is not music must produce a document, not an exception."""

    def test_silence(self):
        doc = analyse_track(synth.silence(6.0), 'silence-doc')
        json.dumps(doc, allow_nan=False)
        self.assertEqual(doc['drops'], [])
        self.assertLess(doc['mood']['arousal'], 0.4)

    def test_white_noise(self):
        doc = analyse_track(synth.noise(8.0), 'noise-doc')
        json.dumps(doc, allow_nan=False)
        for field in COMPATIBILITY_FIELDS:
            self.assertIn(field, doc)

    def test_a_two_second_clip(self):
        doc = analyse_track(synth.four_on_the_floor(bars=1), 'tiny-doc')
        json.dumps(doc, allow_nan=False)
        self.assertGreater(doc['duration'], 0)


@needs_audio
class Reporting(AudioTestCase):
    def test_the_debug_report_is_a_standalone_page(self):
        from analysis import report
        doc = analyse_track(synth.four_on_the_floor(bars=16), 'report-doc')
        html = report.analysis_to_html(doc, title='test', waveform=[0.1, 0.9, 0.4])
        self.assertIn('<!doctype html>', html)
        self.assertIn('application/json', html)
        # No external requests: an operator debugging a rig is not necessarily
        # on a network.
        self.assertNotIn('src="http', html)
        self.assertNotIn('href="http', html)

    def test_a_closing_script_tag_in_the_payload_cannot_break_out(self):
        from analysis import report
        html = report.analysis_to_html({'duration': 1, 'note': '</script><b>x'})
        self.assertNotIn('</script><b>', html)


@needs_audio
class Separation(AudioTestCase):
    """
    Demucs, and the instrument roles read off its stems.

    Separation is the expensive half of the pipeline, so it runs once here over
    a short track rather than under every other test. What it has to establish
    is that the stems are the right stems: the fixture has drums and a bass line
    and no singer, and the roles have to say so.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.doc = analyse_track(synth.four_on_the_floor(bpm=128, bars=16),
                                'separated', separate=True)

    def test_the_document_records_that_it_separated(self):
        self.assertTrue(self.doc['meta']['separated'])
        self.assertIn('sources', self.doc)

    def test_the_stems_add_up_to_the_mix(self):
        total = sum(self.doc['sources'].values())
        self.assertAlmostEqual(total, 1.0, delta=0.02)

    def test_a_track_with_no_singer_scores_no_vocal(self):
        """The band heuristics this replaced read a bright pad as a voice. The
        vocals stem of a track with no voice in it is empty, which is not a
        judgement call."""
        self.assertLess(self.doc['instruments']['scores']['vocal'], 0.1)

    def test_the_drums_and_bass_are_both_found(self):
        scores = self.doc['instruments']['scores']
        self.assertGreater(scores['kick'], 0.2)
        self.assertGreater(scores['bassline'], 0.5)


@needs_audio
class StemRoles(AudioTestCase):
    """
    The role curves as the show engine sees them, before the transport step
    rounds them onto a half-second grid. Beat-level phase cannot be asserted on
    the transported curve: at 128 BPM a half-second bucket holds a whole beat,
    so every bucket contains a kick and the curve is flat by construction.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from analysis import preprocess, features, bands, stems
        track = synth.four_on_the_floor(bpm=128, bars=8)
        import os
        path = track.write(os.path.join(cls.tmpdir, 'roles.wav'))
        audio = preprocess.prepare(path)
        cls.track = track
        cls.features = features.extract(audio)
        cls.stems = stems.separate(audio.mono, audio.sample_rate)
        cls.roles = bands.infer_roles(cls.features,
                                      bands.analyse(cls.features),
                                      stems=cls.stems)

    def test_the_kick_curve_peaks_on_the_beat(self):
        """A kick curve that does not peak on the beats is a curve of
        something else — which is exactly what the band heuristics produced on
        a track whose bass line moved."""
        import librosa
        import numpy as np
        curve = self.roles.curve('kick')
        frames = librosa.time_to_frames(np.asarray(self.track.beats),
                                        sr=self.features.sample_rate,
                                        hop_length=self.features.hop_length)
        frames = frames[(frames >= 0) & (frames < curve.size)]
        on = np.unique(np.concatenate([frames + d for d in (-1, 0, 1)]))
        on = on[(on >= 0) & (on < curve.size)]
        off = np.setdiff1d(np.arange(curve.size), on)
        self.assertGreater(float(curve[on].mean()),
                           3.0 * float(curve[off].mean()))

    def test_the_vocals_stem_of_an_instrumental_is_empty(self):
        self.assertLess(self.stems.energies()['vocals'], 0.01)

    def test_every_role_curve_is_on_the_feature_grid(self):
        """A curve of a different length silently misaligns every cue built
        from it."""
        for name, curve in self.roles.curves.items():
            self.assertEqual(curve.size, self.features.n_frames, name)


if __name__ == '__main__':
    unittest.main()
