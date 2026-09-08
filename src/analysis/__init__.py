"""
Audio understanding pipeline for the artnet-lightshow auto mode.

The package is deliberately split one stage per module so each can be read,
tested and replaced on its own:

    preprocess  raw file  -> normalised, filtered, source-separated audio
    features    audio     -> frame-level spectral / loudness features
    bands       features  -> seven perceptual bands + instrument roles
    rhythm      features  -> onsets, tempo, beats, bars, downbeats
    structure   features  -> self-similarity, sections, section roles
    dynamics    features  -> drops, build-ups, breaks, silences, spikes
    perception  audio     -> mood, danceability, genre, show style
    events      all       -> the musical event stream the show engine consumes
    pipeline    ---       -> wires the stages together (offline)
    realtime    ---       -> the same vocabulary from a live input stream

`pipeline.analyze()` returns one versioned analysis document; `events` is the
part the lighting side actually reads, everything else is context and debug.
"""

from .version import SCHEMA_VERSION  # noqa: F401

__all__ = ['SCHEMA_VERSION']
