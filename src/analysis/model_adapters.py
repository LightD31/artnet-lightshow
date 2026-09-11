"""Optional pretrained model adapters used by the offline analysis path.

The core pipeline remains installable without model weights.  Each adapter
returns a small, serialisable result and reports provenance; callers can keep
the deterministic DSP fallback when an optional package or checkpoint is not
available.
"""

from __future__ import annotations

import importlib
import contextlib
import json
import sys
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


def _model_path(name, variable):
    root = Path(os.environ.get("ARTNET_MODEL_DIR", Path.home() / ".cache" / "artnet-lightshow" / "models"))
    return os.environ.get(variable) or str(root / name)


def _load_muq(kind, model_id):
    from . import models
    module = _optional("muq")
    if module is None:
        return None
    device = models.device()

    def build():
        kwargs = {"local_files_only": True}
        if kind == "MuQMuLan":
            # MuLan's checkpoint also constructs a MuQ backbone. Use the
            # already provisioned local checkpoint instead of fetching it.
            with open(Path(model_id) / "config.json") as handle:
                config = json.load(handle)
            config["audio_model"]["name"] = _model_path("muq", "ARTNET_MUQ_MODEL")
            text_path = _model_path("xlm-roberta-base", "ARTNET_MUQ_TEXT_MODEL")
            if not Path(text_path).is_dir():
                raise FileNotFoundError(
                    f"MuQ-MuLan text model missing at {text_path}; run scripts/download-models.py")
            config["text_model"]["name"] = text_path
            kwargs["config"] = config
        with contextlib.redirect_stdout(sys.stderr):
            cls = getattr(module, kind)
            binary = Path(model_id) / "pytorch_model.bin"
            if kind == "MuQMuLan" and binary.is_file() and not (Path(model_id) / "model.safetensors").is_file():
                # HubMixin 0.x assumes local checkpoints are safetensors, but
                # the published MuLan checkpoint uses the PyTorch format.
                import torch
                model = cls(config=kwargs["config"])
                model.load_state_dict(torch.load(binary, map_location="cpu", weights_only=True), strict=True)
            else:
                model = cls.from_pretrained(model_id, **kwargs)
        return model.float().to(device).eval()

    return models.cached(f"{kind}:{model_id}:{device}", build)


def preload():
    """
    Build the optional MuQ checkpoints during start-up rather than mid-track.

    Failure is deliberately silent: everything these models feed has a
    fallback, and a warm-up hook is the wrong place to make a checkpoint that
    was never provisioned fatal. It is also not a download — a directory that
    is not there is skipped, not fetched, because the moment before doors open
    is not the moment to start pulling gigabytes over venue wifi.
    """
    if _optional("muq") is None:
        return
    for kind, name, variable in (("MuQ", "muq", "ARTNET_MUQ_MODEL"),
                                 ("MuQMuLan", "muq_mulan", "ARTNET_MUQ_MULAN_MODEL")):
        path = _model_path(name, variable)
        if not Path(path).is_dir():
            continue
        try:
            _load_muq(kind, path)
        except Exception as exc:
            print(f"[models] {kind} warm-up skipped: {exc}", file=sys.stderr)


def muq_embeddings(waveform, sample_rate: int, *, step_sec: float = 2.0):
    """Extract MuQ windows when ``muq`` and a configured checkpoint exist.

    MuQ requires 24 kHz input and fp32 inference.  The adapter intentionally
    does not download weights during a show; set ``ARTNET_MUQ_MODEL`` to a
    local checkpoint directory and provision it before playback.
    """
    module = _optional("muq")
    model_id = _model_path("muq", "ARTNET_MUQ_MODEL")
    if module is None or not model_id:
        return []
    import numpy as np
    import torch
    import librosa
    model = _load_muq("MuQ", model_id)
    device = next(model.parameters()).device
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


def mulan_scores(waveform, sample_rate: int, vocabularies):
    """Score several label vocabularies against one MuQ-MuLan audio pass.

    ``vocabularies`` maps a name to its labels; the result maps the same names
    to score rows.  The audio tower is the expensive half and its output does
    not depend on the labels, so genre and mood ask the same embedding rather
    than resampling and re-encoding the track once per question.

    Similarities are cosine values in the joint space, not probabilities.
    Callers decide how to calibrate them.
    """
    module = _optional("muq")
    model_id = _model_path("muq_mulan", "ARTNET_MUQ_MULAN_MODEL")
    if module is None or not model_id:
        return {name: [] for name in vocabularies}
    import numpy as np
    import torch
    import librosa
    model = _load_muq("MuQMuLan", model_id)
    device = next(model.parameters()).device
    audio = librosa.resample(np.asarray(waveform, dtype=np.float32),
                             orig_sr=sample_rate, target_sr=24000)
    result = {}
    with torch.no_grad():
        embedded = model(wavs=torch.from_numpy(audio).unsqueeze(0).to(device))
        for name, vocabulary in vocabularies.items():
            labels = list(vocabulary)
            if not labels:
                result[name] = []
                continue
            text = model(texts=labels)
            scores = model.calc_similarity(embedded, text)[0].float().cpu().tolist()
            result[name] = [{"label": label, "score": float(score), "source": "muq-mulan"}
                            for label, score in zip(labels, scores)]
    return result


def semantic_scores(waveform, sample_rate: int, vocabulary):
    """Return MuQ-MuLan similarities for one vocabulary, or an empty list."""
    return mulan_scores(waveform, sample_rate, {"semantic": vocabulary})["semantic"]


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
