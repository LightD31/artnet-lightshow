"""
Regression tests against analyses of real tracks.

Synthetic signals prove the DSP is correct; they cannot prove the *judgement*
on top of it is sensible, because a synthetic track has no genre, its sections
are identical loops, and its arrangement is whatever the generator wrote. Every
defect in this file was found by running five real tracks through the finished
pipeline and reading the result.

The fixtures in tests/fixtures/tracks/ are the show-facing parts of those
analyses — sections, drops, mood, subgenre scores — with the frame-level curves
stripped. Small enough to read in a diff, and enough to pin the two decisions
that were wrong.
"""

import glob
import json
import os
import unittest

from support import REPO, needs_numpy

FIXTURES = sorted(glob.glob(os.path.join(REPO, 'tests', 'fixtures', 'tracks', '*.json')))


def load(name):
    for path in FIXTURES:
        if name in os.path.basename(path):
            with open(path, encoding='utf-8') as handle:
                return json.load(handle)
    raise AssertionError(f'no fixture matching {name}')


class Tempo:
    """Stand-in for the rhythm result; the style fallback reads only the tempo."""

    def __init__(self, bpm):
        self.bpm = bpm


class Fixtures(unittest.TestCase):
    def test_the_fixtures_are_present_and_current(self):
        self.assertEqual(len(FIXTURES), 5)
        for path in FIXTURES:
            with open(path, encoding='utf-8') as handle:
                fixture = json.load(handle)
            self.assertEqual(fixture['schemaVersion'], '2.0')
            self.assertTrue(fixture['segments'])


@needs_numpy
class GenreDecision(unittest.TestCase):
    """
    Of the four show styles, `calm` is the only one that turns the show off —
    no strobes, no drops, no accents. It was also the easiest to reach: two of
    the five real tracks landed there on a tag the tagger was not remotely sure
    about, and lost their whole show to it.
    """

    def decide(self, fixture):
        from analysis.perception import decide_genre
        return decide_genre(fixture['genre']['subScores'], fixture['mood'],
                            Tempo(fixture['bpm']))

    def test_a_weak_tag_does_not_get_to_silence_a_track(self):
        # 'les filles, les meufs': ambient 0.108 over funk 0.105. A three
        # percent margin decided the track was calm for three minutes.
        fixture = load('marguerite')
        top = sorted(fixture['genre']['subScores'].values(), reverse=True)
        self.assertLess(top[0] / top[1], 1.2, 'fixture should be a near-tie')
        self.assertNotEqual(self.decide(fixture)['style'], 'calm')

    def test_a_near_tie_falls_back_rather_than_picking_a_winner(self):
        fixture = load('marguerite')
        self.assertEqual(self.decide(fixture)['genre'], 'unknown')

    def test_a_loud_danceable_track_is_never_lit_as_a_ballad(self):
        # 'I Want It That Way' reached `ambient` on `christian music`, which
        # AudioSet fires on close vocal harmony. Arousal 0.84 says otherwise,
        # and arousal is measured rather than inferred.
        fixture = load('backstreet')
        self.assertGreaterEqual(fixture['mood']['arousal'], 0.7)
        self.assertNotEqual(self.decide(fixture)['style'], 'calm')

    def test_a_confident_tag_is_still_believed(self):
        # The guards must not cost the cases that were already right.
        for name, expected in (('elton', 'rock'), ('orelsan', 'hiphop'),
                               ('p-nk', 'rock')):
            with self.subTest(track=name):
                fixture = load(name)
                decided = self.decide(fixture)
                self.assertEqual(decided['genre'], expected)
                self.assertEqual(decided['style'], fixture['genre']['style'])

    def test_the_ambient_bucket_holds_only_ambient_labels(self):
        from analysis.perception import SUBGENRES
        for label in ('piano', 'gospel music', 'christian music'):
            self.assertNotIn(label, SUBGENRES['ambient'],
                             f'{label} does not predict how to light a track')


