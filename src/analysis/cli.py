"""
Command line and worker entry points.

Three ways in:

    python src/analyze.py <file|url> [--target-duration S] [--report out.html]
        One-shot analysis to stdout as JSON, optionally also writing a debug
        report next to it.

    python src/analyze.py --worker
        Persistent NDJSON worker. One request per line on stdin, one response
        per line on stdout. This is how the Node server drives it, and it
        exists so the multi-second cost of importing librosa and loading the
        tagger is paid once per server rather than once per track.

    python src/analyze.py --live [--rate 22050]
        Reads raw 32-bit float mono PCM from stdin and writes musical events to
        stdout as NDJSON, as they happen.

stdout is reserved for machine-readable output in every mode. Everything human
goes to stderr — a stray print on stdout corrupts the protocol, which is why
the tagger's own progress chatter is redirected at its source.
"""

import json
import os
import sys
import tempfile

from .config import DEFAULT
from . import model_adapters, pipeline, tagger


def _log(message):
    print(f'[analyze] {message}', file=sys.stderr, flush=True)


# ── Sources ─────────────────────────────────────────────────────────────────

def download(url):
    """Fetch a remote file to a temp path. Returns the path."""
    import urllib.request
    suffix = '.mp3' if '.mp3' in url else '.ogg'
    handle, path = tempfile.mkstemp(suffix=suffix)
    os.close(handle)
    urllib.request.urlretrieve(url, path)
    return path


def resolve(source):
    """Return (path, should_delete)."""
    if source.startswith('http://') or source.startswith('https://'):
        return download(source), True
    return source, False


# ── Worker ──────────────────────────────────────────────────────────────────

def watch_parent():
    """
    Exit when the parent process goes away.

    stdin EOF is the normal shutdown path; this is the safety net for the case
    where the server is SIGKILLed or the terminal is closed, which would
    otherwise leave a worker holding a PyTorch model resident forever.
    """
    import threading
    import time

    parent = os.getppid()

    def watcher():
        if os.name == 'nt':
            import ctypes
            kernel32 = ctypes.windll.kernel32
            SYNCHRONIZE = 0x00100000
            WAIT_TIMEOUT = 258
            handle = kernel32.OpenProcess(SYNCHRONIZE, False, parent)
            if not handle:
                os._exit(0)
            try:
                while kernel32.WaitForSingleObject(handle, 2000) == WAIT_TIMEOUT:
                    pass
            finally:
                kernel32.CloseHandle(handle)
        else:
            while True:
                try:
                    os.kill(parent, 0)
                except (ProcessLookupError, PermissionError):
                    break
                time.sleep(2)
        os._exit(0)

    threading.Thread(target=watcher, daemon=True).start()


