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

**Room.** One card, several models, one process that never exits. `inference()`
is how anything touches the GPU: it takes turns and it hands back what it
reserved. See the note above it for why both halves matter.
"""

import contextlib
import os
import sys
import threading

# Re-entrant: a model's build() calls device(), which locks too. A plain
# Lock deadlocks the first load, and a deadlock at load-in is a dead show.
_LOCK = threading.RLock()
_CACHE = {}
_DEVICE = None


class _Turns:
    """
    The card, one model's pass at a time, with the beat model at the front.

    Held for the duration of one model's pass over one track. Separate from
    _LOCK, which guards the cache dict: a model loading must not block a
    different model that is mid-inference.

    Every pass takes its turn, but not every pass is equally urgent. The beat
    grid is what the rest of the analysis is built on — the bands, the
    dynamics and the sections all wait for it — while the separator and MuQ
    are collected later. Queued behind them the beat model used to wait out
    a whole separation, with the DSP that follows it idle for as long. A
    pass that asks to go `first` goes before anyone else waiting, and the
    pipeline can `reserve` it a place before the others are even started.
    Nothing is interrupted: a pass that has the card keeps it to the end.

    Re-entrant for the thread that holds it, as the RLock it replaced was.
    """

    def __init__(self):
        self._cond = threading.Condition()
        self._owner = None
        self._depth = 0
        self._reserved = []
        self._first_waiting = 0

    def reserve(self):
        """Keep the next `first` turn for a pass that has not asked yet."""
        token = object()
        with self._cond:
            self._reserved.append(token)
        return token

    def cancel(self, token):
        """Give up a reservation that was never used. Safe once it has been."""
        with self._cond:
            if token in self._reserved:
                self._reserved.remove(token)
                self._cond.notify_all()

    def acquire(self, first=False):
        me = threading.get_ident()
        with self._cond:
            if self._owner == me:
                self._depth += 1
                return
            if first:
                self._first_waiting += 1
            try:
                while self._owner is not None or (
                        not first and (self._reserved or self._first_waiting)):
                    self._cond.wait()
            finally:
                if first:
                    self._first_waiting -= 1
            if first and self._reserved:
                self._reserved.pop(0)
            self._owner = me
            self._depth = 1

    def release(self):
        with self._cond:
            self._depth -= 1
            if self._depth == 0:
                self._owner = None
                self._cond.notify_all()


_TURNS = _Turns()

# Growable allocator segments, set before torch makes its first CUDA
# allocation. The analyser is a long-lived process that sees a different track
# length every time, so every pass asks for slightly different block sizes.
# With fixed segments the freed blocks cannot be merged back together, and
# after a few dozen tracks the card reports gigabytes free with no single piece
# of it big enough to hold a checkpoint — which is what "not enough memory to
# load a model" turns out to mean here. An operator who has already set this
# keeps their value.
os.environ.setdefault('PYTORCH_CUDA_ALLOC_CONF', 'expandable_segments:True')


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
        import torch
        chosen = _override(torch)
        if chosen:
            source = 'from ARTNET_ANALYSIS_DEVICE'
        elif torch.cuda.is_available():
            chosen, source = 'cuda', torch.cuda.get_device_name(0)
        else:
            chosen, source = 'cpu', None
        # The same set-up whichever way the device was chosen. The override
        # used to return before it, so forcing the card on a ROCm build left
        # MIOpen on (every BatchNorm model failing), and forcing the CPU left
        # torch on every core, starving the render loop.
        if chosen.startswith('cuda'):
            _avoid_miopen(torch)
            _log(f'device: {chosen} ({source})')
        elif chosen == 'cpu':
            # Threads rather than a GPU. Leave one core for the Art-Net render
            # loop and the web server: a analysis that starves the output is
            # worse than one that takes a few seconds longer.
            cores = os.cpu_count() or 4
            torch.set_num_threads(max(1, cores - 1))
            _log(f'device: cpu ({max(1, cores - 1)} of {cores} threads'
                 f'{", " + source if source else ""})')
        else:
            _log(f'device: {chosen} ({source})')
        _DEVICE = chosen
        return _DEVICE


def _override(torch):
    """
    ARTNET_ANALYSIS_DEVICE, if it names a device this torch can use.

    A typo, or `cuda` on a CPU-only build, used to be handed to every model
    as it was, and every track failed at its first tensor. Now it is named in
    the log and the device is chosen as if it were not set.
    """
    wanted = os.environ.get('ARTNET_ANALYSIS_DEVICE', '').strip().lower()
    if not wanted:
        return None
    try:
        parsed = torch.device(wanted)
    except (RuntimeError, ValueError, TypeError):
        _log(f'ARTNET_ANALYSIS_DEVICE={wanted!r} is not a device; choosing one')
        return None
    if parsed.type == 'cuda' and not torch.cuda.is_available():
        _log(f'ARTNET_ANALYSIS_DEVICE={wanted!r}, but this torch has no usable GPU; '
             'choosing one')
        return None
    if parsed.type not in ('cpu', 'cuda', 'mps', 'xpu'):
        _log(f'ARTNET_ANALYSIS_DEVICE={wanted!r} is not supported here; choosing one')
        return None
    return wanted


def _avoid_miopen(torch):
    """
    On a ROCm build, use PyTorch's own GPU kernels rather than MIOpen's.

    MIOpen compiles some kernels on first use, BatchNorm among them, and AMD's
    Windows wheels ship a runtime compiler that cannot find the C++ standard
    headers: the compile fails, and every model with a BatchNorm layer (the
    beat tracker, PANNs) fails with `miopenStatusUnknownError`. PyTorch's
    native kernels run the same layers at much the same speed on an RDNA 3.5
    iGPU, so nothing is lost by skipping MIOpen. Set ARTNET_MIOPEN=1 to try it
    again on a build that has fixed this.
    """
    if getattr(torch.version, 'hip', None) and os.environ.get('ARTNET_MIOPEN', '') != '1':
        torch.backends.cudnn.enabled = False
        _log('MIOpen off (ROCm): using PyTorch kernels; ARTNET_MIOPEN=1 to re-enable')


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


def unload(key):
    """
    Drop a cached model and give the card back its weights.

    Used where two models answer the same question and only one of them is
    going to be asked — keeping the loser resident costs hundreds of megabytes
    for the life of the process and buys nothing.
    """
    with _LOCK:
        model = _CACHE.pop(key, None)
    if model is None:
        return False
    del model
    release_memory()
    _log(f'unloaded {key}')
    return True


_GPU_FAULT = None


def gpu_fault(exc=None):
    """
    Record, or report, that the GPU's FFT has broken for this process.

    AMD's ROCm nightlies sometimes fail a GPU FFT with HIPFFT_PARSE_ERROR,
    intermittently and only under the pipeline's parallel load, and once one
    has failed every later one in the process fails too — the beat model, then
    each separator in turn. So the first such error marks the process: the
    stage that hit it reruns on the CPU, later stages go straight to the CPU,
    and the worker asks to be replaced once the track is answered, which is
    what gives the next track a working GPU again.

    Called with an exception, returns whether it was such a fault (and records
    it). Called bare, returns the recorded fault or None.
    """
    global _GPU_FAULT
    if exc is None:
        return _GPU_FAULT
    text = str(exc)
    if not any(mark in text for mark in ('HIPFFT_', 'CUFFT_', 'cuFFT error', 'hipErrorLaunchFailure')):
        return False
    if _GPU_FAULT is None:
        _GPU_FAULT = text
        _log(f'GPU fault ({text}); finishing this track on the CPU, then restarting the worker')
    return True


def on_gpu():
    """Is the pipeline running on CUDA? Asked without importing torch."""
    return str(device()).startswith('cuda')


def release_memory():
    """
    Return the caching allocator's free blocks to the driver.

    Worth doing between stages and between tracks, and not inside a loop: it
    synchronises with the device, so calling it per window would cost more than
    the fragmentation it prevents.
    """
    if not on_gpu():
        return
    try:
        import torch
        gc_collect()
        torch.cuda.empty_cache()
    except Exception as exc:  # pragma: no cover - diagnostics only
        _log(f'could not release device memory: {exc}')


def gc_collect():
    """Drop unreachable tensors before asking the allocator to hand blocks back.

    A tensor caught in a traceback or a reference cycle still owns its memory,
    and `empty_cache()` can only free what nothing points at any more.
    """
    import gc
    gc.collect()


@contextlib.contextmanager
def inference(label='model', first=False):
    """
    Hold the device for one model's pass over one track, then hand it back.

    Two separate problems, one context manager.

    *Taking turns.* The pipeline deliberately runs the separator, the tagger
    and MuQ-MuLan in parallel threads, which is right on a CPU and wrong on one
    GPU: run concurrently their peak allocations add together rather than
    taking turns, so a card that fits any one of them comfortably fits all
    three only sometimes. Which tracks fail then depends on their length and on
    who won the race, which is exactly the "occasionally" in the bug report.
    Serialising costs close to nothing, because a single one of these models
    already saturates the card — the threads still overlap the DSP stages,
    which is where the parallelism was actually paying.

    *Handing it back.* Releasing after each stage keeps the high-water mark at
    one model's working set instead of the sum of every model that ran this
    track.

    *Going first.* `first=True` is for the beat model: it takes the next turn
    ahead of anyone already waiting (see `_Turns`).

    On CPU this is a no-op wrapper: there is no single device to contend for,
    and the existing parallelism is what the CPU numbers in the docs measure.
    """
    if not on_gpu():
        yield
        return
    _TURNS.acquire(first=first)
    try:
        yield
    finally:
        try:
            release_memory()
        finally:
            _TURNS.release()


def reserve_first_turn():
    """
    Hold the card's next turn for the beat model before anything else asks.

    The pipeline starts the separator and MuQ on their own threads at the top
    of a track; whichever reaches the card first would otherwise have it for
    tens of seconds. Returns a token for `cancel_turn`, or None on the CPU.
    """
    return _TURNS.reserve() if on_gpu() else None


def cancel_turn(token):
    """Release a reservation that was never taken — the pass failed early."""
    if token is not None:
        _TURNS.cancel(token)


# ── Beat and downbeat tracking ──────────────────────────────────────────────

def beat_tracker(on=None):
    """
    Beat This! (Foscarin et al., ISMIR 2024) — a transformer that predicts beats
    and downbeats directly.

    Chosen over madmom's RNN+DBN, which is the other standard, for two reasons.
    It is more accurate, particularly on downbeats. And it is plain PyTorch: no
    Cython, no C compiler, no unmaintained package pinned to a numpy from 2018 —
    which matters when the person installing this is a VJ on a Windows laptop
    rather than a researcher.

    Run without the DBN post-processor, so madmom is not a dependency at all.
    `on='cpu'` builds a second instance on the CPU, for when the GPU has
    faulted (see `gpu_fault`).
    """
    target = on or device()

    def build():
        require('beat_this', 'pip install -r requirements.txt')
        from beat_this.inference import Audio2Beats
        local = local_checkpoint('beat_this-final0.ckpt')
        if local:
            _log('loading beat_this from cache')
            return Audio2Beats(checkpoint_path=local, device=target, dbn=False)
        _log('downloading beat_this checkpoint (~80 MB, once)…')
        return Audio2Beats(device=target, dbn=False)
    return cached('beat_this' if target == device() else f'beat_this:{target}', build)


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
        model_dir, filename = bs_roformer_checkpoint()
        # The directory has to be known before the separator is built: it is
        # read once, at construction. A checkpoint given as a path used to
        # set it afterwards, and audio-separator looked for the file in the
        # default directory instead.
        model = Separator(output_dir=None, output_format='WAV',
                          model_file_dir=model_dir,
                          log_level=40, use_autocast=False)
        try:
            model.load_model(model_filename=filename)
        except ValueError as exc:
            raise RuntimeError(
                f'BS-RoFormer checkpoint is not registered by audio-separator: {filename}. '
                'Set ARTNET_BS_ROFORMER_MODEL to a supported audio-separator model name '
                'or leave ARTNET_USE_BS_ROFORMER disabled.') from exc
        return model
    return cached('bs-roformer-4stem', build)


def bs_roformer_checkpoint():
    """
    (directory, filename) of the BS-RoFormer checkpoint to load.

    ARTNET_BS_ROFORMER_MODEL is either a model name audio-separator knows,
    looked for in the model directory, or the path to a checkpoint anywhere.
    """
    model_dir = os.environ.get(
        'ARTNET_MODEL_DIR', os.path.expanduser('~/.cache/artnet-lightshow/models'))
    filename = os.environ.get('ARTNET_BS_ROFORMER_MODEL', '').strip()
    if not filename:
        return model_dir, 'BS-Roformer-SW.ckpt'
    if os.path.isfile(filename):
        return os.path.dirname(os.path.abspath(filename)), os.path.basename(filename)
    return model_dir, filename


def bs_roformer_enabled():
    """
    Is BS-RoFormer the configured separator? One reader, several callers.

    The server sets ARTNET_USE_BS_ROFORMER from the Separator setting
    field when it starts the worker. Unset — a one-shot run from the command
    line — it is Demucs, the same default as the settings.
    """
    return os.environ.get('ARTNET_USE_BS_ROFORMER', '0').lower() not in ('0', 'false', 'no', '')


def warm_up():
    """
    Load every model now rather than on the first track.

    The worker is spawned at server start precisely so this cost lands while
    the operator is still opening the UI, not while a track is waiting.

    Only the separator that is actually going to run is warmed. Loading both
    used to leave whichever one lost sitting on the card for the life of the
    process, which on an 8 GB card is memory the track being analysed needs.

    The beat model loads first: it is the one no track can do without, and a
    worker that runs out of room or time loading the rest still has it.
    Returns the names of the models that loaded.
    """
    chosen = bs_roformer_separator if bs_roformer_enabled() else separator
    loaded = []
    for name, load in (('beat_this', beat_tracker), (chosen.__name__, chosen)):
        try:
            load()
            loaded.append(name)
        except Exception as exc:
            _log(f'warm-up of {name} failed: {exc}')
    return loaded
