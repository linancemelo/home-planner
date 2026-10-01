#!/usr/bin/env python3
"""Build a YOLO-seg dataset (room/wall/door/window/stair/annotation) for free-GPU fine-tune.

Primary source: Hugging Face ``phungpx/cubicassa5k-coco`` (CubiCasa5K polygons in
COCO format). Upstream CubiCasa5K license is **CC BY-NC 4.0** — research / personal
non-commercial fine-tune only; review before any commercial use.

Optional: weak (pseudo) labels on marketing/CAD fixtures via a pretrained YOLO-seg.

Usage (Colab / Kaggle / local)::

  python prepare_yolo_dataset.py --out ./fp_yolo --max-train 800 --max-val 80
  python prepare_yolo_dataset.py --out ./fp_yolo --weak-label-dir ./real-samples \\
      --weak-model ./floorplan-rw-seg.pt
"""

from __future__ import annotations

import argparse
import json
import random
import shutil
import sys
from pathlib import Path
from typing import Any, Iterable

# Target taxonomy must match JessiP23/floorplan-seg-v2
CLASS_NAMES = {
    0: "room",
    1: "wall",
    2: "door",
    3: "window",
    4: "stair",
    5: "annotation",
}

# CubiCasa COCO category_id → our class id (skip furniture like bed)
COCO_TO_OURS: dict[int, int] = {
    1: 0,  # bathroom → room
    3: 2,  # door
    4: 0,  # kitchen → room
    5: 0,  # room
    6: 4,  # stairs → stair
    7: 1,  # wall
    8: 3,  # window
}

LICENSE_NOTE = (
    "CubiCasa5K (via phungpx/cubicassa5k-coco): Creative Commons Attribution-"
    "NonCommercial 4.0 (CC BY-NC 4.0). Cite Kalervo et al., SCIA 2019. "
    "Non-commercial / research fine-tune only unless you obtain other rights."
)


def _poly_to_yolo_seg(
    segmentation: list[list[float]] | list[float],
    width: int,
    height: int,
) -> list[str]:
    """COCO polygon(s) → YOLO-seg normalized lines (one poly per returned string body)."""
    if not segmentation:
        return []
    # HF/COCO may store one flat list or list-of-lists
    polys: list[list[float]]
    if segmentation and isinstance(segmentation[0], (int, float)):
        polys = [list(map(float, segmentation))]  # type: ignore[arg-type]
    else:
        polys = [list(map(float, p)) for p in segmentation]  # type: ignore[arg-type]

    out: list[str] = []
    for poly in polys:
        if len(poly) < 6:
            continue
        coords: list[str] = []
        ok = True
        for i in range(0, len(poly) - 1, 2):
            x = poly[i] / float(width)
            y = poly[i + 1] / float(height)
            if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
                # clamp mild overflow from rasterization
                x = min(1.0, max(0.0, x))
                y = min(1.0, max(0.0, y))
            coords.append(f"{x:.6f}")
            coords.append(f"{y:.6f}")
        if len(coords) >= 6 and ok:
            out.append(" ".join(coords))
    return out


def _ann_list_from_row(row: dict[str, Any]) -> list[dict[str, Any]]:
    anns = row.get("annotations")
    if anns is None:
        return []
    # datasets may return list[dict] or columnar dict-of-lists
    if isinstance(anns, dict):
        keys = list(anns.keys())
        n = len(anns[keys[0]]) if keys else 0
        return [{k: anns[k][i] for k in keys} for i in range(n)]
    return list(anns)


def write_data_yaml(out_dir: Path) -> Path:
    yaml_path = out_dir / "data.yaml"
    names_block = "\n".join(f"  {i}: {n}" for i, n in CLASS_NAMES.items())
    yaml_path.write_text(
        f"# Auto-generated for home-planner floorplan YOLO-seg fine-tune\n"
        f"# {LICENSE_NOTE}\n"
        f"path: {out_dir.resolve()}\n"
        f"train: images/train\n"
        f"val: images/val\n"
        f"names:\n{names_block}\n",
        encoding="utf-8",
    )
    return yaml_path