def worker_loop():
    """
    Persistent NDJSON worker.

    Request:  {"id": <any>, "source": "<path>", "targetDurationSec": <num|null>}
    Response: {"id": <same>, "result": {...}} or {"id": <same>, "error": "..."}

    One request at a time, in order. The analysis already saturates the CPU
    across BLAS and the thread pools inside it, so serving two at once would
    make both slower and neither would finish first.
    """
    watch_parent()
    _warm_up()
    print('[analyzer] worker ready', file=sys.stderr, flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get('id')
            source = request.get('source')
            target = request.get('targetDurationSec')
            if not source:
                response = {'id': request_id, 'error': 'missing source'}
            elif not os.path.isfile(source):
                response = {'id': request_id, 'error': f'File not found: {source}'}
            else:
                response = {'id': request_id,
                            'result': pipeline.analyze(source, target)}
        except Exception as exc:
            import traceback
            traceback.print_exc(file=sys.stderr)
            response = {'id': request_id, 'error': str(exc)}
        sys.stdout.write(json.dumps(response) + '\n')
        sys.stdout.flush()


def _warm_up():
    """
    Pay the import and model-load costs before the first request arrives.

    librosa and numba in particular JIT on first use; without this the first
    track of the night is several seconds slower than every one after it, and
    that is exactly the track someone is standing there waiting for.
    """
    try:
        import numpy as np
        import librosa
        silence = np.zeros(4096, dtype=np.float32)
        librosa.stft(silence, n_fft=1024, hop_length=256)
        librosa.onset.onset_strength(y=silence, sr=22050)
    except Exception as exc:
        _log(f'warm-up skipped: {exc}')
    if DEFAULT.enable_semantics:
        try:
            model_adapters.preload()
        except Exception as exc:
            _log(f'MuQ preload skipped: {exc}')
    if DEFAULT.enable_tagger:
        try:
            tagger.preload()
        except Exception as exc:
            _log(f'tagger preload skipped: {exc}')


# ── Live ────────────────────────────────────────────────────────────────────

def live_loop(rate, block=4096):
    """
    Stream raw float32 mono PCM in on stdin, musical events out on stdout.

    The format is deliberately the dumbest one that works: the caller already
    has the samples as floats, and asking it to encode a container just so this
    process can decode it again would add latency to the one mode where latency
    is the whole point.
    """
    import numpy as np
    from .realtime import StreamingAnalyzer

    analyzer = StreamingAnalyzer(DEFAULT.realtime, sample_rate=rate)
    stream = sys.stdin.buffer
    print(f'[analyzer] live mode at {rate} Hz', file=sys.stderr, flush=True)

    while True:
        raw = stream.read(block * 4)
        if not raw:
            break
        samples = np.frombuffer(raw, dtype=np.float32)
        for event in analyzer.push(samples):
            sys.stdout.write(json.dumps(event.to_dict()) + '\n')
        sys.stdout.flush()


# ── One-shot ────────────────────────────────────────────────────────────────

def analyse_once(source, target_duration=None, report_path=None):
    path, temporary = resolve(source)
    try:
        if not os.path.isfile(path):
            raise FileNotFoundError(path)
        document = pipeline.analyze(path, target_duration)
        if report_path:
            write_report(document, path, report_path)
        return document
    finally:
        if temporary and os.path.exists(path):
            os.remove(path)


def write_report(document, audio_path, report_path):
    from . import report as report_mod
    peaks = None
    try:
        import librosa
        samples, _ = librosa.load(audio_path, sr=8000, mono=True)
        peaks = report_mod.waveform_peaks(samples)
    except Exception as exc:
        _log(f'waveform unavailable for the report: {exc}')
    html = report_mod.analysis_to_html(
        document, title=os.path.basename(audio_path), waveform=peaks)
    with open(report_path, 'w', encoding='utf-8') as handle:
        handle.write(html)
    _log(f'report written to {report_path}')


# ── Argument handling ───────────────────────────────────────────────────────

USAGE = """usage:
  analyze.py <file|url> [--target-duration SEC] [--report OUT.html] [--out OUT.json]
  analyze.py --worker
  analyze.py --live [--rate HZ]"""


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)

    if '--worker' in argv:
        worker_loop()
        return 0

    if '--live' in argv:
        rate = DEFAULT.realtime.sample_rate
        if '--rate' in argv:
            rate = int(argv[argv.index('--rate') + 1])
        live_loop(rate)
        return 0

    target_duration, report_path, out_path = None, None, None
    positional = []
    index = 0
    while index < len(argv):
        argument = argv[index]
        if argument == '--target-duration' and index + 1 < len(argv):
            try:
                target_duration = float(argv[index + 1])
            except ValueError:
                json.dump({'error': f'Invalid --target-duration: {argv[index + 1]}'},
                          sys.stdout)
                return 1
            index += 2
            continue
        if argument == '--report' and index + 1 < len(argv):
            report_path = argv[index + 1]
            index += 2
            continue
        if argument == '--out' and index + 1 < len(argv):
            out_path = argv[index + 1]
            index += 2
            continue
        positional.append(argument)
        index += 1

    if not positional:
        json.dump({'error': USAGE}, sys.stdout)
        return 1

    try:
        document = analyse_once(positional[0], target_duration, report_path)
    except Exception as exc:
        json.dump({'error': str(exc)}, sys.stdout)
        return 1

    if out_path:
        with open(out_path, 'w', encoding='utf-8') as handle:
            json.dump(document, handle)
        _log(f'analysis written to {out_path}')
    else:
        json.dump(document, sys.stdout)
    return 0
