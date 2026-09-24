"""
The analysis models: what each one is for, whether it is on this machine, and
fetching the ones that are not.

    python scripts/download-models.py                  the required and recommended ones
    python scripts/download-models.py --only songformer,panns
    python scripts/download-models.py --all            everything, SongFormer's 2.9 GB included
    python scripts/download-models.py --list           what is here and what is not
    python scripts/download-models.py --list --json    the same, for the server
    python scripts/download-models.py --json --only …  progress as JSON lines on stdout

This is a step before the show on purpose, never something the analysis does
by itself: weights run to gigabytes, and the moment a track is waiting on its
analysis on venue wifi is the worst moment to find that out. The settings page
runs this script (Settings → Analysis models) and shows its progress.

With --json every line on stdout is one event:

    {"event": "start", "model": id, "total": bytes or null}
    {"event": "progress", "model": id, "bytes": n, "total": bytes or null}
    {"event": "done", "model": id}
    {"event": "error", "model": id, "message": "…"}
    {"event": "finished", "ok": true | false}

Everything the libraries print goes to stderr, so it cannot break a line.
"""
from __future__ import annotations

import argparse
import contextlib
import fnmatch
import json
import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

ROOT = Path(os.environ.get("ARTNET_MODEL_DIR", Path.home() / ".cache" / "artnet-lightshow" / "models"))
READY = ".ready"
_OUT = sys.stdout
_JSON = False


def emit(event: str, **fields):
    if _JSON:
        _OUT.write(json.dumps({"event": event, **fields}) + "\n")
        _OUT.flush()
    elif event == "progress" and fields.get("total"):
        print(f"[models] {fields['model']}: {fields['bytes'] / 1e6:.0f} of {fields['total'] / 1e6:.0f} MB",
              file=sys.stderr, flush=True)
    elif event in ("start", "done", "error"):
        detail = f" — {fields['message']}" if event == "error" else ""
        print(f"[models] {fields.get('model')}: {event}{detail}", file=sys.stderr, flush=True)


def _size(paths) -> int:
    total = 0
    for base in paths:
        base = Path(base)
        if base.is_file():
            total += base.stat().st_size
            continue
        if not base.is_dir():
            continue
        for dirpath, _dirs, files in os.walk(base):
            for name in files:
                try:
                    total += (Path(dirpath) / name).stat().st_size
                except OSError:
                    pass
    return total


class Watch:
    """How many bytes have landed, read off the disk while a download runs.

    The libraries doing the downloading each report progress their own way,
    or not at all; the bytes arriving in the directories they write to are the
    one measure they share.
    """

    def __init__(self, model: str, paths, total: int | None):
        self.model, self.paths, self.total = model, list(paths), total
        self._stop = threading.Event()
        self._base = _size(self.paths)
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        last = -1
        while not self._stop.wait(0.5):
            landed = max(0, _size(self.paths) - self._base)
            if landed != last:
                last = landed
                emit("progress", model=self.model, bytes=landed, total=self.total)

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *_exc):
        self._stop.set()
        self._thread.join(timeout=2)


@dataclass
class Model:
    id: str
    name: str
    purpose: str
    tier: str                     # required | recommended | optional
    size: int                     # bytes, roughly: what the settings page shows
    license: str
    present: Callable[[], bool]
    fetch: Callable[["Model"], None]
    watch: Callable[[], list] = field(default=lambda: [])
    note: str = ""

    def describe(self):
        return {
            "id": self.id, "name": self.name, "purpose": self.purpose, "tier": self.tier,
            "size": self.size, "license": self.license, "present": _safe(self.present),
            "note": self.note,
        }


def _safe(check) -> bool:
    try:
        return bool(check())
    except Exception:
        return False


# ── Hugging Face repositories ──────────────────────────────────────────────

def _hf_total(repo: str, allow=None, ignore=None) -> int | None:
    try:
        from huggingface_hub import HfApi
        info = HfApi().model_info(repo, files_metadata=True)
    except Exception:
        return None
    total = 0
    for sibling in info.siblings or []:
        name = sibling.rfilename
        if allow and not any(fnmatch.fnmatch(name, p) for p in allow):
            continue
        if ignore and any(fnmatch.fnmatch(name, p) for p in ignore):
            continue
        total += sibling.size or 0
    return total or None


