"""
The pipeline's plumbing: how it reads the file, takes turns on the card, starts
and stops its threads, and what it keeps when an optional model fails.

None of this changes what the analysis says. All of it changed how long a
track took, and what a failure cost the tracks after it.
"""

import os
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import MagicMock, patch

import synth
from support import AudioTestCase, needs_audio, needs_numpy
from analysis import models
from analysis import model_adapters as adapters


def _until(condition, timeout=2.0):
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError('timed out waiting')
        time.sleep(0.005)


# ── One decode per track ────────────────────────────────────────────────────

@needs_audio
class DecodeOnce(AudioTestCase):
    def stereo(self, name, rate=44100, seconds=4):
        import numpy as np
        import soundfile as sf
        t = np.arange(rate * seconds) / rate
        left = 0.3 * np.sin(2 * np.pi * 440 * t)
        right = 0.3 * np.sin(2 * np.pi * 660 * t) + 0.05 * np.sin(2 * np.pi * 9000 * t)
        path = os.path.join(self.tmpdir, name)
        sf.write(path, np.stack([left, right], axis=1), rate)
        return path

    def test_the_file_is_decoded_once(self):
        """Four decodes per track: the analysis rate, the wideband pass, the
        separator's stereo and the key model's. Now one, at the file's rate."""
        import librosa
        from analysis import preprocess
        path = self.stereo('once.wav')
        real = librosa.load
        rates = []

        def counting(*args, **kwargs):
            rates.append(kwargs.get('sr'))
            return real(*args, **kwargs)

        with patch('librosa.load', side_effect=counting):
            audio = preprocess.prepare(path)
            pair = preprocess.load_for_separation(audio, 44100)
        self.assertEqual(rates, [None])
        self.assertIsNotNone(audio.wideband)
        self.assertEqual(pair.shape[0], 2)

    def test_every_rate_is_the_signal_a_decode_at_that_rate_gave(self):
        import numpy as np
        import librosa
        from analysis import preprocess
        path = self.stereo('same.wav')
        audio = preprocess.prepare(path)
        direct, _ = librosa.load(path, sr=audio.sample_rate, mono=False)
        np.testing.assert_allclose(
            preprocess.resample(audio.source, audio.source_rate, audio.sample_rate),
            direct, atol=1e-6)
        wide, _ = librosa.load(path, sr=audio.wideband_rate, mono=True)
        gain = 10.0 ** (audio.applied_gain_db / 20.0)
        np.testing.assert_allclose(audio.wideband, (wide * gain)[:audio.wideband.size], atol=1e-5)

    def test_the_separator_is_served_from_the_decode(self):
        from analysis import preprocess
        path = self.stereo('gone.wav')
        audio = preprocess.prepare(path)
        os.remove(path)
        pair = preprocess.load_for_separation(audio, 44100)
        self.assertEqual(pair.shape[0], 2)
        self.assertAlmostEqual(pair.shape[1] / 44100, audio.duration, delta=0.01)

    def test_the_key_model_is_served_from_the_decode(self):
        import numpy as np
        seen = {}

        def detect_key(path, device='cpu'):
            seen['waveform'] = module.load_audio(path, 22050)
            return ['C major']

        module = types.SimpleNamespace(detect_key=detect_key, load_audio=None)
        stereo = np.stack([np.full(44100, 0.5, np.float32), np.full(44100, 0.25, np.float32)])
        with patch.object(adapters, '_optional', return_value=module):
            result = adapters.skey_key('/nowhere/track.mp3', samples=stereo, sample_rate=44100)
        self.assertEqual(result['value'], 'C major')
        waveform = seen['waveform']
        self.assertEqual(tuple(waveform.shape[:1]), (1,), 'mono')
        self.assertAlmostEqual(waveform.shape[1], 22050, delta=2)
        self.assertAlmostEqual(float(waveform.abs().max()), 1.0, places=5)


# ── Turns on the card ───────────────────────────────────────────────────────

