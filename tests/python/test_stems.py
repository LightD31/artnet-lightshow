"""Separator plumbing, with a stand-in model rather than a checkpoint."""
import os
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

from support import needs_audio
from analysis import models, stems


class FakeSeparator:
    """Writes one stem wherever `output_dir` points by the time it finishes,
    the way audio-separator does, and returns its bare file name."""

    def __init__(self):
        self.output_dir = None
        self.model_instance = types.SimpleNamespace(output_dir=None)

    def separate(self, source):
        import numpy as np
        import soundfile as sf
        time.sleep(0.2)
        name = f'input_(vocals)_{threading.get_ident()}.wav'
        folder = self.model_instance.output_dir or '.'
        sf.write(os.path.join(folder, name), np.full(22050, 0.5, dtype=np.float32), 22050)
        return [name]


@needs_audio
class BsRoformer(unittest.TestCase):
    def test_overlapping_calls_each_get_their_own_stems(self):
        # A failed analysis leaves its separation thread running into the next
        # track. Both calls share one cached separator and swap its output
        # directory; interleaved, one call's stems went to the working
        # directory and it came back with nothing.
        import numpy as np
        fake = FakeSeparator()
        mono = np.zeros(22050, dtype=np.float32)
        results, errors = [], []
        start = threading.Barrier(2)

        def run():
            start.wait()
            try:
                results.append(stems.separate_bs_roformer(mono, 22050))
            except Exception as exc:  # pragma: no cover - the failure being guarded
                errors.append(exc)

        cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(models, 'bs_roformer_separator', return_value=fake), \
             patch.object(models, 'on_gpu', return_value=False):
            os.chdir(directory)
            try:
                threads = [threading.Thread(target=run) for _ in range(2)]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join()
                stray = [f for f in os.listdir(directory) if f.endswith('.wav')]
            finally:
                os.chdir(cwd)

        self.assertEqual(errors, [])
        self.assertEqual(stray, [], 'stems written to the working directory')
        self.assertEqual(len(results), 2)
        for result in results:
            self.assertGreater(float(np.abs(result.vocals).max()), 0.4)


if __name__ == '__main__':
    unittest.main()
