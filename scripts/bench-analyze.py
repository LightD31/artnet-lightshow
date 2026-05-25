#!/usr/bin/env python3
"""Tight head-to-head: load module once, run analyze() N times, report median."""
import time, sys, statistics, importlib.util

WAV = sys.argv[1] if len(sys.argv) > 1 else r'C:\Users\Tom\AppData\Local\Temp\deezer-dl-1779732820391.wav'
DURATION = float(sys.argv[2]) if len(sys.argv) > 2 else 238.0
N = int(sys.argv[3]) if len(sys.argv) > 3 else 3

spec = importlib.util.spec_from_file_location('ea', 'src/essentia-analyze.py')
ea = importlib.util.module_from_spec(spec); spec.loader.exec_module(ea)

# Warmup once (JIT/import)
ea.analyze(WAV, target_duration_sec=DURATION)

times = []
for i in range(N):
    t = time.time()
    ea.analyze(WAV, target_duration_sec=DURATION)
    times.append(time.time() - t)
    print(f'  run {i+1}: {times[-1]:5.2f}s', file=sys.stderr)
print(f'median of {N}: {statistics.median(times):.2f}s', file=sys.stderr)