@needs_numpy
class SectionRoles(unittest.TestCase):
    """
    `drop` was assigned to any section that contained a drop anywhere. Since the
    detector emits a few drops on every track and most sections are long, that
    labelled five of the nine sections of a piano ballad `drop`.
    """

    def roles(self, fixture):
        from analysis.structure import Section, assign_roles
        sections = [Section(start=s['start'], end=s['end'], label=s['label'],
                            energy=s['energy'], level=s['level'],
                            confidence=s.get('confidence', 0.0))
                    for s in fixture['segments']]
        assign_roles(sections, fixture['duration'], fixture['drops'], None)
        return sections

    def test_a_ballad_is_not_mostly_drops(self):
        # Five of nine sections of a piano ballad were `drop`. Three remain, and
        # they are the one cluster the chorus lifts belong to — whether that
        # cluster is better called `drop` or `chorus` is a labelling question
        # the show engine does not act on (the two role profiles are
        # identical). What it must not be is *most of the track*.
        fixture = load('p-nk')
        sections = self.roles(fixture)
        before = sum(1 for s in fixture['segments'] if s['role'] == 'drop')
        after = sum(1 for s in sections if s.role == 'drop')
        self.assertGreaterEqual(before, 5, 'fixture should show the old behaviour')
        self.assertLess(after, before)
        self.assertLess(after, len(sections) / 2)
        labels = {s.label for s in sections if s.role == 'drop'}
        self.assertEqual(len(labels), 1, 'and they should all be the same music')

    def test_the_drop_role_becomes_rare_across_the_board(self):
        # Four of the five tracks are pop, rock or rap — none of them has a
        # drop in the sense the role means.
        for name in ('backstreet', 'elton', 'marguerite', 'orelsan'):
            with self.subTest(track=name):
                fixture = load(name)
                after = sum(1 for s in self.roles(fixture) if s.role == 'drop')
                self.assertEqual(after, 0)

    def test_a_hype_moment_does_not_make_a_section_a_drop(self):
        # A hype drop is an accent inside a section; a proper one starts one.
        from analysis.structure import Section, _starts_on_a_drop
        section = Section(start=10.0, end=40.0, label='A', energy=0.9)
        hype = [{'t': 10.5, 'kind': 'hype'}]
        proper = [{'t': 10.5, 'kind': 'proper'}]
        self.assertFalse(_starts_on_a_drop(section, hype, 0.5))
        self.assertTrue(_starts_on_a_drop(section, proper, 0.5))

    def test_a_drop_in_the_middle_of_a_section_does_not_define_it(self):
        from analysis.structure import Section, _starts_on_a_drop
        section = Section(start=0.0, end=60.0, label='A', energy=0.9)
        self.assertFalse(_starts_on_a_drop(section, [{'t': 40.0, 'kind': 'proper'}], 0.5))
        self.assertTrue(_starts_on_a_drop(section, [{'t': 3.0, 'kind': 'proper'}], 0.5))

    def test_a_drop_into_a_quiet_passage_is_a_transition_not_a_drop(self):
        from analysis.structure import Section, _starts_on_a_drop
        quiet = Section(start=0.0, end=40.0, label='A', energy=0.2)
        self.assertFalse(_starts_on_a_drop(quiet, [{'t': 1.0, 'kind': 'proper'}], 0.5))

    def test_one_cluster_never_gets_two_roles(self):
        """
        The property the whole clustering exists to provide. The show engine
        biases a section's energy tier by its role, so two appearances of one
        cluster that disagree get different beat divisions for identical music.
        Four of the five real tracks had at least one such conflict.
        """
        positional = {'intro', 'outro'}
        for path in FIXTURES:
            with open(path, encoding='utf-8') as handle:
                fixture = json.load(handle)
            with self.subTest(track=os.path.basename(path)):
                by_label = {}
                for section in self.roles(fixture):
                    if section.role in positional:
                        continue
                    by_label.setdefault(section.label, set()).add(section.role)
                conflicts = {k: v for k, v in by_label.items() if len(v) > 1}
                self.assertEqual(conflicts, {})

    def test_the_fixtures_still_record_the_conflicts_this_fixes(self):
        # If a future change makes the fixtures agree by accident, the test
        # above stops proving anything.
        positional = {'intro', 'outro'}
        total = 0
        for path in FIXTURES:
            with open(path, encoding='utf-8') as handle:
                fixture = json.load(handle)
            by_label = {}
            for section in fixture['segments']:
                if section['role'] in positional:
                    continue
                by_label.setdefault(section['label'], set()).add(section['role'])
            total += sum(1 for v in by_label.values() if len(v) > 1)
        self.assertGreaterEqual(total, 4)

    def test_intro_and_outro_survive_the_reconciliation(self):
        # They are defined by position: the first section of a track is an
        # intro however much it resembles the chorus.
        for name in ('p-nk', 'elton'):
            with self.subTest(track=name):
                roles = [s.role for s in self.roles(load(name))]
                self.assertEqual(roles[0], 'intro')
                self.assertEqual(roles[-1], 'outro')


if __name__ == '__main__':
    unittest.main()
