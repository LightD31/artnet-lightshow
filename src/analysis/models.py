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
reserved. See the note above it for why both halves matter. On a card too
small to hold every model at once, the weights live in RAM and go onto the
card for their pass only (`offloading()`), and a pass that still runs out of
memory is run again on the CPU (`run_pass()`).
"""

import contextlib
import os
import sys
import threading
import weakref

# Re-entrant: a model's build() calls device(), which locks too. A plain
# Lock deadlocks the first load, and a deadlock at load-in is a dead show.
_LOCK = threading.RLock()
_CACHE = {}
_DEVICE = None
_OFFLOAD = None


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
            _decide_offload(torch, chosen)
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


# ── Room on the card ────────────────────────────────────────────────────────
#
# An 8 GB card holds any one of these models with room for its pass, and not
# all of them at once. Resident, the separator, MuQ, MuQ-MuLan and SongFormer
# are several gigabytes of weights before a single track is read, and the
# pass that comes last finds the card full: CUDA out of memory, on some tracks
# and not others, depending on how long they are.
#
# So on a card that small the weights live in RAM and go onto the card for
# their own pass only. They stay in RAM — pinned, so the copy is a DMA at the
# bus's full speed rather than a page at a time — and nothing is read from
# disk again: a gigabyte crosses PCIe in a small fraction of a second, where
# loading it from its checkpoint took seconds. Weights do not change during
# inference, so after the pass the copy on the card is simply dropped for the
# one in RAM, and nothing is copied back.
#
# ARTNET_GPU_MEMORY chooses: 'offload' always, 'resident' never, 'auto' (the
# default) when the card has less than SMALL_CARD_GB. The analysis settings
# set it from GPU memory.

SMALL_CARD_GB = 12
_PARKED = weakref.WeakKeyDictionary()   # module -> its weights in RAM
_PINNED = [0]                           # bytes pinned so far
_PIN_WARNED = [False]


def _decide_offload(torch, chosen):
    """Keep models in RAM between passes on this card? Decided with the device."""
    global _OFFLOAD
    wanted = os.environ.get('ARTNET_GPU_MEMORY', 'auto').strip().lower() or 'auto'
    total = None
    try:
        index = torch.device(chosen).index or 0
        total = torch.cuda.get_device_properties(index).total_memory / 2 ** 30
    except Exception:  # pragma: no cover - a card torch cannot describe
        pass
    if wanted == 'offload':
        _OFFLOAD, why = True, 'ARTNET_GPU_MEMORY=offload'
    elif wanted == 'resident':
        _OFFLOAD, why = False, 'ARTNET_GPU_MEMORY=resident'
    else:
        if wanted != 'auto':
            _log(f'ARTNET_GPU_MEMORY={wanted!r} is not auto, offload or resident; using auto')
        _OFFLOAD = total is not None and total < SMALL_CARD_GB
        why = f'{total:.0f} GB card' if total is not None else 'card size unknown'
    _log(('models in RAM, on the card for their pass only' if _OFFLOAD
          else 'models stay on the card') + f' ({why})')
    return _OFFLOAD


def offloading():
    """Do models live in RAM between their passes? Only ever on a CUDA card."""
    if not on_gpu():
        return False
    if _OFFLOAD is None:
        try:
            import torch
            _decide_offload(torch, str(device()))
        except Exception:
            return False
    return bool(_OFFLOAD)


def home():
    """Where a model is built: in RAM when offloading, else on the device."""
    return 'cpu' if offloading() else device()


def _slots(module):
    """
    A module's weights: (owner, kind, name, tensor) for every parameter and
    buffer of every submodule. A weight two submodules share (tied weights)
    is listed under each; callers move it once.
    """
    import torch
    if not isinstance(module, torch.nn.Module):
        return []
    out = []
    for owner in module.modules():
        for name, tensor in owner._parameters.items():
            if tensor is not None:
                out.append((owner, 'parameter', name, tensor))
        for name, tensor in owner._buffers.items():
            if tensor is not None:
                out.append((owner, 'buffer', name, tensor))
    return out


def _put(owner, kind, name, tensor, value):
    """
    Point a weight at `value`, as `nn.Module.to` does: the same Parameter
    re-pointed where torch allows it (between RAM and a card), a new one
    where it does not.
    """
    if kind == 'buffer':
        owner._buffers[name] = value
        return
    try:
        tensor.data = value
    except RuntimeError:
        import torch
        owner._parameters[name] = torch.nn.Parameter(value, requires_grad=tensor.requires_grad)


def _ram_bytes():
    """The machine's RAM, or None."""
    try:
        return os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES')
    except (AttributeError, ValueError, OSError):
        pass
    try:
        import psutil
        return psutil.virtual_memory().total
    except Exception:
        pass
    if sys.platform == 'win32':
        try:
            import ctypes

            class Status(ctypes.Structure):
                _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong),
                            ('total', ctypes.c_ulonglong), ('available', ctypes.c_ulonglong),
                            ('page_total', ctypes.c_ulonglong), ('page_free', ctypes.c_ulonglong),
                            ('virtual_total', ctypes.c_ulonglong), ('virtual_free', ctypes.c_ulonglong),
                            ('extended', ctypes.c_ulonglong)]
            status = Status()
            status.length = ctypes.sizeof(Status)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return status.total
        except Exception:
            pass
    return None


def _pin_budget():
    """
    Bytes of weights to pin: a quarter of the machine's RAM, or ARTNET_PINNED_GB.

    Pinned memory cannot be paged out, so it is RAM the rest of the machine —
    the server, the browser, the DJ software — no longer has. Past the budget
    weights are kept in ordinary memory: the copy is slower, still no disk.
    """
    raw = os.environ.get('ARTNET_PINNED_GB', '').strip()
    if raw:
        try:
            return max(0.0, float(raw)) * 2 ** 30
        except ValueError:
            _log(f'ARTNET_PINNED_GB={raw!r} is not a number; using a quarter of the RAM')
    ram = _ram_bytes()
    return ram / 4 if ram else 8 * 2 ** 30


