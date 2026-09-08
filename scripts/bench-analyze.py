#!/usr/bin/env python3
"""Tight head-to-head: import the pipeline once, analyse N times, report median.

    python scripts/bench-analyze.py path/to/track.wav [duration_sec] [runs]

The first run is discarded — it pays for librosa's imports and numba's JIT,
which the persistent worker only pays once per server lifetime.
"""

import os
import statistics
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src'))

from analysis import pipeline  # noqa: E402

WAV = sys.argv[1] if len(sys.argv) > 1 else None
DURATION = float(sys.argv[2]) if len(sys.argv) > 2 else None
RUNS = int(sys.argv[3]) if len(sys.argv) > 3 else 3

if not WAV or not os.path.isfile(WAV):
    print(__doc__, file=sys.stderr)
    sys.exit(1)

pipeline.analyze(WAV, target_duration_sec=DURATION)  # warm-up

times = []
for run in range(RUNS):
    started = time.time()
    pipeline.analyze(WAV, target_duration_sec=DURATION)
    times.append(time.time() - started)
    print(f'  run {run + 1}: {times[-1]:5.2f}s', file=sys.stderr)
print(f'median of {RUNS}: {statistics.median(times):.2f}s', file=sys.stderr)
