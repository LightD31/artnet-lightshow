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

    def build():
        # Built where it lives: in RAM when models are kept there between
        # passes (models.offloading), on the device otherwise.
        target = models.home()
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
        model = model.float().to(target).eval()
        if models.offloading():
            models.park(model)
        return model

    return models.cached(f"{kind}:{model_id}", build)


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


#: Windows pushed through MuQ in one forward pass. The windows overlap four to
#: one, so a track is hundreds of them and one-at-a-time leaves the card idle
#: between kernel launches while Python walks the loop.
#:
#: Four, not eight. The activations grow in step with the batch (0.15 GB a
#: window), but MuQ's first convolution does not: from six windows up, cuDNN
#: picks an algorithm for it with a 4 GB workspace, and on an RTX 2070 SUPER
#: eight windows peaked at 4.3 GB where four peak at 0.6 GB. The pass then
#: holds nearly all of an 8 GB card — the "expandable_segments: memory mapping
#: failed" warnings in the log — and the desktop, the browser and whatever
#: else is on the card have nothing left. Measured per window, four is as fast
#: as eight (44 ms either way); two is about 5 % slower.
_MUQ_BATCH = max(1, int(os.environ.get("ARTNET_MUQ_BATCH", "4")))

#: Decimal places an embedding keeps. A track is about a hundred and twenty
#: 1024-wide vectors, and at full float precision they were most of a
#: several-megabyte document that went over a socket to the browser and into
#: the cache. Four places is far below the spread between two windows'
#: vectors, so no similarity a consumer computes can tell the difference.
EMBEDDING_DIGITS = 4


def _rounded(vector):
    return [round(float(v), EMBEDDING_DIGITS) for v in vector]


def _to_24k(waveform, sample_rate: int):
    """The 24 kHz mono signal both MuQ towers want, resampled once."""
    import numpy as np
    audio = np.asarray(waveform, dtype=np.float32)
    if int(sample_rate) == 24000:
        return audio
    import librosa
    return librosa.resample(audio, orig_sr=sample_rate, target_sr=24000)


def muq_embeddings(waveform, sample_rate: int, *, step_sec: float = 2.0):
    """Extract MuQ windows when ``muq`` and a configured checkpoint exist.

    MuQ requires 24 kHz input and fp32 inference.  The adapter intentionally
    does not download weights during a show; set ``ARTNET_MUQ_MODEL`` to a
    local checkpoint directory and provision it before playback.

    Windows are encoded in batches. An eight-second window every two seconds
    means a four-minute track is about a hundred and twenty forward passes, and
    run one at a time each is small enough that the launch overhead costs more
    than the arithmetic. The windows themselves are unchanged, so the vectors
    are the same ones the show engine was reading before.
    """
    module = _optional("muq")
    model_id = _model_path("muq", "ARTNET_MUQ_MODEL")
    if module is None or not model_id:
        return []
    import numpy as np
    import torch
    from . import models
    model = _load_muq("MuQ", model_id)
    audio = _to_24k(waveform, sample_rate)
    hop = max(1, int(step_sec * 24000)); window = 8 * 24000

    # Every window but the last few is exactly `window` long; only the tail
    # runs short. Batching needs equal lengths, so the full ones go through
    # together and the ragged tail goes through as it did before.
    starts = [s for s in range(0, len(audio), hop) if len(audio[s:s + window]) >= 24000]
    full = [s for s in starts if len(audio[s:s + window]) == window]
    tail = [s for s in starts if len(audio[s:s + window]) != window]

    def run(device):
        result = []
        with torch.no_grad():
            for index in range(0, len(full), _MUQ_BATCH):
                group = full[index:index + _MUQ_BATCH]
                batch = np.stack([audio[s:s + window] for s in group])
                output = model(torch.from_numpy(batch).to(device))
                vectors = output.last_hidden_state.mean(dim=1).float().cpu().tolist()
                for start, vector in zip(group, vectors):
                    result.append({"time": round(start / 24000, 3), "vector": _rounded(vector),
                                   "confidence": 1.0, "source": "muq"})
            for start in tail:
                output = model(torch.from_numpy(audio[start:start + window]).unsqueeze(0).to(device))
                vector = output.last_hidden_state.mean(dim=1)[0].float().cpu().tolist()
                result.append({"time": round(start / 24000, 3), "vector": _rounded(vector),
                               "confidence": 1.0, "source": "muq"})
        return result

    result = models.run_pass("muq", run, modules=[model])
    result.sort(key=lambda row: row["time"])
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
    from . import models
    model = _load_muq("MuQMuLan", model_id)
    audio = _to_24k(waveform, sample_rate)

    def run(device):
        result = {}
        with torch.no_grad():
            embedded = model(wavs=torch.from_numpy(audio).unsqueeze(0).to(device))
            for name, vocabulary in vocabularies.items():
                labels = tuple(vocabulary)
                if not labels:
                    result[name] = []
                    continue
                text = _text_latents(model, labels, device)
                scores = model.calc_similarity(embedded, text)[0].float().cpu().tolist()
                result[name] = [{"label": label, "score": float(score), "source": "muq-mulan"}
                                for label, score in zip(labels, scores)]
        return result

    return models.run_pass("muq-mulan", run, modules=[model])


# Text latents, keyed by the model instance, the exact label tuple and the
# device they were computed on — a pass that falls back to the CPU cannot
# compare against latents on the card. The model is held alongside its
# latents so a dead object's id cannot be reused for a live one.
_TEXT_LATENTS = {}