def hf_model(id, name, purpose, tier, size, license, repo, weights, allow=None, ignore=None, note="",
             variable=None):
    # The same override the analysis reads (model_adapters, songformer): a
    # model kept somewhere else is found there, and fetched there.
    target = Path(os.environ[variable]) if variable and os.environ.get(variable) else ROOT / id

    def present():
        return (target / READY).is_file() or any((target / w).is_file() for w in weights)

    def fetch(model):
        from huggingface_hub import snapshot_download
        total = _hf_total(repo, allow, ignore) or size
        emit("start", model=id, total=total)
        target.mkdir(parents=True, exist_ok=True)
        with Watch(id, [target], total), contextlib.redirect_stdout(sys.stderr):
            snapshot_download(repo_id=repo, local_dir=target, allow_patterns=allow, ignore_patterns=ignore)
        (target / READY).write_text("ready\n")

    return Model(id, name, purpose, tier, size, license, present, fetch, lambda: [target], note)


# ── Models the packages fetch themselves ───────────────────────────────────

def _torch_checkpoints():
    import torch
    return Path(torch.hub.get_dir()) / "checkpoints"


def _beat_this_present():
    return (ROOT / "beat_this.ready").is_file() or (_torch_checkpoints() / "beat_this-final0.ckpt").is_file()


def _beat_this_fetch(model):
    from analysis import models
    emit("start", model=model.id, total=model.size)
    with Watch(model.id, [_torch_checkpoints()], model.size), contextlib.redirect_stdout(sys.stderr):
        models.beat_tracker()
    ROOT.mkdir(parents=True, exist_ok=True)
    (ROOT / "beat_this.ready").write_text("ready\n")


def _hf_cache_dir(repo: str) -> Path:
    try:
        from huggingface_hub.constants import HF_HUB_CACHE
    except Exception:
        HF_HUB_CACHE = str(Path.home() / ".cache" / "huggingface" / "hub")
    return Path(HF_HUB_CACHE) / ("models--" + repo.replace("/", "--"))


def _demucs_present():
    # Demucs 4.1 keeps htdemucs on the Hugging Face hub; 4.0 fetched it into
    # the torch hub's checkpoints.
    snapshots = _hf_cache_dir("adefossez/HTDemucs") / "snapshots"
    if snapshots.is_dir() and any(snapshots.glob("*/htdemucs.yaml")):
        return True
    return (_torch_checkpoints() / "955717e8-8726e21a.th").is_file()


def _demucs_fetch(model):
    from analysis import models
    emit("start", model=model.id, total=model.size)
    with Watch(model.id, [_hf_cache_dir("adefossez/HTDemucs"), _torch_checkpoints()], model.size), \
            contextlib.redirect_stdout(sys.stderr):
        models.separator("htdemucs")


def _panns_present():
    from analysis import tagger
    return tagger.checkpoint_present() and Path(tagger._LABELS).is_file()


def _panns_fetch(model):
    from analysis import tagger
    emit("start", model=model.id, total=model.size)
    with Watch(model.id, [Path(tagger._DIR)], model.size):
        result = subprocess.run([sys.executable, str(REPO / "scripts" / "setup-panns.py")],
                                stdout=sys.stderr, stderr=sys.stderr)
    # setup-panns exits 2 for "files in place, torch missing": only the files
    # were wanted here, so the verdict is the filesystem's.
    if not _panns_present():
        raise RuntimeError(f"setup-panns.py exited {result.returncode} without the files in place")


def _bs_roformer_present():
    from analysis import models
    directory, filename = models.bs_roformer_checkpoint()
    return (ROOT / "BS-Roformer-SW.ready").is_file() or (Path(directory) / filename).is_file()


def _bs_roformer_fetch(model):
    # audio-separator's own registry fetches the checkpoint and its YAML into
    # the model directory, which guarantees the runtime can load them.
    from analysis import models
    directory, _ = models.bs_roformer_checkpoint()
    emit("start", model=model.id, total=model.size)
    with Watch(model.id, [directory], model.size), contextlib.redirect_stdout(sys.stderr):
        models.bs_roformer_separator()
    ROOT.mkdir(parents=True, exist_ok=True)
    (ROOT / "BS-Roformer-SW.ready").write_text("ready\n")


