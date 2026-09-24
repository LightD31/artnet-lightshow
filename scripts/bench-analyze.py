#!/usr/bin/env python3
"""Import the pipeline once, analyse a track N times, report the median — in
total and stage by stage.

    python scripts/bench-analyze.py track.wav [duration_sec] [runs]
    python scripts/bench-analyze.py track.wav --runs 3 --structure songformer
    python scripts/bench-analyze.py track.wav --no-separation --json

The first run is discarded: it pays for the imports, numba's JIT and loading
the models, which the persistent worker pays once per server lifetime.

The stage table is how to find what a machine is slow at. A model on its own
thread (separation, MuQ, SongFormer, the beat model) is timed on that thread;
`wait.*` is what the main thread spent waiting for one, which is what the
track actually paid. Run it with `--structure songformer` on the machine the
show runs on — a Radeon 890M, say — before turning SongFormer on for real.
"""

import argparse
import json
import os
import statistics
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src'))

from analysis import models, pipeline  # noqa: E402
from analysis.config import AnalysisConfig  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('track')
    parser.add_argument('duration', nargs='?', type=float, default=None,
                        help='the track length the player reports, seconds')
    parser.add_argument('runs_positional', nargs='?', type=int, default=None, metavar='runs')
    parser.add_argument('--runs', type=int, default=None)
    parser.add_argument('--structure', choices=('auto', 'songformer', 'off'), default=None,
                        help='where the sections come from (default: ARTNET_STRUCTURE_MODEL or auto)')
    parser.add_argument('--no-separation', action='store_true', help='skip source separation')
    parser.add_argument('--json', action='store_true', help='the medians as JSON on stdout')
    args = parser.parse_args(argv)

    if not os.path.isfile(args.track):
        parser.error(f'no such file: {args.track}')
    runs = args.runs or args.runs_positional or 3
    config = AnalysisConfig(structure_model=args.structure, separate_sources=not args.no_separation)

    print(f'device: {models.device()}', file=sys.stderr)
    first = pipeline.analyze(args.track, target_duration_sec=args.duration, config=config)
    duration = first['duration']
    print(f'warm-up: {first["meta"]["elapsedSec"]:.2f}s for {duration:.0f}s of audio '
          f'(sections from {first.get("sectionSource")})', file=sys.stderr)

    totals, stages = [], {}
    for run in range(runs):
        started = time.perf_counter()
        document = pipeline.analyze(args.track, target_duration_sec=args.duration, config=config)
        totals.append(time.perf_counter() - started)
        for name, seconds in (document['meta'].get('timings') or {}).items():
            stages.setdefault(name, []).append(seconds)
        print(f'  run {run + 1}: {totals[-1]:6.2f}s', file=sys.stderr)

    total = statistics.median(totals)
    medians = {name: statistics.median(values) for name, values in stages.items()}
    if args.json:
        json.dump({'device': str(models.device()), 'duration': duration, 'runs': runs,
                   'total': round(total, 3), 'ratio': round(total / max(duration, 1e-9), 4),
                   'stages': {k: round(v, 3) for k, v in medians.items()}}, sys.stdout)
        print()
        return 0
    print(f'median of {runs}: {total:.2f}s ({total / max(duration, 1e-9):.2f}x the track)', file=sys.stderr)
    for name, seconds in sorted(medians.items(), key=lambda kv: -kv[1]):
        print(f'  {name:<16} {seconds:7.2f}s', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
