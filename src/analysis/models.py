"""
The one place torch lives.

Every learned component in the pipeline loads through here, for three reasons
that are all about the machines this runs on rather than about the models:

**Device.** The rig is driven from whatever laptop is at the front of house. A
desktop with a CUDA card should use it; a laptop without one has to stay
usable, not merely runnable. `device()` picks once and every model follows it,
so there is no path where half the pipeline is on the GPU and half is not.

**Cost.** These checkpoints take seconds to load and hundreds of megabytes of
RAM. The analyser is a long-lived worker process handling one track after
another, so a model is loaded once per process and kept — which is the whole
reason the worker exists.

**Failure.** A missing checkpoint on the machine at load-in is a show that does
not happen, so the errors raised here name the model and say what to install
rather than surfacing a bare ImportError from three frames down.
"""

import os
import sys
import threading

# Re-entrant: a model's build() calls device(), which locks too. A plain
# Lock deadlocks the first load, and a deadlock at load-in is a dead show.
_LOCK = threading.RLock()
_CACHE = {}
_DEVICE = None


def _log(message):
    print(f'[models] {message}', file=sys.stderr, flush=True)


def device():
    """
    The torch device everything runs on, decided once per process.

    `ARTNET_ANALYSIS_DEVICE` overrides it — useful for forcing CPU when a GPU
    is busy driving a visualiser, which on a one-machine setup it often is.
    """
    global _DEVICE
    if _DEVICE is not None:
        return _DEVICE
    with _LOCK:
        if _DEVICE is not None:
            return _DEVICE
        override = os.environ.get('ARTNET_ANALYSIS_DEVICE', '').strip()
        if override:
            _DEVICE = override
            _log(f'device: {_DEVICE} (from ARTNET_ANALYSIS_DEVICE)')
            return _DEVICE
        import torch
        if torch.cuda.is_available():
            _DEVICE = 'cuda'
            _log(f'device: cuda ({torch.cuda.get_device_name(0)})')
        else:
            # Threads rather than a GPU. Leave one core for the Art-Net render
            # loop and the web server: a analysis that starves the output is
            # worse than one that takes a few seconds longer.
            cores = os.cpu_count() or 4
            torch.set_num_threads(max(1, cores - 1))
            _DEVICE = 'cpu'
            _log(f'device: cpu ({max(1, cores - 1)} of {cores} threads)')
        return _DEVICE


def require(package, install_hint):
    """Import a package or raise with something an operator can act on."""
    import importlib
    try:
        return importlib.import_module(package)
    except ImportError as exc:
        missing = getattr(exc, 'name', None)
        if missing and missing != package and not package.startswith(missing + '.'):
            raise RuntimeError(
                f'{package} could not load because its dependency {missing} '
                f'is missing or cannot be imported ({exc}). '
                f'Install the analysis dependencies into {sys.executable}: '
                f'{install_hint}') from exc
        raise RuntimeError(
            f'{package} is required by the analyser but is not installed '
            f'({exc}). Install it with: {install_hint}') from exc


def checkpoint_cache():
    """Where torch.hub keeps downloaded weights."""
    import torch
    return os.path.join(torch.hub.get_dir(), 'checkpoints')


def local_checkpoint(filename):
    """
    Path to an already-downloaded checkpoint, or None.

    Loading by shortname sends the resolver to the network even when the file
    is already on disk, and a hung request there is a show that does not start.
    That is not hypothetical — it hung repeatedly while this was being built.
    At load-in on venue wifi it is the difference between a five-second model
    load and an analyser that never returns, so a checkpoint that is already
    local is always loaded from the local path.
    """
    path = os.path.join(checkpoint_cache(), filename)
    return path if os.path.isfile(path) else None


def cached(key, build):
    """Build a model once per process and hand back the same instance after."""
    if key in _CACHE:
        return _CACHE[key]
    with _LOCK:
        if key in _CACHE:
            return _CACHE[key]
        _CACHE[key] = build()
        return _CACHE[key]


# ── Beat and downbeat tracking ──────────────────────────────────────────────

def beat_tracker():
    """
    Beat This! (Foscarin et al., ISMIR 2024) — a transformer that predicts beats
    and downbeats directly.

    Chosen over madmom's RNN+DBN, which is the other standard, for two reasons.
    It is more accurate, particularly on downbeats. And it is plain PyTorch: no
    Cython, no C compiler, no unmaintained package pinned to a numpy from 2018 —
    which matters when the person installing this is a VJ on a Windows laptop
    rather than a researcher.

    Run without the DBN post-processor, so madmom is not a dependency at all.
    """
    def build():
        require('beat_this', 'pip install -r requirements.txt')
        from beat_this.inference import Audio2Beats
        local = local_checkpoint('beat_this-final0.ckpt')
        if local:
            _log('loading beat_this from cache')
            return Audio2Beats(checkpoint_path=local, device=device(), dbn=False)
        _log('downloading beat_this checkpoint (~80 MB, once)…')
        return Audio2Beats(device=device(), dbn=False)
    return cached('beat_this', build)


# ── Source separation ───────────────────────────────────────────────────────

def separator(name='htdemucs'):
    """
    Demucs v4. Splits a track into drums, bass, vocals and other.

    This is what turns the instrument roles from inference into measurement.
    The old pipeline guessed at the kick from a band's attack time and at the
    vocal from mid-band harmonic movement weighted by how much it moved; with
    stems, "is there a voice here" is a question about the vocals stem.
    """
    def build():
        require('demucs', 'pip install -r requirements.txt')
        from demucs.pretrained import get_model
        _log(f'loading demucs {name}…')
        model = get_model(name)
        model.eval()
        return model
    return cached(f'demucs:{name}', build)


def bs_roformer_separator():
    """Load the four-stem BS-RoFormer through audio-separator."""
    def build():
        module = require('audio_separator.separator', 'pip install -r requirements.txt')
        Separator = module.Separator
        model_dir = os.environ.get(
            'ARTNET_MODEL_DIR', os.path.expanduser('~/.cache/artnet-lightshow/models'))
        model = Separator(output_dir=None, output_format='WAV',
                          model_file_dir=model_dir,
                          log_level=40, use_autocast=False)
        filename = os.environ.get('ARTNET_BS_ROFORMER_MODEL')
        if not filename:
            filename = 'BS-Roformer-SW.ckpt'
        elif os.path.isfile(filename):
            model_dir = os.path.dirname(filename)
            filename = os.path.basename(filename)
        try:
            model.load_model(model_filename=filename)
        except ValueError as exc:
            raise RuntimeError(
                f'BS-RoFormer checkpoint is not registered by audio-separator: {filename}. '
                'Set ARTNET_BS_ROFORMER_MODEL to a supported audio-separator model name '
                'or leave ARTNET_USE_BS_ROFORMER disabled.') from exc
        return model
    return cached('bs-roformer-4stem', build)


def warm_up():
    """
    Load every model now rather than on the first track.

    The worker is spawned at server start precisely so this cost lands while
    the operator is still opening the UI, not while a track is waiting.
    """
    for load in (beat_tracker, separator):
        try:
            load()
        except Exception as exc:
            _log(f'warm-up failed: {exc}')
