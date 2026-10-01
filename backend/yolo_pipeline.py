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


def _seg_length_m(w: dict[str, Any]) -> float:
    return (
        (w["a"]["x"] - w["b"]["x"]) ** 2 + (w["a"]["y"] - w["b"]["y"]) ** 2
    ) ** 0.5


def _filter_short_walls(
    walls: list[dict[str, Any]], *, min_len_m: float = 0.65
) -> list[dict[str, Any]]:
    return [w for w in walls if _seg_length_m(w) >= min_len_m]


def _merge_collinear_walls(
    walls: list[dict[str, Any]],
    *,
    axis_tol_m: float = 0.15,
    gap_tol_m: float = 0.45,
    min_len_m: float = 0.65,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Merge nearly-collinear H/V wall segments that overlap or nearly touch."""
    notes: list[str] = []
    if len(walls) < 2:
        return _filter_short_walls(walls, min_len_m=min_len_m), notes

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
    out = _filter_short_walls(out, min_len_m=min_len_m)
    if len(out) < len(walls):
        notes.append(f"牆段共線合併／去短：{len(walls)} → {len(out)}。")
    return out, notes



def _detect_content_roi(bgr: np.ndarray) -> tuple[int, int, int, int, list[str]]:
    """Crop to the indoor floor-plan drawing only.

    Ignores titles/headers, marketing banners, color strips, watermarks,
    decorative chrome/frames, and white pads — especially critical for 591
    marketing renders. Returns half-open pixel box (x0, y0, x1, y1) + notes.
    """
    notes: list[str] = []
    h, w = bgr.shape[:2]
    x0, y0, x1, y1 = 0, 0, w, h
    gray_u8 = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    gray = gray_u8.astype(np.float32)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1].astype(np.float32)
    row_mean = gray.mean(axis=1)
    row_std = gray.std(axis=1)
    col_mean = gray.mean(axis=0)
    col_std = gray.std(axis=0)
    row_sat = sat.mean(axis=1)
    col_sat = sat.mean(axis=0)
    mid_sat = (
        float(np.median(row_sat[h // 4 : 3 * h // 4])) if h >= 8 else float(row_sat.mean())
    )

    # 1) Near-white / flat borders (CAD pads, English marketing margins)
    for i in range(min(h // 5, 120)):
        if row_mean[i] >= 245 and row_std[i] < 6:
            y0 = i + 1
        else:
            break
    for i in range(h - 1, max(h - 1 - h // 5, h // 2), -1):
        if row_mean[i] >= 245 and row_std[i] < 6:
            y1 = i
        else:
            break
    for i in range(min(w // 5, 120)):
        if col_mean[i] >= 245 and col_std[i] < 6:
            x0 = i + 1
        else:
            break
    for i in range(w - 1, max(w - 1 - w // 5, w // 2), -1):
        if col_mean[i] >= 245 and col_std[i] < 6:
            x1 = i
        else:
            break

    # 2) Saturated marketing color bars / peach frame strips (591 blue banner)
    sat_cut = max(mid_sat + 50.0, 100.0)
    for i in range(h - 1, max(h // 2, y0), -1):
        if row_sat[i] >= sat_cut:
            y1 = min(y1, i)
        elif y1 < h:
            break
    for i in range(min(h // 3, y1)):
        if row_sat[i] >= sat_cut:
            y0 = max(y0, i + 1)
        else:
            break
    for i in range(min(w // 3, x1)):
        if col_sat[i] >= sat_cut:
            x0 = max(x0, i + 1)
        else:
            break
    for i in range(w - 1, max(2 * w // 3, x0), -1):
        if col_sat[i] >= sat_cut:
            x1 = min(x1, i)
        else:
            break

    x0, y0, x1, y1 = int(x0), int(y0), int(x1), int(y1)

    # 3) Tighten to the actual floor-plan drawing (ignore titles/headers/roses)
    #    Busy = Canny edges outside high-sat chrome within the coarse ROI.
    if x1 - x0 > 40 and y1 - y0 > 40:
        roi_gray = gray_u8[y0:y1, x0:x1]
        roi_sat = sat[y0:y1, x0:x1]
        edges = cv2.Canny(roi_gray, 50, 150)
        busy = (edges > 0) & (roi_sat < 70)
        row_b = busy.sum(axis=1).astype(np.float64)
        col_b = busy.sum(axis=0).astype(np.float64)
        nz_r = row_b[row_b > 0]
        nz_c = col_b[col_b > 0]
        rt = float(max(16.0, np.percentile(nz_r, 28))) if nz_r.size else 16.0
        ct = float(max(16.0, np.percentile(nz_c, 28))) if nz_c.size else 16.0

        def _span(arr: np.ndarray, thr: float) -> tuple[int | None, int | None]:
            start = end = None
            run = 0
            n = len(arr)
            for i in range(n):
                if arr[i] >= thr:
                    run += 1
                    if run >= 3 and start is None:
                        start = i - 2
                else:
                    run = 0
            run = 0
            for i in range(n - 1, -1, -1):
                if arr[i] >= thr:
                    run += 1
                    if run >= 3 and end is None:
                        end = i + 3
                else:
                    run = 0
            if start is None or end is None or end <= start:
                return None, None
            return max(0, start), min(n, end)

        ys, ye = _span(row_b, rt)
        xs, xe = _span(col_b, ct)
        if ys is not None and xs is not None:
            # Pad ~2.5% so outer walls are not clipped
            pad_y = max(4, int((ye - ys) * 0.025))
            pad_x = max(4, int((xe - xs) * 0.025))
            nx0 = x0 + max(0, xs - pad_x)
            ny0 = y0 + max(0, ys - pad_y)
            nx1 = x0 + min(x1 - x0, xe + pad_x)
            ny1 = y0 + min(y1 - y0, ye + pad_y)
            # Only accept if still a large fraction of coarse ROI
            if (nx1 - nx0) >= (x1 - x0) * 0.42 and (ny1 - ny0) >= (y1 - y0) * 0.42:
                x0, y0, x1, y1 = int(nx0), int(ny0), int(nx1), int(ny1)
                notes.append(
                    "已再收斂至平面圖繪圖區（略過標題／頁眉／浮水印／裝飾）。"
                )

    min_w, min_h = int(w * 0.40), int(h * 0.40)
    if (x1 - x0) < min_w or (y1 - y0) < min_h:
        notes.append("內容 ROI 過緊，改回全圖（僅保留邊緣 margin 邏輯）。")
        return 0, 0, int(w), int(h), notes

    if (x0 > 2) or (y0 > 2) or (x1 < w - 2) or (y1 < h - 2):
        notes.append(
            f"分析前裁切至室內平面圖繪圖區：({x0},{y0})–({x1},{y1})"
            f"（原 {w}×{h}；略過標題／橫幅／色條／邊框 chrome）。"
        )
    return int(x0), int(y0), int(x1), int(y1), notes


def _mask_outside_roi(bgr: np.ndarray, roi: tuple[int, int, int, int]) -> np.ndarray:
    """Paint chrome outside content ROI white so detectors never see titles/banners."""
    x0, y0, x1, y1 = roi
    out = np.full_like(bgr, 255)
    out[y0:y1, x0:x1] = bgr[y0:y1, x0:x1]
    return out


def _room_aabb(room: dict[str, Any]) -> tuple[float, float, float, float] | None:
    verts = room.get("vertices") or []
    if len(verts) < 3:
        return None
    xs = [v["x"] for v in verts]
    ys = [v["y"] for v in verts]
    return min(xs), min(ys), max(xs), max(ys)


def _point_seg_dist_m(
    mx: float, my: float, ax: float, ay: float, bx: float, by: float
) -> float:
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy or 1e-9
    t = max(0.0, min(1.0, ((mx - ax) * dx + (my - ay) * dy) / L2))
    px, py = ax + t * dx, ay + t * dy
    return float(((px - mx) ** 2 + (py - my) ** 2) ** 0.5)


def _nearest_wall_dist_m(
    opening_a: tuple[float, float],
    opening_b: tuple[float, float],
    walls: list[dict[str, Any]],
) -> float:
    if not walls:
        return 1e9
    mx = (opening_a[0] + opening_b[0]) / 2
    my = (opening_a[1] + opening_b[1]) / 2
    best = 1e9
    for w in walls:
        d = _point_seg_dist_m(
            mx, my, w["a"]["x"], w["a"]["y"], w["b"]["x"], w["b"]["y"]
        )
        if d < best:
            best = d
    return best


def _project_opening_onto_nearest_wall(
    oa: tuple[float, float],
    ob: tuple[float, float],
    walls: list[dict[str, Any]],
) -> tuple[tuple[float, float], tuple[float, float], str, float] | None:
    """Snap opening centerline onto nearest wall; keep length along wall direction."""
    if not walls:
        return None
    mx = (oa[0] + ob[0]) / 2
    my = (oa[1] + ob[1]) / 2
    best = None
    best_d = 1e9
    for w in walls:
        ax, ay = w["a"]["x"], w["a"]["y"]
        bx, by = w["b"]["x"], w["b"]["y"]
        d = _point_seg_dist_m(mx, my, ax, ay, bx, by)
        if d < best_d:
            best_d = d
            best = w
    if best is None:
        return None
    ax, ay = best["a"]["x"], best["a"]["y"]
    bx, by = best["b"]["x"], best["b"]["y"]
    dx, dy = bx - ax, by - ay
    L = (dx * dx + dy * dy) ** 0.5 or 1.0
    hx, hy = dx / L, dy / L
    # Project midpoint onto infinite line then clamp to segment
    t = ((mx - ax) * hx + (my - ay) * hy)
    t = max(0.0, min(L, t))
    cx, cy = ax + hx * t, ay + hy * t
    open_len = ((oa[0] - ob[0]) ** 2 + (oa[1] - ob[1]) ** 2) ** 0.5
    open_len = min(open_len, L * 0.9)
    na = (cx - hx * open_len / 2, cy - hy * open_len / 2)
    nb = (cx + hx * open_len / 2, cy + hy * open_len / 2)
    return na, nb, best["id"], best_d


def _filter_openings_near_walls(
    items: list[dict[str, Any]],
    walls: list[dict[str, Any]],
    *,
    max_dist_m: float = 0.45,
    snap_max_m: float = 0.9,
) -> tuple[list[dict[str, Any]], int, int]:
    """Keep / snap openings near walls; drop those still too far after snap."""
    kept: list[dict[str, Any]] = []
    dropped = 0
    snapped = 0
    for it in items:
        oa = (it["opening"]["a"]["x"], it["opening"]["a"]["y"])
        ob = (it["opening"]["b"]["x"], it["opening"]["b"]["y"])
        dist = _nearest_wall_dist_m(oa, ob, walls)
        if dist <= max_dist_m:
            kept.append(it)
            continue
        if dist <= snap_max_m:
            proj = _project_opening_onto_nearest_wall(oa, ob, walls)
            if proj is not None:
                na, nb, wid, _d = proj
                it = dict(it)
                it["opening"] = _seg(na, nb)
                it["wallId"] = wid
                kept.append(it)
                snapped += 1
                continue
        dropped += 1
    return kept, dropped, snapped


def _poly_contour_m(room: dict[str, Any]) -> np.ndarray | None:
    verts = room.get("vertices") or []
    if len(verts) < 3:
        return None
    return np.array([[v["x"], v["y"]] for v in verts], dtype=np.float32)


def _wall_interior_hit_ratio(
    wall: dict[str, Any],
    rooms: list[dict[str, Any]],
    *,
    margin_m: float = 0.38,
) -> float:
    """Fraction of samples that cut open floor (deep inside a room, near no boundary).

    Nested free-space blobs: an inner room edge is deep inside an outer hull —
    those samples sit near *some* room boundary and must not be rejected.
    """
    ax, ay = wall["a"]["x"], wall["a"]["y"]
    bx, by = wall["b"]["x"], wall["b"]["y"]
    contours = [c for r in rooms if (c := _poly_contour_m(r)) is not None]
    if not contours:
        return 0.0
    hits = 0
    n = 0
    for t in (0.2, 0.35, 0.5, 0.65, 0.8):
        mx = ax + (bx - ax) * t
        my = ay + (by - ay) * t
        n += 1
        dists = [
            float(cv2.pointPolygonTest(cnt, (float(mx), float(my)), True))
            for cnt in contours
        ]
        # Near any room edge → treat as structural (incl. nested room walls)
        if any(abs(d) <= margin_m for d in dists):
            continue
        # Deep inside some room and not near any boundary → transect
        if any(d > margin_m for d in dists):
            hits += 1
    return hits / max(n, 1)


def _filter_transecting_walls(
    walls: list[dict[str, Any]],
    rooms: list[dict[str, Any]],
    *,
    max_ratio: float = 0.45,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Reject wall segments that cut through open room interiors."""
    notes: list[str] = []
    if not walls or not rooms:
        return walls, notes
    kept: list[dict[str, Any]] = []
    dropped = 0
    for w in walls:
        ratio = _wall_interior_hit_ratio(w, rooms)
        if ratio > max_ratio:
            dropped += 1
            continue
        kept.append(w)
    if dropped:
        notes.append(
            f"剔除穿越室內淨空的偽牆 {dropped} 條（抽樣點深入房間 >{max_ratio:.0%}）。"
        )
    return kept, notes


def _filter_chrome_rooms(
    rooms: list[dict[str, Any]],
    *,
    roi_m: tuple[float, float, float, float] | None,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Drop rooms glued to banner/frame chrome or thin edge strips."""
    notes: list[str] = []
    if not rooms:
        return rooms, notes
    kept: list[dict[str, Any]] = []
    dropped = 0
    for r in rooms:
        box = _room_aabb(r)
        if not box:
            dropped += 1
            continue
        min_x, min_y, max_x, max_y = box
        w_m = max_x - min_x
        h_m = max_y - min_y
        # Thin strip (banner / frame bar)
        if h_m > 1e-6 and (w_m / max(h_m, 1e-6)) >= 4.5 and h_m < 1.35:
            dropped += 1
            continue
        if w_m > 1e-6 and (h_m / max(w_m, 1e-6)) >= 4.5 and w_m < 1.35:
            dropped += 1
            continue
        cx, cy = (min_x + max_x) / 2, (min_y + max_y) / 2
        if roi_m is not None:
            rx0, ry0, rx1, ry1 = roi_m
            if cx < rx0 - 0.05 or cx > rx1 + 0.05 or cy < ry0 - 0.05 or cy > ry1 + 0.05:
                dropped += 1
                continue
            # Mostly sitting on / below ROI bottom (banner remnant in BL coords)
            if max_y <= ry0 + 0.55 and h_m < 1.4:
                dropped += 1
                continue
        kept.append(r)
    if dropped:
        notes.append(f"剔除貼邊框／底欄／細長 chrome 房間 {dropped} 個。")
    return kept, notes


def _opencv_rooms_and_walls(
    bgr: np.ndarray,
    *,
    mpp: float,
    content_roi: tuple[int, int, int, int] | None = None,
    skip_skeleton: bool = False,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """Classical floor-plan geometry with furniture denoise.

    Prefer room free-space → polygon edges as structural walls (far fewer
    false segments than raw Canny+Hough on marketing textures). For CAD-like
    sparse ink, also skeletonize thick dark walls.
    """
    notes: list[str] = []
    h, w = bgr.shape[:2]
    if content_roi is not None:
        x0, y0, x1, y1 = (int(v) for v in content_roi)
        notes.append("使用上游已裁切之室內平面圖繪圖區（略過標題／橫幅／chrome）。")
    else:
        x0, y0, x1, y1, roi_notes = _detect_content_roi(bgr)
        notes.extend(roi_notes)
    # ROI in metres (bottom-left): y grows upward
    roi_m = (
        x0 * mpp,
        (h - y1) * mpp,
        x1 * mpp,
        (h - y0) * mpp,
    )

    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    thr = cv2.adaptiveThreshold(
        blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 35, 8
    )
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    closed = cv2.morphologyEx(thr, cv2.MORPH_CLOSE, kernel, iterations=2)

    # Drop tiny / compact blobs (furniture outlines, text) — keep elongated ink
    n_lab, labels, stats, _ = cv2.connectedComponentsWithStats(closed, connectivity=8)
    ink = np.zeros_like(closed)
    min_ink = max(25, int(min(w, h) * 0.002))
    for i in range(1, n_lab):
        area = int(stats[i, cv2.CC_STAT_AREA])
        ww = int(stats[i, cv2.CC_STAT_WIDTH])
        hh = int(stats[i, cv2.CC_STAT_HEIGHT])
        aspect = max(ww, hh) / (min(ww, hh) + 1e-6)
        if area >= min_ink and (aspect >= 2.2 or area >= 140):
            ink[labels == i] = 255
    notes.append("OpenCV 去噪：剔除短促／緊湊墨跡（家具／文字傾向）。")

    free = cv2.bitwise_not(ink)
    free = cv2.morphologyEx(free, cv2.MORPH_OPEN, kernel, iterations=2)
    # Mask chrome / banner / white pad outside content ROI
    free[:y0, :] = 0
    free[y1:, :] = 0
    free[:, :x0] = 0
    free[:, x1:] = 0
    margin = max(6, min(x1 - x0, y1 - y0) // 60)
    free[y0 : y0 + margin, :] = 0
    free[max(y1 - margin, y0) : y1, :] = 0
    free[:, x0 : x0 + margin] = 0
    free[:, max(x1 - margin, x0) : x1] = 0

    n_labels, labels, stats, _ = cv2.connectedComponentsWithStats(free, connectivity=8)
    # Area gate relative to content ROI (not full chrome frame)
    roi_area = max(1, (x1 - x0) * (y1 - y0))
    min_area = roi_area * 0.018
    rooms: list[dict[str, Any]] = []
    room_polys_px: list[np.ndarray] = []
    chrome_skip = 0
    for i in range(1, n_labels):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        bx = int(stats[i, cv2.CC_STAT_LEFT])
        by = int(stats[i, cv2.CC_STAT_TOP])
        bw = int(stats[i, cv2.CC_STAT_WIDTH])
        bh = int(stats[i, cv2.CC_STAT_HEIGHT])
        # Reject thin strips (banner / frame bars) in pixel space
        if bh > 0 and (bw / bh) >= 4.5 and bh < max(40, int((y1 - y0) * 0.12)):
            chrome_skip += 1
            continue
        if bw > 0 and (bh / bw) >= 4.5 and bw < max(40, int((x1 - x0) * 0.12)):
            chrome_skip += 1
            continue
        # Reject components mostly outside content ROI
        cx_px = bx + bw / 2
        cy_px = by + bh / 2
        if cx_px < x0 or cx_px > x1 or cy_px < y0 or cy_px > y1:
            chrome_skip += 1
            continue
        mask = (labels == i).astype(np.uint8) * 255
        poly = _approx_polygon(mask, epsilon_frac=0.014)
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
    if chrome_skip:
        notes.append(f"略過 chrome／底欄／細長區域房間候選 {chrome_skip} 個。")

    # Primary walls: room polygon edges (structural, low false-positive)
    walls: list[dict[str, Any]] = []
    for ri, poly in enumerate(room_polys_px):
        pts = poly.tolist()
        for j in range(len(pts)):
            px1, py1 = pts[j]
            px2, py2 = pts[(j + 1) % len(pts)]
            a = _px_to_m(float(px1), float(py1), height_px=h, mpp=mpp)
            b = _px_to_m(float(px2), float(py2), height_px=h, mpp=mpp)
            length = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
            if length < 0.55:
                continue
            # Snap near-axis
            ax, ay = a
            bx, by = b
            if abs(ax - bx) < 0.12:
                bx = ax = (ax + bx) / 2
            if abs(ay - by) < 0.12:
                by = ay = (ay + by) / 2
            walls.append(
                {
                    "id": f"w-room{ri}-e{j}",
                    "a": _vec(ax, ay),
                    "b": _vec(bx, by),
                    "thicknessM": WALL_THICKNESS_M,
                    "thicknessAssumed": True,
                    "heightM": CEILING_HEIGHT_M,
                }
            )
    notes.append(f"房間多邊形邊推導牆段 {len(walls)}。")

    # CAD-like sparse dark ink → thick-wall skeleton Hough (supplement)
    # Mode switch uses FULL image dark% (ROI-only underestimates marketing with color bars).
    _, dark = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    dark_pct = float(dark.mean()) / 255.0
    hsv_full = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    sat_frac = float((hsv_full[:, :, 1] > 80).mean())
    marketing_colorful = sat_frac > 0.12
    if dark_pct < 0.16 and not marketing_colorful and not skip_skeleton:
        k5 = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        thick = cv2.morphologyEx(dark, cv2.MORPH_OPEN, k5, iterations=1)
        thick = cv2.morphologyEx(thick, cv2.MORPH_CLOSE, kernel, iterations=2)
        skel = np.zeros_like(thick)
        element = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
        img = thick.copy()
        for _ in range(64):
            opened = cv2.morphologyEx(img, cv2.MORPH_OPEN, element)
            temp = cv2.subtract(img, opened)
            eroded = cv2.erode(img, element)
            skel = cv2.bitwise_or(skel, temp)
            img = eroded
            if cv2.countNonZero(img) == 0:
                break
        min_len = max(36, int(min(w, h) * 0.06))
        lines = cv2.HoughLinesP(
            skel, 1, np.pi / 180, threshold=35, minLineLength=min_len, maxLineGap=18
        )
        n_add = 0
        if lines is not None:
            for i, line in enumerate(lines.reshape(-1, 4)):
                if n_add >= 10:
                    break
                x1, y1, x2, y2 = map(float, line)
                if abs(x2 - x1) < 6:
                    x2 = x1
                if abs(y2 - y1) < 6:
                    y2 = y1
                a = _px_to_m(x1, y1, height_px=h, mpp=mpp)
                b = _px_to_m(x2, y2, height_px=h, mpp=mpp)
                length = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
                if length < 0.7:
                    continue
                walls.append(
                    {
                        "id": f"w-skel-{i}",
                        "a": _vec(*a),
                        "b": _vec(*b),
                        "thicknessM": WALL_THICKNESS_M,
                        "thicknessAssumed": True,
                        "heightM": CEILING_HEIGHT_M,
                    }
                )
                n_add += 1
        notes.append(
            f"CAD 稀疏墨跡（dark≈{dark_pct*100:.1f}%）：骨架牆補 {n_add}。"
        )
    else:
        if skip_skeleton:
            why = "上游標示行銷／已裁切圖"
        elif marketing_colorful:
            why = "高彩度行銷圖"
        else:
            why = "高墨跡圖"
        notes.append(
            f"{why}（dark≈{dark_pct*100:.1f}% sat>80≈{sat_frac*100:.1f}%）："
            "略過骨架 Hough，避免家具偽牆。"
        )

    rooms, chrome_notes = _filter_chrome_rooms(rooms, roi_m=roi_m)
    notes.extend(chrome_notes)
    # Drop wall edges that came from removed chrome room polys (id prefix w-room{i})
    if chrome_notes:
        rx0, ry0, rx1, ry1 = roi_m
        pruned = []
        for wseg in walls:
            mx = (wseg["a"]["x"] + wseg["b"]["x"]) / 2
            my = (wseg["a"]["y"] + wseg["b"]["y"]) / 2
            if mx < rx0 - 0.2 or mx > rx1 + 0.2 or my < ry0 - 0.2 or my > ry1 + 0.2:
                continue
            pruned.append(wseg)
        if len(pruned) < len(walls):
            notes.append(f"剔除 ROI 外牆段 {len(walls) - len(pruned)}。")
            walls = pruned

    walls, merge_notes = _merge_collinear_walls(walls, min_len_m=0.7)
    notes.extend(merge_notes)

    walls, tx_notes = _filter_transecting_walls(walls, rooms)
    notes.extend(tx_notes)

    # Prefer fewer correct walls over padding to a hard cap
    max_walls = 20
    if len(walls) > max_walls:
        def _wall_keep_key(w: dict[str, Any]) -> tuple:
            # Prefer room-edge / merged structural over skeleton Hough junk
            wid = str(w.get("id", ""))
            prio = 0 if ("room" in wid or wid.startswith("w-m-")) else 1
            if "skel" in wid:
                prio = 2
            return (prio, -_seg_length_m(w))

        walls = sorted(walls, key=_wall_keep_key)[:max_walls]
        notes.append(f"牆段過多，已截斷至 {max_walls} 條（優先房間邊，寧少勿濫）。")

    if not walls:
        notes.append(
            "OpenCV 未能抽出牆段；請換更清楚的線稿平面圖或使用 floorplan／CubiCasa 權重。"
        )

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
    *,
    door_range: tuple[float, float] = (0.55, 1.25),
    window_range: tuple[float, float] = (0.9, 2.6),
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """Collinear wall gaps → door (typical leaf) or window (wider)."""
    notes: list[str] = []
    doors: list[dict[str, Any]] = []
    windows: list[dict[str, Any]] = []
    hv: list[tuple[str, str, float, float, float]] = []
    for w in walls:
        ax, ay = w["a"]["x"], w["a"]["y"]
        bx, by = w["b"]["x"], w["b"]["y"]
        if abs(ay - by) < 0.12 and abs(ax - bx) > 0.4:
            t0, t1 = sorted([ax, bx])
            hv.append(("h", w["id"], (ay + by) / 2, t0, t1))
        elif abs(ax - bx) < 0.12 and abs(ay - by) > 0.4:
            t0, t1 = sorted([ay, by])
            hv.append(("v", w["id"], (ax + bx) / 2, t0, t1))

    groups: dict[tuple[str, int], list[tuple[str, float, float]]] = defaultdict(list)
    for orient, wid, const, t0, t1 in hv:
        # 0.1 m bins — more stable than 0.05 m for marketing scale noise
        key = (orient, int(round(const * 10)))
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
            d0, d1 = door_range
            w0, w1 = window_range
            if d0 <= gap <= d1:
                leaf = round(gap, 4)
                doors.append(
                    {
                        "id": f"d-gap-{len(doors)+1}",
                        "kind": "swing",
                        "wallId": wid_a,
                        "opening": _seg(oa, ob),
                        "confidence": 0.48,
                        "swing": {
                            "hinge": _vec(*oa),
                            "leafLengthM": leaf,
                            "openDirection": "cw",
                            "arcQuarter": True,
                        },
                    }
                )
            elif w0 < gap <= w1:
                windows.append(
                    {
                        "id": f"win-gap-{len(windows)+1}",
                        "wallId": wid_a,
                        "opening": _seg(oa, ob),
                        "confidence": 0.42,
                        "sillHeightM": SILL_HEIGHT_M,
                        "sillHeightAssumed": True,
                    }
                )

    if doors or windows:
        notes.append(
            f"由共線牆段缺口推估門 {len(doors)}、窗 {len(windows)}"
            f"（門 {door_range[0]}–{door_range[1]} m／窗 {window_range[0]}–{window_range[1]} m）。"
        )
    else:
        notes.append("未從牆段缺口推估到門／窗；將嘗試外牆窗與連通性補開口。")
    return doors, windows, notes


def _perimeter_windows(
    walls: list[dict[str, Any]],
    rooms: list[dict[str, Any]],
    *,
    existing: list[dict[str, Any]],
    max_add: int = 4,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Place windows on long exterior walls only when real openings already exist.

    Never invent a full perimeter window set from heuristics alone.
    """
    notes: list[str] = []
    aabbs = [b for r in rooms if (b := _room_aabb(r))]
    if not aabbs or max_add <= 0:
        return [], notes
    if not existing:
        notes.append("無真實窗開口偵測，略過外牆啟發式補窗（避免 peri spam）。")
        return [], notes
    min_x = min(a[0] for a in aabbs)
    min_y = min(a[1] for a in aabbs)
    max_x = max(a[2] for a in aabbs)
    max_y = max(a[3] for a in aabbs)
    margin = 0.55

    def opening_near(mx: float, my: float, tol: float = 0.7) -> bool:
        for win in existing:
            oa = win["opening"]["a"]
            ob = win["opening"]["b"]
            cx = (oa["x"] + ob["x"]) / 2
            cy = (oa["y"] + ob["y"]) / 2
            if (cx - mx) ** 2 + (cy - my) ** 2 < tol * tol:
                return True
        return False

    candidates: list[tuple[float, dict[str, Any]]] = []
    for w in walls:
        ax, ay = w["a"]["x"], w["a"]["y"]
        bx, by = w["b"]["x"], w["b"]["y"]
        mx, my = (ax + bx) / 2, (ay + by) / 2
        L = ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5
        if L < 1.7:
            continue
        near_ext = (
            abs(mx - min_x) < margin
            or abs(mx - max_x) < margin
            or abs(my - min_y) < margin
            or abs(my - max_y) < margin
        )
        if not near_ext or opening_near(mx, my):
            continue
        open_len = min(1.35, L * 0.32)
        dx, dy = bx - ax, by - ay
        hx, hy = dx / L, dy / L
        oa = (mx - hx * open_len / 2, my - hy * open_len / 2)
        ob = (mx + hx * open_len / 2, my + hy * open_len / 2)
        candidates.append(
            (
                L,
                {
                    "id": "win-peri-tmp",
                    "wallId": w["id"],
                    "opening": _seg(oa, ob),
                    "confidence": 0.36,
                    "sillHeightM": SILL_HEIGHT_M,
                    "sillHeightAssumed": True,
                },
            )
        )
    candidates.sort(key=lambda t: t[0], reverse=True)
    added: list[dict[str, Any]] = []
    for _, win in candidates[:max_add]:
        win["id"] = f"win-peri-{len(added)+1}"
        added.append(win)
    if added:
        notes.append(
            f"外牆啟發式補窗 {len(added)}（長邊外牆中點，請疊圖確認）。"
        )
    return added, notes



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

    # Layout span — skip nearly-full outer hull (frame free-space blob)
    all_boxes = [b for _, b in aabbs]
    lay_min_x = min(b[0] for b in all_boxes)
    lay_min_y = min(b[1] for b in all_boxes)
    lay_max_x = max(b[2] for b in all_boxes)
    lay_max_y = max(b[3] for b in all_boxes)
    lay_w = max(lay_max_x - lay_min_x, 1e-6)
    lay_h = max(lay_max_y - lay_min_y, 1e-6)

    access_budget = max(0, min(2, len(aabbs) // 2))  # prefer few real doors over patch flood
    access_added = 0

    for rid, box in aabbs:
        if room_has_door(rid, box):
            continue
        min_x, min_y, max_x, max_y = box
        span_frac = ((max_x - min_x) / lay_w) * ((max_y - min_y) / lay_h)
        if span_frac >= 0.72:
            notes.append(f"連通性：略過外框大房間 {rid}（避免 access patch）。")
            continue
        if access_added >= access_budget:
            notes.append(f"連通性：房間 {rid} 無出入口，已達補門上限，請人工確認。")
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
        access_added += 1

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
    # Marketing colorful? Measure on ORIGINAL (before white-mask kills sat bars)
    hsv0 = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    sat_frac0 = float((hsv0[:, :, 1] > 80).mean())
    marketing_colorful = sat_frac0 > 0.12

    x0, y0, x1, y1, roi_notes = _detect_content_roi(bgr)
    # Mask titles/headers/banners/chrome BEFORE YOLO / CubiCasa / OpenCV
    bgr = _mask_outside_roi(bgr, (x0, y0, x1, y1))
    mpp, scale_notes, scale_trusted = _estimate_mpp(bgr, w)

    notes: list[str] = [
        "後端 YOLO＋OpenCV 管線（mock=false）。",
        "單位：公尺；座標原點：圖面左下（bottom-left）。",
        *roi_notes,
        *scale_notes,
        f"天花板假設 {CEILING_HEIGHT_M} m；牆厚假設 {WALL_THICKNESS_M} m；窗台假設 {SILL_HEIGHT_M} m。",
    ]
    if marketing_colorful:
        notes.append(
            f"原圖高彩度（sat>80≈{sat_frac0*100:.1f}%）→ 略過 CAD 骨架牆，避免行銷偽結構。"
        )

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

    # Higher conf on FloorCAD furniture-heavy taxonomy to cut false walls/openings
    conf_thr = 0.22 if has_floorplan_classes else 0.28
    try:
        results = model.predict(bgr, verbose=False, conf=conf_thr, iou=0.45)
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

    cv_rooms, cv_walls, cv_notes = _opencv_rooms_and_walls(
        bgr,
        mpp=mpp,
        content_roi=(x0, y0, x1, y1),
        skip_skeleton=marketing_colorful,
    )
    notes.extend(cv_notes)

    # CubiCasa semantic seg (floor/wall/door/window) when weights present
    cubi = None
    try:
        from cubicasa_seg import cubicasa_available, extract_from_cubicasa

        if cubicasa_available():
            cubi = extract_from_cubicasa(bgr, mpp=mpp)
            notes.extend(cubi.get("notes") or [])
        else:
            notes.append(
                "未找到 CubiCasa 權重（models/cubicasa/best.safetensors）；"
                "可 python scripts/download_model.py --cubicasa。"
            )
    except Exception as e:  # noqa: BLE001
        notes.append(f"CubiCasa 略過：{e}")

    # Structure: prefer OpenCV room-edge walls (stable counts); YOLO/CubiCasa walls sparse-only
    rooms = cv_rooms
    if cubi and cubi.get("rooms") and len(cubi["rooms"]) > len(rooms):
        rooms = cubi["rooms"]
        notes.append("房間採用 CubiCasa floor 連通區域（多於 OpenCV）。")
    elif yolo_rooms and len(yolo_rooms) >= max(3, len(cv_rooms)):
        rooms = yolo_rooms
        notes.append("房間採用 YOLO 遮罩。")

    walls = list(cv_walls)
    if yolo_walls:
        # Only keep YOLO walls that are reasonably long; merge into CV structure
        long_yolo = [w for w in yolo_walls if _seg_length_m(w) >= 0.8]
        if long_yolo:
            walls = walls + long_yolo
            notes.append(f"併入 YOLO 長牆 {len(long_yolo)}。")
    if cubi and cubi.get("wall_segs"):
        cubi_walls = cubi["wall_segs"]
        if len(cubi_walls) <= 40:
            for i, (a, b) in enumerate(cubi_walls):
                walls.append(
                    {
                        "id": f"w-cubi-{i+1}",
                        "a": _vec(*a),
                        "b": _vec(*b),
                        "thicknessM": WALL_THICKNESS_M,
                        "thicknessAssumed": True,
                        "heightM": CEILING_HEIGHT_M,
                    }
                )
            notes.append(f"併入 CubiCasa 牆段 {len(cubi_walls)}。")
        else:
            notes.append(
                f"CubiCasa 牆段過碎（{len(cubi_walls)}），已捨棄以免膨脹偽牆。"
            )

    walls, merge_notes = _merge_collinear_walls(walls, min_len_m=0.7)
    notes.extend(merge_notes)
    walls, tx_notes = _filter_transecting_walls(walls, rooms)
    notes.extend(tx_notes)
    # Prefer fewer correct walls — hard cap 20 (was 32 junk magnet)
    if len(walls) > 20:
        def _wall_keep_key(w: dict[str, Any]) -> tuple:
            wid = str(w.get("id", ""))
            prio = 0 if ("room" in wid or wid.startswith("w-m-")) else 1
            if "skel" in wid or "cubi" in wid:
                prio = 2
            return (prio, -_seg_length_m(w))

        walls = sorted(walls, key=_wall_keep_key)[:20]
        notes.append("牆段過多，最終截斷至 20（優先房間邊，寧少勿濫）。")

    def _opening_len(op: dict[str, Any]) -> float:
        a, b = op["opening"]["a"], op["opening"]["b"]
        return ((a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2) ** 0.5

    def _dedupe_openings(
        items: list[dict[str, Any]], *, min_sep: float = 0.55
    ) -> list[dict[str, Any]]:
        kept: list[dict[str, Any]] = []
        for it in items:
            a, b = it["opening"]["a"], it["opening"]["b"]
            mx, my = (a["x"] + b["x"]) / 2, (a["y"] + b["y"]) / 2
            if any(
                ((k["opening"]["a"]["x"] + k["opening"]["b"]["x"]) / 2 - mx) ** 2
                + ((k["opening"]["a"]["y"] + k["opening"]["b"]["y"]) / 2 - my) ** 2
                < min_sep * min_sep
                for k in kept
            ):
                continue
            kept.append(it)
        return kept

    doors = list(yolo_doors)
    windows = list(yolo_windows)
    # Geometric length filter on YOLO openings
    doors = [d for d in doors if 0.45 <= _opening_len(d) <= 1.6]
    windows = [w for w in windows if 0.55 <= _opening_len(w) <= 3.5]

    if cubi:
        cubi_doors = list(cubi.get("door_segs") or [])
        cubi_doors.sort(
            key=lambda ab: ((ab[0][0] - ab[1][0]) ** 2 + (ab[0][1] - ab[1][1]) ** 2),
            reverse=True,
        )
        for i, (a, b) in enumerate(cubi_doors[:6]):
            leaf = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
            if leaf < 0.6 or leaf > 1.3:
                continue
            doors.append(
                {
                    "id": f"d-cubi-{i+1}",
                    "kind": "swing",
                    "wallId": "w-unknown",
                    "opening": _seg(a, b),
                    "confidence": 0.5,
                    "swing": {
                        "hinge": _vec(*a),
                        "leafLengthM": round(leaf, 4),
                        "openDirection": "cw",
                        "arcQuarter": True,
                    },
                }
            )
        cubi_wins = list(cubi.get("window_segs") or [])
        cubi_wins.sort(
            key=lambda ab: ((ab[0][0] - ab[1][0]) ** 2 + (ab[0][1] - ab[1][1]) ** 2),
            reverse=True,
        )
        for i, (a, b) in enumerate(cubi_wins[:5]):
            wlen = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
            if wlen < 0.7 or wlen > 3.0:
                continue
            windows.append(
                {
                    "id": f"win-cubi-{i+1}",
                    "wallId": "w-unknown",
                    "opening": _seg(a, b),
                    "confidence": 0.48,
                    "sillHeightM": SILL_HEIGHT_M,
                    "sillHeightAssumed": True,
                }
            )

    gap_doors, gap_wins, gap_notes = _openings_from_gaps(walls)
    notes.extend(gap_notes)
    if len(doors) < 2:
        doors.extend(gap_doors)
        if gap_doors:
            notes.append("已併用缺口啟發式補門。")
    if len(windows) < 2:
        windows.extend(gap_wins)
        if gap_wins:
            notes.append("已併用缺口啟發式補窗。")

    # Reject openings far from walls BEFORE peri/access heuristics
    doors, n_drop_d, n_snap_d = _filter_openings_near_walls(
        doors, walls, max_dist_m=0.45, snap_max_m=0.85
    )
    windows, n_drop_w, n_snap_w = _filter_openings_near_walls(
        windows, walls, max_dist_m=0.55, snap_max_m=0.95
    )
    if n_drop_d or n_drop_w or n_snap_d or n_snap_w:
        notes.append(
            f"開口貼牆：門 snap {n_snap_d}/drop {n_drop_d}，"
            f"窗 snap {n_snap_w}/drop {n_drop_w}。"
        )

    # Peri only supplements model openings — never invent from gaps alone
    model_wins = [
        w for w in windows if str(w.get("id", "")).startswith(("win-yolo", "win-cubi"))
    ]
    peri, peri_notes = _perimeter_windows(
        walls,
        rooms,
        existing=model_wins,
        max_add=max(0, 2 - len(windows)) if model_wins else 0,
    )
    notes.extend(peri_notes)
    windows.extend(peri)

    doors = _dedupe_openings(doors)
    windows = _dedupe_openings(windows)
    if len(doors) > 8:
        doors = sorted(doors, key=_opening_len, reverse=True)[:8]
        notes.append("門候選過多，截斷至 8。")
    if len(windows) > 6:
        windows = sorted(windows, key=_opening_len, reverse=True)[:6]
        notes.append("窗候選過多，截斷至 6。")

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
    doors = _dedupe_openings(doors)
    # Access patches are on walls by construction; re-filter any stray far openings
    doors, n_drop_d2, n_snap_d2 = _filter_openings_near_walls(
        doors, walls, max_dist_m=0.45, snap_max_m=0.85
    )
    windows, n_drop_w2, n_snap_w2 = _filter_openings_near_walls(
        windows, walls, max_dist_m=0.55, snap_max_m=0.95
    )
    if n_drop_d2 or n_drop_w2 or n_snap_d2 or n_snap_w2:
        notes.append(
            f"最終貼牆：門 snap {n_snap_d2}/drop {n_drop_d2}，"
            f"窗 snap {n_snap_w2}/drop {n_drop_w2}。"
        )
    notes.append(
        "連通性：請確認門／窗是否落在牆段上；匯入後可於 2D 微調。"
        "CubiCasa＝CAD 風格語意分割；FloorCAD YOLO＝符號；OpenCV＝房間邊牆。"
        "行銷圖仍可能需人工疊圖修正。"
    )

    if confs:
        overall = round(float(sum(confs) / len(confs)), 3)
    else:
        overall = 0.52 if walls else 0.2

    model_label = _MODEL_PATH or "yolo-seg"
    if cubi is not None:
        model_label = f"{model_label} + cubicasa-unet"
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
