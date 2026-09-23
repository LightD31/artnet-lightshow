"""
The live input service: the music as it plays, heard and read as it happens.

    python src/live_input.py --list
    python src/live_input.py --source loopback [--device NAME]
    python src/live_input.py --source input --device NAME
    python src/live_input.py --file track.wav [--realtime]

It captures audio — what the show PC itself is playing (WASAPI loopback on
Windows, the output's monitor on Linux) or a line-in off the booth — and feeds
it to `StreamingAnalyzer` one hop at a time: 256 samples at 22.05 kHz, 12 ms,
so a beat reaches the show within a hop and a half of the window rather than
a whole buffer later. Every hop it writes one JSON object to stdout, a line
each, and the Node server (src/live-input.ts) reads them:

    {"type": "ready", "backend": ..., "device": ..., "sampleRate": ..., "hop": ...}
    {"type": "state", "t": ..., "captured": ..., "beat": ..., "bpm": ..., ...}
    {"type": "event", "event": {... the offline event vocabulary ...}}
    {"type": "error", "message": ..., "fatal": true|false}
    {"type": "end"}                                   (a file ran out)

`captured` is the stream time of the newest sample read, which is the moment
the line is written: the reader maps it onto its own clock. `beat` is the
analyser's continuous beat position at stream time `t`.

Capture uses the `soundcard` package, which does loopback on Windows and Linux
alike; `sounddevice` is the fallback for a line-in when `soundcard` is not
installed. Neither is needed for a file, which is what the tests use.
"""

import argparse
import json
import sys
import time

import numpy as np

from .config import RealtimeConfig

SAMPLE_RATE = 22050
HOP = 256
N_FFT = 1024

# The analyser dates a frame by where its window starts, but an onset only
# tips the spectral flux once the window is about half over it, so its grid
# runs early by about half a window: 15–33 ms on the synthetic tracks at
# 100–174 BPM (tests/python/test_live.py), 23 ms by the arithmetic.
WINDOW_LAG_SEC = N_FFT / 2 / SAMPLE_RATE


def live_config():
    """The analyser's settings for the live service: a finer hop than offline."""
    return RealtimeConfig(sample_rate=SAMPLE_RATE, hop_length=HOP, n_fft=N_FFT)


class Emitter:
    """One JSON object per line, flushed at once: the reader is waiting on it."""

    def __init__(self, stream=None):
        self.stream = stream or sys.stdout

    def send(self, message):
        self.stream.write(json.dumps(message, separators=(',', ':')) + '\n')
        self.stream.flush()


def _round(value, digits=4):
    return None if value is None else round(float(value), digits)


class LiveService:
    """
    Blocks of audio in, lines out. Owns no device and no clock, so a test can
    push a synthetic track through it as fast as it likes.
    """

    def __init__(self, emitter, sample_rate=SAMPLE_RATE):
        from .realtime import StreamingAnalyzer
        self.emitter = emitter
        self.sample_rate = sample_rate
        self.analyzer = StreamingAnalyzer(live_config(), sample_rate=sample_rate)
        self.captured = 0

    def push(self, block):
        block = np.asarray(block, dtype=np.float32)
        if block.ndim > 1:
            block = block.mean(axis=1)
        self.captured += block.size
        before = self.analyzer._frame_index
        events = self.analyzer.push(block)
        for event in events:
            out = event.to_dict()
            out['t'] = round(out['t'] + WINDOW_LAG_SEC, 3)
            self.emitter.send({'type': 'event', 'event': out})
        if self.analyzer._frame_index != before:
            self.emitter.send(self.state())

    def state(self):
        a = self.analyzer
        s = a.state()
        beat = a.beat_position()
        flux, rms = a.last_frame()
        return {
            'type': 'state',
            't': round(s.t + WINDOW_LAG_SEC, 4),
            'captured': round(self.captured / float(self.sample_rate), 4),
            'beat': _round(beat),
            'bpm': s.bpm,
            'phase': _round(s.beat_phase),
            'locked': bool(s.locked),
            'energy': _round(s.energy, 5),
            'onset': _round(s.onset, 5),
            'flux': _round(flux, 5),
            'rms': _round(rms, 5),
            'tension': _round(s.tension, 3),
            'bands': {k: _round(v, 5) for k, v in s.bands.items()},
        }


# ── Sources ───────────────────────────────────────────────────────────────────

def _soundcard():
    try:
        import soundcard
        return soundcard
    except Exception:  # noqa: BLE001 — a missing or broken backend is just unavailable
        return None


def _sounddevice():
    try:
        import sounddevice
        return sounddevice
    except Exception:  # noqa: BLE001
        return None


