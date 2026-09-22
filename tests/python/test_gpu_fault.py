"""A GPU FFT that faults mid-track: the track still gets its answer, on the CPU.

AMD's ROCm nightlies intermittently fail a GPU FFT with HIPFFT_PARSE_ERROR
under the pipeline's parallel load, and every later FFT in the process fails
the same way. Before this, one fault cost the track its beat grid and its
stems at once.
"""
import types
import unittest
from unittest.mock import patch

from support import needs_audio
from analysis import models, rhythm, stems
from analysis.config import RhythmConfig

HIPFFT = RuntimeError('cuFFT error: HIPFFT_PARSE_ERROR')


class Fault(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(models, '_GPU_FAULT', None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_fft_faults_are_recognised_and_remembered(self):
        self.assertIsNone(models.gpu_fault())
        self.assertFalse(models.gpu_fault(RuntimeError('CUDA out of memory')))
        self.assertIsNone(models.gpu_fault(), 'an unrelated error is not a fault')
        self.assertTrue(models.gpu_fault(HIPFFT))
        self.assertIn('HIPFFT_PARSE_ERROR', models.gpu_fault())


@needs_audio
class BeatsFallBackToCpu(Fault):
    def test_a_faulted_gpu_pass_is_rerun_on_the_cpu(self):
        import numpy as np
        grid = np.arange(0, 20, 0.5)
        calls = []

        def tracker(on=None):
            def run(signal, rate):
                calls.append(on)
                if on != 'cpu':
                    raise HIPFFT
                return grid, grid[::4]
            return run

        audio = types.SimpleNamespace(mono=np.zeros(22050 * 20, dtype=np.float32), sample_rate=22050)
        with patch.object(models, 'beat_tracker', side_effect=tracker), \
             patch.object(models, 'on_gpu', return_value=True):
            beats, downbeats = rhythm.model_beats(audio, RhythmConfig())
        self.assertEqual(calls, [None, 'cpu'])
        self.assertEqual(len(beats), len(grid))
        self.assertIsNotNone(models.gpu_fault())

    def test_other_failures_still_fail_the_track(self):
        import numpy as np

        def tracker(on=None):
            def run(signal, rate):
                raise RuntimeError('checkpoint is corrupt')
            return run

        audio = types.SimpleNamespace(mono=np.zeros(22050, dtype=np.float32), sample_rate=22050)
        with patch.object(models, 'beat_tracker', side_effect=tracker):
            with self.assertRaises(rhythm.ModelUnavailable):
                rhythm.model_beats(audio, RhythmConfig())
        self.assertIsNone(models.gpu_fault())


@needs_audio
class SeparationFallsBackToCpu(Fault):
    def test_demucs_reruns_on_the_cpu_after_a_fault(self):
        import numpy as np
        import torch
        devices = []

        def apply_model(model, tensor, device=None, **kwargs):
            devices.append(str(device))
            if str(device) != 'cpu':
                raise HIPFFT
            return torch.zeros(1, 4, 2, tensor.shape[-1])

        model = types.SimpleNamespace(samplerate=44100, sources=['drums', 'bass', 'other', 'vocals'])
        with patch.object(models, 'bs_roformer_enabled', return_value=False), \
             patch.object(models, 'separator', return_value=model), \
             patch.object(models, 'device', return_value='cuda'), \
             patch.object(models, 'on_gpu', return_value=False), \
             patch('demucs.apply.apply_model', side_effect=apply_model):
            result = stems.separate(np.zeros(22050, dtype=np.float32), 22050)
        self.assertEqual(devices, ['cuda', 'cpu'])
        self.assertEqual(result.vocals.size, 22050)

    def test_after_a_fault_bs_roformer_is_skipped_and_demucs_starts_on_the_cpu(self):
        import numpy as np
        import torch
        models.gpu_fault(HIPFFT)
        devices = []

        def apply_model(model, tensor, device=None, **kwargs):
            devices.append(str(device))
            return torch.zeros(1, 4, 2, tensor.shape[-1])

        model = types.SimpleNamespace(samplerate=44100, sources=['drums', 'bass', 'other', 'vocals'])
        with patch.object(models, 'bs_roformer_enabled', return_value=True), \
             patch.object(stems, 'separate_bs_roformer') as roformer, \
             patch.object(models, 'separator', return_value=model), \
             patch.object(models, 'device', return_value='cuda'), \
             patch.object(models, 'on_gpu', return_value=False), \
             patch('demucs.apply.apply_model', side_effect=apply_model):
            stems.separate(np.zeros(22050, dtype=np.float32), 22050)
        roformer.assert_not_called()
        self.assertEqual(devices, ['cpu'])


if __name__ == '__main__':
    unittest.main()