MODELS = [
    Model("beat_this", "Beat This!", "The beat grid, the downbeats and the metre.",
          "required", 81_058_141, "MIT", _beat_this_present, _beat_this_fetch),
    Model("htdemucs", "Demucs v4", "Splits the track into drums, bass, vocals and other.",
          "required", 84_000_000, "MIT", _demucs_present, _demucs_fetch),
    hf_model("muq", "MuQ", "Timbre embeddings, for which sections are the same music.",
             "recommended", 1_270_000_000, "CC BY-NC 4.0", "OpenMuQ/MuQ-large-msd-iter",
             ["model.safetensors", "pytorch_model.bin"], allow=["*.json", "*.bin", "*.safetensors", "*.pt"],
             variable="ARTNET_MUQ_MODEL"),
    hf_model("muq_mulan", "MuQ-MuLan", "Genre and mood, answered from the audio.",
             "recommended", 2_560_000_000, "CC BY-NC 4.0", "OpenMuQ/MuQ-MuLan-large",
             ["model.safetensors", "pytorch_model.bin"], allow=["*.json", "*.bin", "*.safetensors", "*.pt"],
             variable="ARTNET_MUQ_MULAN_MODEL"),
    hf_model("xlm-roberta-base", "XLM-RoBERTa", "MuQ-MuLan's text half: it reads the genre and mood words.",
             "recommended", 1_120_000_000, "MIT", "FacebookAI/xlm-roberta-base",
             ["model.safetensors"], allow=["*.json", "model.safetensors", "*.model"],
             variable="ARTNET_MUQ_TEXT_MODEL"),
    Model("panns", "PANNs Cnn14", "AudioSet tags: instrument priors, and the genre when MuQ-MuLan is absent.",
          "optional", 327_428_481, "MIT", _panns_present, _panns_fetch),
    hf_model("songformer", "SongFormer", "Names the sections: intro, verse, pre-chorus, chorus, bridge, outro.",
             "optional", 2_860_000_000, "CC BY 4.0 (its MuQ backbone CC BY-NC 4.0)", "ASLP-lab/SongFormer",
             ["model.safetensors"], ignore=["*.pt", "musicfm/figs/*"],
             note="Runs by default only on a GPU: on a CPU it takes most of the track's length and 8-10 GB of memory.",
             variable="ARTNET_SONGFORMER_MODEL"),
    Model("bs_roformer", "BS-RoFormer SW", "The slower, more careful separator (Settings → Separator).",
          "optional", 700_000_000, "MIT", _bs_roformer_present, _bs_roformer_fetch,
          note="About seven times as slow as Demucs."),
]
BY_ID = {m.id: m for m in MODELS}


def main(argv=None):
    global _JSON
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--list", action="store_true", help="report what is here and what is not")
    parser.add_argument("--json", action="store_true", help="machine-readable output on stdout")
    parser.add_argument("--only", default="", help="comma-separated model ids")
    parser.add_argument("--all", action="store_true", help="every model, the optional ones included")
    parser.add_argument("--missing", action="store_true", help="skip the models already here")
    args = parser.parse_args(argv)
    _JSON = args.json

    if args.list:
        rows = [m.describe() for m in MODELS]
        if args.json:
            _OUT.write(json.dumps({"root": str(ROOT), "models": rows}) + "\n")
        else:
            for row in rows:
                mark = "here   " if row["present"] else "missing"
                print(f"{mark}  {row['id']:<17} {row['size'] / 1e6:>6.0f} MB  {row['tier']:<11} {row['name']}")
        return 0

    if args.only:
        unknown = [i for i in args.only.split(",") if i and i not in BY_ID]
        if unknown:
            print(f"unknown model(s): {', '.join(unknown)}; known: {', '.join(BY_ID)}", file=sys.stderr)
            return 2
        chosen = [BY_ID[i] for i in args.only.split(",") if i]
    elif args.all:
        chosen = list(MODELS)
    else:
        chosen = [m for m in MODELS if m.tier in ("required", "recommended")]
    if args.missing:
        chosen = [m for m in chosen if not _safe(m.present)]

    try:
        import huggingface_hub  # noqa: F401
    except ImportError:
        emit("error", model=None, message="huggingface_hub is not installed: pip install huggingface_hub")
        emit("finished", ok=False)
        return 1

    ok = True
    for model in chosen:
        try:
            model.fetch(model)
            emit("done", model=model.id)
        except Exception as exc:  # one model failing must not stop the rest
            ok = False
            emit("error", model=model.id, message=str(exc) or type(exc).__name__)
    emit("finished", ok=ok)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
