"""Optional pretrained model adapters used by the offline analysis path.

The core pipeline remains installable without model weights.  Each adapter
returns a small, serialisable result and reports provenance; callers can keep
the deterministic DSP fallback when an optional package or checkpoint is not
available.
"""

from __future__ import annotations

import importlib
import os
from pathlib import Path
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Prediction:
    value: Any
    confidence: float
    source: str

    def to_dict(self):
        return {"value": self.value, "confidence": self.confidence, "source": self.source}


def _optional(name):
    try:
        return importlib.import_module(name)
    except ImportError:
        return None


def muq_embeddings(waveform, sample_rate: int, *, step_sec: float = 2.0):
    """Extract MuQ windows when ``muq`` and a configured checkpoint exist.

    MuQ requires 24 kHz input and fp32 inference.  The adapter intentionally
    does not download weights during a show; set ``ARTNET_MUQ_MODEL`` to a
    local or HuggingFace model id and warm it before playback.
    """
    module = _optional("muq")
    model_id = os.environ.get("ARTNET_MUQ_MODEL") or str(
        Path.home() / ".cache" / "artnet-lightshow" / "models" / "muq")
    if module is None or not model_id:
        return []
    import numpy as np
    import torch
    import librosa
    device = os.environ.get("ARTNET_ANALYSIS_DEVICE", "cpu")
    model = module.MuQ.from_pretrained(model_id).to(device).eval()
    audio = librosa.resample(np.asarray(waveform, dtype=np.float32),
                             orig_sr=sample_rate, target_sr=24000)
    hop = max(1, int(step_sec * 24000)); window = 8 * 24000
    result = []
    with torch.no_grad():
        for start in range(0, len(audio), hop):
            chunk = audio[start:start + window]
            if len(chunk) < 24000:
                break
            output = model(torch.from_numpy(chunk).unsqueeze(0).to(device))
            vector = output.last_hidden_state.mean(dim=1)[0].float().cpu().tolist()
            result.append({"time": round(start / 24000, 3), "vector": vector,
                           "confidence": 1.0, "source": "muq"})
    return result


def semantic_scores(waveform, sample_rate: int, vocabulary):
    """Return MuQ-MuLan similarities, or an empty list when disabled."""
    module = _optional("muq")
    model_id = os.environ.get("ARTNET_MUQ_MULAN_MODEL") or str(
        Path.home() / ".cache" / "artnet-lightshow" / "models" / "muq_mulan")
    if module is None or not model_id:
        return []
    import numpy as np
    import torch
    import librosa
    device = os.environ.get("ARTNET_ANALYSIS_DEVICE", "cpu")
    model = module.MuQMuLan.from_pretrained(model_id).to(device).eval()
    audio = librosa.resample(np.asarray(waveform, dtype=np.float32),
                             orig_sr=sample_rate, target_sr=24000)
    with torch.no_grad():
        a = model(wavs=torch.from_numpy(audio).unsqueeze(0).to(device))
        t = model(texts=list(vocabulary))
        scores = model.calc_similarity(a, t)[0].float().cpu().tolist()
    return [{"label": label, "score": float(score), "source": "muq-mulan"}
            for label, score in zip(vocabulary, scores)]


def skey_key(audio_path: str):
    """Return S-KEY's global key when the optional Deezer package is present."""
    module = _optional("skey.key_detection")
    if module is None:
        return None
    try:
        result = module.detect_key(audio_path, device=os.environ.get('ARTNET_ANALYSIS_DEVICE', 'cpu'))
        value = result[0] if isinstance(result, list) else result
        return {"value": str(value), "confidence": 1.0, "source": "s-key"}
    except Exception:
        return None