def export_cubicasa_hf(
    out_dir: Path,
    *,
    max_train: int | None,
    max_val: int | None,
    seed: int = 42,
) -> dict[str, int]:
    try:
        from datasets import load_dataset
    except ImportError as e:
        raise SystemExit(
            "Need `datasets` (pip install datasets). On Colab/Kaggle the notebook "
            "installs it in the first cell."
        ) from e

    print("Loading phungpx/cubicassa5k-coco from Hugging Face…")
    print(f"LICENSE: {LICENSE_NOTE}")
    ds = load_dataset("phungpx/cubicassa5k-coco")

    counts = {"train": 0, "val": 0}
    rng = random.Random(seed)

    for split_src, split_dst, limit in (
        ("train", "train", max_train),
        ("valid", "val", max_val),
    ):
        if split_src not in ds:
            print(f"WARN: split {split_src} missing; skip", file=sys.stderr)
            continue
        img_dir = out_dir / "images" / split_dst
        lbl_dir = out_dir / "labels" / split_dst
        img_dir.mkdir(parents=True, exist_ok=True)
        lbl_dir.mkdir(parents=True, exist_ok=True)

        rows = list(range(len(ds[split_src])))
        rng.shuffle(rows)
        if limit is not None:
            rows = rows[: max(0, limit)]

        for idx in rows:
            row = ds[split_src][idx]
            image = row["image"]
            width = int(row.get("width") or image.width)
            height = int(row.get("height") or image.height)
            stem = Path(str(row.get("file_name") or f"{split_dst}_{idx:05d}")).stem
            # avoid collisions
            stem = f"{split_dst}_{idx:05d}_{stem}"[:120]
            img_path = img_dir / f"{stem}.jpg"
            lbl_path = lbl_dir / f"{stem}.txt"

            lines: list[str] = []
            for ann in _ann_list_from_row(row):
                cid = int(ann.get("category_id", -1))
                ours = COCO_TO_OURS.get(cid)
                if ours is None:
                    continue
                seg = ann.get("segmentation") or []
                for body in _poly_to_yolo_seg(seg, width, height):
                    lines.append(f"{ours} {body}")

            if not lines:
                continue
            image.convert("RGB").save(img_path, quality=92)
            lbl_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            counts[split_dst] += 1
            if counts[split_dst] % 100 == 0:
                print(f"  {split_dst}: {counts[split_dst]} images…")

    write_data_yaml(out_dir)
    (out_dir / "LICENSE.txt").write_text(LICENSE_NOTE + "\n", encoding="utf-8")
    return counts


