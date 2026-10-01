#!/usr/bin/env python3
"""Render detect overlays for QA baselines."""
from __future__ import annotations
import json
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
sys.path.insert(0, str(ROOT))
from yolo_pipeline import run_yolo_detect  # noqa: E402

FIX = REPO / "src" / "import-plan" / "fixtures" / "real-samples"
OUT = ROOT / "fixtures" / "qa-overlays"


def _m_to_px(x, y, mpp, h):
    return int(round(x / mpp)), int(round(h - y / mpp))


def draw(img_bgr, result):
    h, w = img_bgr.shape[:2]
    mpp = float(result["meta"]["metersPerPixel"])
    vis = img_bgr.copy()
    # rooms fill
    for r in result.get("rooms") or []:
        verts = r.get("vertices") or []
        if len(verts) < 3:
            continue
        pts = np.array([_m_to_px(v["x"], v["y"], mpp, h) for v in verts], np.int32)
        overlay = vis.copy()
        cv2.fillPoly(overlay, [pts], (80, 200, 80))
        vis = cv2.addWeighted(overlay, 0.28, vis, 0.72, 0)
        cv2.polylines(vis, [pts], True, (40, 180, 40), 2, cv2.LINE_AA)
        n = len(verts)
        if n >= 6:
            cv2.putText(vis, f"L{n}", tuple(pts[0]), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 120, 0), 1)
    for wseg in result.get("walls") or []:
        a, b = wseg["a"], wseg["b"]
        p1 = _m_to_px(a["x"], a["y"], mpp, h)
        p2 = _m_to_px(b["x"], b["y"], mpp, h)
        color = (0, 0, 220) if "ring" in str(wseg.get("id", "")) else (40, 40, 40)
        cv2.line(vis, p1, p2, color, 2, cv2.LINE_AA)
    for d in result.get("doors") or []:
        a, b = d["opening"]["a"], d["opening"]["b"]
        cv2.line(vis, _m_to_px(a["x"], a["y"], mpp, h), _m_to_px(b["x"], b["y"], mpp, h), (0, 165, 255), 3)
    for win in result.get("windows") or []:
        a, b = win["opening"]["a"], win["opening"]["b"]
        cv2.line(vis, _m_to_px(a["x"], a["y"], mpp, h), _m_to_px(b["x"], b["y"], mpp, h), (255, 128, 0), 3)
    return vis


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    for p in sorted(FIX.glob("*-b.jpg")):
        bgr = cv2.imread(str(p))
        result = run_yolo_detect(p.read_bytes(), source_name=p.name)
        after = draw(bgr, result)
        after_path = OUT / f"after_{p.stem}.png"
        # before = previous after (copy if exists as before)
        before_path = OUT / f"before_{p.stem}.png"
        prev_after = after_path if after_path.exists() else None
        # Keep existing after as before if we haven't already snapshotted this run
        if after_path.exists() and not (OUT / f".snap_{p.stem}").exists():
            import shutil
            shutil.copy(after_path, before_path)
            (OUT / f".snap_{p.stem}").write_text("1")
        cv2.imwrite(str(after_path), after)
        before = cv2.imread(str(before_path)) if before_path.exists() else bgr
        if before is None:
            before = bgr
        # match heights
        th = max(before.shape[0], after.shape[0])
        def pad(im):
            if im.shape[0] == th:
                return im
            out = np.full((th, im.shape[1], 3), 255, np.uint8)
            out[:im.shape[0]] = im
            return out
        diff = np.hstack([pad(before), pad(after)])
        cv2.imwrite(str(OUT / f"diff_{p.stem}.png"), diff)
        rooms = result["rooms"]
        n_non = sum(1 for r in rooms if len(r.get("vertices") or []) >= 6)
        ring = sum(1 for w in result["walls"] if "ring" in str(w.get("id", "")))
        win_ring = sum(1 for w in result["windows"] if "ring" in str(w.get("wallId", "")))
        peri = sum(1 for w in result["windows"] if str(w.get("id","")).startswith("win-peri"))
        rows.append({
            "image": p.name,
            "walls": len(result["walls"]),
            "doors": len(result["doors"]),
            "windows": len(result["windows"]),
            "rooms": len(rooms),
            "ring_segs": ring,
            "non_aabb_rooms": n_non,
            "windows_on_ring": win_ring,
            "peri_windows": peri,
            "mpp": result["meta"]["metersPerPixel"],
            "notes_head": (result.get("notes") or [])[:8],
        })
        print(p.name, rows[-1]["walls"], rows[-1]["rooms"], "nonAABB", n_non)
    (OUT / "qa-measured-detail.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n")
    print("wrote", OUT / "qa-measured-detail.json")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
