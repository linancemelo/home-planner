"""YOLO-seg + OpenCV floor-plan detect pipeline.

Loads ultralytics seg weights (floorplan-tuned if present, else pretrained nano),
runs inference, converts masks → polygons (approxPolyDP), then derives
walls / doors / windows / rooms in metres (bottom-left origin).

When the model has no floorplan classes (COCO pretrained), OpenCV contour /
edge geometry carries most of the structure; YOLO masks are best-effort.
If the model fails to load, callers should fall back to mock_layout.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import cv2
import numpy as np

WALL_THICKNESS_M = 0.12
CEILING_HEIGHT_M = 2.8
SILL_HEIGHT_M = 0.9
DEFAULT_LAYOUT_WIDTH_M = 8.0

# Class name aliases (custom floorplan weights or remapped)
ROOM_ALIASES = {"room", "rooms", "area", "space", "客廳", "臥室", "房間"}
WALL_ALIASES = {"wall", "walls", "partition", "牆"}
DOOR_ALIASES = {"door", "doors", "opening", "門"}
WINDOW_ALIASES = {"window", "windows", "win", "窗"}

_MODEL = None
_MODEL_PATH: str | None = None
_MODEL_ERROR: str | None = None


def models_dir() -> Path:
    return Path(__file__).resolve().parent / "models"


def default_model_path() -> Path:
    env = os.environ.get("DETECT_MODEL_PATH", "").strip()
    if env:
        return Path(env)
    # Prefer explicit placeholder / downloaded weights in backend/models/
    for name in (
        "floorplan-seg.pt",
        "yolo11n-seg.pt",
        "yolov8n-seg.pt",
    ):
        p = models_dir() / name
        if p.is_file():
            return p
    # Ultralytics will auto-download this name into CWD / weights cache
    return models_dir() / "yolo11n-seg.pt"


def get_model_load_error() -> str | None:
    return _MODEL_ERROR


def load_model(force: bool = False):
    """Load YOLO seg model once. Raises on failure."""
    global _MODEL, _MODEL_PATH, _MODEL_ERROR
    if _MODEL is not None and not force:
        return _MODEL
    _MODEL_ERROR = None
    path = default_model_path()
    try:
        from ultralytics import YOLO  # lazy import
    except Exception as e:  # noqa: BLE001
        _MODEL_ERROR = f"無法匯入 ultralytics：{e}"
        raise RuntimeError(_MODEL_ERROR) from e

    try:
        # If file missing, pass stem name so ultralytics can download pretrained
        load_arg: str | Path = path
        if not path.is_file():
            load_arg = path.name  # e.g. yolo11n-seg.pt → hub download
        _MODEL = YOLO(str(load_arg))
        _MODEL_PATH = str(path)
        # If downloaded to CWD, try copy/link into models/ for next time
        if not path.is_file():
            for candidate in (Path.cwd() / path.name, Path(path.name)):
                if candidate.is_file():
                    try:
                        models_dir().mkdir(parents=True, exist_ok=True)
                        if not path.exists():
                            path.write_bytes(candidate.read_bytes())
                    except OSError:
                        pass
                    break
        return _MODEL
    except Exception as e:  # noqa: BLE001
        _MODEL_ERROR = f"無法載入 YOLO 權重（{path}）：{e}"
        _MODEL = None
        raise RuntimeError(_MODEL_ERROR) from e


def _vec(x: float, y: float) -> dict[str, float]:
    return {"x": round(float(x), 4), "y": round(float(y), 4)}


def _seg(a: tuple[float, float], b: tuple[float, float]) -> dict[str, Any]:
    return {"a": _vec(*a), "b": _vec(*b)}


def _px_to_m(
    x_px: float,
    y_px: float,
    *,
    height_px: int,
    mpp: float,
) -> tuple[float, float]:
    """Image top-left pixels → metres bottom-left."""
    return (x_px * mpp, (height_px - y_px) * mpp)


def _approx_polygon(mask: np.ndarray, epsilon_frac: float = 0.02) -> np.ndarray | None:
    """mask (H,W) uint8 → Nx2 contour points (pixel, top-left), or None."""
    m = (mask > 0).astype(np.uint8) * 255
    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    cnt = max(contours, key=cv2.contourArea)
    if cv2.contourArea(cnt) < 80:
        return None
    peri = cv2.arcLength(cnt, True)
    approx = cv2.approxPolyDP(cnt, epsilon_frac * peri, True)
    if len(approx) < 3:
        return None
    return approx.reshape(-1, 2).astype(np.float64)


def _classify_name(name: str) -> str | None:
    n = name.strip().lower()
    if n in ROOM_ALIASES or any(a in n for a in ("room", "客廳", "臥室", "廚房", "衛浴")):
        return "room"
    if n in WALL_ALIASES or "wall" in n or "牆" in n:
        return "wall"
    if n in DOOR_ALIASES or "door" in n or "門" in n:
        return "door"
    if n in WINDOW_ALIASES or "window" in n or "窗" in n:
        return "window"
    return None


def _opencv_rooms_and_walls(
    bgr: np.ndarray,
    *,
    mpp: float,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """Classical floor-plan geometry: large ink regions → rooms; edges → walls."""
    notes: list[str] = []
    h, w = bgr.shape[:2]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    # Floorplans: dark lines on light paper — invert so walls/rooms are white blobs
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    thr = cv2.adaptiveThreshold(
        blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 35, 8
    )
    # Close gaps in wall lines, then find empty room interiors via distance / flood
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    closed = cv2.morphologyEx(thr, cv2.MORPH_CLOSE, kernel, iterations=2)

    # Room interiors: inverted closed (open space), remove noise
    free = cv2.bitwise_not(closed)
    free = cv2.morphologyEx(free, cv2.MORPH_OPEN, kernel, iterations=2)
    # Drop border frame a bit
    margin = max(4, min(w, h) // 80)
    free[:margin, :] = 0
    free[-margin:, :] = 0
    free[:, :margin] = 0
    free[:, -margin:] = 0

    n_labels, labels, stats, _ = cv2.connectedComponentsWithStats(free, connectivity=8)
    min_area = (w * h) * 0.02
    rooms: list[dict[str, Any]] = []
    room_polys_px: list[np.ndarray] = []
    for i in range(1, n_labels):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        mask = (labels == i).astype(np.uint8) * 255
        poly = _approx_polygon(mask, epsilon_frac=0.015)
        if poly is None or len(poly) < 3:
            continue
        room_polys_px.append(poly)
        verts = [
            _vec(*_px_to_m(float(x), float(y), height_px=h, mpp=mpp)) for x, y in poly
        ]
        rooms.append(
            {
                "id": f"room-{len(rooms)+1}",
                "type": "房間",
                "vertices": verts,
                "confidence": 0.55,
            }
        )

    notes.append(
        f"OpenCV 連通區域房間候選 {len(rooms)} 個（面積門檻≈{min_area:.0f} px）。"
    )

    walls: list[dict[str, Any]] = []
    # Prefer Hough lines on wall ink for segments
    edges = cv2.Canny(blur, 50, 150)
    edges = cv2.bitwise_or(edges, closed)
    min_len = max(30, int(min(w, h) * 0.08))
    lines = cv2.HoughLinesP(
        edges, 1, np.pi / 180, threshold=60, minLineLength=min_len, maxLineGap=12
    )
    if lines is not None:
        for i, line in enumerate(lines.reshape(-1, 4)):
            x1, y1, x2, y2 = (float(line[0]), float(line[1]), float(line[2]), float(line[3]))
            # Snap near-axis
            if abs(x2 - x1) < 8:
                x2 = x1
            if abs(y2 - y1) < 8:
                y2 = y1
            a = _px_to_m(x1, y1, height_px=h, mpp=mpp)
            b = _px_to_m(x2, y2, height_px=h, mpp=mpp)
            length = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
            if length < 0.4:
                continue
            walls.append(
                {
                    "id": f"w-cv-{i}",
                    "a": _vec(*a),
                    "b": _vec(*b),
                    "thicknessM": WALL_THICKNESS_M,
                    "thicknessAssumed": True,
                    "heightM": CEILING_HEIGHT_M,
                }
            )

    # Cap wall count to keep response usable
    if len(walls) > 80:
        walls = sorted(
            walls,
            key=lambda w: (
                (w["a"]["x"] - w["b"]["x"]) ** 2 + (w["a"]["y"] - w["b"]["y"]) ** 2
            ),
            reverse=True,
        )[:80]
        notes.append("牆段過多，已截斷至 80 條較長區段。")

    if not walls and room_polys_px:
        # Derive wall segments from room polygon edges
        for ri, poly in enumerate(room_polys_px):
            pts = poly.tolist()
            for j in range(len(pts)):
                x1, y1 = pts[j]
                x2, y2 = pts[(j + 1) % len(pts)]
                a = _px_to_m(x1, y1, height_px=h, mpp=mpp)
                b = _px_to_m(x2, y2, height_px=h, mpp=mpp)
                walls.append(
                    {
                        "id": f"w-room{ri}-e{j}",
                        "a": _vec(*a),
                        "b": _vec(*b),
                        "thicknessM": WALL_THICKNESS_M,
                        "thicknessAssumed": True,
                        "heightM": CEILING_HEIGHT_M,
                    }
                )
        notes.append("Hough 無足夠線段，改由房間多邊形邊推導牆段。")

    if not walls:
        notes.append("OpenCV 未能抽出牆段；請換更清楚的線稿平面圖或使用 floorplan 微調權重。")

    return rooms, walls, notes


def _nearest_wall_id(
    opening_a: tuple[float, float],
    opening_b: tuple[float, float],
    walls: list[dict[str, Any]],
) -> str:
    if not walls:
        return "w-unknown"
    mx = (opening_a[0] + opening_b[0]) / 2
    my = (opening_a[1] + opening_b[1]) / 2
    best_id = walls[0]["id"]
    best_d = 1e9
    for w in walls:
        ax, ay = w["a"]["x"], w["a"]["y"]
        bx, by = w["b"]["x"], w["b"]["y"]
        # distance from midpoint to segment
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy or 1e-9
        t = max(0.0, min(1.0, ((mx - ax) * dx + (my - ay) * dy) / L2))
        px, py = ax + t * dx, ay + t * dy
        d = (px - mx) ** 2 + (py - my) ** 2
        if d < best_d:
            best_d = d
            best_id = w["id"]
    return best_id


def _openings_from_gaps(
    walls: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """Heuristic: collinear wall pairs with a short gap → door; outer short gaps → window."""
    notes: list[str] = []
    doors: list[dict[str, Any]] = []
    windows: list[dict[str, Any]] = []
    # Group nearly-collinear horizontal / vertical walls and find gaps 0.6–1.2 m
    hv: list[tuple[str, str, float, float, float]] = []
    # (orient, wall_id, const, t0, t1) where const is y for H or x for V
    for w in walls:
        ax, ay = w["a"]["x"], w["a"]["y"]
        bx, by = w["b"]["x"], w["b"]["y"]
        if abs(ay - by) < 0.08 and abs(ax - bx) > 0.3:
            t0, t1 = sorted([ax, bx])
            hv.append(("h", w["id"], (ay + by) / 2, t0, t1))
        elif abs(ax - bx) < 0.08 and abs(ay - by) > 0.3:
            t0, t1 = sorted([ay, by])
            hv.append(("v", w["id"], (ax + bx) / 2, t0, t1))

    # Sort and look for gaps between segments sharing orient+const
    from collections import defaultdict

    groups: dict[tuple[str, int], list[tuple[str, float, float]]] = defaultdict(list)
    for orient, wid, const, t0, t1 in hv:
        key = (orient, int(round(const * 20)))  # ~5 cm buckets
        groups[key].append((wid, t0, t1))

    for (orient, _), segs in groups.items():
        segs = sorted(segs, key=lambda s: s[1])
        for i in range(len(segs) - 1):
            wid_a, _, t1 = segs[i]
            wid_b, t0_next, _ = segs[i + 1]
            gap = t0_next - t1
            if 0.55 <= gap <= 1.35:
                # door
                const = None
                for w in walls:
                    if w["id"] == wid_a:
                        if orient == "h":
                            const = w["a"]["y"]
                            oa, ob = (t1, const), (t0_next, const)
                        else:
                            const = w["a"]["x"]
                            oa, ob = (const, t1), (const, t0_next)
                        break
                if const is None:
                    continue
                did = f"d-gap-{len(doors)+1}"
                leaf = round(gap, 4)
                doors.append(
                    {
                        "id": did,
                        "kind": "swing",
                        "wallId": wid_a,
                        "opening": _seg(oa, ob),
                        "confidence": 0.45,
                        "swing": {
                            "hinge": _vec(*oa),
                            "leafLengthM": leaf,
                            "openDirection": "cw",
                            "arcQuarter": True,
                        },
                    }
                )
            elif 0.9 <= gap <= 2.5 and orient in ("h", "v"):
                # possible window on outer run
                for w in walls:
                    if w["id"] == segs[i][0]:
                        if orient == "h":
                            const = w["a"]["y"]
                            oa, ob = (t1, const), (t0_next, const)
                        else:
                            const = w["a"]["x"]
                            oa, ob = (const, t1), (const, t0_next)
                        windows.append(
                            {
                                "id": f"win-gap-{len(windows)+1}",
                                "wallId": segs[i][0],
                                "opening": _seg(oa, ob),
                                "confidence": 0.4,
                                "sillHeightM": SILL_HEIGHT_M,
                                "sillHeightAssumed": True,
                            }
                        )
                        break

    if doors or windows:
        notes.append(
            f"由共線牆段缺口推估門 {len(doors)}、窗 {len(windows)}（啟發式，請人工確認）。"
        )
    else:
        notes.append("未從牆段缺口推估到門／窗；連通性請於匯入後微調。")
    return doors, windows, notes


def run_yolo_detect(
    image_bytes: bytes,
    *,
    source_name: str,
) -> dict[str, Any]:
    """Full detect path. Raises if model cannot load."""
    model = load_model()
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError("無法解碼影像（請上傳 PNG／JPEG）")
    h, w = bgr.shape[:2]
    mpp = DEFAULT_LAYOUT_WIDTH_M / max(w * 0.84, 1.0)  # ~8% margin each side

    notes: list[str] = [
        "後端 YOLO＋OpenCV 管線（mock=false）。",
        "單位：公尺；座標原點：圖面左下（bottom-left）。",
        f"比例假設外框寬≈{DEFAULT_LAYOUT_WIDTH_M} m，metersPerPixel≈{mpp:.5f}（scaleTrusted=false）。",
        f"天花板假設 {CEILING_HEIGHT_M} m；牆厚假設 {WALL_THICKNESS_M} m；窗台假設 {SILL_HEIGHT_M} m。",
    ]

    names: dict[int, str] = {}
    try:
        names = dict(getattr(model, "names", {}) or {})
    except Exception:  # noqa: BLE001
        names = {}

    has_floorplan_classes = any(
        _classify_name(str(n)) is not None for n in names.values()
    )
    if not has_floorplan_classes:
        notes.append(
            "目前權重似乎非平面圖微調（無 room/wall/door/window 類別）；"
            "YOLO 遮罩僅作 best-effort，主要結構由 OpenCV 幾何後處理產生。"
            "可將微調權放置於 backend/models/floorplan-seg.pt 或設 DETECT_MODEL_PATH。"
        )

    # Run YOLO
    yolo_rooms: list[dict[str, Any]] = []
    yolo_walls: list[dict[str, Any]] = []
    yolo_doors: list[dict[str, Any]] = []
    yolo_windows: list[dict[str, Any]] = []
    confs: list[float] = []

    try:
        results = model.predict(bgr, verbose=False, conf=0.25, iou=0.5)
    except Exception as e:  # noqa: BLE001
        notes.append(f"YOLO 推論失敗，改純 OpenCV：{e}")
        results = []

    for ri, result in enumerate(results or []):
        masks = getattr(result, "masks", None)
        boxes = getattr(result, "boxes", None)
        if masks is None or boxes is None:
            continue
        try:
            mask_data = masks.data.cpu().numpy()  # N,H,W
        except Exception:  # noqa: BLE001
            continue
        cls_ids = boxes.cls.cpu().numpy().astype(int)
        conf_arr = boxes.conf.cpu().numpy()
        for mi, (cls_id, conf) in enumerate(zip(cls_ids, conf_arr)):
            if mi >= len(mask_data):
                break
            raw_mask = mask_data[mi]
            # Resize mask to image size if needed
            if raw_mask.shape[0] != h or raw_mask.shape[1] != w:
                raw_mask = cv2.resize(raw_mask, (w, h), interpolation=cv2.INTER_LINEAR)
            poly = _approx_polygon((raw_mask > 0.5).astype(np.uint8) * 255)
            if poly is None:
                continue
            cname = str(names.get(int(cls_id), str(cls_id)))
            kind = _classify_name(cname)
            confs.append(float(conf))
            verts_m = [
                _px_to_m(float(x), float(y), height_px=h, mpp=mpp) for x, y in poly
            ]
            area_px = float(cv2.contourArea(poly.astype(np.float32).reshape(-1, 1, 2)))
            if kind == "room" or (kind is None and area_px > (w * h * 0.03)):
                # large unknown → room candidate
                yolo_rooms.append(
                    {
                        "id": f"room-yolo-{len(yolo_rooms)+1}",
                        "type": cname if kind == "room" else "房間",
                        "vertices": [_vec(*p) for p in verts_m],
                        "confidence": round(float(conf), 3),
                    }
                )
            elif kind == "wall":
                # wall mask → longest edge as segment
                pts = list(verts_m)
                best = (0.0, pts[0], pts[1] if len(pts) > 1 else pts[0])
                for i in range(len(pts)):
                    a, b = pts[i], pts[(i + 1) % len(pts)]
                    d = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
                    if d > best[0]:
                        best = (d, a, b)
                yolo_walls.append(
                    {
                        "id": f"w-yolo-{len(yolo_walls)+1}",
                        "a": _vec(*best[1]),
                        "b": _vec(*best[2]),
                        "thicknessM": WALL_THICKNESS_M,
                        "thicknessAssumed": True,
                        "heightM": CEILING_HEIGHT_M,
                    }
                )
            elif kind == "door":
                # opening = bbox diagonal of poly
                xs = [p[0] for p in verts_m]
                ys = [p[1] for p in verts_m]
                oa, ob = (min(xs), min(ys)), (max(xs), min(ys))
                if abs(max(ys) - min(ys)) > abs(max(xs) - min(xs)):
                    oa, ob = (min(xs), min(ys)), (min(xs), max(ys))
                yolo_doors.append(
                    {
                        "id": f"d-yolo-{len(yolo_doors)+1}",
                        "kind": "swing",
                        "wallId": "w-unknown",
                        "opening": _seg(oa, ob),
                        "confidence": round(float(conf), 3),
                        "swing": {
                            "hinge": _vec(*oa),
                            "leafLengthM": round(
                                ((oa[0] - ob[0]) ** 2 + (oa[1] - ob[1]) ** 2) ** 0.5, 4
                            ),
                            "openDirection": "cw",
                            "arcQuarter": True,
                        },
                    }
                )
            elif kind == "window":
                xs = [p[0] for p in verts_m]
                ys = [p[1] for p in verts_m]
                oa, ob = (min(xs), min(ys)), (max(xs), min(ys))
                if abs(max(ys) - min(ys)) > abs(max(xs) - min(xs)):
                    oa, ob = (min(xs), min(ys)), (min(xs), max(ys))
                yolo_windows.append(
                    {
                        "id": f"win-yolo-{len(yolo_windows)+1}",
                        "wallId": "w-unknown",
                        "opening": _seg(oa, ob),
                        "confidence": round(float(conf), 3),
                        "sillHeightM": SILL_HEIGHT_M,
                        "sillHeightAssumed": True,
                    }
                )

    notes.append(
        f"YOLO 遮罩解析：房間 {len(yolo_rooms)}、牆 {len(yolo_walls)}、"
        f"門 {len(yolo_doors)}、窗 {len(yolo_windows)}。"
    )

    cv_rooms, cv_walls, cv_notes = _opencv_rooms_and_walls(bgr, mpp=mpp)
    notes.extend(cv_notes)

    # Merge: prefer YOLO floorplan-class hits; else OpenCV
    rooms = yolo_rooms if yolo_rooms else cv_rooms
    walls = yolo_walls if yolo_walls else cv_walls
    if yolo_walls and cv_walls and len(yolo_walls) < 4:
        # sparse YOLO walls → supplement with OpenCV
        walls = yolo_walls + cv_walls
        notes.append("YOLO 牆段稀疏，已併用 OpenCV Hough 牆段。")

    doors = list(yolo_doors)
    windows = list(yolo_windows)
    if not doors and not windows:
        gap_doors, gap_wins, gap_notes = _openings_from_gaps(walls)
        doors.extend(gap_doors)
        windows.extend(gap_wins)
        notes.extend(gap_notes)

    # Bind openings to nearest wall
    for d in doors:
        oa = (d["opening"]["a"]["x"], d["opening"]["a"]["y"])
        ob = (d["opening"]["b"]["x"], d["opening"]["b"]["y"])
        d["wallId"] = _nearest_wall_id(oa, ob, walls)
    for win in windows:
        oa = (win["opening"]["a"]["x"], win["opening"]["a"]["y"])
        ob = (win["opening"]["b"]["x"], win["opening"]["b"]["y"])
        win["wallId"] = _nearest_wall_id(oa, ob, walls)

    notes.append(
        "連通性：請確認門／窗是否落在牆段上；匯入後可於 2D 微調。"
        "無平面圖微調權重時結果僅供參考。"
    )

    if confs:
        overall = round(float(sum(confs) / len(confs)), 3)
    else:
        overall = 0.5 if walls else 0.2

    model_label = _MODEL_PATH or "yolo-seg"
    notes.insert(1, f"模型：{model_label}")

    return {
        "version": 1,
        "kind": "detect-result",
        "meta": {
            "sourceName": source_name or "upload.png",
            "imageWidthPx": int(w),
            "imageHeightPx": int(h),
            "metersPerPixel": round(mpp, 6),
            "scaleTrusted": False,
            "coordinateOrigin": "bottom-left",
            "ceilingHeightM": CEILING_HEIGHT_M,
            "ceilingHeightAssumed": True,
            "detectionConfidence": overall,
            "units": "meters",
            "notes": notes,
        },
        "walls": walls,
        "doors": doors,
        "windows": windows,
        "rooms": rooms,
        "confidence": overall,
        "notes": notes,
        "mock": False,
        "mode": "yolo",
    }
