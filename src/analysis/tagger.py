"""
Optional AudioSet tagging with PANNs (Cnn14, 527 classes).

This is the pipeline's only learned component. Everything else is signal
processing with explicit rules; this is the part that answers questions DSP
cannot — "is this electronic dance music", "is someone singing", "is that a
distorted guitar" — because those are cultural categories, not spectral ones.

The model is a fixed pretrained checkpoint run on CPU, not something the show
trains or fine-tunes: it costs a few seconds per track alongside the rest of
the analysis, and every consumer of its output treats a missing answer as
"unknown" rather than as an error. A rig without torch installed still runs a
complete show; it just makes its genre decisions from tempo and brightness.

The file bootstrapping below looks defensive because it is. `panns_inference`
downloads its own data files with `wget` at *import* time and then reads the
labels CSV unconditionally — so on a machine without wget the import prints a
shell error and raises. Everything here therefore makes sure the files exist
*before* the import, since there is no "after".
"""

import os
import sys

_MODEL = None  # cached AudioTagging instance; the checkpoint load is seconds

_DIR = os.path.join(os.path.expanduser('~'), 'panns_data')
_CHECKPOINT = os.path.join(_DIR, 'Cnn14_mAP=0.431.pth')
_LABELS = os.path.join(_DIR, 'class_labels_indices.csv')
_SETUP = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    'scripts', 'setup-panns.py')
_MIN_CHECKPOINT_BYTES = int(3e8)

SAMPLE_RATE = 32000
CHUNK_SECONDS = 10  # the clip length the model was trained on


def _log(message):
    print(f'[tagger] {message}', file=sys.stderr)


def installed():
    """Is `panns_inference` importable — asked without importing it.

    `find_spec` locates the package without executing its `__init__`, which is
    the only safe way to ask: importing is what triggers the download attempt
    this module exists to get ahead of.
    """
    import importlib.util
    try:
        return importlib.util.find_spec('panns_inference') is not None
    except Exception:
        return False


def checkpoint_present():
    return (os.path.isfile(_CHECKPOINT)
            and os.path.getsize(_CHECKPOINT) >= _MIN_CHECKPOINT_BYTES)


def _run_setup(extra_args, note):
    """
    Fetch the data files through `scripts/setup-panns.py` (urllib with verified
    digests) rather than leaving it to the package's `wget`.

    The exit code is deliberately not the verdict: the script exits 2 for
    "files are in place but torch is missing", which is a fine outcome here —
    only the files were wanted. Callers decide by looking at the filesystem.
    """
    if not os.path.isfile(_SETUP):
        return
    _log(note)
    import subprocess
    try:
        subprocess.run([sys.executable, _SETUP, *extra_args], check=False,
                       stdout=sys.stderr, stderr=sys.stderr)
    except Exception as exc:
        _log(f'could not run setup-panns.py: {exc}')


def ensure_labels():
    """The ~15 KB labels CSV, without which `import panns_inference` raises."""
    if os.path.isfile(_LABELS):
        return True
    _run_setup(['--labels-only'], 'fetching the AudioSet labels CSV (~15 KB)')
    return os.path.isfile(_LABELS)


def ensure_files():
    """Labels CSV plus the ~310 MB checkpoint."""
    if os.path.isfile(_LABELS) and checkpoint_present():
        return True
    _run_setup([], 'model files missing — running setup-panns.py (one-time ~310 MB download)')
    return os.path.isfile(_LABELS) and checkpoint_present()


def preload():
    """
    Build the model during server start-up so the first track does not pay the
    load cost. Silently skipped when anything is missing — a start-up hook is
    the wrong moment for a 310 MB download.
    """
    global _MODEL
    if _MODEL is not None or not installed() or not checkpoint_present():
        return
    if not ensure_labels():
        return
    try:
        import contextlib
        from panns_inference import AudioTagging
        with contextlib.redirect_stdout(sys.stderr):
            _MODEL = AudioTagging(checkpoint_path=_CHECKPOINT, device='cpu')
    except Exception as exc:
        _log(f'preload skipped: {exc}')


def tag(samples=None, sample_rate=None, path=None):
    """
    Return `{label: probability}` over the 527 AudioSet classes, or None.

    Accepts either an already-loaded waveform (the pipeline has one) or a file
    path (the CLI may not). Predictions are averaged over ten-second chunks,
    matching the clip length the model was trained on.
    """
    global _MODEL
    try:
        import warnings
        warnings.filterwarnings('ignore')
        import numpy as np
    except Exception as exc:
        _log(f'skipped: {exc}')
        return None

    if not installed():
        _log('skipped: panns_inference is not installed')
        return None
    if not ensure_files():
        _log('model files still missing after setup — skipping')
        return None

    try:
        from panns_inference import AudioTagging, labels
    except Exception as exc:
        _log(f'skipped: {exc}')
        return None

    if _MODEL is None:
        import contextlib
        with contextlib.redirect_stdout(sys.stderr):
            _MODEL = AudioTagging(checkpoint_path=_CHECKPOINT, device='cpu')

    if samples is None or sample_rate != SAMPLE_RATE:
        try:
            import librosa
            source = path if samples is None else samples
            if samples is None:
                samples, _ = librosa.load(path, sr=SAMPLE_RATE, mono=True)
            else:
                samples = librosa.resample(np.asarray(samples, dtype=np.float32),
                                           orig_sr=sample_rate, target_sr=SAMPLE_RATE)
        except Exception as exc:
            _log(f'could not prepare audio: {exc}')
            return None

    samples = np.asarray(samples, dtype=np.float32)
    chunk = SAMPLE_RATE * CHUNK_SECONDS
    total = None
    used = 0
    for start in range(0, max(1, len(samples)), chunk):
        piece = samples[start:start + chunk]
        if len(piece) < SAMPLE_RATE:
            continue
        clipwise, _embedding = _MODEL.inference(piece[np.newaxis, :])
        probs = clipwise[0]
        total = probs if total is None else total + probs
        used += 1
    if total is None or used == 0:
        return None

    mean = total / used
    return {label.lower(): float(p) for label, p in zip(labels, mean)}
