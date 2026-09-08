"""
Sections, and the dynamics that happen inside them.

The synthetic track has a written arrangement — intro, verse, build-up, drop,
breakdown, outro — at known bar positions, so the assertions here are about
whether the pipeline finds the arrangement that is actually there.

Boundary detection on real music is a research problem and the tolerances
reflect that: the tests check that the *drop* lands within a bar, because a
drop late by a bar is a show that misses its biggest moment, and only that the
sections are plausible, because a chorus boundary a bar early is a scene change
a bar early and nobody notices.
"""

import unittest

import synth
from support import AudioTestCase, needs_audio, needs_numpy


@needs_audio
class Sections(AudioTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from analysis import preprocess, features, rhythm, bands, dynamics, structure
        track = synth.four_on_the_floor(bpm=128, bars=48)
        cls.track = track
        audio = preprocess.prepare(cls().write(track, 'structure.wav')
                                   if False else track.write(f'{cls.tmpdir}/structure.wav'))
        frames = features.extract(audio)
        cls.rhythm = rhythm.analyse(audio, frames)
        band_map = bands.analyse(frames, cls.rhythm.beats)
        cls.roles = bands.infer_roles(frames, band_map)
        cls.dynamics = dynamics.analyse(frames, band_map, cls.rhythm)
        cls.sections = structure.analyse(
            frames, cls.rhythm, cls.roles,
            [d.to_dict() for d in cls.dynamics.drops])
        cls.frames = frames

    def test_the_track_is_divided_into_several_sections(self):
        self.assertGreaterEqual(len(self.sections), 2)
        self.assertLessEqual(len(self.sections), 12)

    def test_sections_tile_the_track_without_gaps_or_overlaps(self):
        for previous, section in zip(self.sections, self.sections[1:]):
            self.assertAlmostEqual(previous.end, section.start, delta=0.001)
        self.assertLess(self.sections[0].start, 2.0)

    def test_no_section_is_shorter_than_the_configured_minimum(self):
        """A four-second block is a fill, not a section, and changing the whole
        look for one is the commonest way an automatic show looks twitchy."""
        from analysis.config import StructureConfig
        minimum = StructureConfig().min_section_sec
        for section in self.sections:
            self.assertGreaterEqual(section.duration, minimum - 0.5)

    def test_the_first_section_is_an_intro_and_the_last_is_an_outro(self):
        self.assertEqual(self.sections[0].role, 'intro')
        self.assertIn(self.sections[-1].role, ('outro', 'breakdown'))

    def test_every_role_is_one_the_show_engine_knows(self):
        from analysis import structure
        for section in self.sections:
            self.assertIn(section.role, structure.ROLES)

    def test_the_loudest_section_is_not_labelled_intro_or_outro(self):
        loudest = max(self.sections, key=lambda s: s.energy)
        self.assertNotIn(loudest.role, ('intro', 'outro'))

    def test_sections_sharing_a_label_share_a_role(self):
        """A chorus that lights differently on its second appearance reads as a
        mistake rather than as variety."""
        by_label = {}
        for section in self.sections:
            by_label.setdefault(section.label, set()).add(section.role)
        structural = {'intro', 'outro', 'drop'}
        for label, roles in by_label.items():
            self.assertLessEqual(len(roles - structural), 1,
                                 f'label {label} has roles {roles}')


@needs_audio
class Dynamics(Sections):
    def test_the_drop_is_found_where_it_was_written(self):
        written = self.track.drops[0]['t']
        found = [d.t for d in self.dynamics.drops]
        self.assertTrue(found, 'no drop detected at all')
        closest = min(found, key=lambda t: abs(t - written))
        # Within one bar at 128 BPM.
        self.assertLess(abs(closest - written), 1.9,
                        f'drop at {written}s reported at {closest}s')

    def test_the_drop_lands_on_a_downbeat(self):
        """Drops are written on bar lines, and the detector's own resolution is
        coarser than a bar — so it snaps."""
        self.assertTrue(any(d.snap == 'downbeat' for d in self.dynamics.drops))

    def test_the_buildup_precedes_the_drop_and_does_not_swallow_the_verse(self):
        written = self.track.buildups[0]
        self.assertTrue(self.dynamics.buildups)
        build = min(self.dynamics.buildups,
                    key=lambda b: abs(b.end - written['end']))
        self.assertLess(abs(build.end - written['end']), 2.0)
        self.assertLess(abs(build.start - written['start']), 4.0,
                        'the build-up must not extend back through the verse')

    def test_a_flat_track_produces_no_drops(self):
        """The detector must not find one everywhere it looks; a loop with no
        arrangement has nothing to fire on."""
        from analysis import preprocess, features, rhythm, bands, dynamics
        path = self.write(
            synth.four_on_the_floor(bars=24, with_structure=False), 'flat.wav')
        audio = preprocess.prepare(path)
        frames = features.extract(audio)
        beat = rhythm.analyse(audio, frames)
        band_map = bands.analyse(frames, beat.beats)
        result = dynamics.analyse(frames, band_map, beat)
        self.assertEqual(len(result.drops), 0)

    def test_no_silences_are_reported_between_kicks(self):
        """An unsmoothed energy test finds a silence in every gap of a
        four-on-the-floor track — several hundred of them."""
        self.assertLessEqual(len(self.dynamics.silences), 2)

    def test_breaks_do_not_run_through_the_drop_that_ends_them(self):
        for span in self.dynamics.breaks:
            for drop in self.dynamics.drops:
                self.assertFalse(span.start < drop.t < span.end,
                                 'a break must end where the energy returns')


@needs_numpy
class RollMeasurement(unittest.TestCase):
    def test_the_subdivision_is_measured_not_assumed(self):
        from analysis.dynamics import roll_subdivision

        flat = [i * 0.25 for i in range(40)]           # constant density
        self.assertEqual(roll_subdivision(flat, 0.0, 10.0), 1)

        doubling = ([i * 0.25 for i in range(14)]
                    + [3.5 + i * 0.125 for i in range(52)])
        self.assertGreaterEqual(roll_subdivision(doubling, 0.0, 10.0), 2)

    def test_a_buildup_from_silence_is_not_read_as_a_roll(self):
        """A ratio against an empty first third says nothing, and reading it as
        an enormous acceleration slams the rig to its fastest division."""
        from analysis.dynamics import roll_subdivision
        late_only = [7.0 + i * 0.1 for i in range(30)]
        self.assertEqual(roll_subdivision(late_only, 0.0, 10.0), 1)


if __name__ == '__main__':
    unittest.main()
