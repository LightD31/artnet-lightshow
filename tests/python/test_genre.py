"""
Zero-shot genre classification: the fold from prompts to a show style.

The model itself is not exercised here — the interesting failures are on
either side of it. What a cosine similarity means for the `calm` threshold,
what happens when two subgenres tie, and what happens when the checkpoint is
absent are all decisions this file pins, and all three cost a whole track's
show when they go the wrong way.
"""

import unittest

from support import needs_numpy


class Tempo:
    def __init__(self, bpm):
        self.bpm = bpm


NEUTRAL_MOOD = {'valence': 0.5, 'arousal': 0.5, 'danceability': 0.5,
                'kickiness': 0.5, 'tension': 0.5}


def rows(**similarity):
    """Adapter rows for named prompts, defaulting everything else low."""
    from analysis import perception
    scores = []
    for name, prompts in perception.GENRE_PROMPTS.items():
        for index, prompt in enumerate(prompts):
            value = similarity.get(name, 0.05)
            # Only the first phrasing of a named subgenre is given the high
            # score, so the fold is proved to take a maximum rather than a mean.
            scores.append({'label': prompt, 'score': value if index == 0 else 0.02,
                           'source': 'muq-mulan'})
    return scores


@needs_numpy
class PromptFold(unittest.TestCase):
    def test_every_prompt_is_offered_to_the_model_once(self):
        from analysis import perception
        prompts = perception.genre_prompts()
        self.assertEqual(len(prompts), len(set(prompts)), 'prompts must be unique')
        self.assertEqual(sorted(prompts), sorted(
            p for group in perception.GENRE_PROMPTS.values() for p in group))

    def test_a_subgenre_takes_its_best_prompt_not_its_average(self):
        from analysis.perception import subgenre_scores_from_prompts
        scores = subgenre_scores_from_prompts(rows(edm=0.45))
        self.assertEqual(max(scores, key=scores.get), 'edm')

    def test_scores_are_a_distribution_over_the_subgenres(self):
        from analysis import perception
        scores = perception.subgenre_scores_from_prompts(rows(rock=0.4))
        self.assertEqual(set(scores), set(perception.GENRE_PROMPTS))
        self.assertAlmostEqual(sum(scores.values()), 1.0, places=6)

    def test_unknown_prompts_are_ignored_rather_than_scored(self):
        from analysis.perception import subgenre_scores_from_prompts
        self.assertEqual(subgenre_scores_from_prompts(
            [{'label': 'sea shanty', 'score': 0.9}]), {})

    def test_no_scores_without_a_model_pass(self):
        from analysis.perception import subgenre_scores_from_prompts
        self.assertEqual(subgenre_scores_from_prompts(None), {})
        self.assertEqual(subgenre_scores_from_prompts([]), {})


@needs_numpy
class Calibration(unittest.TestCase):
    """
    The softmax temperature exists to make cosine similarities comparable to
    thresholds written for a distribution. These two cases are what it is set
    for, and they are the ones that decide whether the rig strobes.
    """

    def classify(self, **similarity):
        from analysis.perception import classify_genre
        return classify_genre(None, NEUTRAL_MOOD, Tempo(128), rows(**similarity))

    def test_a_clear_win_clears_the_confidence_floor(self):
        from analysis import perception
        result = self.classify(edm=0.45)
        self.assertEqual(result['genre'], 'edm')
        self.assertEqual(result['style'], 'dance')
        self.assertEqual(result['genre_source'], 'muq-mulan')
        self.assertGreaterEqual(result['genre_confidence'],
                                perception.GENRE_MIN_SCORE)

    def test_the_floor_sits_where_the_temperature_was_set_to_put_it(self):
        # A tenth of a cosine of lead is the documented meaning of
        # GENRE_MIN_SCORE. Changing the temperature without revisiting the
        # threshold moves the line between "labelled" and "signal" for every
        # track, so the relationship is pinned rather than left implicit.
        from analysis import perception
        under = perception.subgenre_scores_from_prompts(rows(edm=0.05 + 0.08))
        over = perception.subgenre_scores_from_prompts(rows(edm=0.05 + 0.12))
        self.assertLess(under['edm'], perception.GENRE_MIN_SCORE)
        self.assertGreater(over['edm'], perception.GENRE_MIN_SCORE)

    def test_a_near_tie_falls_back_to_the_signal(self):
        result = self.classify(jazz=0.30, folk=0.29)
        self.assertEqual(result['genre'], 'unknown')
        self.assertEqual(result['genre_source'], 'signal')

    def test_an_undecided_model_never_silences_a_track(self):
        # Every subgenre equally likely: 1/16 is well under the floor, so the
        # style comes from tempo and arousal instead of from a coin toss.
        result = self.classify()
        self.assertEqual(result['genre'], 'unknown')
        self.assertNotEqual(result['style'], 'calm')


@needs_numpy
class Precedence(unittest.TestCase):
    """Which classifier gets to answer, and what happens when it cannot."""

    def classify(self, tags=None, genre_scores=None, mood=None):
        from analysis.perception import classify_genre
        return classify_genre(tags, mood or NEUTRAL_MOOD, Tempo(128), genre_scores)

    def test_zero_shot_scores_win_over_audioset_tags(self):
        result = self.classify(tags={'jazz': 0.9}, genre_scores=rows(edm=0.45))
        self.assertEqual(result['genre'], 'edm')
        self.assertEqual(result['genre_source'], 'muq-mulan')

    def test_audioset_tags_still_answer_without_a_checkpoint(self):
        result = self.classify(tags={'techno': 0.6, 'house music': 0.4})
        self.assertEqual(result['genre'], 'edm')
        self.assertEqual(result['genre_source'], 'panns')

    def test_neither_classifier_leaves_the_label_unknown(self):
        result = self.classify()
        self.assertEqual(result['genre'], 'unknown')
        self.assertEqual(result['genre_source'], 'signal')

    def test_the_calm_veto_still_applies_to_the_zero_shot_answer(self):
        # A confident `ambient` on a loud, danceable track is the failure the
        # veto exists for, and it does not care which model was confident.
        mood = dict(NEUTRAL_MOOD, arousal=0.84, danceability=0.7)
        result = self.classify(genre_scores=rows(ambient=0.45), mood=mood)
        self.assertEqual(result['genre'], 'ambient')
        self.assertNotEqual(result['style'], 'calm')

    def test_the_evidence_shown_is_the_evidence_used(self):
        from analysis import perception
        zero_shot = self.classify(genre_scores=rows(edm=0.45))
        self.assertTrue(all(tag['label'] in perception.GENRE_PROMPTS
                            for tag in zero_shot['top_tags']))
        folded = self.classify(tags={'techno': 0.6})
        self.assertEqual(folded['top_tags'][0]['label'], 'techno')


if __name__ == '__main__':
    unittest.main()