def list_devices():
    sc = _soundcard()
    if sc is not None:
        return {
            'type': 'devices', 'backend': 'soundcard',
            'outputs': [s.name for s in sc.all_speakers()],
            'inputs': [m.name for m in sc.all_microphones(include_loopback=False)],
            'defaultOutput': _name(sc.default_speaker),
            'defaultInput': _name(sc.default_microphone),
        }
    sd = _sounddevice()
    if sd is not None:
        devices = sd.query_devices()
        return {
            'type': 'devices', 'backend': 'sounddevice',
            'outputs': [],
            'inputs': [d['name'] for d in devices if d.get('max_input_channels', 0) > 0],
            'defaultOutput': None,
            'defaultInput': None,
        }
    return {'type': 'devices', 'backend': None, 'outputs': [], 'inputs': [],
            'defaultOutput': None, 'defaultInput': None}


def _name(get):
    try:
        return get().name
    except Exception:  # noqa: BLE001 — no default device
        return None


def capture_soundcard(sc, source, device, service, emitter, stop):
    if source == 'loopback':
        speaker = sc.get_speaker(device) if device else sc.default_speaker()
        mic = sc.get_microphone(id=str(speaker.name), include_loopback=True)
        name = speaker.name
    else:
        mic = sc.get_microphone(device) if device else sc.default_microphone()
        name = mic.name
    # The backends resample to what is asked for: WASAPI shared mode and
    # PulseAudio both convert, so the analyser gets its own rate directly.
    with mic.recorder(samplerate=SAMPLE_RATE, blocksize=HOP) as recorder:
        emitter.send({'type': 'ready', 'backend': 'soundcard', 'source': source, 'device': name,
                      'sampleRate': SAMPLE_RATE, 'hop': HOP})
        while not stop():
            service.push(recorder.record(numframes=HOP))


def capture_sounddevice(sd, device, service, emitter, stop):
    import queue
    blocks = queue.Queue(maxsize=256)

    def callback(indata, _frames, _time, _status):
        try:
            blocks.put_nowait(indata.copy())
        except queue.Full:
            pass

    with sd.InputStream(samplerate=SAMPLE_RATE, blocksize=HOP, channels=1,
                        device=device or None, callback=callback) as stream:
        emitter.send({'type': 'ready', 'backend': 'sounddevice', 'source': 'input',
                      'device': str(device or stream.device), 'sampleRate': SAMPLE_RATE, 'hop': HOP})
        while not stop():
            service.push(blocks.get())


def play_file(path, service, emitter, realtime=False):
    import librosa
    samples, _sr = librosa.load(path, sr=SAMPLE_RATE, mono=True)
    emitter.send({'type': 'ready', 'backend': 'file', 'source': 'file', 'device': path,
                  'sampleRate': SAMPLE_RATE, 'hop': HOP})
    started = time.perf_counter()
    for i, start in enumerate(range(0, len(samples), HOP)):
        if realtime:
            due = started + (i + 1) * HOP / SAMPLE_RATE
            wait = due - time.perf_counter()
            if wait > 0:
                time.sleep(wait)
        service.push(samples[start:start + HOP])
    emitter.send({'type': 'end'})


def main(argv=None):
    parser = argparse.ArgumentParser(description='Live audio input for the light show.')
    parser.add_argument('--list', action='store_true', help='list the audio devices and exit')
    parser.add_argument('--source', choices=('loopback', 'input'), default='loopback')
    parser.add_argument('--device', default='', help='a device name, or part of one')
    parser.add_argument('--file', default='', help='read a file instead of a device')
    parser.add_argument('--realtime', action='store_true', help='play a file at its own speed')
    args = parser.parse_args(argv)
    emitter = Emitter()

    if args.list:
        emitter.send(list_devices())
        return 0

    service = LiveService(emitter)
    try:
        if args.file:
            play_file(args.file, service, emitter, realtime=args.realtime)
            return 0
        sc = _soundcard()
        if sc is not None:
            capture_soundcard(sc, args.source, args.device, service, emitter, lambda: False)
            return 0
        sd = _sounddevice()
        if sd is not None and args.source == 'input':
            capture_sounddevice(sd, args.device, service, emitter, lambda: False)
            return 0
        emitter.send({'type': 'error', 'fatal': True,
                      'message': 'no audio capture backend: pip install soundcard'
                      + ('' if args.source == 'loopback' else ' (or sounddevice)')})
        return 2
    except KeyboardInterrupt:
        return 0
    except BrokenPipeError:
        # The server went away; there is no one left to tell.
        return 0
    except Exception as err:  # noqa: BLE001 — reported to the server, which decides
        emitter.send({'type': 'error', 'fatal': True, 'message': f'{type(err).__name__}: {err}'})
        return 1


if __name__ == '__main__':
    sys.exit(main())
