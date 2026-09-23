"""
The document schema, and the validator the pipeline's tests use against it.

The schema itself is exercised by the real pipeline in test_pipeline.py; these
pin the validator, so a document that is wrong is always reported as wrong.
"""

import copy
import unittest

import support  # noqa: F401  (puts src/ on the path)
from analysis import schema


def minimal():
    return {
        'schemaVersion': '2.0',
        'track': {'hash': 'abc', 'duration': 10.0},
        'duration': 10.0,
        'bpm': 120.0,
        'beats': [0.5, 1.0],
        'downbeats': [0.5],
        'segments': [{'start': 0, 'end': 10, 'label': 'A', 'role': 'verse', 'energy': 0.5, 'level': 'mid'}],
        'events': [{'t': 0.5, 'type': 'BEAT', 'data': {'index': 0}}],
    }


class Schema(unittest.TestCase):
    def test_the_schema_loads_and_names_the_document(self):
        self.assertEqual(schema.load_schema()['title'], 'AnalysisDocument')

    def test_a_minimal_document_is_valid(self):
        doc = minimal()
        self.assertEqual(schema.errors(doc), [])
        self.assertIs(schema.validate(doc), doc, 'validate hands the document back')

    def test_a_missing_required_field_is_named(self):
        doc = minimal()
        del doc['beats']
        self.assertEqual(schema.errors(doc), ['/beats: missing'])

    def test_a_wrong_type_is_named_with_its_path(self):
        doc = minimal()
        doc['segments'][0]['energy'] = 'loud'
        self.assertEqual(schema.errors(doc), ['/segments/0/energy: expected number, got str'])

    def test_an_enum_holds(self):
        doc = minimal()
        doc['segments'][0]['level'] = 'deafening'
        self.assertEqual(len(schema.errors(doc)), 1)
        self.assertIn('/segments/0/level', schema.errors(doc)[0])

    def test_a_boolean_is_not_a_number(self):
        doc = minimal()
        doc['bpm'] = True
        self.assertEqual(schema.errors(doc), ['/bpm: expected number, got bool'])

    def test_nullable_fields_take_null(self):
        doc = minimal()
        doc['loudness'] = {'integratedLufs': None, 'range': 3.0}
        doc['sources'] = None
        self.assertEqual(schema.errors(doc), [])

    def test_maps_check_their_values(self):
        doc = minimal()
        doc['bands'] = {'bass': {'name': 'bass', 'energy': 0.2}, 'sub': {'energy': 0.1}}
        self.assertEqual(schema.errors(doc), ['/bands/sub/name: missing'])

    def test_validate_raises_with_the_first_problems(self):
        doc = copy.deepcopy(minimal())
        doc['duration'] = None
        with self.assertRaises(ValueError) as caught:
            schema.validate(doc)
        self.assertIn('/duration', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
