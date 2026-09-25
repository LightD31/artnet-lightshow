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
reads a track in windows of up to 420 seconds, so its attention grows with the
square of the window. Measured on a CPU, beyond its 3.6 GB of weights it needs
about 1.25e-4 GB per second² of window: 4 GB at 180 s, 7 GB at 240 s, 22 GB for
a whole 420 s. A five-minute track read in one window was killed for memory on
a 16 GB machine — the worker with it, and the track lost its analysis rather
than falling back. So the window is chosen from the memory free when it runs
(`window_for`): as long as fits, and a longer track in equal windows. The model
reads a track longer than its window that way anyway; it is how it was built.

On a four-core laptop CPU it runs at about three quarters of real time; on a
GPU it is a few seconds. So the default, `auto`, runs it only when the analyser
has a GPU and the weights are on disk, and the self-similarity labeller answers
otherwise.
`ARTNET_STRUCTURE_MODEL` (the Structure setting, under Sources → Analysis) chooses:

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

How well it works was measured on real music, not only on synthetic tracks
(which prove the plumbing and nothing more): scripts/eval-structure.py scores
it against human annotations of ten SALAMI live recordings, two annotators
each. Boundaries within 3 s: 0.71 F against the labeller's 0.56; within 0.5 s
0.58 against 0.15. Section names match over 69 % of the track, against 33 %
for the labeller and 30 % for "verse" everywhere. Live bands, not studio pop or
club tracks, and whether SALAMI was in its training data is not known.
"""

import contextlib
import importlib.util
import math
import os
import sys
import types
from pathlib import Path

from . import models

#: The rate both backbones were trained at.
RATE = 24000
#: The model's analysis window, in seconds (its config's `win_size`): the
#: longest it reads at once, and what it reads when memory allows.
WINDOW_SEC = 420
#: The shortest window worth reading: below this the model sees too little of
#: the song to place its sections, and the labeller is the better answer.
MIN_WINDOW_SEC = 60
#: Working memory beyond the weights, per second² of window (measured on CPU).
GB_PER_SECOND_SQUARED = 1.25e-4
#: How much of the free memory it may take: the separator and MuQ may be
#: running beside it.
MEMORY_SHARE = 0.6
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
    """
    The model, built once per process: on the analysis device, or in RAM when
    models are kept there between passes (models.offloading).
    """
    directory = model_dir()

    def build():
        target = models.home()
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
        model = model.float().to(target).eval()
        if models.offloading():
            models.park(model)
        return model

    return models.cached(f'songformer:{directory}', build)


def available_gb(device):
    """Memory free for the model now: the card's, or the machine's. None if unknown."""
    if str(device).startswith('cuda'):
        try:
            import torch
            return torch.cuda.mem_get_info()[0] / 1e9
        except Exception:
            return None
    try:
        import psutil
        return psutil.virtual_memory().available / 1e9
    except Exception:
        pass
    try:
        with open('/proc/meminfo') as handle:
            for line in handle:
                if line.startswith('MemAvailable:'):
                    return int(line.split()[1]) / 1e6
    except OSError:
        pass
    return None


def window_for(duration, free_gb):
    """
    The window to read a track of `duration` seconds in, given `free_gb`.

    The longest whole number of 30-second steps (the model's inner windows)
    whose working memory fits in its share of what is free, at most 420 s.
    A track longer than that is read in equal windows rather than full ones
    and a scrap. Raises MemoryError when not even MIN_WINDOW_SEC fits.
    Unknown free memory is treated as 8 GB.
    """
    budget = (8.0 if free_gb is None else free_gb) * MEMORY_SHARE
    fits = math.sqrt(max(0.0, budget) / GB_PER_SECOND_SQUARED)
    window = min(WINDOW_SEC, int(fits // 30) * 30)
    if window < MIN_WINDOW_SEC:
        raise MemoryError(f'SongFormer needs {GB_PER_SECOND_SQUARED * MIN_WINDOW_SEC ** 2 / MEMORY_SHARE:.1f} GB '
                          f'free for its shortest window; {free_gb:.1f} GB is')
    if duration <= window:
        return window
    count = math.ceil(duration / window)
    return min(window, int(math.ceil(duration / count / 30)) * 30)


def _fit_windows(audio, window=WINDOW_SEC):
    """
    Trim a tail the model would never finish.

    Its window loop skips a window of 1024 samples or fewer without moving on,
    so a track a few milliseconds longer than a multiple of the window hangs
    the worker. Those milliseconds carry no structure.
    """
    step = window * RATE
    tail = len(audio) % step
    if 0 < tail <= 1024 and len(audio) > step:
        return audio[:len(audio) - tail]
    return audio


def sections(samples, sample_rate):
    """
    Sections of mono `samples`, as `[{'start', 'end', 'label'}, …]` in seconds.

    Labels are SongFormer's own: intro, verse, pre-chorus, chorus, bridge,
    inst, outro, silence. Raises when the model cannot run, or when there is
    not the memory to; the caller keeps the labeller's answer.
    """
    import numpy as np
    import torch
    from .preprocess import resample
    audio = np.asarray(samples, dtype=np.float32)
    if audio.ndim > 1:
        audio = audio.mean(axis=0)
    audio = resample(audio, sample_rate, RATE)
    if audio.size < RATE * 5:
        return []
    model = load()

    def run(device):
        with torch.inference_mode(), contextlib.redirect_stdout(sys.stderr):
            # Measured once the card is ours, with the weights on it: the
            # models before this one have handed back what they held.
            window = window_for(audio.size / RATE, available_gb(device))
            if window < WINDOW_SEC:
                _log(f'reading in {window} s windows ({audio.size / RATE:.0f} s track)')
            fitted = _fit_windows(audio, window)
            model.config.win_size = model.config.hop_size = window
            return fitted, model(fitted)

    audio, rows = models.run_pass('songformer', run, modules=[model])
    duration = audio.size / RATE
    out = []
    for row in rows or []:
        start = max(0.0, float(row['start']))
        end = min(duration, float(row['end']))
        if end - start > 0.05:
            out.append({'start': round(start, 3), 'end': round(end, 3), 'label': str(row['label'])})
    return out
