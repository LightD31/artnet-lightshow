"""
Live mode — the same event vocabulary, from a stream, with no future.

Every offline stage above is allowed to look at the whole track: the tempo is
whatever best explains four minutes of onsets, a drop is a rise that *held* for
four seconds, a chorus is a section that comes back. None of that is available
here. So the live analyser is not a port of the offline one; it is a different
implementation of the same interface, and the differences are all consequences
of that one fact:

* Thresholds are adaptive rather than global. There is no track-wide percentile
  to normalise against, so everything is measured against a rolling window —
  median plus a multiple of the median absolute deviation, which is robust to
  the outliers a fixed standard deviation is not.

* The beat grid is *predicted*, not tracked. An oscillator runs at the current
  tempo estimate, and twice a second its phase is re-fitted to the last few
  seconds of onsets — the phase that lines the most onset strength up on a
  grid of that tempo — and moved part of the way there. This is what keeps the
  show on the beat through a bar where the kick drops out. Nudging it from
  each onset instead, as it once was, let every hat and snare push the
  predicted beat a little later, and at a fine hop the beat ran away from the
  music entirely.

* Drops are called on the rise, not on the sustain. Waiting four seconds to
  confirm a drop is correct offline and useless live. Confidence is reported
  lower to match, and the show engine spends a smaller gesture on it.

Latency is one hop — 23 ms at the default settings — plus whatever the caller's
own buffering adds.
"""

from collections import deque
from dataclasses import dataclass, field

import numpy as np

from . import dsp
from .config import RealtimeConfig, BANDS, BAND_ORDER
from .events import (Event, BEAT, BAR, DROP, BUILDUP, ENERGY_SPIKE, BASS_HIT,
                     SILENCE, TRANSITION)


def _fold_octave(bpm, reference, tolerance=0.10):
    """
    Move `bpm` by whole octaves until it lands on `reference`.

    Only when it actually lands there. A reading that folds to within
    `tolerance` of the running tempo is the same music counted at a different
    metrical level — the estimator legitimately reports half tempo when the kick
    drops out for a breakdown, and averaging 174 with 87 gives 130, a tempo the
    track has never played. A reading that does not fold onto the reference is
    describing different music, not a different octave of it, and must be
    followed: a DJ mixing 174 into 100 is a real tempo change.
    """
    if reference <= 0 or bpm <= 0:
        return bpm
    best = bpm
    for factor in (0.25, 0.5, 1.0, 2.0, 4.0):
        candidate = bpm * factor
        if abs(np.log2(candidate / reference)) < abs(np.log2(best / reference)):
            best = candidate
    if abs(best - reference) / reference <= tolerance:
        return best
    return bpm


@dataclass
class LiveState:
    """A snapshot the show engine can poll between events."""
    t: float = 0.0
    bpm: float = 0.0
    beat_phase: float = 0.0
    bar_position: int = 0
    energy: float = 0.0
    onset: float = 0.0
    tension: float = 0.0
    bands: dict = field(default_factory=dict)
    locked: bool = False


