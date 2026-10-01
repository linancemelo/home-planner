"""YOLO-seg + OpenCV floor-plan detect pipeline.

Loads ultralytics seg weights (floorplan-tuned if present, else pretrained nano),
runs inference, converts masks/boxes → geometry, then derives
walls / doors / windows / rooms in metres (bottom-left origin).

When the model has no floorplan classes (COCO pretrained), OpenCV contour /
edge geometry carries most of the structure; YOLO masks are best-effort.
If the model fails to load, callers should fall back to mock_layout.
"""

from __future__ import annotations

import os
from collections import defaultdict
from pathlib import Path
from typing import Any

import cv2
import numpy as np

WALL_THICKNESS_M = 0.12
CEILING_HEIGHT_M = 2.8
SILL_HEIGHT_M = 0.9
DEFAULT_LAYOUT_WIDTH_M = 8.0

# Class name aliases (custom floorplan / FloorCAD / remapped)
ROOM_ALIASES = {"room", "rooms", "area", "space", "客廳", "臥室", "房間"}
WALL_ALIASES = {"wall", "walls", "partition", "牆"}
DOOR_ALIASES = {
    "door",
    "doors",
    "opening",
    "opening_symbol",
    "single_door",
    "double_door",
    "sliding_door",
    "folding_door",
    "門",
}
WINDOW_ALIASES = {
    "window",
    "windows",
    "win",
    "bay_window",
    "blind_window",
    "窗",
}

_MODEL = None
_MODEL_PATH: str | None = None
_MODEL_ERROR: str | None = None


def models_dir() -> Path:
    return Path(__file__).resolve().parent / "models"


def default_model_path() -> Path:
    env = os.environ.get("DETECT_MODEL_PATH", "").strip()
    if env:
        return Path(env)
    for name in (
        "floorplan-seg.pt",
        "yolo11n-seg.pt",
        "yolov8n-seg.pt",
    ):
        p = models_dir() / name
        if p.is_file():
            return p
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
        load_arg: str | Path = path
        if not path.is_file():
            load_arg = path.name
        _MODEL = YOLO(str(load_arg))
        _MODEL_PATH = str(path if path.is_file() else load_arg)
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
    if cv2.contourArea(cnt) < 40:
        return None
    peri = cv2.arcLength(cnt, True)
    approx = cv2.approxPolyDP(cnt, epsilon_frac * peri, True)
    if len(approx) < 3:
        return None
    return approx.reshape(-1, 2).astype(np.float64)


def _classify_name(name: str) -> str | None:
    n = name.strip().lower().replace("-", "_").replace(" ", "_")
    if n in ROOM_ALIASES or any(a in n for a in ("room", "客廳", "臥室", "廚房", "衛浴")):
        return "room"
    if n in WALL_ALIASES or "wall" in n or "牆" in n:
        return "wall"
    if n in DOOR_ALIASES or "door" in n or "opening" in n or "門" in n:
        return "door"
    if n in WINDOW_ALIASES or "window" in n or "窗" in n:
        return "window"
    return None


def _estimate_mpp(bgr: np.ndarray, width_px: int) -> tuple[float, list[str], bool]:
    """metres-per-pixel from env, DPI heuristic, or default layout width.

    Priority:
      1. DETECT_SCALE_M — assumed outer layout width in metres
      2. Rough DPI / EXIF-less heuristic from image size (marketing plans ~150–300 DPI)
      3. DEFAULT_LAYOUT_WIDTH_M across ~84% of image width
    """
    notes: list[str] = []
    scale_env = os.environ.get("DETECT_SCALE_M", "").strip()
    if scale_env:
        try:
            layout_w = float(scale_env)
            if layout_w > 0.5:
                mpp = layout_w / max(width_px * 0.84, 1.0)
                notes.append(
                    f"比例由 DETECT_SCALE_M={layout_w} m 推得 metersPerPixel≈{mpp:.5f}（scaleTrusted=false）。"
                )
                return mpp, notes, False
        except ValueError:
            notes.append(f"DETECT_SCALE_M={scale_env!r} 無效，改用預設比例。")

    # Heuristic: very large marketing renders often depict ~10–14 m homes
    h, w = bgr.shape[:2]
    long_side = max(h, w)
    if long_side >= 1600:
        layout_w = 12.0
        notes.append(
            f"大型圖（長邊 {long_side} px）啟發式假設外框寬≈{layout_w} m。"
        )
    elif long_side >= 1000:
        layout_w = 10.0
        notes.append(
            f"中型圖（長邊 {long_side} px）啟發式假設外框寬≈{layout_w} m。"
        )
    else:
        layout_w = DEFAULT_LAYOUT_WIDTH_M
        notes.append(
            f"比例假設外框寬≈{layout_w} m（可用 DETECT_SCALE_M 覆寫）。"
        )
    mpp = layout_w / max(width_px * 0.84, 1.0)
    notes.append(f"metersPerPixel≈{mpp:.5f}（scaleTrusted=false）。")
    return mpp, notes, False


