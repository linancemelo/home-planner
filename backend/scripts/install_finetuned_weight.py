#!/usr/bin/env python3
"""Install a fine-tuned YOLO-seg checkpoint into backend/models/ and verify load.

Typical flow after Colab/Kaggle download of ``best.pt``::

  cd backend
  source .venv/bin/activate
  python scripts/install_finetuned_weight.py ~/Downloads/best.pt
  # or promote as primary RW weight:
  python scripts/install_finetuned_weight.py ~/Downloads/best.pt --as floorplan-rw-seg.pt

Then::

  export DETECT_MODE=yolo
  export DETECT_MODEL_PATH=\"$(pwd)/models/floorplan-rw-seg.pt\"   # if using custom name
  uvicorn main:app --reload --host 127.0.0.1 --port 8000

Default destination is ``models/floorplan-rw-seg.pt`` (preferred by yolo_pipeline).
Use ``--as floorplan-seg.pt`` only if you intentionally replace the FloorCAD fallback.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "models"

PREFERRED = ("floorplan-rw-seg.pt", "floorplan-seg.pt")


def _verify_yolo(path: Path) -> dict:
    from ultralytics import YOLO

    model = YOLO(str(path))
    names = dict(getattr(model, "names", {}) or {})
    return {
        "path": str(path.resolve()),
        "size_bytes": path.stat().st_size,
        "names": names,
        "nc": len(names),
        "task": getattr(model, "task", None),
    }


def _smoke_predict(path: Path) -> str | None:
    """Optional one-image smoke using repo fixtures if present."""
    candidates = [
        ROOT.parent / "src" / "import-plan" / "fixtures" / "real-samples" / "2b69218a-b.jpg",
        ROOT / "fixtures" / "sample.png",
    ]
    img = next((p for p in candidates if p.is_file()), None)
    if img is None:
        return None
    from ultralytics import YOLO
    import numpy as np

    model = YOLO(str(path))
    # tiny array if we somehow lack images — but we have img
    results = model.predict(str(img), imgsz=640, conf=0.25, verbose=False)
    n = 0
    if results and results[0].boxes is not None:
        n = int(len(results[0].boxes))
    return f"smoke predict on {img.name}: {n} boxes"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("weight", type=Path, help="Path to best.pt (or any YOLO-seg .pt)")
    ap.add_argument(
        "--as",
        dest="dest_name",
        default="floorplan-rw-seg.pt",
        help="Destination filename under backend/models/ (default floorplan-rw-seg.pt)",
    )
    ap.add_argument("--no-smoke", action="store_true", help="Skip one-image predict")
    ap.add_argument(
        "--print-env",
        action="store_true",
        help="Print DETECT_MODE / DETECT_MODEL_PATH exports",
    )
    args = ap.parse_args()

    src = args.weight.expanduser().resolve()
    if not src.is_file():
        print(f"ERROR: weight not found: {src}", file=sys.stderr)
        return 1
    if src.stat().st_size < 100_000:
        print(f"ERROR: file too small to be a YOLO weight: {src}", file=sys.stderr)
        return 1

    MODELS.mkdir(parents=True, exist_ok=True)
    dest = MODELS / args.dest_name
    if dest.resolve() != src.resolve():
        # backup existing
        if dest.is_file():
            bak = dest.with_suffix(dest.suffix + ".bak")
            shutil.copy2(dest, bak)
            print(f"Backed up existing → {bak}")
        shutil.copy2(src, dest)
        print(f"Installed → {dest} ({dest.stat().st_size} bytes)")
    else:
        print(f"Already at destination: {dest}")

    try:
        info = _verify_yolo(dest)
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: ultralytics failed to load {dest}: {e}", file=sys.stderr)
        return 2

    print("Load OK:")
    print(f"  task={info['task']}  nc={info['nc']}")
    print(f"  names={info['names']}")

    expected = {"room", "wall", "door", "window"}
    have = {str(v).lower() for v in info["names"].values()}
    missing = expected - have
    if missing:
        print(
            f"WARN: weight missing preferred classes {sorted(missing)}. "
            "Pipeline may lean on OpenCV / CubiCasa companion.",
            file=sys.stderr,
        )
    else:
        print("Classes include room/wall/door/window — good for DETECT_MODE=yolo.")

    if not args.no_smoke:
        try:
            msg = _smoke_predict(dest)
            if msg:
                print(msg)
        except Exception as e:  # noqa: BLE001
            print(f"WARN: smoke predict failed (weight still installed): {e}", file=sys.stderr)

    # Also verify default_model_path resolution if this is the preferred name
    sys.path.insert(0, str(ROOT))
    os.environ.pop("DETECT_MODEL_PATH", None)
    try:
        from yolo_pipeline import default_model_path, load_model

        resolved = default_model_path()
        print(f"yolo_pipeline.default_model_path() → {resolved}")
        if resolved.resolve() == dest.resolve() or args.dest_name in PREFERRED:
            load_model(force=True)
            print("yolo_pipeline.load_model(force=True) OK")
    except Exception as e:  # noqa: BLE001
        print(f"WARN: pipeline import/load check: {e}", file=sys.stderr)

    print()
    print("Enable backend:")
    print("  export DETECT_MODE=yolo")
    if args.dest_name not in ("floorplan-rw-seg.pt",):
        print(f"  export DETECT_MODEL_PATH=\"{dest}\"")
    else:
        print(f"  # DETECT_MODEL_PATH optional — defaults pick {dest.name}")
        print(f"  # export DETECT_MODEL_PATH=\"{dest}\"")
    print("  uvicorn main:app --reload --host 127.0.0.1 --port 8000")
    print("  # or from repo root: ./scripts/dev-local.sh")
    print()
    print("Regress:")
    print("  python scripts/regress_detect.py")

    if args.print_env:
        print(f"DETECT_MODE=yolo")
        print(f"DETECT_MODEL_PATH={dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
