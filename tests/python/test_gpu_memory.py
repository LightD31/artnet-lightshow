"""Room on the card: models kept in RAM between passes, and a pass that runs
the card out of memory run again on the CPU.

An 8 GB card holds any one of the analysis models with room for its pass and
not all of them at once, so kept resident the pass that came last failed with
CUDA out of memory — on some tracks and not others. There is no card on a CI
runner, so torch's `meta` device stands in for one where weights have to move.
"""
import os
import types
import unittest
from unittest.mock import patch

from support import _importable
from analysis import models

GiB = 2 ** 30
needs_torch = unittest.skipUnless(_importable('torch'), 'torch is not installed')


def oom():
    import torch
    kind = getattr(torch.cuda, 'OutOfMemoryError', RuntimeError)
    return kind('CUDA out of memory. Tried to allocate 2.00 GiB')


@needs_torch
class Decision(unittest.TestCase):
    def decide(self, total_gb, setting=None):
        import torch
        env = {} if setting is None else {'ARTNET_GPU_MEMORY': setting}
        card = types.SimpleNamespace(total_memory=total_gb * GiB)
        with patch.object(models, '_OFFLOAD', None), \
             patch.dict(os.environ, env, clear=False), \
             patch.object(torch.cuda, 'get_device_properties', return_value=card):
            if setting is None:
                os.environ.pop('ARTNET_GPU_MEMORY', None)
            return models._decide_offload(torch, 'cuda')

    def test_a_small_card_keeps_models_in_ram_and_a_big_one_on_the_card(self):
        self.assertTrue(self.decide(8))
        self.assertTrue(self.decide(11.5))
        self.assertFalse(self.decide(24))

    def test_the_setting_overrides_the_size(self):
        self.assertFalse(self.decide(8, 'resident'))
        self.assertTrue(self.decide(24, 'offload'))
        self.assertTrue(self.decide(8, 'bogus'), 'anything else is auto')

    def test_never_without_a_card(self):
        with patch.object(models, 'on_gpu', return_value=False):
            self.assertFalse(models.offloading())
            self.assertEqual(models.home(), models.device())


@needs_torch
class Parking(unittest.TestCase):
    def test_weights_go_to_the_card_and_come_back_from_ram_without_a_copy_back(self):
        import torch
        model = torch.nn.Sequential(torch.nn.Linear(4, 3), torch.nn.BatchNorm1d(3)).eval()
        before = {k: v.clone() for k, v in model.state_dict().items()}
        with patch.object(models, 'on_gpu', return_value=False):
            models.park(model)
            host = model[0].weight.data_ptr()
            models.to_card(model, 'meta')
            self.assertTrue(all(t.device.type == 'meta' for t in model.state_dict().values()),
                            'parameters and buffers alike')
            # The copy on the "card" has no data at all: whatever comes back
            # can only have come from RAM.
            models.park(model)
        self.assertEqual(model[0].weight.data_ptr(), host, 'the same copy in RAM, not a new one')
        for key, value in model.state_dict().items():
            self.assertEqual(value.device.type, 'cpu')
            self.assertTrue(torch.equal(value, before[key]), key)
        with torch.no_grad():
            self.assertEqual(tuple(model(torch.ones(2, 4)).shape), (2, 3), 'and it still runs')

    def test_a_weight_two_layers_share_is_kept_in_ram_once(self):
        import torch
        model = torch.nn.Sequential(torch.nn.Linear(3, 3, bias=False), torch.nn.Linear(3, 3, bias=False))
        model[1].weight = model[0].weight
        with patch.object(models, 'on_gpu', return_value=False):
            models.park(model)
            models.to_card(model, 'meta')
            models.park(model)
        self.assertEqual(model[0].weight.data_ptr(), model[1].weight.data_ptr())
        self.assertEqual(len({id(host) for host in models._PARKED[model].values()}), 1)

    def test_anything_that_is_not_a_torch_module_is_left_alone(self):
        thing = types.SimpleNamespace(samplerate=44100)
        models.park(thing)
        models.to_card(thing, 'meta')
        models.park(None)
        self.assertEqual(thing.samplerate, 44100)

    def test_the_pinned_budget_is_a_quarter_of_the_ram_unless_set(self):
        with patch.dict(os.environ, {'ARTNET_PINNED_GB': '3'}):
            self.assertEqual(models._pin_budget(), 3 * GiB)
        with patch.dict(os.environ, {'ARTNET_PINNED_GB': ''}), \
             patch.object(models, '_ram_bytes', return_value=32 * GiB):
            self.assertEqual(models._pin_budget(), 8 * GiB)