class Turns(unittest.TestCase):
    def test_the_beat_model_goes_ahead_of_those_already_waiting(self):
        turns = models._Turns()
        order = []
        turns.acquire()                      # the separator has the card

        def take(name, first):
            turns.acquire(first=first)
            order.append(name)
            turns.release()

        muq = threading.Thread(target=take, args=('muq', False))
        muq.start()
        time.sleep(0.05)
        beat = threading.Thread(target=take, args=('beat_this', True))
        beat.start()
        _until(lambda: turns._first_waiting == 1)
        turns.release()
        muq.join(2)
        beat.join(2)
        self.assertEqual(order, ['beat_this', 'muq'])

    def test_a_reserved_turn_holds_the_card_until_it_is_taken_or_given_up(self):
        turns = models._Turns()
        got = threading.Event()

        def separator():
            turns.acquire()
            got.set()
            turns.release()

        token = turns.reserve()
        threading.Thread(target=separator).start()
        self.assertFalse(got.wait(0.1), 'the separator waits for the beat model')
        turns.acquire(first=True)
        turns.release()
        self.assertTrue(got.wait(2))
        turns.cancel(token)                  # already used: nothing to give up

        got.clear()
        token = turns.reserve()
        threading.Thread(target=separator).start()
        self.assertFalse(got.wait(0.1))
        turns.cancel(token)                  # the beat pass failed before its turn
        self.assertTrue(got.wait(2))

    def test_the_holder_can_take_it_again(self):
        turns = models._Turns()
        turns.acquire()
        turns.acquire(first=True)
        turns.release()
        self.assertEqual(turns._owner, threading.get_ident())
        turns.release()
        self.assertIsNone(turns._owner)

    def test_inference_takes_a_turn_only_on_a_card(self):
        turns = models._Turns()
        with patch.object(models, 'on_gpu', return_value=True), \
             patch.object(models, 'release_memory'), \
             patch.object(models, '_TURNS', turns):
            models.reserve_first_turn()
            with models.inference('beat_this', first=True):
                self.assertEqual(turns._owner, threading.get_ident())
                self.assertEqual(turns._reserved, [], 'the reservation is used')
            self.assertIsNone(turns._owner)
        with patch.object(models, 'on_gpu', return_value=False):
            self.assertIsNone(models.reserve_first_turn())


# ── Device and checkpoints ──────────────────────────────────────────────────

class DeviceOverride(unittest.TestCase):
    def choose(self, wanted, cuda=False, hip=None):
        threads = []

        def device(name):
            kind = name.split(':')[0]
            if kind not in ('cpu', 'cuda', 'mps', 'xpu', 'meta'):
                raise RuntimeError(f'Expected one of cpu, cuda, ... device type: {name}')
            return types.SimpleNamespace(type=kind)

        torch = types.SimpleNamespace(
            device=device,
            cuda=types.SimpleNamespace(is_available=lambda: cuda,
                                       get_device_name=lambda index: 'Radeon 890M'),
            set_num_threads=threads.append,
            version=types.SimpleNamespace(hip=hip),
            backends=types.SimpleNamespace(cudnn=types.SimpleNamespace(enabled=True)))
        env = {k: v for k, v in os.environ.items() if k != 'ARTNET_MIOPEN'}
        env['ARTNET_ANALYSIS_DEVICE'] = wanted
        with patch.dict(sys.modules, {'torch': torch}), \
             patch.object(models, '_DEVICE', None), \
             patch.dict(os.environ, env, clear=True):
            return models.device(), threads, torch

    def test_forcing_the_cpu_still_leaves_a_core_for_the_render_loop(self):
        chosen, threads, _ = self.choose('cpu', cuda=True)
        self.assertEqual(chosen, 'cpu')
        self.assertEqual(threads, [max(1, (os.cpu_count() or 4) - 1)])

    def test_forcing_the_card_on_rocm_still_turns_miopen_off(self):
        chosen, threads, torch = self.choose('cuda:0', cuda=True, hip='7.1')
        self.assertEqual(chosen, 'cuda:0')
        self.assertFalse(torch.backends.cudnn.enabled)
        self.assertEqual(threads, [])

    def test_a_device_this_torch_cannot_use_is_named_and_ignored(self):
        self.assertEqual(self.choose('gpu')[0], 'cpu')
        self.assertEqual(self.choose('cuda', cuda=False)[0], 'cpu')
        self.assertEqual(self.choose('meta', cuda=True)[0], 'cuda')