def export_weak_labels(
    out_dir: Path,
    image_paths: Iterable[Path],
    model_path: Path,
    *,
    split: str = "train",
    conf: float = 0.25,
    imgsz: int = 640,
) -> int:
    """Pseudo-label fixture images with a pretrained YOLO-seg and append to dataset."""
    from ultralytics import YOLO
    from PIL import Image

    model = YOLO(str(model_path))
    img_dir = out_dir / "images" / split
    lbl_dir = out_dir / "labels" / split
    img_dir.mkdir(parents=True, exist_ok=True)
    lbl_dir.mkdir(parents=True, exist_ok=True)

    name_to_id = {v: k for k, v in CLASS_NAMES.items()}
    # also accept model.names strings
    n = 0
    for src in image_paths:
        src = Path(src)
        if not src.is_file():
            continue
        results = model.predict(str(src), conf=conf, imgsz=imgsz, verbose=False)
        if not results:
            continue
        r0 = results[0]
        h, w = int(r0.orig_shape[0]), int(r0.orig_shape[1])
        lines: list[str] = []
        if r0.masks is not None and r0.boxes is not None:
            cls_ids = r0.boxes.cls.cpu().numpy().astype(int)
            # ultralytics masks.xyn is already normalized polygons
            xyn = r0.masks.xyn
            model_names = r0.names or {}
            for ci, poly in zip(cls_ids, xyn):
                cname = str(model_names.get(int(ci), "")).lower()
                ours = name_to_id.get(cname)
                if ours is None:
                    # try alias
                    if cname in ("rooms", "area", "space"):
                        ours = 0
                    elif cname in ("walls",):
                        ours = 1
                    elif cname in ("doors", "opening"):
                        ours = 2
                    elif cname in ("windows", "win"):
                        ours = 3
                    elif cname in ("stairs",):
                        ours = 4
                    else:
                        continue
                flat = poly.reshape(-1)
                if flat.size < 6:
                    continue
                coords = " ".join(f"{float(v):.6f}" for v in flat)
                lines.append(f"{ours} {coords}")
        if not lines:
            continue
        stem = f"weak_{src.stem}"
        dst = img_dir / f"{stem}{src.suffix.lower() if src.suffix else '.jpg'}"
        if src.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}:
            shutil.copy2(src, dst)
        else:
            Image.open(src).convert("RGB").save(dst.with_suffix(".jpg"), quality=92)
            dst = dst.with_suffix(".jpg")
        (lbl_dir / f"{dst.stem}.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
        n += 1
        print(f"  weak-label: {src.name} → {len(lines)} instances")
    write_data_yaml(out_dir)
    return n


def make_synthetic_smoke(out_dir: Path, n_train: int = 24, n_val: int = 6) -> dict[str, int]:
    """Tiny synthetic rectangles so the training loop can be smoke-tested offline."""
    import numpy as np
    from PIL import Image, ImageDraw

    counts = {"train": 0, "val": 0}
    rng = random.Random(0)
    for split, n in (("train", n_train), ("val", n_val)):
        img_dir = out_dir / "images" / split
        lbl_dir = out_dir / "labels" / split
        img_dir.mkdir(parents=True, exist_ok=True)
        lbl_dir.mkdir(parents=True, exist_ok=True)
        for i in range(n):
            w, h = 640, 480
            im = Image.new("RGB", (w, h), (245, 245, 240))
            draw = ImageDraw.Draw(im)
            lines: list[str] = []
            # outer wall ring
            margin = 40
            wall_t = 12
            draw.rectangle([margin, margin, w - margin, h - margin], outline=(30, 30, 30), width=wall_t)
            # wall poly (outer rect as thin ring approximated by filled outer - skip; use box)
            def box_poly(x0, y0, x1, y1, cls_id: int) -> None:
                xs = [x0 / w, y0 / h, x1 / w, y0 / h, x1 / w, y1 / h, x0 / w, y1 / h]
                lines.append(f"{cls_id} " + " ".join(f"{v:.6f}" for v in xs))

            box_poly(margin, margin, w - margin, margin + wall_t, 1)
            box_poly(margin, h - margin - wall_t, w - margin, h - margin, 1)
            box_poly(margin, margin, margin + wall_t, h - margin, 1)
            box_poly(w - margin - wall_t, margin, w - margin, h - margin, 1)
            # rooms
            mid = w // 2
            box_poly(margin + wall_t + 4, margin + wall_t + 4, mid - 4, h - margin - wall_t - 4, 0)
            box_poly(mid + 4, margin + wall_t + 4, w - margin - wall_t - 4, h - margin - wall_t - 4, 0)
            # door / window
            dx = mid - 20
            box_poly(dx, h - margin - wall_t - 2, dx + 40, h - margin + 2, 2)
            wx = margin + 80 + rng.randint(0, 40)
            box_poly(wx, margin - 2, wx + 50, margin + wall_t + 2, 3)
            stem = f"synth_{split}_{i:03d}"
            im.save(img_dir / f"{stem}.jpg", quality=90)
            (lbl_dir / f"{stem}.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
            counts[split] += 1
    write_data_yaml(out_dir)
    (out_dir / "LICENSE.txt").write_text(
        "Synthetic smoke data generated by prepare_yolo_dataset.py (public domain).\n",
        encoding="utf-8",
    )
    return counts


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, default=Path("./fp_yolo_dataset"))
    p.add_argument("--max-train", type=int, default=800, help="Cap CubiCasa train images (None=all via -1)")
    p.add_argument("--max-val", type=int, default=80)
    p.add_argument("--synthetic-only", action="store_true", help="Skip CubiCasa; write tiny synthetic set")
    p.add_argument("--weak-label-dir", type=Path, default=None, help="Dir of *.jpg for pseudo-labels")
    p.add_argument("--weak-model", type=Path, default=None, help="YOLO-seg .pt for weak labels")
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()

    out = args.out
    out.mkdir(parents=True, exist_ok=True)

    max_train = None if args.max_train is not None and args.max_train < 0 else args.max_train
    max_val = None if args.max_val is not None and args.max_val < 0 else args.max_val

    if args.synthetic_only:
        counts = make_synthetic_smoke(out)
        print(f"Synthetic dataset → {out} {counts}")
    else:
        try:
            counts = export_cubicasa_hf(out, max_train=max_train, max_val=max_val, seed=args.seed)
            print(f"CubiCasa export → {out} {counts}")
        except SystemExit:
            raise
        except Exception as e:  # noqa: BLE001
            print(f"CubiCasa download/convert failed: {e}", file=sys.stderr)
            print("Falling back to synthetic smoke dataset…", file=sys.stderr)
            counts = make_synthetic_smoke(out)
            print(f"Synthetic fallback → {out} {counts}")

    if args.weak_label_dir and args.weak_model:
        paths = sorted(args.weak_label_dir.glob("*-b.jpg"))
        if not paths:
            paths = sorted(args.weak_label_dir.glob("*.jpg"))
        n = export_weak_labels(out, paths, args.weak_model, split="train")
        print(f"Added {n} weak-labeled images from {args.weak_label_dir}")

    meta = {
        "out": str(out.resolve()),
        "counts": counts if isinstance(counts, dict) else {},
        "license": LICENSE_NOTE,
        "class_names": CLASS_NAMES,
    }
    (out / "prepare_meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {out / 'data.yaml'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