@needs_torch
class OutOfMemory(unittest.TestCase):
    def setUp(self):
        for name, value in (('_OFFLOAD', False), ('_GPU_FAULT', None)):
            patcher = patch.object(models, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for name, value in (('device', 'cuda'), ('on_gpu', True)):
            patcher = patch.object(models, name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)
        logged = []
        patcher = patch.object(models, '_log', side_effect=logged.append)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.logged = logged
        # No real card to take turns on or to empty.
        patcher = patch.object(models, 'release_memory')
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_recognised_by_its_type_or_its_words_and_nothing_else(self):
        self.assertTrue(models.out_of_memory(oom()))
        self.assertTrue(models.out_of_memory(RuntimeError('HIP out of memory. Tried to allocate 512.00 MiB')))
        self.assertFalse(models.out_of_memory(RuntimeError('cuFFT error: HIPFFT_PARSE_ERROR')))
        self.assertFalse(models.out_of_memory(ValueError('bad checkpoint')))

    def test_a_pass_that_runs_the_card_out_of_memory_is_run_on_the_cpu(self):
        calls = []

        def run(device):
            calls.append(str(device))
            if device != 'cpu':
                raise oom()
            return 'stems'

        self.assertEqual(models.run_pass('demucs', run), 'stems')
        self.assertEqual(calls, ['cuda', 'cpu'])
        self.assertTrue(models._OFFLOAD, 'and from now on models are kept in RAM between passes')
        self.assertTrue(any('keeping models in RAM' in line for line in self.logged), self.logged)
        self.assertIsNone(models.gpu_fault(), 'running out of room is not a broken card')

        calls.clear()
        self.assertEqual(models.run_pass('muq', run), 'stems', 'the next pass tries the card first again')
        self.assertEqual(calls, ['cuda', 'cpu'])

    def test_its_model_is_parked_in_ram_before_the_cpu_pass(self):
        import torch
        model = torch.nn.Linear(2, 2)
        seen = []

        def run(device):
            seen.append((str(device), model.weight.device.type))
            if device != 'cpu':
                raise oom()
            return True

        # Onto the "card" (meta) for its pass, as inference() puts it; RAM
        # copies without pinning, which a CPU build cannot do.
        real_to_card = models.to_card
        with patch.object(models, 'to_card', side_effect=lambda module, target: real_to_card(module, 'meta')), \
             patch.object(models, '_host_copy', side_effect=lambda tensor: tensor.detach().clone()):
            models.park(model)
            models.run_pass('songformer', run, modules=[model])
        self.assertEqual(seen, [('cuda', 'meta'), ('cpu', 'cpu')])

    def test_other_failures_are_not_swallowed(self):
        def run(device):
            raise ValueError('checkpoint is corrupt')

        with self.assertRaises(ValueError):
            models.run_pass('muq', run)

    def test_after_a_fault_the_pass_goes_straight_to_the_cpu(self):
        models.gpu_fault(RuntimeError('cuFFT error: HIPFFT_PARSE_ERROR'))
        calls = []
        self.assertEqual(models.run_pass('muq', lambda device: calls.append(str(device)) or 'ok'), 'ok')
        self.assertEqual(calls, ['cpu'])

    def test_on_the_cpu_there_is_only_the_cpu(self):
        with patch.object(models, 'device', return_value='cpu'):
            calls = []
            models.run_pass('muq', lambda device: calls.append(device))
        self.assertEqual(calls, ['cpu'])


if __name__ == '__main__':
    unittest.main()
