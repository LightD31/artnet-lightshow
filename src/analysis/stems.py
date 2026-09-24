"""
Source separation, so the instrument roles are measured rather than inferred.

The old pipeline guessed. The kick was "the bass band, if its attack is short
enough"; the vocal was "mid-band harmonic energy, weighted by how much it
moves, because a held pad must not read as a singer". Those rules are the best
you can do from a spectrogram, and they are wrong often enough to matter — a
sustained synth bass reads as a kick, a bright pad reads as a voice.

Demucs answers the same questions directly: the kick is in the drums stem, the
voice is in the vocals stem. Everything downstream that used to reason about
bands and attack times now reasons about the stem that actually contains the
thing.

The separation is the single most expensive step in the pipeline — roughly a
third of real time on a laptop CPU, far less on a GPU — so it happens once and
every consumer reads the result.
"""

from dataclasses import dataclass, field
import os
import sys
import threading

import numpy as np

from . import models


@dataclass
class Stems:
    """Separated sources, resampled to the analysis rate and summed to mono."""

    drums: np.ndarray = field(default_factory=lambda: np.zeros(0))
    bass: np.ndarray = field(default_factory=lambda: np.zeros(0))
    vocals: np.ndarray = field(default_factory=lambda: np.zeros(0))
    other: np.ndarray = field(default_factory=lambda: np.zeros(0))
    sample_rate: int = 0
    backend: str = 'demucs'

    def named(self, name):
        return getattr(self, name, np.zeros(0))

    @property
    def names(self):
        return ('drums', 'bass', 'vocals', 'other')

    def energies(self):
        """RMS per stem, as a share of the total. A cheap description of the
        arrangement: what a track is *made of*."""
        levels = {}
        for name in self.names:
            signal = self.named(name)
            levels[name] = float(np.sqrt(np.mean(signal ** 2))) if signal.size else 0.0
        total = sum(levels.values())
        if total <= 1e-12:
            return {name: 0.0 for name in self.names}
        return {name: value / total for name, value in levels.items()}


def separate(mono, sample_rate, overlap=0.10, segment_seconds=None, stereo_loader=None):
    """
    Split `mono` into stems, returned at the same rate and length.

    `stereo_loader(rate)` returns the same span of the source as (2, n) at
    `rate`, or None. When it gives one, Demucs separates the real stereo at its
    own rate instead of the mono signal copied into two channels: it has the
    channel difference and the top octave to work with. Called only once the
    separator is loaded, so a track that never reaches Demucs never pays for
    the reload. The stems still come back at `sample_rate`, one per sample of
    `mono`.

    `overlap` trades quality for time. Demucs defaults to 0.25; 0.10 is roughly
    a fifth faster and the difference does not survive the downstream use, which
    is envelopes and onset times rather than anything anybody listens to.
    """
    import torch
    import librosa
    from demucs.apply import apply_model

    # BS-RoFormer when the settings ask for it (see
    # models.bs_roformer_enabled), with Demucs as the fallback if it cannot
    # load or run. Demucs is the default: BS-RoFormer takes about seven times
    # as long, which on an integrated GPU is longer than the track plays.
    if models.bs_roformer_enabled() and not models.gpu_fault():
        try:
            return separate_bs_roformer(mono, sample_rate, stereo_loader)
        except Exception as exc:
            models.gpu_fault(exc)
            print(f'[stems] BS-RoFormer unavailable; using Demucs: {exc}', file=sys.stderr)
            # Never hold both. The usual reason this path is taken is that the
            # card had no room for BS-RoFormer, and answering that by loading a
            # second separator alongside it is how one bad track turns into
            # every later track failing too. Dropping it also means the next
            # track retries BS-RoFormer from a clean card rather than being
            # quietly downgraded for the rest of the night.
            models.unload('bs-roformer-4stem')

    model = models.separator()
    device = 'cpu' if models.gpu_fault() else models.device()

    # Demucs wants stereo at its own rate. Given the real stereo at that rate it
    # gets it; otherwise the mono analysis signal goes up to its rate and is
    # copied into both channels. Either way the stems come back down.
    stereo = stereo_loader(model.samplerate) if stereo_loader else None
    if stereo is not None and np.ndim(stereo) == 2 and stereo.shape[0] == 2:
        pair = np.asarray(stereo, dtype=np.float32)
    else:
        resampled = librosa.resample(np.asarray(mono, dtype=np.float32),
                                     orig_sr=sample_rate, target_sr=model.samplerate)
        pair = np.vstack([resampled, resampled])
    tensor = torch.tensor(pair, dtype=torch.float32)[None]

    kwargs = dict(device=device, split=True, overlap=overlap, progress=False)
    if segment_seconds:
        kwargs['segment'] = segment_seconds
    try:
        with models.inference('demucs'), torch.no_grad():
            separated = apply_model(model, tensor, **kwargs)[0].cpu()
    except Exception as exc:
        # A GPU that faulted mid-track stays faulted; Demucs on the CPU is
        # slower but still an answer (see models.gpu_fault).
        if device == 'cpu' or not models.gpu_fault(exc):
            raise
        kwargs['device'] = 'cpu'
        with torch.no_grad():
            separated = apply_model(model, tensor, **kwargs)[0].cpu()

    out = {}
    for name, source in zip(model.sources, separated):
        signal = source.mean(dim=0).numpy()
        back = librosa.resample(signal, orig_sr=model.samplerate,
                                target_sr=sample_rate)
        # Length can drift by a sample or two through two resamples; the rest
        # of the pipeline indexes stems against the feature grid, so they have
        # to line up exactly.
        if back.size < mono.size:
            back = np.pad(back, (0, mono.size - back.size))
        out[name] = back[:mono.size].astype(np.float32)

    return Stems(sample_rate=sample_rate,
                 **{name: out.get(name, np.zeros(mono.size, dtype=np.float32))
                    for name in ('drums', 'bass', 'vocals', 'other')})


