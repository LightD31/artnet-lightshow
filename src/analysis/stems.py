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


def separate(mono, sample_rate, overlap=0.10, segment_seconds=None):
    """
    Split `mono` into stems, returned at the same rate and length.

    `overlap` trades quality for time. Demucs defaults to 0.25; 0.10 is roughly
    a fifth faster and the difference does not survive the downstream use, which
    is envelopes and onset times rather than anything anybody listens to.
    """
    import torch
    import librosa
    from demucs.apply import apply_model

    # BS-RoFormer is preferred for the lighting roles. Keep the existing
    # Demucs path as a measured fallback for installations without the optional
    # adapter or checkpoint.
    # The generic audio-separator registry cannot load every arbitrary
    # community checkpoint. Keep this opt-in until a compatible registry model
    # and config are explicitly supplied; this prevents a show from paying a
    # failed load attempt on every track.
    if models.bs_roformer_enabled():
        try:
            return separate_bs_roformer(mono, sample_rate)
        except Exception as exc:
            print(f'[stems] BS-RoFormer unavailable; using Demucs: {exc}', file=sys.stderr)
            # Never hold both. The usual reason this path is taken is that the
            # card had no room for BS-RoFormer, and answering that by loading a
            # second separator alongside it is how one bad track turns into
            # every later track failing too. Dropping it also means the next
            # track retries BS-RoFormer from a clean card rather than being
            # quietly downgraded for the rest of the night.
            models.unload('bs-roformer-4stem')

    model = models.separator()
    device = models.device()

    # Demucs wants stereo at its own rate. The analysis signal is mono at
    # 22.05 kHz, so it goes up and the stems come back down.
    resampled = librosa.resample(np.asarray(mono, dtype=np.float32),
                                 orig_sr=sample_rate, target_sr=model.samplerate)
    stereo = np.vstack([resampled, resampled])
    tensor = torch.tensor(stereo, dtype=torch.float32)[None]

    kwargs = dict(device=device, split=True, overlap=overlap, progress=False)
    if segment_seconds:
        kwargs['segment'] = segment_seconds
    with models.inference('demucs'), torch.no_grad():
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


def separate_bs_roformer(mono, sample_rate):
    """Run the configured four-stem BS-RoFormer and normalise its outputs."""
    import os
    import sys
    import tempfile
    import soundfile as sf
    import librosa
    separator = models.bs_roformer_separator()
    with tempfile.TemporaryDirectory(prefix='artnet-bs-') as tmp:
        source = os.path.join(tmp, 'input.wav')
        sf.write(source, np.asarray(mono, dtype=np.float32), sample_rate)
        # audio-separator copies output_dir into the loaded model. Redirect
        # both: otherwise its WAVs land in the worker's current directory.
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
            name = next((n for n in ('drums', 'bass', 'vocals', 'other') if n in label), None)
            if name:
                output = item if os.path.isabs(item) else os.path.join(tmp, item)
                signal, sr = librosa.load(output, sr=sample_rate, mono=True)
                stems[name] = np.pad(signal, (0, max(0, len(mono) - len(signal))))[:len(mono)]
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
