#!/usr/bin/env python3
"""
Launcher for the live input service.

Exists so the package can be spawned by absolute path without the caller having
to arrange `sys.path` or a working directory:

    python /path/to/src/live_input.py --source loopback

The real implementation is in `src/analysis/live.py`.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from analysis.live import main  # noqa: E402

if __name__ == '__main__':
    sys.exit(main())