# The rate BS-RoFormer's checkpoints are trained at; audio-separator resamples
# anything else to it on load, so handing it the source at this rate costs no
# extra pass.
BS_ROFORMER_RATE = 44100

# One cached separator is shared by every caller, and each call points its
# output directory at its own temp folder and back. Two calls at once — a
# failed analysis leaves its separation thread running into the next track —
# interleave those swaps, and one call's stems land in the process's working
# directory where it never looks for them.
_BS_ROFORMER_LOCK = threading.Lock()

# What each separator output counts as. The default checkpoint,
# BS-Roformer-SW, has six stems; guitar and piano are what Demucs calls
# "other", and dropping them left "other" with only what was left over.
STEM_OF = {'drums': 'drums', 'bass': 'bass', 'vocals': 'vocals', 'other': 'other',
           'guitar': 'other', 'piano': 'other'}


def separate_bs_roformer(mono, sample_rate, stereo_loader=None):
    """
    Run the configured four-stem BS-RoFormer and normalise its outputs.

    Like Demucs, it is given the real stereo at its own rate when
    `stereo_loader` can supply it, and the mono analysis signal otherwise.
    """
    import os
    import sys
    import tempfile
    import soundfile as sf
    import librosa
    separator = models.bs_roformer_separator()
    with tempfile.TemporaryDirectory(prefix='artnet-bs-') as tmp:
        source = os.path.join(tmp, 'input.wav')
        stereo = stereo_loader(BS_ROFORMER_RATE) if stereo_loader else None
        if stereo is not None and np.ndim(stereo) == 2 and stereo.shape[0] == 2:
            sf.write(source, np.asarray(stereo, dtype=np.float32).T, BS_ROFORMER_RATE)
        else:
            sf.write(source, np.asarray(mono, dtype=np.float32), sample_rate)
        # audio-separator copies output_dir into the loaded model. Redirect
        # both: otherwise its WAVs land in the worker's current directory.
        with _BS_ROFORMER_LOCK:
            targets = [separator, separator.model_instance]
            previous_dirs = [target.output_dir for target in targets]
            try:
                for target in targets:
                    target.output_dir = tmp
                with models.inference('bs-roformer'):
                    paths = separator.separate(source)
            finally:
                for target, previous in zip(targets, previous_dirs):
                    target.output_dir = previous
        stems = {}
        for item in paths:
            label = os.path.basename(item).lower()
            source_name = next((n for n in STEM_OF if f'({n})' in label), None)
            if source_name:
                name = STEM_OF[source_name]
                output = item if os.path.isabs(item) else os.path.join(tmp, item)
                signal, sr = librosa.load(output, sr=sample_rate, mono=True)
                signal = np.pad(signal, (0, max(0, len(mono) - len(signal))))[:len(mono)]
                stems[name] = stems[name] + signal if name in stems else signal
    return Stems(sample_rate=sample_rate, backend='bs_roformer', **{
        name: stems.get(name, np.zeros(len(mono), dtype=np.float32))
        for name in ('drums', 'bass', 'vocals', 'other')})


def envelope(signal, features, smooth_sec=0.0):
    """
    A stem's level on the feature grid, normalised 0..1.

    Framed with the same hop as everything else so a stem envelope can be
    indexed by frame alongside the bands and the onset curve.
    """
    from . import dsp
    if signal.size == 0 or features.n_frames == 0:
        return np.zeros(features.n_frames)
    hop, n_fft = features.hop_length, features.n_fft
    frames = features.n_frames
    padded = np.pad(signal, (n_fft // 2, n_fft // 2))
    levels = np.empty(frames)
    for i in range(frames):
        start = i * hop
        window = padded[start:start + n_fft]
        levels[i] = np.sqrt(np.mean(window ** 2)) if window.size else 0.0
    if smooth_sec > 0:
        levels = dsp.moving_average(levels, max(1, int(smooth_sec * features.frame_rate)))
    return dsp.robust_norm(levels)
