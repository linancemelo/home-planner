#!/usr/bin/env python3
"""Download YOLO-seg nano weights into backend/models/ for DETECT_MODE=yolo.

Default: yolo11n-seg.pt (ultralytics pretrained). Not floorplan-tuned —
use as best-effort until a custom floorplan-seg.pt is trained.

Usage (from backend/):
  source .venv/bin/activate
  python scripts/download_model.py
  # optional:
  python scripts/download_model.py --name yolov8n-seg.pt
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "models"


def main() -> int:
    parser = argparse.ArgumentParser(description="Download YOLO-seg weights for home-planner")
    parser.add_argument(
        "--name",
        default="yolo11n-seg.pt",
        help="Weight filename (default yolo11n-seg.pt)",
    )
    args = parser.parse_args()
    MODELS.mkdir(parents=True, exist_ok=True)
    dest = MODELS / args.name

    try:
        from ultralytics import YOLO
    except ImportError:
        print("請先：pip install -r requirements.txt", file=sys.stderr)
        return 1

    print(f"Downloading / loading {args.name} via ultralytics…")
    model = YOLO(args.name)
    # Ultralytics caches under cwd or ultralytics hub; try to locate file
    src = Path(args.name)
    if not src.is_file():
        # common cache locations relative to cwd
        for cand in (
            Path.cwd() / args.name,
            Path.home() / ".cache" / "ultralytics" / args.name,
        ):
            if cand.is_file():
                src = cand
                break
    # model.ckpt_path may exist on newer ultralytics
    ckpt = getattr(model, "ckpt_path", None) or getattr(getattr(model, "model", None), "ckpt_path", None)
    if ckpt and Path(str(ckpt)).is_file():
        src = Path(str(ckpt))

    if src.is_file() and src.resolve() != dest.resolve():
        shutil.copy2(src, dest)
        print(f"Copied → {dest}")
    elif dest.is_file():
        print(f"Already present: {dest}")
    else:
        # Trigger predict once so weight is materialized, then search again
        import numpy as np

        dummy = np.zeros((64, 64, 3), dtype=np.uint8)
        model.predict(dummy, verbose=False)
        found = None
        for cand in Path.cwd().rglob(args.name):
            if cand.is_file():
                found = cand
                break
        if found:
            shutil.copy2(found, dest)
            print(f"Copied → {dest}")
        else:
            print(
                f"權重已由 ultralytics 快取，但未複製到 {dest}。"
                f"可手動將 {args.name} 放到 backend/models/，或設 DETECT_MODEL_PATH。",
                file=sys.stderr,
            )
            return 0

    print("Done. Enable with:")
    print("  export DETECT_MODE=yolo")
    print("  uvicorn main:app --reload --host 127.0.0.1 --port 8000")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
