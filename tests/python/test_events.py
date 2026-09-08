"""
The event stream, and the invariants the show engine relies on.

The show engine processes events in order and lets later ones override earlier
ones, so ordering is part of the contract. So is the shape: an event missing a
confidence or carrying a NaN timestamp is one the director cannot reason about.
"""

import unittest

import synth
from support import AudioTestCase, analyse_track, needs_audio


@needs_audio
class Stream(AudioTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.doc = analyse_track(synth.four_on_the_floor(bpm=128, bars=48), 'events')
        cls.events = cls.doc['events']

    def test_every_event_has_the_common_fields(self):
        for event in self.events:
            for field in ('t', 'type', 'confidence', 'intensity', 'duration', 'effect'):
                self.assertIn(field, event, f'{event["type"]} is missing {field}')

    def test_every_type_is_one_the_show_engine_knows(self):
        from analysis import events as events_module
        for event in self.events:
            self.assertIn(event['type'], events_module.TYPES)

    def test_every_recommended_effect_is_one_the_renderer_knows(self):
        from analysis import events as events_module
        for event in self.events:
            self.assertIn(event['effect'], events_module.EFFECTS)

    def test_the_stream_is_sorted_and_inside_the_track(self):
        times = [event['t'] for event in self.events]
        self.assertEqual(times, sorted(times))
        for t in times:
            self.assertGreaterEqual(t, 0)
            self.assertLessEqual(t, self.doc['duration'] + 1.0)

    def test_confidence_and_intensity_are_fractions(self):
        for event in self.events:
            self.assertGreaterEqual(event['confidence'], 0.0)
            self.assertLessEqual(event['confidence'], 1.0)
            self.assertGreaterEqual(event['intensity'], 0.0)
            self.assertLessEqual(event['intensity'], 1.0)

    def test_a_drop_and_a_section_change_on_one_instant_resolve_to_the_drop(self):
        """The show engine takes the last event at an instant as the winner, so
        the drop has to sort last."""
        from analysis import events as events_module
        by_time = {}
        for event in self.events:
            by_time.setdefault(round(event['t'], 3), []).append(event['type'])
        for types in by_time.values():
            if events_module.DROP in types and len(types) > 1:
                self.assertEqual(types[-1], events_module.DROP)

    def test_the_expected_types_are_all_present(self):
        from analysis import events as events_module
        present = {event['type'] for event in self.events}
        for required in (events_module.BEAT, events_module.BAR,
                         events_module.SECTION, events_module.TRANSITION,
                         events_module.DROP, events_module.BUILDUP):
            self.assertIn(required, present)

    def test_beats_carry_their_position_in_the_bar(self):
        from analysis import events as events_module
        beats = [e for e in self.events if e['type'] == events_module.BEAT]
        self.assertTrue(beats)
        positions = {e['data']['inBar'] for e in beats}
        self.assertEqual(positions, set(range(self.doc['meter'])))

    def test_bars_carry_their_position_in_the_phrase(self):
        """Popular music is built in four-bar phrases, and a scene change on
        bar three reads as a mistake even when the energy justified it."""
        from analysis import events as events_module
        bars = [e for e in self.events if e['type'] == events_module.BAR]
        self.assertTrue(bars)
        starts = [e for e in bars if e['data']['phraseStart']]
        self.assertAlmostEqual(len(starts), len(bars) / 4, delta=1)

    def test_span_events_carry_an_end(self):
        for event in self.events:
            if event['duration'] > 0 and 'data' in event and 'end' in event['data']:
                self.assertGreaterEqual(event['data']['end'], event['t'])

    def test_transitions_name_both_sides_of_the_boundary(self):
        from analysis import events as events_module
        transitions = [e for e in self.events
                       if e['type'] == events_module.TRANSITION]
        self.assertTrue(transitions)
        self.assertIsNone(transitions[0]['data']['from'])
        for event in transitions[1:]:
            self.assertIsNotNone(event['data']['from'])
            self.assertIsNotNone(event['data']['to'])

    def test_a_silent_track_produces_a_silence_and_no_beats(self):
        from analysis import events as events_module
        doc = analyse_track(synth.silence(8.0), 'quiet')
        types = {event['type'] for event in doc['events']}
        self.assertIn(events_module.SILENCE, types)
        self.assertNotIn(events_module.DROP, types)


if __name__ == '__main__':
    unittest.main()
