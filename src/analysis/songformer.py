"""
SongFormer (Hao et al., 2025): the sections a listener would name.

The structure stage finds *where* a song repeats — that is what self-similarity
is good at — and then has to guess *what* each part is from arrangement rules:
the loudest repeated block is the chorus, a quiet one in the middle is a
breakdown. The rules have no pre-chorus, and a song whose chorus is not its
loudest part gets its roles backwards. SongFormer was trained on thousands of
annotated songs to answer the second question directly: intro, verse,
pre-chorus, chorus, bridge, instrumental, outro, silence.

It is optional, and heavy. The published checkpoint carries both of its
self-supervised backbones (MuQ and MusicFM, 690 M parameters, 2.9 GB), and it
reads the whole track in one 420-second window, so its attention grows with the
square of the track's length. On a four-core laptop CPU it runs at about three
quarters of real time with 8-10 GB of RAM in use; on a GPU it is a few seconds.
So the default, `auto`, runs it only when the analyser has a GPU and the
weights are on disk, and the self-similarity labeller answers otherwise.
`ARTNET_STRUCTURE_MODEL` (the settings page's Structure field) chooses:

    auto        SongFormer on a GPU, the labeller on a CPU
    songformer  SongFormer whenever the weights are here, CPU included
    off         the labeller always

The model code ships with the checkpoint (it is not a pip package) and imports
its modules by bare name — `model`, `dataset`, `postprocessing` — from its own
directory, so that directory goes on `sys.path` once, when it first loads. Its
one import nothing here needs, msaf's evaluation metrics, is stubbed rather than
installed: msaf pins `enum34`, which breaks the standard library on any Python 3.

The companion EDM model (EDMFormer) has no released weights, and SongFormer's
labels include no drop. The fusion in `structure.from_model` makes a section
that starts on a detected drop a `drop`, which is the distinction EDMFormer
would have drawn.

What it has been checked on: synthetic tracks, which prove the plumbing (it
loads, runs, and its answer is fused and validated) and nothing about how well
it labels real music. The published SongFormBench results are the evidence for
that.
"""

import contextlib
import importlib.util
import os
import sys
import types
from pathlib import Path

from . import models

#: The rate both backbones were trained at.
RATE = 24000
#: The model's analysis window, in seconds (its config's `win_size`).
WINDOW_SEC = 420
#: What must be in the model directory for it to load.
REQUIRED_FILES = ('model.safetensors', 'modeling_songformer.py', 'config.json',
                  'muq_config2.json', 'msd_stats.json')
#: Packages the model code imports, checked without importing them.
REQUIRED_PACKAGES = ('muq', 'x_transformers', 'omegaconf', 'ema_pytorch', 'loguru',
                     'safetensors', 'transformers')
MODES = ('auto', 'songformer', 'off')


def _log(message):
    print(f'[songformer] {message}', file=sys.stderr, flush=True)


def model_dir():
    root = Path(os.environ.get('ARTNET_MODEL_DIR',
                               Path.home() / '.cache' / 'artnet-lightshow' / 'models'))
    return Path(os.environ.get('ARTNET_SONGFORMER_MODEL') or root / 'songformer')


def mode(value=None):
    """The configured mode, `auto` when unset or unrecognised."""
    value = (value or os.environ.get('ARTNET_STRUCTURE_MODEL') or 'auto').strip().lower()
    return value if value in MODES else 'auto'


def missing():
    """What stops SongFormer loading here: missing files and packages, or []."""
    directory = model_dir()
    gaps = [f'{directory / name}' for name in REQUIRED_FILES if not (directory / name).is_file()]
    for package in REQUIRED_PACKAGES:
        try:
            found = importlib.util.find_spec(package) is not None
        except (ImportError, ValueError):
            found = False
        if not found:
            gaps.append(f'python package {package}')
    return gaps


def available():
    return not missing()


def wanted(value=None):
    """Should this track's sections come from SongFormer?"""
    chosen = mode(value)
    if chosen == 'off' or not available():
        return False
    if chosen == 'songformer':
        return True
    return models.on_gpu()


def _stub_msaf():
    """The model imports msaf for its evaluation metrics, which inference never calls."""
    if 'msaf' in sys.modules or importlib.util.find_spec('msaf') is not None:
        return
    def compute_results(*_args, **_kwargs):
        raise RuntimeError('msaf is not installed; SongFormer evaluation is unavailable')
    msaf = types.ModuleType('msaf')
    evaluation = types.ModuleType('msaf.eval')
    evaluation.compute_results = compute_results
    msaf.eval = evaluation
    sys.modules['msaf'] = msaf
    sys.modules['msaf.eval'] = evaluation


def load():
    """The model, built once per process on the analysis device."""
    directory = model_dir()
    target = 'cpu' if models.gpu_fault() else models.device()

    def build():
        gaps = missing()
        if gaps:
            raise RuntimeError(f'SongFormer is not installed: missing {", ".join(gaps)}')
        _stub_msaf()
        os.environ['SONGFORMER_LOCAL_DIR'] = str(directory)
        if str(directory) not in sys.path:
            sys.path.insert(0, str(directory))
        import torch
        from safetensors.torch import load_file
        _log(f'loading from {directory}…')
        # Its code and transformers both talk on stdout, which is the worker's
        # protocol stream.
        with contextlib.redirect_stdout(sys.stderr):
            modeling = importlib.import_module('modeling_songformer')
            configuration = importlib.import_module('configuration_songformer')
            config = configuration.SongFormerConfig.from_pretrained(str(directory))
            model = modeling.SongFormerModel(config)
            state = load_file(str(directory / 'model.safetensors'))
            model.load_state_dict(state, strict=True)
            del state
        return model.float().to(target).eval()

    return models.cached(f'songformer:{directory}:{target}', build)


def _fit_windows(audio):
    """
    Trim a tail the model would never finish.

    Its window loop skips a window of 1024 samples or fewer without moving on,
    so a track a few milliseconds longer than a multiple of the window hangs
    the worker. Those milliseconds carry no structure.
    """
    step = WINDOW_SEC * RATE
    tail = len(audio) % step
    if 0 < tail <= 1024 and len(audio) > step:
        return audio[:len(audio) - tail]
    return audio


def sections(samples, sample_rate):
    """
    Sections of mono `samples`, as `[{'start', 'end', 'label'}, …]` in seconds.

    Labels are SongFormer's own: intro, verse, pre-chorus, chorus, bridge,
    inst, outro, silence. Raises when the model cannot run; the caller keeps
    the labeller's answer.
    """
    import numpy as np
    import torch
    from .preprocess import resample
    audio = np.asarray(samples, dtype=np.float32)
    if audio.ndim > 1:
        audio = audio.mean(axis=0)
    audio = _fit_windows(resample(audio, sample_rate, RATE))
    if audio.size < RATE * 5:
        return []
    model = load()
    with models.inference('songformer'), torch.inference_mode(), \
            contextlib.redirect_stdout(sys.stderr):
        rows = model(audio)
    duration = audio.size / RATE
    out = []
    for row in rows or []:
        start = max(0.0, float(row['start']))
        end = min(duration, float(row['end']))
        if end - start > 0.05:
            out.append({'start': round(start, 3), 'end': round(end, 3), 'label': str(row['label'])})
    return out