class StreamingAnalyzer:
    """
    Feed it audio with `push()`, get musical events back.

    The caller owns the audio device and the clock; this class owns no threads
    and does no I/O, which is what makes it testable — the tests drive it with
    a synthetic buffer and assert on the events, at no real-time cost.
    """

    def __init__(self, config: RealtimeConfig = None, sample_rate=None):
        self.config = config or RealtimeConfig()
        self.sample_rate = int(sample_rate or self.config.sample_rate)
        self.hop = self.config.hop_length
        self.n_fft = self.config.n_fft

        history_frames = max(8, int(self.config.history_sec
                                    * self.sample_rate / self.hop))
        self._buffer = np.zeros(0, dtype=np.float32)
        self._window = np.hanning(self.n_fft).astype(np.float32)
        self._previous_spectrum = None
        self._onset_history = deque(maxlen=history_frames)
        self._energy_history = deque(maxlen=history_frames)
        self._band_history = {name: deque(maxlen=history_frames) for name in BAND_ORDER}

        self._frame_index = 0
        self._frames_since_tempo = 0
        self._frames_since_phase = 0
        self._bpm = 0.0
        self._period_frames = 0.0
        self._next_beat_frame = None
        self._beat_count = 0
        self._locked = False
        self._last_onset_frame = -10 ** 9
        self._last_event = {}
        self._silence_since = None
        self._in_silence = False
        self._rise_history = deque(maxlen=history_frames)
        self._section_energy = None

        freqs = np.fft.rfftfreq(self.n_fft, 1.0 / self.sample_rate)
        self._band_masks = {
            name: (freqs >= low) & (freqs < min(high, self.sample_rate / 2.0))
            for name, (low, high) in BANDS.items()
        }

    # ── Public API ──────────────────────────────────────────────────────────

    @property
    def time(self):
        return self._frame_index * self.hop / float(self.sample_rate)

    def state(self) -> LiveState:
        return LiveState(
            t=self.time,
            bpm=round(self._bpm, 2),
            beat_phase=self._phase(),
            bar_position=self._beat_count % 4,
            energy=self._recent(self._energy_history),
            onset=self._recent(self._onset_history),
            tension=self._tension(),
            bands={name: self._recent(hist) for name, hist in self._band_history.items()},
            locked=self._locked,
        )

    def beat_position(self):
        """
        Beats counted by the grid, continuously: 3.25 is a quarter of the way
        into the fourth beat. None until there is a grid. It jumps only when the
        grid is re-found after losing lock.
        """
        if self._next_beat_frame is None or self._period_frames <= 0:
            return None
        # Not through _phase(), whose wrap reads a beat that is a frame overdue
        # (it fires on the next frame) as one just begun: a whole beat back.
        return self._beat_count - (self._next_beat_frame - self._frame_index) / self._period_frames

    def last_frame(self):
        """The newest frame's spectral flux and RMS level, unsmoothed."""
        flux = self._onset_history[-1] if self._onset_history else 0.0
        rms = self._energy_history[-1] if self._energy_history else 0.0
        return float(flux), float(rms)

    def push(self, samples):
        """
        Consume audio and return the events it produced, oldest first.

        Any block size is fine; whole hops are processed and the remainder is
        kept for the next call.
        """
        samples = np.asarray(samples, dtype=np.float32).ravel()
        if samples.size:
            self._buffer = np.concatenate([self._buffer, samples])

        events = []
        while self._buffer.size >= self.n_fft:
            frame = self._buffer[:self.n_fft]
            self._buffer = self._buffer[self.hop:]
            events.extend(self._process(frame))
            self._frame_index += 1
        return events

    def reset(self):
        self.__init__(self.config, self.sample_rate)

    # ── Per-frame processing ────────────────────────────────────────────────

    def _process(self, frame):
        spectrum = np.abs(np.fft.rfft(frame * self._window))
        events = []

        energy = float(np.sqrt(np.mean(frame ** 2)))
        self._energy_history.append(energy)

        band_levels = {}
        for name, mask in self._band_masks.items():
            level = float(np.sqrt(np.mean(spectrum[mask] ** 2))) if np.any(mask) else 0.0
            band_levels[name] = level
            self._band_history[name].append(level)

        # Half-wave rectified spectral flux — the same onset function as
        # offline, which is what keeps the two modes' timing comparable.
        if self._previous_spectrum is None:
            flux = 0.0
        else:
            flux = float(np.sum(np.maximum(spectrum - self._previous_spectrum, 0.0)))
        self._previous_spectrum = spectrum
        self._onset_history.append(flux)

        events.extend(self._silence_events(energy))
        onset = self._detect_onset(flux)
        if onset:
            events.extend(self._on_onset(band_levels))

        self._frames_since_tempo += 1
        if self._frames_since_tempo * self.hop / self.sample_rate >= self.config.tempo_refresh_sec:
            self._frames_since_tempo = 0
            self._estimate_tempo()
        self._frames_since_phase += 1
        if self._frames_since_phase * self.hop / self.sample_rate >= self.config.phase_refresh_sec:
            self._frames_since_phase = 0
            self._refit_phase()

        events.extend(self._beat_events())
        events.extend(self._dynamics_events(energy))
        return events

    # ── Adaptive onset detection ────────────────────────────────────────────

    def _detect_onset(self, flux):
        """
        Median + k × MAD over the rolling window.

        The median absolute deviation rather than the standard deviation
        because the window contains the very peaks being detected: a standard
        deviation is inflated by them, so the threshold rises after every hit
        and the detector goes deaf exactly when the music gets busy.
        """
        if len(self._onset_history) < 8:
            return False
        window = np.fromiter(self._onset_history, dtype=float)
        median = float(np.median(window))
        mad = float(np.median(np.abs(window - median))) or 1e-9
        threshold = median + self.config.onset_k * mad * 1.4826
        if flux <= threshold:
            return False
        min_gap = max(1, int(0.04 * self.sample_rate / self.hop))
        if self._frame_index - self._last_onset_frame < min_gap:
            return False
        self._last_onset_frame = self._frame_index
        return True

    def _on_onset(self, band_levels):
        events = []
        low = band_levels.get('bass', 0.0) + band_levels.get('sub', 0.0)
        baseline = (self._recent(self._band_history['bass'], 1.0)
                    + self._recent(self._band_history['sub'], 1.0))
        if baseline > 1e-9 and low > baseline * 1.6:
            events.append(Event(t=self.time, type=BASS_HIT, confidence=0.6,
                                intensity=dsp.clamp01(low / (baseline * 3.0)),
                                effect='pulse', data={'live': True}))
        return events

    # ── Tempo and phase ─────────────────────────────────────────────────────

    def _estimate_tempo(self):
        """
        Re-estimate tempo from the rolling onset history.

        The offline pipeline puts a beat-tracking transformer over the whole
        file. Live there is no whole file and no room for its latency, so this
        is the signal chain: autocorrelation over the last ten seconds of onset
        history, weighted by the tempo prior. It has to get the pulse right
        within a window the track is not changing much over, which is a far
        easier problem than deciding a record's tempo from scratch — and the
        octave folding below covers the one failure it still makes.
        """
        if len(self._onset_history) < 48:
            return
        from .rhythm import estimate_tempo
        from .config import RhythmConfig

        window = np.fromiter(self._onset_history, dtype=float)
        bpm, confidence = estimate_tempo(
            window, self.sample_rate, self.hop,
            RhythmConfig(tempo_min=60.0, tempo_max=190.0))
        if bpm <= 0 or confidence <= 0.05:
            return

        frame_rate = self.sample_rate / float(self.hop)
        # Fold octave flips onto the running tempo before smoothing. When the
        # kick drops out for a breakdown the estimator legitimately reports half
        # tempo, and averaging 174 with 87 lands on 130 — a tempo the track has
        # never played. Folding keeps the grid where it was and lets the level
        # change do the talking.
        bpm = _fold_octave(bpm, self._bpm)
        # Smooth towards the new estimate rather than jumping. A live tempo
        # that snaps between 128 and 64 makes the rig stutter; one that eases
        # is wrong for a second and then right.
        self._bpm = bpm if self._bpm <= 0 else 0.7 * self._bpm + 0.3 * bpm
        self._period_frames = 60.0 * frame_rate / max(1e-6, self._bpm)
        was_locked = self._locked
        self._locked = confidence > 0.25

        # Phase has to be *found*, not assumed. Starting the oscillator a beat
        # from now puts it on a random phase, and the pull from onsets can only
        # correct a third of a beat — so a grid that starts an eighth out never
        # converges. Searching the recent onset history for the phase that best
        # explains it costs one pass and lands the grid immediately.
        if self._next_beat_frame is None or not was_locked:
            self._align_phase(window)

    def _fit_next_beat(self, window):
        """
        The next beat frame that the onsets in `window` (the newest last) fit
        best: the phase, in half-frame steps, whose grid at the current period
        collects the most onset strength. None without two beats of history.
        """
        period = self._period_frames
        if period <= 1 or window.size < period * 2:
            return None
        count = int((window.size - 1) // period) + 1
        best_phase, best_score = 0.0, -1.0
        steps = np.arange(count) * period
        for phase in np.arange(0.0, period, 0.5):
            idx = np.round(phase + steps).astype(int)
            idx = idx[idx < window.size]
            if idx.size < 2:
                continue
            value = float(np.mean(window[idx]))
            if value > best_score:
                best_phase, best_score = phase, value
        # Absolute frame of the last predicted beat inside the window.
        last_in_window = best_phase + period * int((window.size - 1 - best_phase) // period)
        offset = (window.size - 1) - last_in_window
        return self._frame_index - offset + period

    def _align_phase(self, window):
        """Set the oscillator's phase to whichever one the recent onsets fit."""
        target = self._fit_next_beat(window)
        if target is not None:
            self._next_beat_frame = target

    def _refit_phase(self):
        """
        Move the running grid part of the way to the phase the last few
        seconds of onsets fit.

        A window of several beats outvotes a syncopated hit or a missing kick,
        which a correction from each onset could not: every hat and snare
        pushed that grid a little, and the pushes added up to a beat that never
        came.
        """
        if self._next_beat_frame is None or self._period_frames <= 0 or not self._locked:
            return
        frames = int(self.config.phase_window_sec * self.sample_rate / self.hop)
        window = np.fromiter(self._onset_history, dtype=float)[-frames:]
        target = self._fit_next_beat(window)
        if target is None:
            return
        period = self._period_frames
        # Wrap into ±half a beat: a whole beat either way is the same grid.
        error = (target - self._next_beat_frame + period / 2.0) % period - period / 2.0
        self._next_beat_frame += error * self.config.phase_lock_strength

        # Frequency term: errors that keep pointing the same way mean the
        # *period* is wrong, not the phase. Clamped so a run of syncopation
        # cannot walk the tempo away.
        self._period_frames += error * self.config.frequency_lock_strength
        if self._bpm > 0:
            frame_rate = self.sample_rate / float(self.hop)
            nominal = 60.0 * frame_rate / self._bpm
            self._period_frames = float(np.clip(self._period_frames,
                                                nominal * 0.94, nominal * 1.06))

    def _phase(self):
        if self._next_beat_frame is None or self._period_frames <= 0:
            return 0.0
        remaining = (self._next_beat_frame - self._frame_index) % self._period_frames
        return float(1.0 - remaining / self._period_frames)

    def _beat_events(self):
        if self._next_beat_frame is None or self._period_frames <= 0:
            return []
        events = []
        while self._frame_index >= self._next_beat_frame:
            confidence = 0.75 if self._locked else 0.4
            in_bar = self._beat_count % 4
            baseline = self._recent(self._onset_history, 2.0)
            immediate = self._recent(self._onset_history, 0.1)
            intensity = dsp.clamp01(immediate / (baseline * 2.0)) if baseline > 1e-9 else 0.5
            events.append(Event(
                t=self.time, type=BEAT, confidence=confidence,
                intensity=intensity,
                effect='pulse' if in_bar == 0 else 'accent',
                data={'inBar': in_bar, 'live': True}))
            if in_bar == 0:
                events.append(Event(
                    t=self.time, type=BAR, confidence=confidence * 0.7,
                    intensity=0.5, effect='pulse',
                    data={'index': self._beat_count // 4, 'live': True}))
            self._beat_count += 1
            self._next_beat_frame += self._period_frames
        return events

    # ── Dynamics ────────────────────────────────────────────────────────────

    def _dynamics_events(self, energy):
        """
        Spikes, build-ups and drops, called from the rise alone.

        Offline these are confirmed by what follows. Live there is no what
        follows, so each is reported with a lower confidence and the show engine
        is expected to spend a proportionally smaller gesture on it.
        """
        if len(self._energy_history) < 16:
            return []
        window = np.fromiter(self._energy_history, dtype=float)
        median = float(np.median(window))
        mad = float(np.median(np.abs(window - median))) or 1e-9
        deviation = (energy - median) / (mad * 1.4826)
        self._rise_history.append(deviation)

        events = []
        recent = np.fromiter(self._rise_history, dtype=float)
        half = max(4, recent.size // 3)

        if deviation > 3.0 and self._cooldown('spike', 1.2):
            events.append(Event(t=self.time, type=ENERGY_SPIKE, confidence=0.5,
                                intensity=dsp.clamp01(deviation / 6.0),
                                effect='flash', data={'live': True}))

        if recent.size >= half * 2:
            before = float(np.mean(recent[-half * 2:-half]))
            after = float(np.mean(recent[-half:]))
            if after - before > 2.5 and self._cooldown('drop', 8.0):
                events.append(Event(
                    t=self.time, type=DROP, confidence=0.45,
                    intensity=dsp.clamp01((after - before) / 5.0),
                    effect='flash', data={'live': True, 'unconfirmed': True}))
            elif 0.6 < after - before <= 2.5 and self._trending_up(recent) \
                    and self._cooldown('buildup', 6.0):
                events.append(Event(
                    t=self.time, type=BUILDUP, confidence=0.4,
                    intensity=dsp.clamp01((after - before) / 2.5),
                    duration=self.config.tempo_refresh_sec, effect='ramp',
                    data={'live': True}))

        # A sustained shift in level is the live stand-in for a section change.
        long_term = float(np.mean(window))
        if self._section_energy is None:
            self._section_energy = long_term
        elif abs(long_term - self._section_energy) > max(1e-6, self._section_energy) * 0.55 \
                and self._cooldown('transition', 10.0):
            rising = long_term > self._section_energy
            self._section_energy = long_term
            events.append(Event(
                t=self.time, type=TRANSITION, confidence=0.4,
                intensity=dsp.clamp01(long_term / max(1e-9, median * 3.0)),
                effect='scene-change',
                data={'live': True, 'to': 'high' if rising else 'low'}))
        else:
            self._section_energy = 0.9 * self._section_energy + 0.1 * long_term
        return events

    def _silence_events(self, energy):
        window = np.fromiter(self._energy_history, dtype=float)
        reference = float(np.percentile(window, 90)) if window.size > 8 else 0.0
        quiet = reference > 1e-6 and energy < reference * 0.05
        events = []
        if quiet and not self._in_silence:
            if self._silence_since is None:
                self._silence_since = self.time
            elif self.time - self._silence_since >= 0.4:
                self._in_silence = True
                events.append(Event(t=self._silence_since, type=SILENCE,
                                    confidence=0.8, intensity=0.0,
                                    duration=self.time - self._silence_since,
                                    effect='blackout', data={'live': True}))
        elif not quiet:
            self._silence_since = None
            self._in_silence = False
        return events

    # ── Helpers ─────────────────────────────────────────────────────────────

    def _cooldown(self, key, seconds):
        now = self.time
        if now - self._last_event.get(key, -1e9) < seconds:
            return False
        self._last_event[key] = now
        return True

    def _trending_up(self, values):
        if values.size < 4:
            return False
        ramp = np.arange(values.size, dtype=float)
        if float(np.std(values)) < 1e-9:
            return False
        return float(np.corrcoef(ramp, values)[0, 1]) > 0.5

    def _recent(self, history, seconds=0.25):
        """Mean of the last `seconds` of a history deque."""
        if not history:
            return 0.0
        count = max(1, int(seconds * self.sample_rate / self.hop))
        values = list(history)[-count:]
        return float(np.mean(values))

    def _tension(self):
        highs = self._recent(self._band_history['high']) + \
            self._recent(self._band_history['presence'])
        lows = self._recent(self._band_history['bass']) + \
            self._recent(self._band_history['sub'])
        total = highs + lows
        return dsp.clamp01(highs / total) if total > 1e-9 else 0.0
