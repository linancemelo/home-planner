#!/usr/bin/env python3
"""Download YOLO-seg weights into backend/models/ for DETECT_MODE=yolo.

Prefers a public FloorCAD-style floorplan seg checkpoint as floorplan-seg.pt
(when --floorplan / default). Falls back to ultralytics pretrained nano seg.

Usage (from backend/):
  source .venv/bin/activate
  python scripts/download_model.py
  # COCO pretrained only:
  python scripts/download_model.py --name yolo11n-seg.pt --no-floorplan
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "models"

# Public FloorPlanCAD-symbol YOLO-seg (walls / doors / windows …). Not room-seg;
# still better than COCO for CAD-like plans. AGPL-3.0 Ultralytics lineage.
HF_FLOORPLAN_REPO = "mudasir13cs/floorcad-yolov8n-seg"
HF_FLOORPLAN_FILE = "floorcad-yolov8n-seg.pt"
FLOORPLAN_DEST_NAME = "floorplan-seg.pt"

# Room/wall/door/window YOLO-seg (preferred over FloorCAD symbol taxonomy)
HF_RW_REPO = "JessiP23/floorplan-seg-v2"
HF_RW_FILE = "best.pt"
RW_DEST_NAME = "floorplan-rw-seg.pt"

# CubiCasa5K ResNet34-UNet (floor/wall/door/window semantic). MIT weights.
HF_CUBICASA_REPO = "Yytsi/floorplan-to-3d-walls"
HF_CUBICASA_FILE = "best.safetensors"
HF_CUBICASA_CFG = "config.yaml"
CUBICASA_DIR_NAME = "cubicasa"


def _copy_ultralytics(name: str, dest: Path) -> bool:
    from ultralytics import YOLO

    print(f"Downloading / loading {name} via ultralytics…")
    model = YOLO(name)
    src = Path(name)
    if not src.is_file():
        for cand in (
            Path.cwd() / name,
            Path.home() / ".cache" / "ultralytics" / name,
        ):
            if cand.is_file():
                src = cand
                break
    ckpt = getattr(model, "ckpt_path", None) or getattr(
        getattr(model, "model", None), "ckpt_path", None
    )
    if ckpt and Path(str(ckpt)).is_file():
        src = Path(str(ckpt))

    if src.is_file() and src.resolve() != dest.resolve():
        shutil.copy2(src, dest)
        print(f"Copied → {dest}")
        return True
    if dest.is_file():
        print(f"Already present: {dest}")
        return True

    import numpy as np

    dummy = np.zeros((64, 64, 3), dtype=np.uint8)
    model.predict(dummy, verbose=False)
    found = None
    for cand in Path.cwd().rglob(name):
        if cand.is_file():
            found = cand
            break
    if found:
        shutil.copy2(found, dest)
        print(f"Copied → {dest}")
        return True
    print(
        f"權重已由 ultralytics 快取，但未複製到 {dest}。"
        f"可手動將 {name} 放到 backend/models/，或設 DETECT_MODEL_PATH。",
        file=sys.stderr,
    )
    return False


def _download_floorplan(dest: Path) -> bool:
    if dest.is_file() and dest.stat().st_size > 1_000_000:
        print(f"Already present: {dest}")
        return True
    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        print(
            "未安裝 huggingface_hub；改下載 ultralytics 預訓練權重。"
            "可：pip install huggingface_hub",
            file=sys.stderr,
        )
        return False
    print(f"Downloading {HF_FLOORPLAN_REPO}/{HF_FLOORPLAN_FILE} …")
    try:
        ckpt = hf_hub_download(HF_FLOORPLAN_REPO, HF_FLOORPLAN_FILE)
    except Exception as e:  # noqa: BLE001
        print(f"Hugging Face 下載失敗：{e}", file=sys.stderr)
        return False
    shutil.copy2(ckpt, dest)
    print(f"Copied → {dest}")
    print(
        "Note: FloorCAD symbol seg（wall/door/window…），非 room 分割；"
        "房間仍靠 OpenCV。授權請見 Hugging Face model card（Ultralytics AGPL）。"
    )
    return True



def _download_rw(dest: Path) -> bool:
    if dest.is_file() and dest.stat().st_size > 1_000_000:
        print(f"Already present: {dest}")
        return True
    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        print("未安裝 huggingface_hub；無法下載 RW-seg。", file=sys.stderr)
        return False
    print(f"Downloading {HF_RW_REPO}/{HF_RW_FILE} …")
    try:
        ckpt = hf_hub_download(HF_RW_REPO, HF_RW_FILE)
    except Exception as e:  # noqa: BLE001
        print(f"RW-seg 下載失敗：{e}", file=sys.stderr)
        return False
    shutil.copy2(ckpt, dest)
    print(f"Copied → {dest}")
    print(
        "Note: floorplan-rw-seg（room/wall/door/window/stair/annotation）；"
        "優於 FloorCAD 符號分類對行銷圖的可用性。授權見 HF model card。"
    )
    return True

def _download_cubicasa(dest_dir: Path) -> bool:
    dest_dir.mkdir(parents=True, exist_ok=True)
    ckpt = dest_dir / HF_CUBICASA_FILE
    cfg = dest_dir / HF_CUBICASA_CFG
    if ckpt.is_file() and ckpt.stat().st_size > 1_000_000:
        print(f"Already present: {ckpt}")
        if not cfg.is_file():
            try:
                from huggingface_hub import hf_hub_download
                import shutil

                c = hf_hub_download(HF_CUBICASA_REPO, HF_CUBICASA_CFG)
                shutil.copy2(c, cfg)
            except Exception as e:  # noqa: BLE001
                print(f"CubiCasa config 下載失敗（可略）：{e}", file=sys.stderr)
        return True
    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        print("未安裝 huggingface_hub；無法下載 CubiCasa。", file=sys.stderr)
        return False
    print(f"Downloading {HF_CUBICASA_REPO}/{HF_CUBICASA_FILE} …")
    try:
        import shutil

        src = hf_hub_download(HF_CUBICASA_REPO, HF_CUBICASA_FILE)
        shutil.copy2(src, ckpt)
        csrc = hf_hub_download(HF_CUBICASA_REPO, HF_CUBICASA_CFG)
        shutil.copy2(csrc, cfg)
    except Exception as e:  # noqa: BLE001
        print(f"CubiCasa 下載失敗：{e}", file=sys.stderr)
        return False
    print(f"Copied → {ckpt}")
    print(
        "Note: CubiCasa UNet（floor/wall/door/window）；房間由 floor 連通區域推得。"
        "CAD 風格較準；行銷圖請搭配 OpenCV 房間邊牆。"
    )
    return True



def main() -> int:
    parser = argparse.ArgumentParser(description="Download YOLO-seg weights for home-planner")
    parser.add_argument(
        "--name",
        default="yolo11n-seg.pt",
        help="Ultralytics weight filename fallback (default yolo11n-seg.pt)",
    )
    parser.add_argument(
        "--no-floorplan",
        action="store_true",
        help="Skip FloorCAD floorplan-seg.pt download",
    )
    parser.add_argument(
        "--cubicasa",
        action="store_true",
        default=True,
        help="Download CubiCasa UNet (floor/wall/door/window) into models/cubicasa/ (default on)",
    )
    parser.add_argument(
        "--no-cubicasa",
        action="store_true",
        help="Skip CubiCasa UNet download",
    )
    args = parser.parse_args()
    MODELS.mkdir(parents=True, exist_ok=True)

    try:
        from ultralytics import YOLO  # noqa: F401
    except ImportError:
        print("請先：pip install -r requirements.txt", file=sys.stderr)
        return 1

    ok = True
    # Preferred: room/wall/door/window YOLO-seg
    rw_dest = MODELS / RW_DEST_NAME
    if not _download_rw(rw_dest):
        print("RW-seg 略過／失敗（將嘗試 FloorCAD）。", file=sys.stderr)

    if not args.no_floorplan:
        fp_dest = MODELS / FLOORPLAN_DEST_NAME
        if not _download_floorplan(fp_dest):
            print("Floorplan 權重略過／失敗，繼續下載預訓練 nano…", file=sys.stderr)
            ok = _copy_ultralytics(args.name, MODELS / args.name) or ok
        else:
            # Also keep a nano fallback for debugging
            nano = MODELS / args.name
            if not nano.is_file():
                _copy_ultralytics(args.name, nano)
    else:
        ok = _copy_ultralytics(args.name, MODELS / args.name)

    ok = rw_dest.is_file() or ok

    if not args.no_cubicasa and args.cubicasa:
        cubi_ok = _download_cubicasa(MODELS / CUBICASA_DIR_NAME)
        ok = cubi_ok or ok
        if not cubi_ok:
            print("CubiCasa 略過／失敗（YOLO 仍可用）。", file=sys.stderr)

    print("Done. Enable with:")
    print("  export DETECT_MODE=yolo")
    print("  # optional: export DETECT_SCALE_M=10")
    print("  uvicorn main:app --reload --host 127.0.0.1 --port 8000")
    print("Or from repo root: ./scripts/dev-local.sh")
    print("Regression: python scripts/regress_detect.py")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