def _host_copy(tensor):
    """The tensor in RAM, pinned while the budget allows."""
    import torch
    value = tensor.detach()
    size = value.numel() * value.element_size()
    if on_gpu() and _PINNED[0] + size <= _pin_budget():
        try:
            host = torch.empty(value.shape, dtype=value.dtype, pin_memory=True)
            host.copy_(value)
            _PINNED[0] += size
            return host
        except Exception as exc:
            if not _PIN_WARNED[0]:
                _PIN_WARNED[0] = True
                _log(f'could not pin weights in RAM ({exc}); keeping them in ordinary memory')
    return value if value.device.type == 'cpu' else value.to('cpu')


def park(module):
    """
    Put a module's weights in RAM, and drop any copy of them on the card.

    The first time, a copy of each weight is made in RAM (pinned); every time
    after, the weights simply go back to that copy. Anything that is not a
    torch module is left as it is.
    """
    slots = _slots(module)
    if not slots:
        return
    with _LOCK:
        store = _PARKED.get(module)
        if store is None:
            store = {}
            _PARKED[module] = store
        made = {}
        for owner, kind, name, tensor in slots:
            key = (id(owner), kind, name)
            host = store.get(key)
            if host is None:
                host = made.get(id(tensor))
                if host is None:
                    host = made[id(tensor)] = _host_copy(tensor)
                store[key] = host
            _put(owner, kind, name, tensor, host)


def _forget_parked(module):
    """Drop a module's copy in RAM, and count its pinned bytes as free again."""
    store = _PARKED.pop(module, None) if module is not None else None
    for host in {id(host): host for host in (store or {}).values()}.values():
        try:
            if host.is_pinned():
                _PINNED[0] -= host.numel() * host.element_size()
        except Exception:  # pragma: no cover - a tensor torch cannot describe
            pass


def to_card(module, target):
    """Put a module's weights on `target` for a pass, from RAM where they are there."""
    slots = _slots(module)
    if not slots:
        return
    where = _as_device(target)
    moved = {}
    for owner, kind, name, tensor in slots:
        if tensor.device != where:
            value = moved.get(id(tensor))
            if value is None:
                value = moved[id(tensor)] = tensor.detach().to(where, non_blocking=True)
            _put(owner, kind, name, tensor, value)


def _as_device(target):
    import torch
    parsed = torch.device(target)
    if parsed.type == 'cuda' and parsed.index is None:
        return torch.device('cuda', torch.cuda.current_device())
    return parsed


def out_of_memory(exc, label='a model'):
    """
    Did this pass run the card out of memory? If so, make room and say so.

    The pass is then run again on the CPU by the caller. The first time it
    happens with the models kept on the card, they are kept in RAM between
    passes from then on: whatever is on the card next time is only what the
    pass in hand needs.
    """
    global _OFFLOAD
    torch = sys.modules.get('torch')
    kind = getattr(getattr(torch, 'cuda', None), 'OutOfMemoryError', None) if torch else None
    if not ((kind and isinstance(exc, kind)) or 'out of memory' in str(exc).lower()):
        return False
    release_memory()
    if on_gpu() and not _OFFLOAD:
        _OFFLOAD = True
        _log(f'{label} ran out of memory on the card: running it on the CPU, and keeping models in RAM '
             'between passes from now on (Analysis → GPU memory)')
    else:
        _log(f'{label} ran out of memory on the card: running it on the CPU')
    return True


def run_pass(label, run, modules=(), first=False):
    """
    One model's pass over one track: `run(device)`, with `modules` on that device.

    On the card when there is one, taking its turn (`inference`). On the CPU
    when the card has faulted (`gpu_fault`) or when the pass ran it out of
    memory — slower, but the track still gets its answer. Anything else the
    pass raises is raised.
    """
    target = device()
    if str(target) == 'cpu':
        return run('cpu')
    if not gpu_fault():
        try:
            with inference(label, first=first, modules=modules):
                return run(target)
        except Exception as exc:
            if not (gpu_fault(exc) or out_of_memory(exc, label)):
                raise
    for module in modules:
        park(module)
    return run('cpu')


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
    _forget_parked(model)
    _forget_parked(bs_roformer_module(model))
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
def inference(label='model', first=False, modules=()):
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

    *Bringing the weights.* `modules` go onto the card once the turn is ours,
    and back to RAM after it when models are kept there (`offloading`). A model
    run on the CPU after a fault comes back to the card the same way.

    On CPU this is a no-op wrapper: there is no single device to contend for,
    and the existing parallelism is what the CPU numbers in the docs measure.
    """
    if not on_gpu():
        yield
        return
    _TURNS.acquire(first=first)
    try:
        target = device()
        for module in modules:
            to_card(module, target)
        yield
    finally:
        try:
            if offloading():
                for module in modules:
                    park(module)
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
        if offloading():
            park(model)
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
        # audio-separator puts it on the card itself; kept in RAM, it leaves.
        if offloading():
            park(bs_roformer_module(model))
        return model
    return cached('bs-roformer-4stem', build)


def bs_roformer_module(separator_):
    """
    The torch model inside audio-separator's Separator, or None.

    audio-separator keeps it as `model_instance.model_run`. Where a version of
    it does not, the model simply stays where audio-separator put it.
    """
    return getattr(getattr(separator_, 'model_instance', None), 'model_run', None)


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
