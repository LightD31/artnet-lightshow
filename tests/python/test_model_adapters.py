"""Adapter regressions without checkpoint downloads or large model allocations."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from support import needs_audio
from analysis import model_adapters as adapters, models


class ModelLoading(unittest.TestCase):
    def test_model_is_reused_and_uses_selected_device(self):
        module = MagicMock()
        with patch.object(adapters, '_optional', return_value=module), \
             patch.object(models, 'device', return_value='cuda'), \
             patch.dict(models._CACHE, {}, clear=True):
            first = adapters._load_muq('MuQ', '/tmp/test-muq')
            self.assertIs(first, adapters._load_muq('MuQ', '/tmp/test-muq'))
        module.MuQ.from_pretrained.assert_called_once_with('/tmp/test-muq', local_files_only=True)
        module.MuQ.from_pretrained.return_value.float.return_value.to.assert_called_once_with('cuda')

    def test_missing_text_encoder_does_not_attempt_hub_download(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'config.json').write_text(json.dumps({'audio_model': {}, 'text_model': {}}))
            module = MagicMock()
            with patch.object(adapters, '_optional', return_value=module), \
                 patch.object(models, 'device', return_value='cpu'), \
                 patch.object(adapters, '_model_path', return_value=str(root / 'missing')), \
                 patch.dict(models._CACHE, {}, clear=True):
                with self.assertRaisesRegex(FileNotFoundError, 'text model missing'):
                    adapters._load_muq('MuQMuLan', str(root))
            module.MuQMuLan.from_pretrained.assert_not_called()


@needs_audio
class ModelOutputs(unittest.TestCase):
    def test_embeddings_resample_and_keep_time_grid(self):
        import numpy as np
        import torch
        model = MagicMock()
        model.parameters.return_value = iter([torch.zeros(1)])
        model.return_value.last_hidden_state = torch.ones(1, 3, 1024)
        with patch.object(adapters, '_optional', return_value=object()), \
             patch.object(adapters, '_load_muq', return_value=model):
            result = adapters.muq_embeddings(np.zeros(4 * 16000, dtype=np.float32), 16000)
        self.assertEqual([row['time'] for row in result], [0, 2])
        self.assertEqual(len(result[0]['vector']), 1024)
        self.assertEqual(model.call_args_list[0].args[0].shape, (1, 4 * 24000))
        json.dumps(result, allow_nan=False)

    def test_one_audio_pass_serves_every_vocabulary(self):
        # The audio tower is the expensive half and its output does not depend
        # on the labels, so genre and mood must share a single encode.
        import numpy as np
        import torch
        model = MagicMock()
        model.parameters.return_value = iter([torch.zeros(1)])
        model.calc_similarity.return_value = torch.tensor([[0.3, 0.1]])
        with patch.object(adapters, '_optional', return_value=object()), \
             patch.object(adapters, '_load_muq', return_value=model):
            result = adapters.mulan_scores(np.zeros(24000, dtype=np.float32), 24000,
                                           {'genre': ['techno', 'jazz'],
                                            'semantic': ['warm', 'cold'],
                                            'empty': []})
        audio_calls = [c for c in model.call_args_list if 'wavs' in c.kwargs]
        self.assertEqual(len(audio_calls), 1)
        self.assertEqual(len([c for c in model.call_args_list if 'texts' in c.kwargs]), 2)
        self.assertEqual([row['label'] for row in result['genre']], ['techno', 'jazz'])
        self.assertEqual(result['empty'], [])

    def test_vocabularies_are_empty_without_the_optional_package(self):
        with patch.object(adapters, '_optional', return_value=None):
            self.assertEqual(adapters.mulan_scores([], 24000, {'genre': ['techno']}),
                             {'genre': []})

    def test_semantics_preserve_label_order_and_similarity_values(self):
        import numpy as np
        import torch
        model = MagicMock()
        model.parameters.return_value = iter([torch.zeros(1)])
        model.calc_similarity.return_value = torch.tensor([[0.25, -0.5]])
        with patch.object(adapters, '_optional', return_value=object()), \
             patch.object(adapters, '_load_muq', return_value=model):
            result = adapters.semantic_scores(np.zeros(24000, dtype=np.float32), 24000, ['warm', 'cold'])
        self.assertEqual([row['label'] for row in result], ['warm', 'cold'])
        self.assertEqual([row['score'] for row in result], [0.25, -0.5])
