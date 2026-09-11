"""Download optional analysis weights into the local model cache.

This is intentionally a preflight step rather than an import-time side effect:
an operator can see the download progress and license notices before a show.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

MODELS = {
    "muq": ("OpenMuQ/MuQ-large-msd-iter", None),
    "muq_mulan": ("OpenMuQ/MuQ-MuLan-large", None),
    "xlm-roberta-base": ("FacebookAI/xlm-roberta-base", None),
    "skey": ("musetric/skey-onnx", None),
}


def main():
    try:
        from huggingface_hub import snapshot_download, hf_hub_download
    except ImportError as exc:
        raise SystemExit("Install model downloader support: pip install huggingface_hub") from exc
    root = Path(os.environ.get("ARTNET_MODEL_DIR", Path.home() / ".cache" / "artnet-lightshow" / "models"))
    root.mkdir(parents=True, exist_ok=True)
    for name, (repo, filename) in MODELS.items():
        target = root / name
        target.mkdir(exist_ok=True)
        if filename:
            path = hf_hub_download(repo_id=repo, filename=filename, local_dir=target)
        else:
            path = snapshot_download(repo_id=repo, local_dir=target,
                                     allow_patterns=(["*.json", "model.safetensors", "*.model"]
                                                     if name == "xlm-roberta-base" else
                                                     ["*.json", "*.bin", "*.safetensors", "*.pt"]))
        print(f"[models] {name}: {path}")
    # Use audio-separator's own registry for BS-RoFormer-SW. This downloads
    # both its checkpoint and YAML into the configured model directory and
    # guarantees that the runtime can actually load the files.
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
        from analysis.models import bs_roformer_separator
        bs_roformer_separator()
        (root / "BS-Roformer-SW.ready").write_text("ready\n")
        print("[models] BS-RoFormer-SW: ready")
    except Exception as exc:
        raise SystemExit(f"BS-RoFormer download failed: {exc}") from exc
    # Beat This! publishes its checkpoint through the Python package's model
    # loader rather than a stable Hub repository. Calling the same loader here
    # makes the pre-show check pay that cost before playback.
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
        from analysis.models import beat_tracker
        beat_tracker()
        (root / "beat_this.ready").write_text("ready\n")
        print("[models] beat_this: ready")
    except Exception as exc:
        raise SystemExit(f"Beat This! checkpoint download failed: {exc}") from exc


if __name__ == "__main__":
    main()