class BsRoformerCheckpoint(unittest.TestCase):
    def test_a_checkpoint_path_is_where_the_separator_looks(self):
        built = {}

        class Separator:
            def __init__(self, **kwargs):
                built.update(kwargs)

            def load_model(self, model_filename):
                built['filename'] = model_filename

        with tempfile.TemporaryDirectory() as directory:
            checkpoint = os.path.join(directory, 'my-roformer.ckpt')
            open(checkpoint, 'w').close()
            with patch.object(models, 'require', return_value=types.SimpleNamespace(Separator=Separator)), \
                 patch.dict(models._CACHE, {}, clear=True), \
                 patch.dict(os.environ, {'ARTNET_BS_ROFORMER_MODEL': checkpoint}):
                models.bs_roformer_separator()
        self.assertEqual(built['model_file_dir'], directory)
        self.assertEqual(built['filename'], 'my-roformer.ckpt')

    def test_a_model_name_is_looked_for_in_the_model_directory(self):
        with patch.dict(os.environ, {'ARTNET_BS_ROFORMER_MODEL': 'model_bs_roformer_ep_317_sdr_12.9755.ckpt',
                                     'ARTNET_MODEL_DIR': '/models'}):
            self.assertEqual(models.bs_roformer_checkpoint(),
                             ('/models', 'model_bs_roformer_ep_317_sdr_12.9755.ckpt'))
        with patch.dict(os.environ, {'ARTNET_BS_ROFORMER_MODEL': '', 'ARTNET_MODEL_DIR': '/models'}):
            self.assertEqual(models.bs_roformer_checkpoint(), ('/models', 'BS-Roformer-SW.ckpt'))


# ── Warm-up ─────────────────────────────────────────────────────────────────

class WarmUp(unittest.TestCase):
    def test_the_beat_model_loads_first_and_a_failure_does_not_stop_the_rest(self):
        order = []

        def beat_tracker():
            order.append('beat_this')

        def separator():
            order.append('separator')
            raise RuntimeError('no room on the card')

        with patch.object(models, 'beat_tracker', beat_tracker), \
             patch.object(models, 'separator', separator), \
             patch.object(models, 'bs_roformer_enabled', return_value=False):
            loaded = models.warm_up()
        self.assertEqual(order, ['beat_this', 'separator'])
        self.assertEqual(loaded, ['beat_this'])

    def test_the_worker_loads_the_models_before_the_optional_ones(self):
        """The docs said the worker loaded its models at start. It did not:
        the first track of the night loaded them, on the clock."""
        from analysis import cli
        order = []
        with patch.object(models, 'warm_up', side_effect=lambda: order.append('models') or ['beat_this']), \
             patch.object(models, 'device', return_value='cpu'), \
             patch.object(cli.model_adapters, 'preload', side_effect=lambda: order.append('muq')), \
             patch.object(cli.tagger, 'preload', side_effect=lambda: order.append('tagger')), \
             patch.object(cli, 'DEFAULT', types.SimpleNamespace(enable_semantics=True, enable_tagger=True)):
            cli._warm_up()
        self.assertEqual(order, ['models', 'muq', 'tagger'])


# ── MuQ ─────────────────────────────────────────────────────────────────────

@needs_numpy
class Muq(unittest.TestCase):
    def test_one_muq_model_failing_keeps_the_other(self):
        import numpy as np
        audio = np.zeros(24000 * 4, np.float32)
        with patch.object(adapters, 'mulan_scores', side_effect=FileNotFoundError('text model missing')), \
             patch.object(adapters, 'muq_embeddings', return_value=[{'time': 0.0}]):
            self.assertEqual(adapters.muq_pass(audio, 24000, {'genre': ['techno']}),
                             {'scores': {}, 'embeddings': [{'time': 0.0}]})
        with patch.object(adapters, 'mulan_scores', return_value={'genre': [{'label': 'techno'}]}), \
             patch.object(adapters, 'muq_embeddings', side_effect=RuntimeError('out of memory')):
            self.assertEqual(adapters.muq_pass(audio, 24000, {'genre': ['techno']}),
                             {'scores': {'genre': [{'label': 'techno'}]}, 'embeddings': []})

    @needs_audio
    def test_embeddings_are_rounded(self):
        import numpy as np
        import torch
        model = MagicMock()
        model.parameters.return_value = iter([torch.zeros(1)])
        model.return_value.last_hidden_state = torch.full((1, 3, 1024), 1 / 3)
        with patch.object(adapters, '_optional', return_value=object()), \
             patch.object(adapters, '_load_muq', return_value=model):
            result = adapters.muq_embeddings(np.zeros(4 * 24000, dtype=np.float32), 24000)
        self.assertEqual(result[0]['vector'][0], 0.3333)
        self.assertEqual(len(result[0]['vector']), 1024)


