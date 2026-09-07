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
import hashlib
import os
import sys
import urllib.request
from pathlib import Path

# Both URLs are HTTPS: the checkpoint is a pickle that torch.load() executes, so
# a tampered download is arbitrary code execution on this machine.
LABELS_URL = (
    'https://storage.googleapis.com/us_audioset/youtube_corpus/v1/csv/'
    'class_labels_indices.csv'
)
CHECKPOINT_URL = (
    'https://zenodo.org/record/3987831/files/Cnn14_mAP%3D0.431.pth?download=1'
)

# Pinned digests. A size check alone cannot tell a real model from a malicious
# one of similar length, which is what this script used to rely on.
#
#   labels     — SHA-256 of the AudioSet class index (527 classes).
#   checkpoint — MD5 as published by Zenodo for record 3987831. MD5 is not
#                collision-resistant, but it is the digest the publisher
#                provides and it pins the file to their record; combined with
#                the exact byte size it rules out substitution in transit.
LABELS_SHA256 = 'cdd1049833c4b86127c2773ac0d14a2754b6a6d0d1798002ed5c66e699708429'
LABELS_SIZE = 14675
CHECKPOINT_MD5 = '541141fa2ee191a88f24a3219fff024e'
CHECKPOINT_SIZE = 327428481

# Set to skip digest enforcement (e.g. upstream republished the artifact).
# Downloads are then trusted on size alone, as they were before.
ALLOW_UNVERIFIED = os.environ.get('PANNS_ALLOW_UNVERIFIED') == '1'

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


def digest(path: Path, algo: str) -> str:
    h = hashlib.new(algo)
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def verify(path: Path, expected_size: int, algo: str, expected_digest: str):
    """Return (ok, reason). Size is checked first because it is free."""
    if not path.is_file():
        return False, 'missing'
    size = path.stat().st_size
    if size != expected_size:
        return False, f'size {human(size)}, expected {human(expected_size)}'
    if ALLOW_UNVERIFIED:
        return True, 'size only (PANNS_ALLOW_UNVERIFIED=1)'
    actual = digest(path, algo)
    if actual != expected_digest:
        return False, f'{algo} {actual[:16]}… != expected {expected_digest[:16]}…'
    return True, f'{algo} verified'


def file_ok(path: Path, expected_size: int, algo: str, expected_digest: str) -> bool:
    ok, _ = verify(path, expected_size, algo, expected_digest)
    return ok


def download(url: str, target: Path, label: str,
             expected_size: int, algo: str, expected_digest: str) -> bool:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + '.partial')
    try:
        urllib.request.urlretrieve(url, tmp, reporthook=progress_hook(label))
        sys.stdout.write('\n')
        sys.stdout.flush()
        ok, reason = verify(tmp, expected_size, algo, expected_digest)
        if not ok:
            # Never leave an unverified artifact on disk: the checkpoint is a
            # pickle that torch.load() would execute.
            print(f'  [!!] integrity check failed ({reason}), discarding')
            tmp.unlink(missing_ok=True)
            return False
        tmp.replace(target)
        print(f'  [ok] saved {target}  ({human(target.stat().st_size)}, {reason})')
        return True
    except Exception as exc:
        sys.stdout.write('\n')
        sys.stdout.flush()
        print(f'  [!!] download failed: {exc}')
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        return False


def check_python_deps() -> bool:
    """Verify torch + panns_inference are installed. Print actionable hint
    if not."""
    import importlib.util

    missing = []
    try:
        import torch  # noqa: F401
    except Exception:
        missing.append('torch')

    # find_spec, not import: panns_inference's config.py shells out to `wget`
    # at import time and then reads the labels CSV unconditionally, so on a
    # machine without wget importing it raises — and an installed package
    # would be reported here as missing, which is exactly the wrong hint when
    # this script is what fixes it.
    try:
        found = importlib.util.find_spec('panns_inference') is not None
    except Exception:
        found = False
    if not found:
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
    parser.add_argument(
        '--labels-only', action='store_true',
        help='Fetch just the ~15 KB labels CSV, not the ~310 MB checkpoint. '
             'The analyzer uses this to make "import panns_inference" work '
             'without committing to the full download.'
    )
    args = parser.parse_args()

    print(f'PANNs data directory: {PANNS_DIR}')

    deps_ok = check_python_deps()

    labels_ok, labels_why = verify(LABELS_PATH, LABELS_SIZE, 'sha256', LABELS_SHA256)
    ckpt_ok, ckpt_why = verify(CHECKPOINT_PATH, CHECKPOINT_SIZE, 'md5', CHECKPOINT_MD5)

    print(f'\n  labels CSV   {"[ok] " + labels_why if labels_ok else "[!!] " + labels_why}  {LABELS_PATH}')
    print(f'  checkpoint   {"[ok] " + ckpt_why if ckpt_ok else "[!!] " + ckpt_why}  {CHECKPOINT_PATH}')

    if args.check:
        ok = labels_ok and ckpt_ok and deps_ok
        print('\n[ok] ready' if ok else '\n[!!] not ready')
        sys.exit(0 if ok else 1)

    # No-op shortcut

    need_labels = args.force or not labels_ok
    need_ckpt = (args.force or not ckpt_ok) and not args.labels_only

    if not need_labels and not need_ckpt:
        print('\n[ok] already set up — nothing to do')
        sys.exit(0 if deps_ok else 2)

    if args.labels_only and need_labels:
        if not download(LABELS_URL, LABELS_PATH, 'labels',
                        LABELS_SIZE, 'sha256', LABELS_SHA256):
            sys.exit(1)
        print('\n[ok] labels in place (checkpoint not requested)')
        sys.exit(0 if deps_ok else 2)

    print('')
    if need_labels:
        if not download(LABELS_URL, LABELS_PATH, 'labels',
                        LABELS_SIZE, 'sha256', LABELS_SHA256):
            sys.exit(1)
    if need_ckpt:
        print('Downloading the Cnn14 checkpoint (~310 MB). This is a one-time')
        print('cost. The model will be cached at ~/panns_data/ for all future runs.')
        if not download(CHECKPOINT_URL, CHECKPOINT_PATH, 'checkpoint',
                        CHECKPOINT_SIZE, 'md5', CHECKPOINT_MD5):
            sys.exit(1)

    print('\n[ok] PANNs ready' if deps_ok else '\n[!!] files in place but Python deps still missing')
    sys.exit(0 if deps_ok else 2)


if __name__ == '__main__':
    main()
