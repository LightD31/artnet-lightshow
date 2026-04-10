#!/usr/bin/env python3
"""
Bootstrap PANNs (Pretrained Audio Neural Networks) for genre classification.

Downloads the two files panns_inference needs at runtime but can't fetch
itself on Windows because its built-in fetcher uses `wget`:

  1. AudioSet class labels CSV       (~15 KB)
  2. Cnn14_mAP=0.431.pth checkpoint  (~310 MB)

Both land at ~/panns_data/ where panns_inference looks for them.

Usage:
    python scripts/setup-panns.py             # download anything missing
    python scripts/setup-panns.py --force     # re-download even if present
    python scripts/setup-panns.py --check     # verify only, no downloads

Exit codes:
    0  – everything in place (or fixed)
    1  – downloads needed but failed (or --check found something missing)
    2  – pip dependency missing (torch / panns_inference)
"""

import argparse
import os
import sys
import urllib.request
from pathlib import Path

LABELS_URL = (
    'http://storage.googleapis.com/us_audioset/youtube_corpus/v1/csv/'
    'class_labels_indices.csv'
)
CHECKPOINT_URL = (
    'https://zenodo.org/record/3987831/files/Cnn14_mAP%3D0.431.pth?download=1'
)

# Expected sizes (bytes). Used to detect partial / corrupt downloads.
LABELS_MIN_SIZE = 10 * 1024            # ≥ 10 KB
CHECKPOINT_MIN_SIZE = 300 * 1024 * 1024  # ≥ 300 MB

PANNS_DIR = Path.home() / 'panns_data'
LABELS_PATH = PANNS_DIR / 'class_labels_indices.csv'
CHECKPOINT_PATH = PANNS_DIR / 'Cnn14_mAP=0.431.pth'


def human(num_bytes):
    if num_bytes >= 1024 * 1024 * 1024:
        return f'{num_bytes / 1024 / 1024 / 1024:.2f} GB'
    if num_bytes >= 1024 * 1024:
        return f'{num_bytes / 1024 / 1024:.1f} MB'
    if num_bytes >= 1024:
        return f'{num_bytes / 1024:.1f} KB'
    return f'{num_bytes} B'


def progress_hook(label):
    """Return a urlretrieve reporthook that prints in-place progress."""
    state = {'last_pct': -1}

    def hook(blocks, block_size, total_size):
        downloaded = blocks * block_size
        if total_size > 0:
            pct = int(downloaded * 100 / total_size)
            if pct != state['last_pct']:
                state['last_pct'] = pct
                bar = '#' * (pct // 4) + '-' * (25 - pct // 4)
                sys.stdout.write(
                    f'\r  {label}: [{bar}] {pct:3d}%  ({human(downloaded)} / {human(total_size)})'
                )
                sys.stdout.flush()
        else:
            sys.stdout.write(f'\r  {label}: {human(downloaded)} downloaded')
            sys.stdout.flush()

    return hook


def file_ok(path: Path, min_size: int) -> bool:
    return path.is_file() and path.stat().st_size >= min_size


def download(url: str, target: Path, label: str, min_size: int) -> bool:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + '.partial')
    try:
        urllib.request.urlretrieve(url, tmp, reporthook=progress_hook(label))
        sys.stdout.write('\n')
        sys.stdout.flush()
        size = tmp.stat().st_size
        if size < min_size:
            print(f'  [!!] download too small ({human(size)} < {human(min_size)}), discarding')
            tmp.unlink(missing_ok=True)
            return False
        tmp.replace(target)
        print(f'  [ok] saved {target}  ({human(size)})')
        return True
    except Exception as exc:
        sys.stdout.write('\n')
        sys.stdout.flush()
        print(f'  [!!] download failed: {exc}')
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        return False


def check_python_deps() -> bool:
    """Verify torch + panns_inference are importable. Print actionable hint
    if not."""
    missing = []
    try:
        import torch  # noqa: F401
    except Exception:
        missing.append('torch')
    try:
        import panns_inference  # noqa: F401
    except Exception:
        missing.append('panns_inference')

    if missing:
        print('\nMissing Python packages:', ', '.join(missing))
        print('Install with:')
        print('    pip install --user torch torchaudio panns_inference')
        return False
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n', 1)[0])
    parser.add_argument(
        '--force', action='store_true',
        help='Re-download even if files already exist'
    )
    parser.add_argument(
        '--check', action='store_true',
        help='Verify only — exit nonzero if anything is missing'
    )
    args = parser.parse_args()

    print(f'PANNs data directory: {PANNS_DIR}')

    deps_ok = check_python_deps()

    labels_ok = file_ok(LABELS_PATH, LABELS_MIN_SIZE)
    ckpt_ok = file_ok(CHECKPOINT_PATH, CHECKPOINT_MIN_SIZE)

    print(f'\n  labels CSV   {"[ok] present" if labels_ok else "[!!] missing"}  {LABELS_PATH}')
    print(f'  checkpoint   {"[ok] present" if ckpt_ok else "[!!] missing"}  {CHECKPOINT_PATH}')

    if args.check:
        ok = labels_ok and ckpt_ok and deps_ok
        print('\n[ok] ready' if ok else '\n[!!] not ready')
        sys.exit(0 if ok else 1)

    # No-op shortcut

    need_labels = args.force or not labels_ok
    need_ckpt = args.force or not ckpt_ok

    if not need_labels and not need_ckpt:
        print('\n[ok] already set up — nothing to do')
        sys.exit(0 if deps_ok else 2)

    print('')
    if need_labels:
        if not download(LABELS_URL, LABELS_PATH, 'labels', LABELS_MIN_SIZE):
            sys.exit(1)
    if need_ckpt:
        print('Downloading the Cnn14 checkpoint (~310 MB). This is a one-time')
        print('cost. The model will be cached at ~/panns_data/ for all future runs.')
        if not download(CHECKPOINT_URL, CHECKPOINT_PATH, 'checkpoint', CHECKPOINT_MIN_SIZE):
            sys.exit(1)

    print('\n[ok] PANNs ready' if deps_ok else '\n⚠ files in place but Python deps still missing')
    sys.exit(0 if deps_ok else 2)


if __name__ == '__main__':
    main()