# ── The pipeline's threads ──────────────────────────────────────────────────

@needs_audio
class PipelineThreads(AudioTestCase):
    def test_every_pool_is_shut_down_and_the_card_let_go_when_a_stage_fails(self):
        import numpy as np
        from concurrent.futures import ThreadPoolExecutor
        from analysis import pipeline
        from analysis.config import AnalysisConfig
        pools = []

        class Recording(ThreadPoolExecutor):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.closed = False
                pools.append(self)

            def shutdown(self, *args, **kwargs):
                self.closed = True
                return super().shutdown(*args, **kwargs)

        path = self.write(synth.four_on_the_floor(bars=4), 'fails.wav')
        turns = models._Turns()
        grid = (np.arange(0, 8, 0.5), np.arange(0, 8, 2.0))
        with patch.object(pipeline, 'ThreadPoolExecutor', Recording), \
             patch.object(models, '_TURNS', turns), \
             patch.object(models, 'on_gpu', return_value=True), \
             patch.object(models, 'release_memory'), \
             patch.object(pipeline, '_safe_separate', return_value=None), \
             patch.object(pipeline.songformer, 'wanted', return_value=False), \
             patch.object(pipeline.model_adapters, 'skey_available', return_value=False), \
             patch.object(pipeline.rhythm_stage, 'model_beats', return_value=grid), \
             patch.object(pipeline.features_stage, 'extract', side_effect=RuntimeError('boom')):
            with self.assertRaisesRegex(RuntimeError, 'boom'):
                pipeline.analyze(path, config=AnalysisConfig(
                    separate_sources=True, enable_semantics=False, enable_tagger=False))
        self.assertEqual(len(pools), 2, 'the beat pass and the separator')
        self.assertTrue(all(pool.closed for pool in pools))
        self.assertEqual(turns._reserved, [])

    def test_a_tagger_without_its_weights_is_not_started(self):
        from analysis import pipeline, tagger
        from analysis.config import AnalysisConfig
        path = self.write(synth.four_on_the_floor(bars=4), 'untagged.wav')
        with patch.object(tagger, 'ready', return_value=False), \
             patch.object(tagger, 'tag') as tag:
            document = pipeline.analyze(path, config=AnalysisConfig(
                separate_sources=False, enable_semantics=False, enable_tagger=True))
        tag.assert_not_called()
        self.assertEqual(document['meta']['modelUsage']['tagger'], 'none')


# ── Live reads ──────────────────────────────────────────────────────────────

@needs_numpy
class LiveReads(unittest.TestCase):
    def test_samples_are_read_a_hop_at_a_time_across_ragged_reads(self):
        """A pipe read ends wherever the pipe did, which need not be on a
        sample boundary. Nothing is lost or shifted when it is not."""
        import numpy as np
        from analysis import cli
        samples = np.arange(3000, dtype=np.float32)
        raw = samples.tobytes()
        chunks = [raw[:1001], raw[1001:1003], raw[1003:5000], raw[5000:]]

        class Pipe:
            sizes = []

            def read1(self, n):
                self.sizes.append(n)
                return chunks.pop(0) if chunks else b''

        pushed = []

        class Analyzer:
            def __init__(self, *args, **kwargs):
                pass

            def push(self, block):
                pushed.append(np.array(block))
                return []

        pipe = Pipe()
        with patch.object(sys, 'stdin', types.SimpleNamespace(buffer=pipe)), \
             patch('analysis.realtime.StreamingAnalyzer', Analyzer):
            cli.live_loop(22050)
        np.testing.assert_array_equal(np.concatenate(pushed), samples)
        self.assertEqual(set(pipe.sizes), {cli.DEFAULT.realtime.hop_length * 4})


if __name__ == '__main__':
    unittest.main()