def _text_latents(model, labels, device=None):
    """
    Encode a vocabulary once per process rather than once per track.

    The genre prompts and the mood words are fixed constants — the same
    fifty-six strings for every track of every show — but the text tower is a
    full XLM-RoBERTa and it was being run over them again for each one. Its
    answer cannot change between tracks, so it is computed on the first track
    and read from memory after.
    """
    key = (id(model), labels, str(device))
    hit = _TEXT_LATENTS.get(key)
    if hit is not None:
        return hit[1]
    latents = model(texts=list(labels))
    _TEXT_LATENTS[key] = (model, latents)
    return latents


def semantic_scores(waveform, sample_rate: int, vocabulary):
    """Return MuQ-MuLan similarities for one vocabulary, or an empty list."""
    return mulan_scores(waveform, sample_rate, {"semantic": vocabulary})["semantic"]


def muq_pass(waveform, sample_rate: int, vocabularies):
    """
    Every MuQ question about one track, asked in one visit to the card.

    Both towers want the same 24 kHz signal, and resampling a four-minute track
    is not free, so it happens once here rather than once inside each adapter.
    Grouping them also lets the caller put the whole MuQ stage on a thread
    beside the DSP: the embeddings used to run inline after the document was
    assembled, which put the slowest optional model squarely on the critical
    path for no reason — nothing later in the pipeline reads them.

    The two are separate models with separate checkpoints, and one failing
    says nothing about the other: MuLan's text tower missing used to cost the
    track its embeddings too, and an embedding pass that ran out of memory
    its genre. Each is asked on its own, and what fails comes back empty.
    """
    audio = _to_24k(waveform, sample_rate)
    try:
        scores = mulan_scores(audio, 24000, vocabularies)
    except Exception as exc:
        print(f"[models] MuQ-MuLan unavailable ({exc}); genre and mood fall back",
              file=sys.stderr)
        scores = {}
    try:
        embeddings = muq_embeddings(audio, 24000)
    except Exception as exc:
        print(f"[models] MuQ embeddings unavailable ({exc})", file=sys.stderr)
        embeddings = []
    return {"scores": scores, "embeddings": embeddings}


def _skey_load_audio(song_path, sr, mono=True, normalize=True):
    """
    S-KEY's `load_audio`, read with soundfile instead of `torchaudio.load`.

    From torchaudio 2.9, `load` needs torchcodec, which is not built for every
    torch — AMD's ROCm wheels for Windows have none — and S-KEY has no fallback.
    The adapter swallows the error, so the symptom was not a failure but every
    track quietly losing its key. Same contract: (channels, samples) at `sr`,
    peak-normalised.
    """
    import numpy as np
    import soundfile as sf
    import librosa
    import torch
    if not Path(song_path).exists():
        raise FileNotFoundError(f"File {song_path} not found.")
    signal, file_sr = sf.read(song_path, dtype="float32", always_2d=True)
    signal = signal.T
    if mono and signal.shape[0] > 1:
        signal = signal.mean(axis=0, keepdims=True)
    if file_sr != sr:
        signal = librosa.resample(signal, orig_sr=file_sr, target_sr=int(sr))
    waveform = torch.from_numpy(np.ascontiguousarray(signal, dtype=np.float32))
    if normalize:
        peak = torch.max(torch.abs(waveform))
        if peak > 0:
            waveform = waveform / peak
    return waveform


def skey_available():
    """Is S-KEY installed — asked without importing it, which loads torch models."""
    import importlib.util
    try:
        return importlib.util.find_spec("skey") is not None
    except (ImportError, ValueError):
        return False


def _decoded_loader(samples, samples_rate):
    """
    S-KEY's `load_audio`, served from a signal the pipeline already decoded.

    Same contract as `_skey_load_audio`: (channels, samples) at `sr`,
    peak-normalised. The path it is handed is ignored.
    """
    def load_audio(_song_path, sr, mono=True, normalize=True):
        import numpy as np
        import librosa
        import torch
        signal = np.atleast_2d(np.asarray(samples, dtype=np.float32))
        if mono and signal.shape[0] > 1:
            signal = signal.mean(axis=0, keepdims=True)
        if int(samples_rate) != int(sr):
            signal = librosa.resample(signal, orig_sr=int(samples_rate), target_sr=int(sr))
        waveform = torch.from_numpy(np.ascontiguousarray(signal, dtype=np.float32))
        if normalize:
            peak = torch.max(torch.abs(waveform))
            if peak > 0:
                waveform = waveform / peak
        return waveform
    return load_audio


def skey_key(audio_path: str, samples=None, sample_rate=None):
    """
    Return S-KEY's global key when the optional Deezer package is present.

    Given `samples` (the file as the pipeline decoded it, channels first) and
    their `sample_rate`, S-KEY reads those instead of decoding the file again.
    """
    module = _optional("skey.key_detection")
    if module is None:
        return None
    if samples is not None and sample_rate:
        module.load_audio = _decoded_loader(samples, sample_rate)
    else:
        module.load_audio = _skey_load_audio
    try:
        # S-KEY prints its answer, emoji included, and on a Windows console
        # the emoji alone raises — which the except below turned into "no
        # key", every track. Its chatter goes nowhere; the return value is the
        # answer. Silenced in its own module, not with redirect_stdout: that
        # swaps sys.stdout for the whole process while other models run on
        # other threads, and the two swaps put back each other's value (see
        # cli._claim_stdout).
        module.print = lambda *args, **kwargs: None
        result = module.detect_key(audio_path, device=os.environ.get('ARTNET_ANALYSIS_DEVICE', 'cpu'))
        value = result[0] if isinstance(result, list) else result
        return {"value": str(value), "confidence": 1.0, "source": "s-key"}
    except Exception:
        return None
