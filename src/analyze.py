#!/usr/bin/env python3
"""
Launcher for the audio analysis pipeline.

Exists so the package can be spawned by absolute path without the caller having
to arrange `sys.path` or a working directory:

    python /path/to/src/analyze.py --worker

The real implementation is in `src/analysis/`; see `analysis/cli.py` for the
modes and `docs/audio-analysis.md` for what the pipeline does.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from analysis.cli import main  # noqa: E402

if __name__ == '__main__':
    sys.exit(main())