def _merge_collinear_walls(
    walls: list[dict[str, Any]],
    *,
    axis_tol_m: float = 0.12,
    gap_tol_m: float = 0.35,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Merge nearly-collinear H/V wall segments that overlap or nearly touch."""
    notes: list[str] = []
    if len(walls) < 2:
        return walls, notes

    hv: list[tuple[str, float, float, float, dict[str, Any]]] = []
    diagonal: list[dict[str, Any]] = []
    for w in walls:
        ax, ay = w["a"]["x"], w["a"]["y"]
        bx, by = w["b"]["x"], w["b"]["y"]
        if abs(ay - by) <= axis_tol_m and abs(ax - bx) > 0.25:
            t0, t1 = sorted([ax, bx])
            hv.append(("h", (ay + by) / 2, t0, t1, w))
        elif abs(ax - bx) <= axis_tol_m and abs(ay - by) > 0.25:
            t0, t1 = sorted([ay, by])
            hv.append(("v", (ax + bx) / 2, t0, t1, w))
        else:
            diagonal.append(w)

    groups: dict[tuple[str, int], list[tuple[float, float, float, dict[str, Any]]]] = defaultdict(list)
    for orient, const, t0, t1, w in hv:
        key = (orient, int(round(const / max(axis_tol_m, 0.05))))
        groups[key].append((const, t0, t1, w))

    merged: list[dict[str, Any]] = []
    mid = 0
    for (orient, _), segs in groups.items():
        segs = sorted(segs, key=lambda s: s[1])
        cur_const, cur_t0, cur_t1, _src = segs[0]
        for const, t0, t1, _w in segs[1:]:
            if t0 <= cur_t1 + gap_tol_m:
                cur_t1 = max(cur_t1, t1)
                cur_const = (cur_const + const) / 2
            else:
                mid += 1
                if orient == "h":
                    a, b = (cur_t0, cur_const), (cur_t1, cur_const)
                else:
                    a, b = (cur_const, cur_t0), (cur_const, cur_t1)
                merged.append(
                    {
                        "id": f"w-m-{mid}",
                        "a": _vec(*a),
                        "b": _vec(*b),
                        "thicknessM": WALL_THICKNESS_M,
                        "thicknessAssumed": True,
                        "heightM": CEILING_HEIGHT_M,
                    }
                )
                cur_const, cur_t0, cur_t1 = const, t0, t1
        mid += 1
        if orient == "h":
            a, b = (cur_t0, cur_const), (cur_t1, cur_const)
        else:
            a, b = (cur_const, cur_t0), (cur_const, cur_t1)
        merged.append(
            {
                "id": f"w-m-{mid}",
                "a": _vec(*a),
                "b": _vec(*b),
                "thicknessM": WALL_THICKNESS_M,
                "thicknessAssumed": True,
                "heightM": CEILING_HEIGHT_M,
            }
        )

    out = merged + diagonal
    if len(out) < len(walls):
        notes.append(f"牆段共線合併：{len(walls)} → {len(out)}。")
    return out, notes


def _opencv_rooms_and_walls(
    bgr: np.ndarray,
    *,
    mpp: float,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """Classical floor-plan geometry: large ink regions → rooms; edges → walls."""
    notes: list[str] = []
    h, w = bgr.shape[:2]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    thr = cv2.adaptiveThreshold(
        blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 35, 8
    )
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    closed = cv2.morphologyEx(thr, cv2.MORPH_CLOSE, kernel, iterations=2)

    free = cv2.bitwise_not(closed)
    free = cv2.morphologyEx(free, cv2.MORPH_OPEN, kernel, iterations=2)
    margin = max(4, min(w, h) // 80)
    free[:margin, :] = 0
    free[-margin:, :] = 0
    free[:, :margin] = 0
    free[:, -margin:] = 0

    n_labels, labels, stats, _ = cv2.connectedComponentsWithStats(free, connectivity=8)
    min_area = (w * h) * 0.015
    rooms: list[dict[str, Any]] = []
    room_polys_px: list[np.ndarray] = []
    for i in range(1, n_labels):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        mask = (labels == i).astype(np.uint8) * 255
        poly = _approx_polygon(mask, epsilon_frac=0.012)
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
    edges = cv2.Canny(blur, 50, 150)
    edges = cv2.bitwise_or(edges, closed)
    min_len = max(28, int(min(w, h) * 0.06))
    lines = cv2.HoughLinesP(
        edges, 1, np.pi / 180, threshold=55, minLineLength=min_len, maxLineGap=15
    )
    if lines is not None:
        for i, line in enumerate(lines.reshape(-1, 4)):
            x1, y1, x2, y2 = (float(line[0]), float(line[1]), float(line[2]), float(line[3]))
            if abs(x2 - x1) < 8:
                x2 = x1
            if abs(y2 - y1) < 8:
                y2 = y1
            a = _px_to_m(x1, y1, height_px=h, mpp=mpp)
            b = _px_to_m(x2, y2, height_px=h, mpp=mpp)
            length = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
            if length < 0.35:
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

    walls, merge_notes = _merge_collinear_walls(walls)
    notes.extend(merge_notes)

    if len(walls) > 60:
        walls = sorted(
            walls,
            key=lambda ww: (
                (ww["a"]["x"] - ww["b"]["x"]) ** 2 + (ww["a"]["y"] - ww["b"]["y"]) ** 2
            ),
            reverse=True,
        )[:60]
        notes.append("牆段過多，已截斷至 60 條較長區段。")

    if not walls and room_polys_px:
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
    """Heuristic: collinear wall pairs with a short gap → door; wider gaps → window."""
    notes: list[str] = []
    doors: list[dict[str, Any]] = []
    windows: list[dict[str, Any]] = []
    hv: list[tuple[str, str, float, float, float]] = []
    for w in walls:
        ax, ay = w["a"]["x"], w["a"]["y"]
        bx, by = w["b"]["x"], w["b"]["y"]
        if abs(ay - by) < 0.1 and abs(ax - bx) > 0.3:
            t0, t1 = sorted([ax, bx])
            hv.append(("h", w["id"], (ay + by) / 2, t0, t1))
        elif abs(ax - bx) < 0.1 and abs(ay - by) > 0.3:
            t0, t1 = sorted([ay, by])
            hv.append(("v", w["id"], (ax + bx) / 2, t0, t1))

    groups: dict[tuple[str, int], list[tuple[str, float, float]]] = defaultdict(list)
    for orient, wid, const, t0, t1 in hv:
        key = (orient, int(round(const * 20)))
        groups[key].append((wid, t0, t1))

    for (orient, _), segs in groups.items():
        segs = sorted(segs, key=lambda s: s[1])
        for i in range(len(segs) - 1):
            wid_a, _, t1 = segs[i]
            _, t0_next, _ = segs[i + 1]
            gap = t0_next - t1
            const = None
            for w in walls:
                if w["id"] == wid_a:
                    if orient == "h":
                        const = (w["a"]["y"] + w["b"]["y"]) / 2
                        oa, ob = (t1, const), (t0_next, const)
                    else:
                        const = (w["a"]["x"] + w["b"]["x"]) / 2
                        oa, ob = (const, t1), (const, t0_next)
                    break
            if const is None:
                continue
            if 0.5 <= gap <= 1.4:
                leaf = round(gap, 4)
                doors.append(
                    {
                        "id": f"d-gap-{len(doors)+1}",
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
            elif 1.4 < gap <= 2.8:
                windows.append(
                    {
                        "id": f"win-gap-{len(windows)+1}",
                        "wallId": wid_a,
                        "opening": _seg(oa, ob),
                        "confidence": 0.4,
                        "sillHeightM": SILL_HEIGHT_M,
                        "sillHeightAssumed": True,
                    }
                )

    if doors or windows:
        notes.append(
            f"由共線牆段缺口推估門 {len(doors)}、窗 {len(windows)}（啟發式，請人工確認）。"
        )
    else:
        notes.append("未從牆段缺口推估到門／窗；將嘗試連通性補開口。")
    return doors, windows, notes


def _room_aabb(room: dict[str, Any]) -> tuple[float, float, float, float] | None:
    verts = room.get("vertices") or []
    if len(verts) < 3:
        return None
    xs = [v["x"] for v in verts]
    ys = [v["y"] for v in verts]
    return min(xs), min(ys), max(xs), max(ys)


def _opening_touches_aabb(
    op_a: tuple[float, float],
    op_b: tuple[float, float],
    aabb: tuple[float, float, float, float],
    tol: float = 0.3,
) -> bool:
    mx = (op_a[0] + op_b[0]) / 2
    my = (op_a[1] + op_b[1]) / 2
    min_x, min_y, max_x, max_y = aabb
    return (
        min_x - tol <= mx <= max_x + tol and min_y - tol <= my <= max_y + tol
    )


def _ensure_room_access(
    rooms: list[dict[str, Any]],
    walls: list[dict[str, Any]],
    doors: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """ensureRoomAccess-style: sealed rooms get a door on longest shared/boundary wall."""
    notes: list[str] = []
    if len(rooms) < 1:
        return walls, doors, notes

    aabbs: list[tuple[str, tuple[float, float, float, float]]] = []
    for r in rooms:
        box = _room_aabb(r)
        if box:
            aabbs.append((r["id"], box))

    def room_has_door(rid: str, box: tuple[float, float, float, float]) -> bool:
        for d in doors:
            oa = (d["opening"]["a"]["x"], d["opening"]["a"]["y"])
            ob = (d["opening"]["b"]["x"], d["opening"]["b"]["y"])
            if _opening_touches_aabb(oa, ob, box):
                return True
        return False

    def walls_on_boundary(box: tuple[float, float, float, float]) -> list[dict[str, Any]]:
        min_x, min_y, max_x, max_y = box
        out = []
        for w in walls:
            mx = (w["a"]["x"] + w["b"]["x"]) / 2
            my = (w["a"]["y"] + w["b"]["y"]) / 2
            near = (
                abs(mx - min_x) < 0.35
                or abs(mx - max_x) < 0.35
                or abs(my - min_y) < 0.35
                or abs(my - max_y) < 0.35
            )
            inside = min_x - 0.4 <= mx <= max_x + 0.4 and min_y - 0.4 <= my <= max_y + 0.4
            if near and inside:
                out.append(w)
        return out

    for rid, box in aabbs:
        if room_has_door(rid, box):
            continue
        boundary = walls_on_boundary(box)
        if not boundary:
            notes.append(f"連通性：房間 {rid} 無邊界牆可補開口，請人工確認。")
            continue
        best = max(
            boundary,
            key=lambda w: (
                (w["a"]["x"] - w["b"]["x"]) ** 2 + (w["a"]["y"] - w["b"]["y"]) ** 2
            ),
        )
        ax, ay = best["a"]["x"], best["a"]["y"]
        bx, by = best["b"]["x"], best["b"]["y"]
        dx, dy = bx - ax, by - ay
        L = (dx * dx + dy * dy) ** 0.5 or 1.0
        # Center 0.9 m opening
        open_len = min(0.9, L * 0.45)
        mid = 0.5
        hx, hy = dx / L, dy / L
        cx, cy = ax + dx * mid, ay + dy * mid
        oa = (cx - hx * open_len / 2, cy - hy * open_len / 2)
        ob = (cx + hx * open_len / 2, cy + hy * open_len / 2)
        did = f"d-access-{len(doors)+1}"
        doors.append(
            {
                "id": did,
                "kind": "swing",
                "wallId": best["id"],
                "opening": _seg(oa, ob),
                "confidence": 0.35,
                "swing": {
                    "hinge": _vec(*oa),
                    "leafLengthM": round(open_len, 4),
                    "openDirection": "cw",
                    "arcQuarter": True,
                },
            }
        )
        notes.append(
            f"連通性：房間 {rid} 無出入口，已在牆 {best['id']} 補開口（請於疊圖確認）。"
        )

    return walls, doors, notes


def _box_to_opening_m(
    xyxy: np.ndarray,
    *,
    height_px: int,
    mpp: float,
) -> tuple[tuple[float, float], tuple[float, float]]:
    x1, y1, x2, y2 = [float(v) for v in xyxy]
    w_box, h_box = abs(x2 - x1), abs(y2 - y1)
    if w_box >= h_box:
        # horizontal opening along bottom of box
        ya = (y1 + y2) / 2
        a = _px_to_m(min(x1, x2), ya, height_px=height_px, mpp=mpp)
        b = _px_to_m(max(x1, x2), ya, height_px=height_px, mpp=mpp)
    else:
        xa = (x1 + x2) / 2
        a = _px_to_m(xa, max(y1, y2), height_px=height_px, mpp=mpp)
        b = _px_to_m(xa, min(y1, y2), height_px=height_px, mpp=mpp)
    return a, b


def _box_to_wall_segment_m(
    xyxy: np.ndarray,
    *,
    height_px: int,
    mpp: float,
) -> tuple[tuple[float, float], tuple[float, float]]:
    x1, y1, x2, y2 = [float(v) for v in xyxy]
    w_box, h_box = abs(x2 - x1), abs(y2 - y1)
    if w_box >= h_box:
        ya = (y1 + y2) / 2
        return (
            _px_to_m(min(x1, x2), ya, height_px=height_px, mpp=mpp),
            _px_to_m(max(x1, x2), ya, height_px=height_px, mpp=mpp),
        )
    xa = (x1 + x2) / 2
    return (
        _px_to_m(xa, max(y1, y2), height_px=height_px, mpp=mpp),
        _px_to_m(xa, min(y1, y2), height_px=height_px, mpp=mpp),
    )


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
    mpp, scale_notes, scale_trusted = _estimate_mpp(bgr, w)

    notes: list[str] = [
        "後端 YOLO＋OpenCV 管線（mock=false）。",
        "單位：公尺；座標原點：圖面左下（bottom-left）。",
        *scale_notes,
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
    else:
        notes.append(
            "權重含平面圖相關類別（wall/door/window 等）；YOLO 框／遮罩與 OpenCV 併用。"
        )

    yolo_rooms: list[dict[str, Any]] = []
    yolo_walls: list[dict[str, Any]] = []
    yolo_doors: list[dict[str, Any]] = []
    yolo_windows: list[dict[str, Any]] = []
    confs: list[float] = []

    conf_thr = 0.15 if has_floorplan_classes else 0.25
    try:
        results = model.predict(bgr, verbose=False, conf=conf_thr, iou=0.5)
    except Exception as e:  # noqa: BLE001
        notes.append(f"YOLO 推論失敗，改純 OpenCV：{e}")
        results = []

    for result in results or []:
        masks = getattr(result, "masks", None)
        boxes = getattr(result, "boxes", None)
        if boxes is None:
            continue
        try:
            cls_ids = boxes.cls.cpu().numpy().astype(int)
            conf_arr = boxes.conf.cpu().numpy()
            xyxy = boxes.xyxy.cpu().numpy()
        except Exception:  # noqa: BLE001
            continue

        mask_data = None
        if masks is not None:
            try:
                mask_data = masks.data.cpu().numpy()
            except Exception:  # noqa: BLE001
                mask_data = None

        for mi, (cls_id, conf) in enumerate(zip(cls_ids, conf_arr)):
            cname = str(names.get(int(cls_id), str(cls_id)))
            kind = _classify_name(cname)
            if kind is None and mask_data is None:
                continue
            confs.append(float(conf))

            poly = None
            if mask_data is not None and mi < len(mask_data):
                raw_mask = mask_data[mi]
                if raw_mask.shape[0] != h or raw_mask.shape[1] != w:
                    raw_mask = cv2.resize(raw_mask, (w, h), interpolation=cv2.INTER_LINEAR)
                poly = _approx_polygon((raw_mask > 0.5).astype(np.uint8) * 255)

            if kind == "room" or (
                kind is None
                and poly is not None
                and float(cv2.contourArea(poly.astype(np.float32).reshape(-1, 1, 2)))
                > (w * h * 0.03)
            ):
                if poly is None:
                    continue
                verts_m = [
                    _px_to_m(float(x), float(y), height_px=h, mpp=mpp) for x, y in poly
                ]
                yolo_rooms.append(
                    {
                        "id": f"room-yolo-{len(yolo_rooms)+1}",
                        "type": cname if kind == "room" else "房間",
                        "vertices": [_vec(*p) for p in verts_m],
                        "confidence": round(float(conf), 3),
                    }
                )
            elif kind == "wall":
                if poly is not None and len(poly) >= 2:
                    verts_m = [
                        _px_to_m(float(x), float(y), height_px=h, mpp=mpp) for x, y in poly
                    ]
                    best = (0.0, verts_m[0], verts_m[1] if len(verts_m) > 1 else verts_m[0])
                    for i in range(len(verts_m)):
                        a, b = verts_m[i], verts_m[(i + 1) % len(verts_m)]
                        d = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
                        if d > best[0]:
                            best = (d, a, b)
                    a_m, b_m = best[1], best[2]
                else:
                    a_m, b_m = _box_to_wall_segment_m(xyxy[mi], height_px=h, mpp=mpp)
                length = ((a_m[0] - b_m[0]) ** 2 + (a_m[1] - b_m[1]) ** 2) ** 0.5
                if length < 0.25:
                    continue
                yolo_walls.append(
                    {
                        "id": f"w-yolo-{len(yolo_walls)+1}",
                        "a": _vec(*a_m),
                        "b": _vec(*b_m),
                        "thicknessM": WALL_THICKNESS_M,
                        "thicknessAssumed": True,
                        "heightM": CEILING_HEIGHT_M,
                    }
                )
            elif kind == "door":
                oa, ob = _box_to_opening_m(xyxy[mi], height_px=h, mpp=mpp)
                leaf = ((oa[0] - ob[0]) ** 2 + (oa[1] - ob[1]) ** 2) ** 0.5
                yolo_doors.append(
                    {
                        "id": f"d-yolo-{len(yolo_doors)+1}",
                        "kind": "sliding" if "sliding" in cname.lower() else "swing",
                        "wallId": "w-unknown",
                        "opening": _seg(oa, ob),
                        "confidence": round(float(conf), 3),
                        "swing": {
                            "hinge": _vec(*oa),
                            "leafLengthM": round(leaf, 4),
                            "openDirection": "cw",
                            "arcQuarter": True,
                        },
                    }
                )
            elif kind == "window":
                oa, ob = _box_to_opening_m(xyxy[mi], height_px=h, mpp=mpp)
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
        f"YOLO 解析：房間 {len(yolo_rooms)}、牆 {len(yolo_walls)}、"
        f"門 {len(yolo_doors)}、窗 {len(yolo_windows)}（conf≥{conf_thr}）。"
    )

    cv_rooms, cv_walls, cv_notes = _opencv_rooms_and_walls(bgr, mpp=mpp)
    notes.extend(cv_notes)

    rooms = yolo_rooms if yolo_rooms else cv_rooms
    walls = yolo_walls if yolo_walls else cv_walls
    if yolo_walls and cv_walls and len(yolo_walls) < 6:
        walls = yolo_walls + cv_walls
        notes.append("YOLO 牆段稀疏，已併用 OpenCV Hough 牆段。")
        walls, merge_notes = _merge_collinear_walls(walls)
        notes.extend(merge_notes)

    doors = list(yolo_doors)
    windows = list(yolo_windows)
    # Always try gap heuristics to supplement (YOLO often misses marketing-plan doors)
    gap_doors, gap_wins, gap_notes = _openings_from_gaps(walls)
    notes.extend(gap_notes)
    if not doors:
        doors.extend(gap_doors)
    elif gap_doors and len(doors) < 2:
        doors.extend(gap_doors[:2])
        notes.append("已併用缺口啟發式補出門候選。")
    if not windows:
        windows.extend(gap_wins)

    for d in doors:
        oa = (d["opening"]["a"]["x"], d["opening"]["a"]["y"])
        ob = (d["opening"]["b"]["x"], d["opening"]["b"]["y"])
        d["wallId"] = _nearest_wall_id(oa, ob, walls)
    for win in windows:
        oa = (win["opening"]["a"]["x"], win["opening"]["a"]["y"])
        ob = (win["opening"]["b"]["x"], win["opening"]["b"]["y"])
        win["wallId"] = _nearest_wall_id(oa, ob, walls)

    walls, doors, access_notes = _ensure_room_access(rooms, walls, doors)
    notes.extend(access_notes)
    notes.append(
        "連通性：請確認門／窗是否落在牆段上；匯入後可於 2D 微調。"
        "無專用微調權重時結果僅供參考。"
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
            "scaleTrusted": scale_trusted,
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
