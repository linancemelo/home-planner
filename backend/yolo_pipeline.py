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



def _ortho_polygon_from_mask(mask: np.ndarray, *, max_verts: int = 12) -> np.ndarray | None:
    """Axis-aligned-ish room outline from free-space mask.

    Prefer morphologically closed rectilinear outlines when the blob is L/T-shaped
    (fill low); fall back to AABB for compact rectangular rooms. Avoid jagged
    furniture contours that fail overlay QA.
    """
    m = (mask > 0).astype(np.uint8) * 255
    if m.max() == 0:
        return None
    # Light close to fill furniture holes inside a room without bridging walls
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    m_closed = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k, iterations=1)
    ys, xs = np.where(m_closed > 0)
    if xs.size < 30:
        return None
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    area = int(xs.size)
    fill = area / max(bw * bh, 1)
    aabb = np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], dtype=np.float64)
    # Compact / rectangular → AABB
    if fill >= 0.62 or area < 6000:
        return aabb
    # L/T shaped: try ortho-snapped approx on closed mask
    poly = _approx_polygon(m_closed, epsilon_frac=0.028)
    if poly is None or len(poly) < 4:
        return aabb
    pts = poly.astype(np.float64).tolist()
    snapped = [pts[0][:]]
    for i in range(1, len(pts)):
        px, py = snapped[-1]
        qx, qy = pts[i]
        if abs(qx - px) < abs(qy - py) * 0.40:
            qx = px
        elif abs(qy - py) < abs(qx - px) * 0.40:
            qy = py
        snapped.append([qx, qy])
    if abs(snapped[-1][0] - snapped[0][0]) < 4:
        snapped[-1][0] = snapped[0][0]
    if abs(snapped[-1][1] - snapped[0][1]) < 4:
        snapped[-1][1] = snapped[0][1]
    arr = np.array(snapped, dtype=np.float64)
    if len(arr) < 4 or len(arr) > max_verts:
        return aabb
    # Reject if ortho poly area far from mask (junk contour)
    poly_area = abs(cv2.contourArea(arr.astype(np.float32).reshape(-1, 1, 2)))
    if poly_area < area * 0.55:
        return aabb
    return arr


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




def _crop_vertical_title_columns(
    gray: np.ndarray,
    x0: int,
    y0: int,
    x1: int,
    y1: int,
) -> tuple[int, int, int, int, list[str]]:
    """Crop L/R CAD title / sidebar columns via quiet gutters.

    Marketing banners are usually horizontal; CAD sheets often put the title
    block in a vertical column separated by a near-white gutter. Detect that
    gutter and cut before the title strip so rooms/walls never land on chrome.
    """
    notes: list[str] = []
    roi = gray[y0:y1, x0:x1]
    if roi.size == 0 or (x1 - x0) < 80 or (y1 - y0) < 80:
        return x0, y0, x1, y1, notes
    edges = cv2.Canny(roi, 40, 120)
    col_edge = edges.mean(axis=0)
    col_dark = (roi < 160).mean(axis=0)
    rw = x1 - x0
    nx0, nx1 = x0, x1

    # Right third: quiet gutter then text-like strip
    i = int(rw * 0.55)
    while i < rw - 8:
        if col_edge[i] < 2.5 and col_dark[i] < 0.015:
            j = i
            while j < rw and col_edge[j] < 2.5 and col_dark[j] < 0.015:
                j += 1
            if (j - i) >= 12:
                after_e = col_edge[j : min(rw, j + max(24, int(rw * 0.18)))]
                after_d = col_dark[j : min(rw, j + max(24, int(rw * 0.18)))]
                if (
                    after_e.size > 10
                    and float(after_e.mean()) > 3.0
                    and float(after_d.mean()) > 0.01
                ):
                    cut = x0 + i
                    # Pull 1.5% left so title frame line is excluded
                    cut = max(x0 + int(rw * 0.42), cut - max(8, int(rw * 0.015)))
                    if (cut - x0) >= rw * 0.42:
                        nx1 = cut
                        notes.append(
                            f"裁切右側標題欄／sidebar（quiet gutter → x1={nx1}）。"
                        )
                    break
            i = j + 1
        else:
            i += 1

    # Left third (dimension / title strips)
    i = int(rw * 0.45)
    while i > 8:
        if col_edge[i] < 2.5 and col_dark[i] < 0.015:
            j = i
            while j >= 0 and col_edge[j] < 2.5 and col_dark[j] < 0.015:
                j -= 1
            if (i - j) >= 12:
                before_e = col_edge[max(0, j - max(24, int(rw * 0.18))) : j + 1]
                before_d = col_dark[max(0, j - max(24, int(rw * 0.18))) : j + 1]
                if (
                    before_e.size > 10
                    and float(before_e.mean()) > 3.0
                    and float(before_d.mean()) > 0.01
                ):
                    cut = x0 + i + 1
                    if (x1 - cut) >= rw * 0.42:
                        nx0 = cut
                        notes.append(
                            f"裁切左側標題／尺寸欄（quiet gutter → x0={nx0}）。"
                        )
                    break
            i = j - 1
        else:
            i -= 1

    return int(nx0), int(y0), int(nx1), int(y1), notes


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

    # 4) Vertical title / sidebar columns (CAD right chrome, dim strips)
    x0, y0, x1, y1, side_notes = _crop_vertical_title_columns(
        gray_u8, int(x0), int(y0), int(x1), int(y1)
    )
    notes.extend(side_notes)

    min_w, min_h = int(w * 0.40), int(h * 0.40)
    if (x1 - x0) < min_w or (y1 - y0) < min_h:
        notes.append("內容 ROI 過緊，改回全圖（僅保留邊緣 margin 邏輯）。")
        return 0, 0, int(w), int(h), notes

    if (x0 > 2) or (y0 > 2) or (x1 < w - 2) or (y1 < h - 2):
        notes.append(
            f"分析前裁切至室內平面圖繪圖區：({x0},{y0})–({x1},{y1})"
            f"（原 {w}×{h}；略過標題／橫幅／色條／邊框／側欄 chrome）。"
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
        wid = str(w.get("id", ""))
        # Ink / skeleton walls already sit on dark strokes — don't drop as "transect"
        # when room AABBs are coarse marketing blobs.
        if "ink" in wid or "skel" in wid:
            kept.append(w)
            continue
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



def _axis_align_score(ax: float, ay: float, bx: float, by: float) -> float:
    """1.0 = perfectly axis-aligned; 0.0 = 45° diagonal."""
    dx, dy = abs(bx - ax), abs(by - ay)
    L = (dx * dx + dy * dy) ** 0.5 or 1.0
    return max(dx, dy) / L


def _is_structural_edge(
    ax: float, ay: float, bx: float, by: float, *, min_len: float = 0.7
) -> bool:
    """Keep straighter, longer edges; drop short jagged / diagonal furniture edges."""
    L = ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5
    if L < min_len:
        return False
    score = _axis_align_score(ax, ay, bx, by)
    # Require near-axis OR very long (outer diagonal rare but ok if long)
    if score >= 0.92:
        return True
    if L >= 2.2 and score >= 0.80:
        return True
    return False


def _footprint_mask(
    bgr: np.ndarray, x0: int, y0: int, x1: int, y1: int
) -> np.ndarray:
    """Binary mask of likely drawing footprint inside ROI (exclude cream chrome)."""
    h, w = bgr.shape[:2]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    cream = (gray > 225) & (hsv[:, :, 1] < 40)
    banner = hsv[:, :, 1] > 90
    lap = cv2.Laplacian(blur, cv2.CV_32F)
    var = cv2.GaussianBlur(lap ** 2, (15, 15), 0)
    textured = var > 28
    dark = gray < 105
    plan = ((~cream) & (~banner) & (textured | dark)).astype(np.uint8) * 255
    plan[:y0, :] = 0
    plan[y1:, :] = 0
    plan[:, :x0] = 0
    plan[:, x1:] = 0
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (11, 11))
    plan = cv2.morphologyEx(plan, cv2.MORPH_CLOSE, k, iterations=2)
    plan = cv2.morphologyEx(plan, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)), iterations=1)
    cnts, _ = cv2.findContours(plan, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    foot = np.zeros((h, w), np.uint8)
    if not cnts:
        foot[y0:y1, x0:x1] = 255
        return foot
    cnts = sorted(cnts, key=cv2.contourArea, reverse=True)
    # Largest blob that still covers a solid fraction of ROI
    roi_a = max(1, (x1 - x0) * (y1 - y0))
    for c in cnts[:3]:
        if cv2.contourArea(c) >= roi_a * 0.18:
            cv2.drawContours(foot, [c], -1, 255, -1)
            break
    if foot.max() == 0:
        foot[y0:y1, x0:x1] = 255
    return foot


def _plan_style_from_bgr(
    bgr: np.ndarray,
    foot: np.ndarray | None = None,
    *,
    orig_sat_frac: float | None = None,
) -> str:
    """Classify plan as 'marketing' (dark stroke ink) vs 'cad' (mid-gray fills).

    IMPORTANT: measure color on *original* sat when available — ROI white-mask
    kills marketing sat and previously forced CAD mid-gray logic onto furniture.
    """
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1]
    if foot is None:
        foot = np.ones(gray.shape, np.uint8) * 255
    inside = foot > 0
    if not inside.any():
        return "cad"
    sat_frac = float(orig_sat_frac) if orig_sat_frac is not None else float((sat[inside] > 80).mean())
    near_black = float(((blur < 55) & inside).mean())
    mid_gray = float(((blur > 40) & (blur < 135) & (sat < 55) & inside).mean())
    # Colorful marketing renders
    if sat_frac > 0.08:
        return "marketing"
    # Desaturated marketing line-art: thin near-black strokes dominate mid fills
    if near_black >= 0.008 and near_black >= mid_gray * 0.25:
        return "marketing"
    # Furniture-heavy desaturated marketing: mid-gray fills (rugs/mats) inflate
    # mid_gray, but structural walls are still near-black strokes.
    if near_black >= 0.012:
        return "marketing"
    return "cad"


def _split_free_via_watershed(
    free: np.ndarray,
    *,
    min_area: float,
    max_rooms: int = 5,
) -> list[np.ndarray]:
    """Split a large free-space blob at narrow necks (doorways) via DT watershed."""
    if free.max() == 0:
        return []
    # If already many CCs, just return them
    n0, lab0, st0, _ = cv2.connectedComponentsWithStats(free, connectivity=8)
    simple: list[np.ndarray] = []
    big_masks: list[np.ndarray] = []
    for i in range(1, n0):
        area = int(st0[i, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        m = (lab0 == i).astype(np.uint8) * 255
        # Huge blob → watershed; modest → keep
        # Only watershed true mega-blobs (open-plan living); keep modest CCs
        free_total = max(1, int(free.sum() // 255))
        if area >= max(min_area * 5.0, free_total * 0.22):
            big_masks.append(m)
        else:
            simple.append(m)
    out = list(simple)
    k3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    for big in big_masks:
        dist = cv2.distanceTransform(big, cv2.DIST_L2, 5)
        dmax = float(dist.max())
        if dmax < 8:
            out.append(big)
            continue
        h, w = big.shape
        ks = max(15, int(min(h, w) * 0.045) | 1)
        dil = cv2.dilate(dist, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ks, ks)))
        # Lower peak floor so bedrooms separated by thin ink still get seeds
        peaks = ((dist >= dil - 0.5) & (dist >= max(dmax * 0.28, 12.0))).astype(np.uint8)
        peaks = cv2.bitwise_and(peaks * 255, big)
        n_seed, seed_lab = cv2.connectedComponents(peaks)
        seeds: list[tuple[float, int, int, int]] = []
        for i in range(1, n_seed):
            ys, xs = np.where(seed_lab == i)
            if xs.size == 0:
                continue
            dval = float(dist[ys, xs].max())
            seeds.append((dval, i, int(xs.mean()), int(ys.mean())))
        seeds.sort(reverse=True)
        markers = np.zeros(big.shape, np.int32)
        placed: list[tuple[int, int]] = []
        sid = 1
        min_seed_sep = (ks * 0.50) ** 2
        for dval, i, cx, cy in seeds:
            if sid > max_rooms:
                break
            if dval < max(dmax * 0.22, 10.0):
                continue
            if any((cx - px) ** 2 + (cy - py) ** 2 < min_seed_sep for px, py in placed):
                continue
            markers[seed_lab == i] = sid
            placed.append((cx, cy))
            sid += 1
        if sid <= 2:
            out.append(big)
            continue
        sure_bg = cv2.dilate(big, k3, iterations=2)
        unknown = cv2.subtract(sure_bg, (markers > 0).astype(np.uint8) * 255)
        mk = markers.copy()
        mk[unknown == 255] = 0
        vis = cv2.cvtColor(big, cv2.COLOR_GRAY2BGR)
        cv2.watershed(vis, mk)
        for lab_id in set(mk.flatten().tolist()):
            if lab_id <= 0:
                continue
            m = (mk == lab_id).astype(np.uint8) * 255
            # clip to original big blob
            m = cv2.bitwise_and(m, big)
            if int(m.sum() // 255) >= min_area * 0.55:
                out.append(m)
    return out


def _structural_walls_from_ink(
    bgr: np.ndarray,
    *,
    mpp: float,
    x0: int,
    y0: int,
    x1: int,
    y1: int,
    foot: np.ndarray,
    max_add: int = 40,
    plan_style: str = "cad",
) -> tuple[list[dict[str, Any]], np.ndarray]:
    """Long near-axis walls from thick fill + stroke ink (hand-traced skeleton).

    Returns (walls, ink_mask). Priority: perimeter + major partitions overlapping
    real wall ink; suppress compact furniture/decor. Merges fill + stroke paths
    then extracts via H/V morphological CCs + Hough (door-sized gaps).
    """
    h, w = bgr.shape[:2]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1]
    marketing = plan_style == "marketing"
    k3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))

    if marketing:
        # Near-black strokes. Extract H/V line masses FIRST so furniture mats
        # (compact solids) fail the long-kernel open, while wall networks survive.
        dark = (blur < 78).astype(np.uint8) * 255
        dark = cv2.bitwise_and(dark, foot)
        dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, k3, iterations=2)
        dist = cv2.distanceTransform(dark, cv2.DIST_L2, 5)
        thick_core = ((dist >= 1.0) & (dark > 0)).astype(np.uint8) * 255
        min_dim0 = min(h, w)
        hw0 = max(17, int(min_dim0 * 0.024)) | 1
        kh0 = cv2.getStructuringElement(cv2.MORPH_RECT, (hw0, 1))
        kv0 = cv2.getStructuringElement(cv2.MORPH_RECT, (1, hw0))
        hv_lines = cv2.bitwise_or(
            cv2.morphologyEx(dark, cv2.MORPH_OPEN, kh0),
            cv2.morphologyEx(dark, cv2.MORPH_OPEN, kv0),
        )
        # Also keep thick cores that are elongated (corner columns / thick walls)
        n, lab, st, _ = cv2.connectedComponentsWithStats(thick_core, connectivity=8)
        cores = np.zeros_like(thick_core)
        for i in range(1, n):
            area = int(st[i, cv2.CC_STAT_AREA])
            ww = int(st[i, cv2.CC_STAT_WIDTH])
            hh = int(st[i, cv2.CC_STAT_HEIGHT])
            aspect = max(ww, hh) / (min(ww, hh) + 1e-6)
            solidity = area / max(ww * hh, 1)
            # Only drop clearly rectangular furniture mats (compact + solid)
            if area >= 500 and aspect < 2.2 and solidity > 0.55:
                continue
            if area >= 40 and (aspect >= 1.5 or area >= 200):
                cores[lab == i] = 255
        ink = cv2.bitwise_or(hv_lines, cores)
        # Stroke path: Canny ∩ near-dark for thin perimeter
        edges = cv2.Canny(blur, 40, 120)
        darkish = cv2.dilate((blur < 95).astype(np.uint8) * 255, k3, iterations=1)
        stroke = cv2.bitwise_and(cv2.bitwise_and(edges, darkish), foot)
        n2, lab2, st2, _ = cv2.connectedComponentsWithStats(stroke, connectivity=8)
        for i in range(1, n2):
            area = int(st2[i, cv2.CC_STAT_AREA])
            ww = int(st2[i, cv2.CC_STAT_WIDTH])
            hh = int(st2[i, cv2.CC_STAT_HEIGHT])
            aspect = max(ww, hh) / (min(ww, hh) + 1e-6)
            if area >= 20 and aspect >= 3.0 and max(ww, hh) >= 24:
                ink[lab2 == i] = 255
    else:
        # CAD wall fills: mid-gray solid bands (do NOT over-filter — missing
        # perimeter was from too-strict variance/thickness cuts).
        dark = ((blur > 25) & (blur < 170) & (sat < 65)).astype(np.uint8) * 255
        dark = cv2.bitwise_and(dark, foot)
        dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, k3, iterations=1)
        dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, k3, iterations=2)
        # Soft thickness prefer, but keep elongated thin fills too
        dist = cv2.distanceTransform(dark, cv2.DIST_L2, 5)
        thick = ((dist >= 0.9) & (dark > 0)).astype(np.uint8) * 255
        n, lab, st, _ = cv2.connectedComponentsWithStats(dark, connectivity=8)
        ink = np.zeros_like(dark)
        for i in range(1, n):
            area = int(st[i, cv2.CC_STAT_AREA])
            ww = int(st[i, cv2.CC_STAT_WIDTH])
            hh = int(st[i, cv2.CC_STAT_HEIGHT])
            aspect = max(ww, hh) / (min(ww, hh) + 1e-6)
            mean_t = float(dist[lab == i].mean()) if area else 0.0
            # Prefer thick OR elongated; drop tiny compact noise
            if area >= 40 and aspect >= 1.5:
                ink[lab == i] = 255
            elif area >= 180 and mean_t >= 1.0:
                ink[lab == i] = 255
        ink = cv2.bitwise_or(ink, thick)
        # Adaptive strokes for double-line partitions
        thr = cv2.adaptiveThreshold(
            blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 35, 8
        )
        thr = cv2.bitwise_and(thr, foot)
        n2, lab2, st2, _ = cv2.connectedComponentsWithStats(thr, connectivity=8)
        for i in range(1, n2):
            area = int(st2[i, cv2.CC_STAT_AREA])
            ww = int(st2[i, cv2.CC_STAT_WIDTH])
            hh = int(st2[i, cv2.CC_STAT_HEIGHT])
            aspect = max(ww, hh) / (min(ww, hh) + 1e-6)
            if area >= 40 and aspect >= 3.2 and max(ww, hh) >= 36:
                ink[lab2 == i] = 255

    ink = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, k3, iterations=2)

    # H/V morphological separation → CC centerlines (long perimeter / partitions)
    min_dim = min(max(x1 - x0, 1), max(y1 - y0, 1))
    hw = max(15, int(min_dim * 0.022)) | 1
    t = 1 if marketing else 3
    kh = cv2.getStructuringElement(cv2.MORPH_RECT, (hw, t))
    kv = cv2.getStructuringElement(cv2.MORPH_RECT, (t, hw))
    ink_d = cv2.dilate(ink, k3, iterations=1)
    horiz = cv2.morphologyEx(ink_d, cv2.MORPH_OPEN, kh)
    vert = cv2.morphologyEx(ink_d, cv2.MORPH_OPEN, kv)
    if not marketing:
        kh2 = cv2.getStructuringElement(cv2.MORPH_RECT, (hw, 5))
        kv2 = cv2.getStructuringElement(cv2.MORPH_RECT, (5, hw))
        horiz = cv2.bitwise_or(horiz, cv2.morphologyEx(ink_d, cv2.MORPH_OPEN, kh2))
        vert = cv2.bitwise_or(vert, cv2.morphologyEx(ink_d, cv2.MORPH_OPEN, kv2))

    def _cc_runs(mask: np.ndarray, orient: str, prefix: str) -> list[dict[str, Any]]:
        roi = mask[y0:y1, x0:x1]
        if roi.size == 0:
            return []
        nlab, labels, stats, _ = cv2.connectedComponentsWithStats(roi, connectivity=8)
        out: list[dict[str, Any]] = []
        min_run = max(26, int(min(roi.shape) * 0.048))
        gap_tol = max(14, int(min(roi.shape) * 0.028))
        for i in range(1, nlab):
            area = int(stats[i, cv2.CC_STAT_AREA])
            if area < min_run * 2:
                continue
            ys, xs = np.where(labels == i)
            if xs.size == 0:
                continue
            if orient == "h":
                cy = int(np.median(ys))
                band = np.zeros(roi.shape[1], dtype=bool)
                for yb in range(max(0, cy - 3), min(roi.shape[0], cy + 4)):
                    band |= labels[yb, :] == i
                j = 0
                rw = roi.shape[1]
                while j < rw:
                    if band[j]:
                        k = j
                        gap = 0
                        while k < rw:
                            if band[k]:
                                gap = 0
                                k += 1
                            elif gap < gap_tol:
                                gap += 1
                                k += 1
                            else:
                                break
                        end = k - gap
                        if end - j >= min_run:
                            a = _px_to_m(float(x0 + j), float(y0 + cy), height_px=h, mpp=mpp)
                            b = _px_to_m(float(x0 + end), float(y0 + cy), height_px=h, mpp=mpp)
                            if _is_structural_edge(a[0], a[1], b[0], b[1], min_len=0.7):
                                out.append(
                                    {
                                        "id": f"{prefix}-h{len(out)}",
                                        "a": _vec(*a),
                                        "b": _vec(*b),
                                        "thicknessM": WALL_THICKNESS_M,
                                        "thicknessAssumed": True,
                                        "heightM": CEILING_HEIGHT_M,
                                    }
                                )
                        j = k
                    else:
                        j += 1
            else:
                cx = int(np.median(xs))
                band = np.zeros(roi.shape[0], dtype=bool)
                for xb in range(max(0, cx - 3), min(roi.shape[1], cx + 4)):
                    band |= labels[:, xb] == i
                j = 0
                rh = roi.shape[0]
                while j < rh:
                    if band[j]:
                        k = j
                        gap = 0
                        while k < rh:
                            if band[k]:
                                gap = 0
                                k += 1
                            elif gap < gap_tol:
                                gap += 1
                                k += 1
                            else:
                                break
                        end = k - gap
                        if end - j >= min_run:
                            a = _px_to_m(float(x0 + cx), float(y0 + j), height_px=h, mpp=mpp)
                            b = _px_to_m(float(x0 + cx), float(y0 + end), height_px=h, mpp=mpp)
                            if _is_structural_edge(a[0], a[1], b[0], b[1], min_len=0.7):
                                out.append(
                                    {
                                        "id": f"{prefix}-v{len(out)}",
                                        "a": _vec(*a),
                                        "b": _vec(*b),
                                        "thicknessM": WALL_THICKNESS_M,
                                        "thicknessAssumed": True,
                                        "heightM": CEILING_HEIGHT_M,
                                    }
                                )
                        j = k
                    else:
                        j += 1
        return out

    walls: list[dict[str, Any]] = []
    walls.extend(_cc_runs(horiz, "h", "w-ink"))
    walls.extend(_cc_runs(vert, "v", "w-ink"))

    # Skeleton + Hough with door-sized maxLineGap (supplement short gaps)
    skel = np.zeros_like(ink)
    element = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
    img = ink.copy()
    for _ in range(72):
        opened = cv2.morphologyEx(img, cv2.MORPH_OPEN, element)
        temp = cv2.subtract(img, opened)
        eroded = cv2.erode(img, element)
        skel = cv2.bitwise_or(skel, temp)
        img = eroded
        if cv2.countNonZero(img) == 0:
            break
    hough_src = cv2.bitwise_or(cv2.dilate(ink, k3, iterations=1), skel)
    if marketing:
        edges = cv2.Canny(blur, 40, 120)
        edges = cv2.bitwise_and(edges, foot)
        dark_e = cv2.bitwise_and(
            edges, cv2.dilate((blur < 95).astype(np.uint8) * 255, k3, iterations=1)
        )
        hough_src = cv2.bitwise_or(hough_src, dark_e)
    min_len = max(20 if marketing else 24, int(min_dim * (0.032 if marketing else 0.038)))
    lines = cv2.HoughLinesP(
        hough_src,
        1,
        np.pi / 180,
        threshold=18 if marketing else 22,
        minLineLength=min_len,
        maxLineGap=40,  # bridge typical door / window gaps
    )
    if lines is not None:
        for i, line in enumerate(lines.reshape(-1, 4)):
            x1p, y1p, x2p, y2p = map(float, line)
            if abs(x2p - x1p) < 7:
                x2p = x1p
            if abs(y2p - y1p) < 7:
                y2p = y1p
            if abs(x2p - x1p) >= 8 and abs(y2p - y1p) >= 8:
                continue
            a = _px_to_m(x1p, y1p, height_px=h, mpp=mpp)
            b = _px_to_m(x2p, y2p, height_px=h, mpp=mpp)
            min_L = 0.75 if marketing else 0.55
            if not _is_structural_edge(a[0], a[1], b[0], b[1], min_len=min_L):
                continue
            mx = (a[0] + b[0]) / 2 / mpp
            my_px = h - (a[1] + b[1]) / 2 / mpp
            if not (x0 - 2 <= mx <= x1 + 2 and y0 - 2 <= my_px <= y1 + 2):
                continue
            walls.append(
                {
                    "id": f"w-ink-hough-{i}",
                    "a": _vec(*a),
                    "b": _vec(*b),
                    "thicknessM": WALL_THICKNESS_M,
                    "thicknessAssumed": True,
                    "heightM": CEILING_HEIGHT_M,
                }
            )

    # Axis-projection major walls (long perimeter / partitions)
    roi = ink[y0:y1, x0:x1]
    if roi.size > 0:
        rh, rw = roi.shape

        def _smooth(arr: np.ndarray, k: int = 9) -> np.ndarray:
            ker = np.ones(k, dtype=np.float64) / k
            return np.convolve(arr.astype(np.float64), ker, mode="same")

        col = _smooth(roi.sum(axis=0) / 255.0)
        row = _smooth(roi.sum(axis=1) / 255.0)

        def _peaks(arr: np.ndarray, sep: int, frac: float) -> list[int]:
            thr = max(12.0, float(arr.max()) * frac)
            out: list[int] = []
            for i in range(2, len(arr) - 2):
                if arr[i] >= thr and arr[i] >= arr[i - 1] and arr[i] >= arr[i + 1]:
                    if out and i - out[-1] < sep:
                        if arr[i] > arr[out[-1]]:
                            out[-1] = i
                    else:
                        out.append(i)
            return out

        sep = max(12, int(min(rh, rw) * 0.022))
        min_run = max(32, int(min(rh, rw) * 0.055))
        gap_tol = max(16, int(min(rh, rw) * 0.03))
        for xp in _peaks(col, sep, 0.34):
            band = roi[:, max(0, xp - 2) : min(rw, xp + 3)].max(axis=1) > 0
            i = 0
            while i < rh:
                if band[i]:
                    j = i
                    gap = 0
                    while j < rh:
                        if band[j]:
                            gap = 0
                            j += 1
                        elif gap < gap_tol:
                            gap += 1
                            j += 1
                        else:
                            break
                    end = j - gap
                    if end - i >= min_run:
                        a = _px_to_m(float(x0 + xp), float(y0 + i), height_px=h, mpp=mpp)
                        b = _px_to_m(float(x0 + xp), float(y0 + end), height_px=h, mpp=mpp)
                        if _is_structural_edge(a[0], a[1], b[0], b[1], min_len=0.95):
                            walls.append(
                                {
                                    "id": f"w-ink-axv-{len(walls)}",
                                    "a": _vec(*a),
                                    "b": _vec(*b),
                                    "thicknessM": WALL_THICKNESS_M,
                                    "thicknessAssumed": True,
                                    "heightM": CEILING_HEIGHT_M,
                                }
                            )
                    i = j
                else:
                    i += 1
        for yp in _peaks(row, sep, 0.34):
            band = roi[max(0, yp - 2) : min(rh, yp + 3), :].max(axis=0) > 0
            i = 0
            while i < rw:
                if band[i]:
                    j = i
                    gap = 0
                    while j < rw:
                        if band[j]:
                            gap = 0
                            j += 1
                        elif gap < gap_tol:
                            gap += 1
                            j += 1
                        else:
                            break
                    end = j - gap
                    if end - i >= min_run:
                        a = _px_to_m(float(x0 + i), float(y0 + yp), height_px=h, mpp=mpp)
                        b = _px_to_m(float(x0 + end), float(y0 + yp), height_px=h, mpp=mpp)
                        if _is_structural_edge(a[0], a[1], b[0], b[1], min_len=0.95):
                            walls.append(
                                {
                                    "id": f"w-ink-axh-{len(walls)}",
                                    "a": _vec(*a),
                                    "b": _vec(*b),
                                    "thicknessM": WALL_THICKNESS_M,
                                    "thicknessAssumed": True,
                                    "heightM": CEILING_HEIGHT_M,
                                }
                            )
                    i = j
                else:
                    i += 1

    # Ink support + reject segments sitting on thick furniture fills (marketing)
    filtered: list[dict[str, Any]] = []
    for wseg in walls:
        if not _wall_has_ink_support(wseg, ink, height_px=h, mpp=mpp, min_frac=0.12):
            continue
        if marketing:
            # Reject if perpendicular ink span is mat-like (very thick)
            ax, ay = wseg["a"]["x"], wseg["a"]["y"]
            bx, by = wseg["b"]["x"], wseg["b"]["y"]
            ddx = (bx - ax) / mpp
            ddy = -((by - ay) / mpp)  # image y
            LL = (ddx * ddx + ddy * ddy) ** 0.5 or 1.0
            nx, ny = -ddy / LL, ddx / LL
            widths: list[int] = []
            for t in (0.25, 0.5, 0.75):
                sx = (ax + (bx - ax) * t) / mpp
                sy = h - (ay + (by - ay) * t) / mpp
                span = 0
                for s in range(0, 26):
                    xx, yy = int(round(sx + nx * s)), int(round(sy + ny * s))
                    if not (0 <= xx < w and 0 <= yy < h) or ink[yy, xx] == 0:
                        span = s
                        break
                else:
                    span = 26
                span2 = 0
                for s in range(0, 26):
                    xx, yy = int(round(sx - nx * s)), int(round(sy - ny * s))
                    if not (0 <= xx < w and 0 <= yy < h) or ink[yy, xx] == 0:
                        span2 = s
                        break
                else:
                    span2 = 26
                widths.append(span + span2)
            if widths and float(np.median(widths)) > 22:
                continue
        filtered.append(wseg)
    walls = filtered

    # Prefer longer near-axis; soft dedupe by collinear midpoint
    walls = sorted(walls, key=_seg_length_m, reverse=True)
    kept: list[dict[str, Any]] = []
    for wseg in walls:
        mx = (wseg["a"]["x"] + wseg["b"]["x"]) / 2
        my = (wseg["a"]["y"] + wseg["b"]["y"]) / 2
        wh = abs(wseg["a"]["y"] - wseg["b"]["y"]) < 0.25
        dup = False
        for kseg in kept:
            kh = abs(kseg["a"]["y"] - kseg["b"]["y"]) < 0.25
            if wh != kh:
                continue
            kx = (kseg["a"]["x"] + kseg["b"]["x"]) / 2
            ky = (kseg["a"]["y"] + kseg["b"]["y"]) / 2
            if wh:
                if abs(my - ky) < 0.28:
                    wt0, wt1 = sorted([wseg["a"]["x"], wseg["b"]["x"]])
                    kt0, kt1 = sorted([kseg["a"]["x"], kseg["b"]["x"]])
                    if min(wt1, kt1) - max(wt0, kt0) > -0.35:
                        dup = True
                        break
            else:
                if abs(mx - kx) < 0.28:
                    wt0, wt1 = sorted([wseg["a"]["y"], wseg["b"]["y"]])
                    kt0, kt1 = sorted([kseg["a"]["y"], kseg["b"]["y"]])
                    if min(wt1, kt1) - max(wt0, kt0) > -0.35:
                        dup = True
                        break
        if not dup:
            kept.append(wseg)
        if len(kept) >= max_add:
            break
    return kept, ink



def _wall_has_ink_support(
    wall: dict[str, Any],
    ink: np.ndarray,
    *,
    height_px: int,
    mpp: float,
    min_frac: float = 0.28,
) -> bool:
    """Require wall segment to overlap dark ink (reject furniture / open-floor ghosts)."""
    h, w = ink.shape[:2]
    ax, ay = wall["a"]["x"], wall["a"]["y"]
    bx, by = wall["b"]["x"], wall["b"]["y"]
    hits = 0
    n = 0
    for t in (0.15, 0.3, 0.45, 0.5, 0.55, 0.7, 0.85):
        mx = ax + (bx - ax) * t
        my = ay + (by - ay) * t
        px = int(round(mx / mpp))
        py = int(round(height_px - my / mpp))
        n += 1
        if 0 <= px < w and 0 <= py < h and ink[py, px] > 0:
            hits += 1
        else:
            # small neighborhood
            for dy in (-4, -2, 0, 2, 4):
                for dx in (-4, -2, 0, 2, 4):
                    xx, yy = px + dx, py + dy
                    if 0 <= xx < w and 0 <= yy < h and ink[yy, xx] > 0:
                        hits += 1
                        break
                else:
                    continue
                break
    return (hits / max(n, 1)) >= min_frac


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
        # Tall skinny sidebar column (CAD title strip mistaken as room)
        if w_m > 1e-6 and (h_m / max(w_m, 1e-6)) >= 2.8 and w_m < 2.4 and h_m > 4.0:
            dropped += 1
            continue
        cx, cy = (min_x + max_x) / 2, (min_y + max_y) / 2
        if roi_m is not None:
            rx0, ry0, rx1, ry1 = roi_m
            roi_w = max(rx1 - rx0, 1e-6)
            roi_h = max(ry1 - ry0, 1e-6)
            if cx < rx0 - 0.05 or cx > rx1 + 0.05 or cy < ry0 - 0.05 or cy > ry1 + 0.05:
                dropped += 1
                continue
            # Mostly sitting on / below ROI bottom (banner remnant in BL coords)
            if max_y <= ry0 + 0.55 and h_m < 1.4:
                dropped += 1
                continue
            # Glued to left/right ROI edge as a vertical strip (title column remnant)
            on_right = min_x >= rx1 - min(2.6, roi_w * 0.18) and w_m < min(3.0, roi_w * 0.22)
            on_left = max_x <= rx0 + min(2.6, roi_w * 0.18) and w_m < min(3.0, roi_w * 0.22)
            if (on_right or on_left) and h_m >= roi_h * 0.45:
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
    plan_style: str | None = None,
    orig_sat_frac: float | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """Classical floor-plan geometry with furniture denoise + watershed rooms.

    Prefer structural (dark-ink / near-axis) walls over jagged free-space polygon
    edges that transect open floor or hug furniture. Split large free-space
    blobs at door necks so marketing plans are not one giant room.
    """
    notes: list[str] = []
    h, w = bgr.shape[:2]
    if content_roi is not None:
        x0, y0, x1, y1 = (int(v) for v in content_roi)
        notes.append("使用上游已裁切之室內平面圖繪圖區（略過標題／橫幅／側欄 chrome）。")
    else:
        x0, y0, x1, y1, roi_notes = _detect_content_roi(bgr)
        notes.extend(roi_notes)
    roi_m = (
        x0 * mpp,
        (h - y1) * mpp,
        x1 * mpp,
        (h - y0) * mpp,
    )

    foot = _footprint_mask(bgr, x0, y0, x1, y1)
    if plan_style is None:
        plan_style = _plan_style_from_bgr(bgr, foot, orig_sat_frac=orig_sat_frac)
    notes.append(f"平面圖風格判定：{plan_style}（影響墨跡／骨架路徑）。")
    foot_frac = float(foot[y0:y1, x0:x1].mean()) / 255.0
    # Tighten ROI to footprint bbox (marketing cream / CAD pads)
    ys, xs = np.where(foot > 0)
    if xs.size > 100:
        fx0, fx1 = int(xs.min()), int(xs.max()) + 1
        fy0, fy1 = int(ys.min()), int(ys.max()) + 1
        pad = max(4, int(min(fx1 - fx0, fy1 - fy0) * 0.01))
        nx0 = max(x0, fx0 - pad)
        ny0 = max(y0, fy0 - pad)
        nx1 = min(x1, fx1 + pad)
        ny1 = min(y1, fy1 + pad)
        if (nx1 - nx0) >= (x1 - x0) * 0.55 and (ny1 - ny0) >= (y1 - y0) * 0.55:
            if (nx0, ny0, nx1, ny1) != (x0, y0, x1, y1):
                notes.append(
                    f"ROI 再收斂至 footprint：({nx0},{ny0})–({nx1},{ny1})。"
                )
            x0, y0, x1, y1 = nx0, ny0, nx1, ny1
            # refresh roi_m
            roi_m = (
                x0 * mpp,
                (h - y1) * mpp,
                x1 * mpp,
                (h - y0) * mpp,
            )
    if foot_frac < 0.95:
        notes.append(
            f"繪圖 footprint 收斂（覆蓋 ROI≈{foot_frac*100:.0f}%），略過外側奶油底／裝飾。"
        )

    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    thr = cv2.adaptiveThreshold(
        blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 35, 8
    )
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    closed = cv2.morphologyEx(thr, cv2.MORPH_CLOSE, kernel, iterations=2)

    # Prefer thick structural ink as barriers (plan_style from ORIGINAL sat / strokes)
    hsv_b = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    marketing = plan_style == "marketing"
    if marketing:
        dark = (blur < 72).astype(np.uint8) * 255
    else:
        dark = ((blur > 25) & (blur < 165) & (hsv_b[:, :, 1] < 60)).astype(np.uint8) * 255
    dark = cv2.bitwise_and(dark, foot)
    # Thickness prior on marketing only — drop thin furniture strokes from barriers
    if marketing:
        dist = cv2.distanceTransform(
            cv2.morphologyEx(dark, cv2.MORPH_CLOSE, kernel, iterations=1), cv2.DIST_L2, 5
        )
        dark_thick = ((dist >= 1.0) & (dark > 0)).astype(np.uint8) * 255
        if cv2.countNonZero(dark_thick) >= 60:
            dark = dark_thick
    n_lab, labels, stats, _ = cv2.connectedComponentsWithStats(dark, connectivity=8)
    ink = np.zeros_like(closed)
    min_ink = max(25, int(min(w, h) * 0.002))
    for i in range(1, n_lab):
        area = int(stats[i, cv2.CC_STAT_AREA])
        ww = int(stats[i, cv2.CC_STAT_WIDTH])
        hh = int(stats[i, cv2.CC_STAT_HEIGHT])
        aspect = max(ww, hh) / (min(ww, hh) + 1e-6)
        if area >= min_ink and (aspect >= 2.2 or area >= (500 if marketing else 220)):
            ink[labels == i] = 255
    # CAD: lightly blend long adaptive strokes; marketing: skip (furniture noise)
    if not marketing:
        n2, lab2, st2, _ = cv2.connectedComponentsWithStats(closed, connectivity=8)
        for i in range(1, n2):
            area = int(st2[i, cv2.CC_STAT_AREA])
            ww = int(st2[i, cv2.CC_STAT_WIDTH])
            hh = int(st2[i, cv2.CC_STAT_HEIGHT])
            aspect = max(ww, hh) / (min(ww, hh) + 1e-6)
            if area >= min_ink * 2 and aspect >= 3.5:
                ink[lab2 == i] = 255
    notes.append(
        "OpenCV 去噪：保留細長厚墨跡結構牆，略過緊湊家具／文字"
        f"（style={plan_style}）。"
    )

    # Dilate barriers to close door gaps for room CC (CAD fills need more)
    dil_it = 3 if marketing else 5
    barrier = cv2.dilate(ink, kernel, iterations=dil_it)
    free = cv2.bitwise_and(foot, cv2.bitwise_not(barrier))
    free = cv2.morphologyEx(free, cv2.MORPH_OPEN, kernel, iterations=2)
    free[:y0, :] = 0
    free[y1:, :] = 0
    free[:, :x0] = 0
    free[:, x1:] = 0
    margin = max(6, min(x1 - x0, y1 - y0) // 60)
    free[y0 : y0 + margin, :] = 0
    free[max(y1 - margin, y0) : y1, :] = 0
    free[:, x0 : x0 + margin] = 0
    free[:, max(x1 - margin, x0) : x1] = 0

    roi_area = max(1, int(cv2.countNonZero(foot[y0:y1, x0:x1])) or (x1 - x0) * (y1 - y0))
    min_area = roi_area * 0.015

    room_masks = _split_free_via_watershed(free, min_area=min_area, max_rooms=12)
    notes.append(
        f"房間分割：watershed／連通區域候選 {len(room_masks)}（面積門檻≈{min_area:.0f} px）。"
    )

    rooms: list[dict[str, Any]] = []
    room_polys_px: list[np.ndarray] = []
    chrome_skip = 0
    for mask in room_masks:
        area = int(mask.sum() // 255)
        if area < min_area:
            continue
        ys, xs = np.where(mask > 0)
        if xs.size == 0:
            continue
        bx, by = int(xs.min()), int(ys.min())
        bw, bh = int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)
        # Reject thin strips (banner / sidebar)
        if bh > 0 and (bw / bh) >= 4.5 and bh < max(40, int((y1 - y0) * 0.12)):
            chrome_skip += 1
            continue
        if bw > 0 and (bh / bw) >= 4.5 and bw < max(40, int((x1 - x0) * 0.12)):
            chrome_skip += 1
            continue
        cx_px = bx + bw / 2
        cy_px = by + bh / 2
        if cx_px < x0 or cx_px > x1 or cy_px < y0 or cy_px > y1:
            chrome_skip += 1
            continue
        # Ortho / AABB from mask — L-shaped when fill low; else AABB
        ys, xs = np.where(mask > 0)
        if xs.size < 40:
            continue
        poly = _ortho_polygon_from_mask(mask, max_verts=10)
        if poly is None:
            xa, xb = int(xs.min()), int(xs.max())
            ya, yb = int(ys.min()), int(ys.max())
            poly = np.array(
                [[xa, ya], [xb, ya], [xb, yb], [xa, yb]], dtype=np.float64
            )
        room_polys_px.append(poly)
        verts = [
            _vec(*_px_to_m(float(x), float(y), height_px=h, mpp=mpp)) for x, y in poly
        ]
        rooms.append(
            {
                "id": f"room-{len(rooms)+1}",
                "type": "房間",
                "vertices": verts,
                "confidence": 0.58,
            }
        )
    if chrome_skip:
        notes.append(f"略過 chrome／底欄／細長區域房間候選 {chrome_skip} 個。")

    # Cap over-segmentation: keep largest rooms (marketing watershed can fragment)
    if len(rooms) > 9:
        scored = []
        for r, poly in zip(rooms, room_polys_px):
            area = float(cv2.contourArea(poly.astype(np.float32).reshape(-1, 1, 2)))
            scored.append((area, r, poly))
        scored.sort(key=lambda t: t[0], reverse=True)
        keep = scored[:9]
        rooms = [t[1] for t in keep]
        room_polys_px = [t[2] for t in keep]
        for i, r in enumerate(rooms):
            r["id"] = f"room-{i+1}"
        notes.append(f"房間過碎，保留面積最大 {len(rooms)} 個。")


    # Merge heavily overlapping AABB rooms (watershed fragments)
    if len(rooms) >= 2:
        merged_rooms: list[dict[str, Any]] = []
        merged_polys: list[np.ndarray] = []
        used = [False] * len(rooms)
        for i, (r, poly) in enumerate(zip(rooms, room_polys_px)):
            if used[i]:
                continue
            xa = [float(poly[:, 0].min()), float(poly[:, 0].max())]
            ya = [float(poly[:, 1].min()), float(poly[:, 1].max())]
            for j in range(i + 1, len(rooms)):
                if used[j]:
                    continue
                p2 = room_polys_px[j]
                xb = [float(p2[:, 0].min()), float(p2[:, 0].max())]
                yb = [float(p2[:, 1].min()), float(p2[:, 1].max())]
                ix0, iy0 = max(xa[0], xb[0]), max(ya[0], yb[0])
                ix1, iy1 = min(xa[1], xb[1]), min(ya[1], yb[1])
                iw, ih = max(0.0, ix1 - ix0), max(0.0, iy1 - iy0)
                inter = iw * ih
                a1 = max(1.0, (xa[1] - xa[0]) * (ya[1] - ya[0]))
                a2 = max(1.0, (xb[1] - xb[0]) * (yb[1] - yb[0]))
                if inter / min(a1, a2) >= 0.58:
                    xa = [min(xa[0], xb[0]), max(xa[1], xb[1])]
                    ya = [min(ya[0], yb[0]), max(ya[1], yb[1])]
                    used[j] = True
            used[i] = True
            npoly = np.array(
                [[xa[0], ya[0]], [xa[1], ya[0]], [xa[1], ya[1]], [xa[0], ya[1]]],
                dtype=np.float64,
            )
            verts = [
                _vec(*_px_to_m(float(x), float(y), height_px=h, mpp=mpp))
                for x, y in npoly
            ]
            merged_rooms.append(
                {
                    "id": f"room-{len(merged_rooms)+1}",
                    "type": "房間",
                    "vertices": verts,
                    "confidence": 0.55,
                }
            )
            merged_polys.append(npoly)
        if len(merged_rooms) < len(rooms):
            notes.append(
                f"合併重疊房間 {len(rooms)}→{len(merged_rooms)}。"
            )
            rooms, room_polys_px = merged_rooms, merged_polys

    # Primary walls: structural dark-ink Hough (straighter than room edges)
    walls, ink_struct = _structural_walls_from_ink(
        bgr, mpp=mpp, x0=x0, y0=y0, x1=x1, y1=y1, foot=foot,
        max_add=40, plan_style=plan_style,
    )
    # Prefer structural ink for support tests / barriers when richer
    if int(ink_struct.sum() // 255) > int(ink.sum() // 255):
        ink = ink_struct
    notes.append(f"深色墨跡結構牆段 {len(walls)}。")

    # Room-edge walls ONLY as last resort when ink walls are sparse.
    # Jagged free-space contours are the #1 source of transecting junk walls.
    n_edge = 0
    if len(walls) < 10:
        for ri, poly in enumerate(room_polys_px):
            pts = poly.tolist()
            for j in range(len(pts)):
                px1, py1 = pts[j]
                px2, py2 = pts[(j + 1) % len(pts)]
                a = _px_to_m(float(px1), float(py1), height_px=h, mpp=mpp)
                b = _px_to_m(float(px2), float(py2), height_px=h, mpp=mpp)
                ax, ay = a
                bx, by = b
                # Stricter: must be strongly axis-aligned and reasonably long
                if not _is_structural_edge(ax, ay, bx, by, min_len=1.4):
                    continue
                if _axis_align_score(ax, ay, bx, by) < 0.97:
                    continue
                if abs(ax - bx) < 0.12:
                    bx = ax = (ax + bx) / 2
                if abs(ay - by) < 0.12:
                    by = ay = (ay + by) / 2
                # Skip if an ink wall already covers this span
                mx, my = (ax + bx) / 2, (ay + by) / 2
                if any(
                    _point_seg_dist_m(
                        mx, my, w["a"]["x"], w["a"]["y"], w["b"]["x"], w["b"]["y"]
                    )
                    < 0.35
                    for w in walls
                ):
                    continue
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
                n_edge += 1
        notes.append(f"房間邊補結構牆（僅墨跡不足時，近軸長邊）{n_edge}。")
    else:
        notes.append("墨跡結構牆充足，略過房間多邊形邊（避免鋸齒穿越淨空）。")

    # CAD-like sparse dark ink → thick-wall skeleton Hough (supplement)
    _, dark_otsu = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    dark_pct = float(dark_otsu.mean()) / 255.0
    hsv_full = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    sat_frac = float((hsv_full[:, :, 1] > 80).mean())
    marketing_colorful = plan_style == "marketing" or skip_skeleton
    if dark_pct < 0.16 and not marketing_colorful and not skip_skeleton:
        k5 = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        thick = cv2.morphologyEx(dark_otsu, cv2.MORPH_OPEN, k5, iterations=1)
        thick = cv2.morphologyEx(thick, cv2.MORPH_CLOSE, kernel, iterations=2)
        thick = cv2.bitwise_and(thick, foot)
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
                if n_add >= 8:
                    break
                xa, ya, xb, yb = map(float, line)
                if abs(xb - xa) < 6:
                    xb = xa
                if abs(yb - ya) < 6:
                    yb = ya
                a = _px_to_m(xa, ya, height_px=h, mpp=mpp)
                b = _px_to_m(xb, yb, height_px=h, mpp=mpp)
                if not _is_structural_edge(a[0], a[1], b[0], b[1], min_len=0.8):
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

    # Drop walls that don't sit on dark ink (furniture ghosts / open-floor cuts)
    before = len(walls)
    if plan_style == "marketing":
        walls = [
            w
            for w in walls
            if _wall_has_ink_support(w, ink, height_px=h, mpp=mpp, min_frac=0.08)
            or str(w.get("id", "")).startswith(("w-room", "w-m-", "w-ink"))
        ]
    else:
        kept_ink = [
            w
            for w in walls
            if _wall_has_ink_support(w, ink, height_px=h, mpp=mpp, min_frac=0.08)
            or str(w.get("id", "")).startswith(("w-ink", "w-skel", "w-m-"))
        ]
        # CAD: if ink-only is too sparse, keep long near-axis room/skel edges
        if len(kept_ink) < 10:
            extras = [
                w
                for w in walls
                if w not in kept_ink
                and (
                    str(w.get("id", "")).startswith(("w-room", "w-skel", "w-m-"))
                    or _seg_length_m(w) >= 1.2
                )
                and _axis_align_score(
                    w["a"]["x"], w["a"]["y"], w["b"]["x"], w["b"]["y"]
                )
                >= 0.95
            ]
            extras = sorted(extras, key=_seg_length_m, reverse=True)[:12]
            walls = kept_ink + extras
            notes.append(
                f"CAD 墨跡牆偏少（{len(kept_ink)}），保留長近軸房間／骨架邊 {len(extras)}。"
            )
        else:
            walls = kept_ink
    if before - len(walls):
        notes.append(f"剔除無墨跡支撐的偽牆 {before - len(walls)} 條。")

    walls, merge_notes = _merge_collinear_walls(
        walls, min_len_m=0.70, gap_tol_m=0.85, axis_tol_m=0.18
    )
    notes.extend(merge_notes)

    # Stricter transect filter — drop walls cutting open floor
    walls, tx_notes = _filter_transecting_walls(walls, rooms, max_ratio=0.28)
    notes.extend(tx_notes)

    # Prefer structural / long / axis-aligned when capping (coverage > aggressive cut)
    max_walls = 36
    if len(walls) > max_walls:
        def _wall_keep_key(wseg: dict[str, Any]) -> tuple:
            wid = str(wseg.get("id", ""))
            L = _seg_length_m(wseg)
            ax, ay = wseg["a"]["x"], wseg["a"]["y"]
            bx, by = wseg["b"]["x"], wseg["b"]["y"]
            align = _axis_align_score(ax, ay, bx, by)
            prio = 0
            if "ink" in wid or wid.startswith("w-m-"):
                prio = 0
            elif "room" in wid:
                prio = 1
            elif "skel" in wid:
                prio = 2
            else:
                prio = 1
            return (prio, -align, -L)

        walls = sorted(walls, key=_wall_keep_key)[:max_walls]
        notes.append(f"牆段過多，已截斷至 {max_walls} 條（優先結構／近軸長牆）。")

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


def _layout_extent_m(
    walls: list[dict[str, Any]],
    rooms: list[dict[str, Any]] | None = None,
) -> tuple[float, float, float, float] | None:
    xs: list[float] = []
    ys: list[float] = []
    for w in walls:
        xs.extend([w["a"]["x"], w["b"]["x"]])
        ys.extend([w["a"]["y"], w["b"]["y"]])
    if rooms:
        for r in rooms:
            box = _room_aabb(r)
            if box:
                xs.extend([box[0], box[2]])
                ys.extend([box[1], box[3]])
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def _is_exterior_wall_line(
    orient: str,
    const: float,
    extent: tuple[float, float, float, float],
    *,
    margin_m: float = 0.85,
) -> bool:
    min_x, min_y, max_x, max_y = extent
    if orient == "h":
        return abs(const - min_y) < margin_m or abs(const - max_y) < margin_m
    return abs(const - min_x) < margin_m or abs(const - max_x) < margin_m


def _openings_from_gaps(
    walls: list[dict[str, Any]],
    *,
    rooms: list[dict[str, Any]] | None = None,
    door_range: tuple[float, float] = (0.55, 1.25),
    window_range: tuple[float, float] = (0.85, 2.8),
    allow_gap_windows: bool = True,
    max_gap_windows: int = 6,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """Collinear wall gaps → door (typical leaf) or carefully exterior window.

    Gap windows ONLY on near-exterior collinear wall lines (not peri-flood midpoints,
    not interior furniture gaps). Doors allowed on any collinear gap in door range.
    """
    notes: list[str] = []
    doors: list[dict[str, Any]] = []
    windows: list[dict[str, Any]] = []
    extent = _layout_extent_m(walls, None) or _layout_extent_m(walls, rooms)
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

    groups: dict[tuple[str, int], list[tuple[str, float, float, float]]] = defaultdict(list)
    for orient, wid, const, t0, t1 in hv:
        key = (orient, int(round(const * 10)))
        groups[key].append((wid, const, t0, t1))

    win_cands: list[tuple[float, dict[str, Any]]] = []
    for (orient, _), segs in groups.items():
        segs = sorted(segs, key=lambda s: s[2])
        for i in range(len(segs) - 1):
            wid_a, const, _, t1 = segs[i]
            _, _, t0_next, _ = segs[i + 1]
            gap = t0_next - t1
            if orient == "h":
                oa, ob = (t1, const), (t0_next, const)
            else:
                oa, ob = (const, t1), (const, t0_next)
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
            elif allow_gap_windows and w0 < gap <= w1 and extent is not None:
                if not _is_exterior_wall_line(orient, const, extent, margin_m=0.95):
                    continue
                win_cands.append(
                    (
                        gap,
                        {
                            "id": "win-gap-tmp",
                            "wallId": wid_a,
                            "opening": _seg(oa, ob),
                            "confidence": 0.40,
                            "sillHeightM": SILL_HEIGHT_M,
                            "sillHeightAssumed": True,
                        },
                    )
                )

    win_cands.sort(key=lambda t: t[0], reverse=True)
    for _, win in win_cands[:max_gap_windows]:
        win["id"] = f"win-gap-{len(windows)+1}"
        windows.append(win)

    if doors or windows:
        notes.append(
            f"由共線牆段缺口推估門 {len(doors)}、外牆缺口窗 {len(windows)}"
            f"（門 {door_range[0]}–{door_range[1]} m／窗 {window_range[0]}–{window_range[1]} m，"
            "窗僅近外框共線缺口）。"
        )
    else:
        notes.append("未從牆段缺口推估到門／窗；將嘗試模型開口與連通性補門。")
    return doors, windows, notes


def _windows_from_parallel_strokes(
    bgr: np.ndarray,
    walls: list[dict[str, Any]],
    rooms: list[dict[str, Any]],
    *,
    mpp: float,
    foot: np.ndarray | None = None,
    max_add: int = 5,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Marketing/CAD window glyphs = 2–3 parallel strokes near exterior walls.

    Carefully: only clusters near layout exterior AND near an existing wall segment.
    Avoids peri-flood midpoints on every outer edge.
    """
    notes: list[str] = []
    if not walls or max_add <= 0:
        return [], notes
    # Walls-only extent — CubiCasa rooms can bleed to chrome and inflate bbox
    extent = _layout_extent_m(walls, None) or _layout_extent_m(walls, rooms)
    if extent is None:
        return [], notes
    h, w = bgr.shape[:2]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    edges = cv2.Canny(blur, 45, 130)
    if foot is not None:
        edges = cv2.bitwise_and(edges, foot)
    min_len = max(28, int(min(h, w) * 0.04))
    lines = cv2.HoughLinesP(
        edges, 1, np.pi / 180, threshold=22, minLineLength=max(22, min_len - 8), maxLineGap=14
    )
    if lines is None:
        return [], notes
    min_x, min_y, max_x, max_y = extent
    # Collect near-axis segments in metres
    segs: list[tuple[str, float, float, float]] = []  # orient, const, t0, t1
    for x1, y1, x2, y2 in lines.reshape(-1, 4):
        if abs(x2 - x1) < 6:
            x2 = x1
        if abs(y2 - y1) < 6:
            y2 = y1
        if abs(x2 - x1) >= 8 and abs(y2 - y1) >= 8:
            continue
        a = _px_to_m(float(x1), float(y1), height_px=h, mpp=mpp)
        b = _px_to_m(float(x2), float(y2), height_px=h, mpp=mpp)
        if abs(a[1] - b[1]) < 0.12 and abs(a[0] - b[0]) > 0.55:
            t0, t1 = sorted([a[0], b[0]])
            const = (a[1] + b[1]) / 2
            segs.append(("h", const, t0, t1))
        elif abs(a[0] - b[0]) < 0.12 and abs(a[1] - b[1]) > 0.55:
            t0, t1 = sorted([a[1], b[1]])
            const = (a[0] + b[0]) / 2
            segs.append(("v", const, t0, t1))

    # Group parallel strokes within 0.35 m of each other near exterior
    used = [False] * len(segs)
    cands: list[tuple[float, tuple[float, float], tuple[float, float], str]] = []
    for i, (ori, c0, t0a, t1a) in enumerate(segs):
        if used[i]:
            continue
        # Must be near exterior const
        if ori == "h":
            if not (abs(c0 - min_y) < 1.4 or abs(c0 - max_y) < 1.4):
                continue
        else:
            if not (abs(c0 - min_x) < 1.4 or abs(c0 - max_x) < 1.4):
                continue
        cluster = [(c0, t0a, t1a)]
        used[i] = True
        for j in range(i + 1, len(segs)):
            if used[j]:
                continue
            ori2, c1, t0b, t1b = segs[j]
            if ori2 != ori:
                continue
            if abs(c1 - c0) > 0.55:
                continue
            # overlap in t
            ov0, ov1 = max(t0a, t0b), min(t1a, t1b)
            if ov1 - ov0 < 0.45:
                continue
            cluster.append((c1, t0b, t1b))
            used[j] = True
        if len(cluster) < 2:
            continue
        # Prefer overlap; else union clipped to typical window length
        t0_ov = max(s[1] for s in cluster)
        t1_ov = min(s[2] for s in cluster)
        if t1_ov - t0_ov >= 0.7:
            t0, t1 = t0_ov, min(t1_ov, t0_ov + 2.6)
        else:
            t0_u = min(s[1] for s in cluster)
            t1_u = max(s[2] for s in cluster)
            span = t1_u - t0_u
            if span < 0.7:
                continue
            # Center a 1.2–2.0 m window in the union
            mid = (t0_u + t1_u) / 2
            half = min(1.0, max(0.6, span * 0.35))
            t0, t1 = mid - half, mid + half
        const = float(np.mean([s[0] for s in cluster]))
        if ori == "h":
            oa, ob = (t0, const), (t1, const)
        else:
            oa, ob = (const, t0), (const, t1)
        # Must be near a wall
        wid = _nearest_wall_id(oa, ob, walls)
        d = _nearest_wall_dist_m(oa, ob, walls)
        if d > 0.85:
            continue
        L = ((oa[0] - ob[0]) ** 2 + (oa[1] - ob[1]) ** 2) ** 0.5
        cands.append((L, oa, ob, wid))

    cands.sort(key=lambda t: t[0], reverse=True)
    added: list[dict[str, Any]] = []
    for L, oa, ob, wid in cands:
        if len(added) >= max_add:
            break
        mx, my = (oa[0] + ob[0]) / 2, (oa[1] + ob[1]) / 2
        if any(
            ((k["opening"]["a"]["x"] + k["opening"]["b"]["x"]) / 2 - mx) ** 2
            + ((k["opening"]["a"]["y"] + k["opening"]["b"]["y"]) / 2 - my) ** 2
            < 0.85 ** 2
            for k in added
        ):
            continue
        added.append(
            {
                "id": f"win-par-{len(added)+1}",
                "wallId": wid,
                "opening": _seg(oa, ob),
                "confidence": 0.37,
                "sillHeightM": SILL_HEIGHT_M,
                "sillHeightAssumed": True,
            }
        )
    if added:
        notes.append(
            f"外牆平行筆劃窗符號 {len(added)}（雙／三線窗，貼近外框牆段）。"
        )
    return added, notes


def _windows_from_exterior_ink(
    bgr: np.ndarray,
    walls: list[dict[str, Any]],
    rooms: list[dict[str, Any]],
    *,
    mpp: float,
    plan_style: str,
    max_add: int = 5,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Detect classic double-line window symbols on near-exterior structural walls.

    Looks for short bright gaps / parallel thin strokes along exterior ink walls —
    NOT peri midpoints of every outer wall (that spam failed QA).
    """
    notes: list[str] = []
    if max_add <= 0 or not walls:
        return [], notes
    extent = _layout_extent_m(walls, None) or _layout_extent_m(walls, rooms)
    if extent is None:
        return [], notes
    h, w = bgr.shape[:2]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    # Bright openings / window cavities along walls
    if plan_style == "marketing":
        bright = (blur > 190).astype(np.uint8) * 255
    else:
        bright = (blur > 200).astype(np.uint8) * 255
    k3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    bright = cv2.morphologyEx(bright, cv2.MORPH_OPEN, k3, iterations=1)

    min_x, min_y, max_x, max_y = extent
    cands: list[tuple[float, dict[str, Any]]] = []
    for wall in walls:
        ax, ay = wall["a"]["x"], wall["a"]["y"]
        bx, by = wall["b"]["x"], wall["b"]["y"]
        L = ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5
        if L < 1.4:
            continue
        mx, my = (ax + bx) / 2, (ay + by) / 2
        exterior = (
            abs(mx - min_x) < 0.9
            or abs(mx - max_x) < 0.9
            or abs(my - min_y) < 0.9
            or abs(my - max_y) < 0.9
        )
        if not exterior:
            continue
        # Sample along wall for bright cavity runs (window glazing / sill)
        horiz = abs(ay - by) < 0.15
        hits = []
        for t in np.linspace(0.08, 0.92, 24):
            x = ax + (bx - ax) * t
            y = ay + (by - ay) * t
            px = int(round(x / mpp))
            py = int(round(h - y / mpp))
            ok = False
            for dy in (-3, -1, 0, 1, 3):
                for dx in (-3, -1, 0, 1, 3):
                    xx, yy = px + dx, py + dy
                    if 0 <= xx < w and 0 <= yy < h and bright[yy, xx] > 0:
                        ok = True
                        break
                if ok:
                    break
            hits.append((t, ok))
        # Find contiguous bright runs → candidate windows
        run_t0 = None
        for t, ok in hits + [(1.0, False)]:
            if ok and run_t0 is None:
                run_t0 = t
            elif not ok and run_t0 is not None:
                run_len = (t - run_t0) * L
                if 0.7 <= run_len <= 2.8:
                    tm = (run_t0 + t) / 2
                    open_len = min(run_len, L * 0.45)
                    hx = (bx - ax) / L
                    hy = (by - ay) / L
                    cx = ax + (bx - ax) * tm
                    cy = ay + (by - ay) * tm
                    oa = (cx - hx * open_len / 2, cy - hy * open_len / 2)
                    ob = (cx + hx * open_len / 2, cy + hy * open_len / 2)
                    cands.append(
                        (
                            run_len,
                            {
                                "id": "win-ink-tmp",
                                "wallId": wall["id"],
                                "opening": _seg(oa, ob),
                                "confidence": 0.38,
                                "sillHeightM": SILL_HEIGHT_M,
                                "sillHeightAssumed": True,
                            },
                        )
                    )
                run_t0 = None
    cands.sort(key=lambda t: t[0], reverse=True)
    added: list[dict[str, Any]] = []
    for _, win in cands:
        if len(added) >= max_add:
            break
        a, b = win["opening"]["a"], win["opening"]["b"]
        mx, my = (a["x"] + b["x"]) / 2, (a["y"] + b["y"]) / 2
        if any(
            ((k["opening"]["a"]["x"] + k["opening"]["b"]["x"]) / 2 - mx) ** 2
            + ((k["opening"]["a"]["y"] + k["opening"]["b"]["y"]) / 2 - my) ** 2
            < 0.7 ** 2
            for k in added
        ):
            continue
        win["id"] = f"win-ink-{len(added)+1}"
        added.append(win)
    if added:
        notes.append(
            f"外牆墨跡亮縫補窗 {len(added)}（僅近外框牆段上的連續亮帶，非 peri 中點）。"
        )
    return added, notes


def _perimeter_windows(
    walls: list[dict[str, Any]],
    rooms: list[dict[str, Any]],
    *,
    existing: list[dict[str, Any]],
    max_add: int = 4,
) -> tuple[list[dict[str, Any]], list[str]]:
    """DISABLED: heuristic perimeter windows are forbidden (QA).

    Kept as a no-op stub so older call sites fail closed.
    """
    notes: list[str] = ["略過外牆啟發式 peri 窗（已全面禁止，僅模型偵測有效）。"]
    return [], notes
    aabbs = [b for r in rooms if (b := _room_aabb(r))]  # noqa: unreachable
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

    # Budget scales with doorless enclosed rooms (still capped to avoid spam)
    doorless = [
        (rid, box)
        for rid, box in aabbs
        if not room_has_door(rid, box)
    ]
    enclosed = []
    for rid, box in doorless:
        min_x, min_y, max_x, max_y = box
        span_frac = ((max_x - min_x) / lay_w) * ((max_y - min_y) / lay_h)
        if span_frac < 0.72:
            enclosed.append((rid, box, span_frac))
    # Prefer smaller rooms first (bedrooms/baths need doors; open living less so)
    enclosed.sort(key=lambda t: t[2])
    access_budget = max(0, min(4, len(enclosed)))
    access_added = 0

    for rid, box, span_frac in enclosed:
        if room_has_door(rid, box):
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




def _extend_perimeter_walls_along_ink(
    walls: list[dict[str, Any]],
    bgr: np.ndarray,
    *,
    mpp: float,
    content_roi: tuple[int, int, int, int],
    plan_style: str,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Grow near-exterior H/V walls along dark/CAD ink to close perimeter gaps."""
    notes: list[str] = []
    if not walls or mpp <= 0:
        return walls, notes
    h, w = bgr.shape[:2]
    x0, y0, x1, y1 = (int(v) for v in content_roi)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    k3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    if plan_style == "marketing":
        ink = (blur < 80).astype(np.uint8) * 255
    else:
        ink = ((blur > 25) & (blur < 170) & (hsv[:, :, 1] < 65)).astype(np.uint8) * 255
    ink = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, k3, iterations=1)
    extent = _layout_extent_m(walls, None)
    if extent is None:
        return walls, notes
    min_x, min_y, max_x, max_y = extent
    margin = 1.15
    extended = 0
    out: list[dict[str, Any]] = []
    for wall in walls:
        ax, ay = wall["a"]["x"], wall["a"]["y"]
        bx, by = wall["b"]["x"], wall["b"]["y"]
        mx, my = (ax + bx) / 2, (ay + by) / 2
        near_ext = (
            abs(mx - min_x) < margin
            or abs(mx - max_x) < margin
            or abs(my - min_y) < margin
            or abs(my - max_y) < margin
        )
        if not near_ext:
            out.append(wall)
            continue
        horiz = abs(ay - by) < 0.2
        # Walk endpoints outward along axis while ink supports
        def _ink_at(xm: float, ym: float) -> bool:
            px = int(round(xm / mpp))
            py = int(round(h - ym / mpp))
            if not (0 <= px < w and 0 <= py < h):
                return False
            if ink[py, px] > 0:
                return True
            for dy in (-3, 0, 3):
                for dx in (-3, 0, 3):
                    xx, yy = px + dx, py + dy
                    if 0 <= xx < w and 0 <= yy < h and ink[yy, xx] > 0:
                        return True
            return False

        step = 0.08
        max_grow = 2.8
        ax2, ay2, bx2, by2 = ax, ay, bx, by
        if horiz:
            # left end
            left, right = (ax, bx) if ax <= bx else (bx, ax)
            yconst = (ay + by) / 2
            g = 0.0
            while g < max_grow and _ink_at(left - step, yconst):
                left -= step
                g += step
            g = 0.0
            while g < max_grow and _ink_at(right + step, yconst):
                right += step
                g += step
            ax2, bx2, ay2, by2 = left, right, yconst, yconst
        else:
            bot, top = (ay, by) if ay <= by else (by, ay)
            xconst = (ax + bx) / 2
            g = 0.0
            while g < max_grow and _ink_at(xconst, bot - step):
                bot -= step
                g += step
            g = 0.0
            while g < max_grow and _ink_at(xconst, top + step):
                top += step
                g += step
            ax2, bx2, ay2, by2 = xconst, xconst, bot, top
        old_L = ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5
        new_L = ((ax2 - bx2) ** 2 + (ay2 - by2) ** 2) ** 0.5
        nw = dict(wall)
        if new_L > old_L + 0.15:
            nw["a"] = _vec(ax2, ay2)
            nw["b"] = _vec(bx2, by2)
            extended += 1
        out.append(nw)
    if extended:
        notes.append(f"外牆段沿墨跡延伸 {extended} 條（補齊周界缺口）。")
        out, _ = _merge_collinear_walls(out, min_len_m=0.65, gap_tol_m=0.95, axis_tol_m=0.2)
    return out, notes


def _constrain_rooms_by_walls(
    rooms: list[dict[str, Any]],
    walls: list[dict[str, Any]],
    *,
    mpp: float,
    height_px: int,
    content_roi: tuple[int, int, int, int] | None = None,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Clip coarse room polygons to free-space cells bounded by wall barriers.

    Builds a raster barrier from wall segments, floods free space, and for each
    room keeps the largest free CC overlapping its centroid / AABB — yielding
    wall-constrained ortho polygons instead of coarse AABB/watershed only.
    """
    notes: list[str] = []
    if not rooms or not walls or mpp <= 0:
        return rooms, notes
    # Bound raster to ROI or layout extent
    xs: list[float] = []
    ys: list[float] = []
    for w in walls:
        xs.extend([w["a"]["x"], w["b"]["x"]])
        ys.extend([w["a"]["y"], w["b"]["y"]])
    for r in rooms:
        for v in r.get("vertices") or []:
            xs.append(float(v["x"]))
            ys.append(float(v["y"]))
    if not xs:
        return rooms, notes
    pad = 0.4
    min_x, max_x = min(xs) - pad, max(xs) + pad
    min_y, max_y = min(ys) - pad, max(ys) + pad
    # raster size
    rw = max(32, int(round((max_x - min_x) / mpp)))
    rh = max(32, int(round((max_y - min_y) / mpp)))
    if rw * rh > 4_000_000:
        return rooms, notes
    barrier = np.zeros((rh, rw), np.uint8)
    thick = max(2, int(round(0.12 / mpp)))

    def _m_to_r(x: float, y: float) -> tuple[int, int]:
        px = int(round((x - min_x) / mpp))
        # y up in metres → row down
        py = int(round((max_y - y) / mpp))
        return px, py

    for w in walls:
        p1 = _m_to_r(w["a"]["x"], w["a"]["y"])
        p2 = _m_to_r(w["b"]["x"], w["b"]["y"])
        cv2.line(barrier, p1, p2, 255, thick)
    k3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    barrier = cv2.dilate(barrier, k3, iterations=1)
    free = cv2.bitwise_not(barrier)
    if content_roi is not None:
        # optional: zero outside ROI in raster — skip for simplicity
        pass
    n, lab, st, _ = cv2.connectedComponentsWithStats(free, connectivity=4)
    if n <= 2:
        return rooms, notes

    out: list[dict[str, Any]] = []
    improved = 0
    for r in rooms:
        box = _room_aabb(r)
        if not box:
            out.append(r)
            continue
        cx = (box[0] + box[2]) / 2
        cy = (box[1] + box[3]) / 2
        px, py = _m_to_r(cx, cy)
        label = 0
        if 0 <= px < rw and 0 <= py < rh:
            label = int(lab[py, px])
        if label <= 0:
            # search nearby free cell inside AABB
            x0, y0, x1, y1 = box
            best = (0, 0)
            for yy in np.linspace(y0 + 0.1, y1 - 0.1, 5):
                for xx in np.linspace(x0 + 0.1, x1 - 0.1, 5):
                    qx, qy = _m_to_r(float(xx), float(yy))
                    if 0 <= qx < rw and 0 <= qy < rh:
                        lid = int(lab[qy, qx])
                        if lid > 0:
                            area = int(st[lid, cv2.CC_STAT_AREA])
                            if area > best[0]:
                                best = (area, lid)
            label = best[1]
        if label <= 0:
            out.append(r)
            continue
        mask = (lab == label).astype(np.uint8) * 255
        # Clip mask to expanded room AABB to avoid swallowing whole floor
        x0, y0, x1, y1 = box
        exp = 0.55
        rx0, ry0 = _m_to_r(x0 - exp, y1 + exp)
        rx1, ry1 = _m_to_r(x1 + exp, y0 - exp)
        rx0, rx1 = max(0, min(rx0, rx1)), min(rw, max(rx0, rx1))
        ry0, ry1 = max(0, min(ry0, ry1)), min(rh, max(ry0, ry1))
        clip = np.zeros_like(mask)
        clip[ry0:ry1, rx0:rx1] = mask[ry0:ry1, rx0:rx1]
        if cv2.countNonZero(clip) < 40:
            out.append(r)
            continue
        poly = _ortho_polygon_from_mask(clip, max_verts=12)
        if poly is None or len(poly) < 4:
            out.append(r)
            continue
        # Convert raster poly → metres
        verts = []
        for x, y in poly:
            mx = min_x + float(x) * mpp
            my = max_y - float(y) * mpp
            verts.append(_vec(mx, my))
        nr = dict(r)
        nr["vertices"] = verts
        nr["confidence"] = min(0.72, float(r.get("confidence") or 0.55) + 0.08)
        out.append(nr)
        improved += 1
    if improved:
        notes.append(f"房間多邊形以牆段屏障約束 {improved}/{len(rooms)}（ortho clip）。")
    return out, notes


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
    # Plan style from ORIGINAL (before ROI white-mask kills sat / stroke stats)
    plan_style = _plan_style_from_bgr(bgr, orig_sat_frac=sat_frac0)
    if marketing_colorful:
        plan_style = "marketing"

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
        f"平面圖風格（原圖）：{plan_style}（sat>80≈{sat_frac0*100:.1f}%）。",
    ]
    if plan_style == "marketing":
        notes.append(
            "行銷／線稿風格 → 深色筆劃牆＋略過 CAD 骨架 Hough，避免傢具偽結構。"
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
        skip_skeleton=(plan_style == "marketing"),
        plan_style=plan_style,
        orig_sat_frac=sat_frac0,
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

    # Prefer richer room topology (split bedrooms) — CubiCasa floor+wall barriers or OpenCV
    rooms = cv_rooms
    roi_m = (
        x0 * mpp,
        (h - y1) * mpp,
        x1 * mpp,
        (h - y0) * mpp,
    )
    if cubi and cubi.get("rooms"):
        cr = cubi["rooms"]
        cr_f, cr_notes = _filter_chrome_rooms(cr, roi_m=roi_m)
        notes.extend(cr_notes)
        # Prefer CubiCasa only if chrome-filtered set still has good topology
        if len(cr_f) >= max(4, len(cv_rooms) - 1):
            rooms = cr_f
            notes.append(
                f"房間採用 CubiCasa floor＋牆屏障（{len(cr_f)}，OpenCV={len(cv_rooms)}）。"
            )
        elif len(cr_f) >= 3 and len(cr_f) >= len(cv_rooms):
            rooms = cr_f
            notes.append(
                f"房間採用 CubiCasa（chrome 過濾後 {len(cr_f)}）。"
            )
        else:
            notes.append(
                f"CubiCasa 房間 chrome 過濾後僅 {len(cr_f)}，改用 OpenCV {len(cv_rooms)}。"
            )
    elif yolo_rooms and len(yolo_rooms) >= max(3, len(cv_rooms)):
        rooms = yolo_rooms
        notes.append("房間採用 YOLO 遮罩。")
    rooms, chrome2 = _filter_chrome_rooms(rooms, roi_m=roi_m)
    notes.extend(chrome2)

    walls = list(cv_walls)
    if yolo_walls:
        # Only keep YOLO walls that are reasonably long; merge into CV structure
        long_yolo = [w for w in yolo_walls if _seg_length_m(w) >= 0.8]
        if long_yolo:
            walls = walls + long_yolo
            notes.append(f"併入 YOLO 長牆 {len(long_yolo)}。")
    if cubi and cubi.get("wall_segs"):
        cubi_walls = cubi["wall_segs"]
        # CAD: keep more CubiCasa walls (trained on CAD). Marketing: fewer, longer only.
        cubi_cap = 24 if plan_style == "cad" else 12
        cubi_walls = sorted(
            cubi_walls,
            key=lambda ab: ((ab[0][0] - ab[1][0]) ** 2 + (ab[0][1] - ab[1][1]) ** 2),
            reverse=True,
        )[:cubi_cap]
        n_cubi = 0
        for i, (a, b) in enumerate(cubi_walls):
            L = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
            min_L = 0.7 if plan_style == "cad" else 1.0
            if L < min_L:
                continue
            # Near-axis only
            if abs(a[0] - b[0]) >= 0.28 and abs(a[1] - b[1]) >= 0.28:
                continue
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
            n_cubi += 1
        notes.append(f"併入 CubiCasa 近軸長牆至多 {cubi_cap}（實際 {n_cubi}）。")

    walls, merge_notes = _merge_collinear_walls(
        walls, min_len_m=0.65, gap_tol_m=0.90, axis_tol_m=0.18
    )
    notes.extend(merge_notes)
    tx_ratio = 0.40 if len(walls) < 12 else 0.32
    walls, tx_notes = _filter_transecting_walls(walls, rooms, max_ratio=tx_ratio)
    notes.extend(tx_notes)
    # Drop remaining non-structural short diagonals
    walls = [
        w
        for w in walls
        if _is_structural_edge(
            w["a"]["x"], w["a"]["y"], w["b"]["x"], w["b"]["y"], min_len=0.55
        )
    ]
    # Extend near-exterior wall segments along ink (close perimeter gaps)
    walls, peri_ext_notes = _extend_perimeter_walls_along_ink(
        walls, bgr, mpp=mpp, content_roi=(x0, y0, x1, y1), plan_style=plan_style
    )
    notes.extend(peri_ext_notes)
    # Wall-constrained room polygons (after structural walls settle)
    rooms, room_wall_notes = _constrain_rooms_by_walls(
        rooms, walls, mpp=mpp, height_px=h, content_roi=(x0, y0, x1, y1)
    )
    notes.extend(room_wall_notes)
    # Coverage-first cap: keep long near-axis structural walls (was 22; too aggressive)
    if len(walls) > 36:
        def _wall_keep_key(w: dict[str, Any]) -> tuple:
            wid = str(w.get("id", ""))
            L = _seg_length_m(w)
            align = _axis_align_score(
                w["a"]["x"], w["a"]["y"], w["b"]["x"], w["b"]["y"]
            )
            if "ink" in wid or wid.startswith("w-m-"):
                prio = 0
            elif "cubi" in wid:
                prio = 0 if plan_style == "cad" else 1
            elif "skel" in wid:
                prio = 1
            elif "room" in wid:
                prio = 2
            else:
                prio = 1
            return (prio, -align, -L)

        walls = sorted(walls, key=_wall_keep_key)[:36]
        notes.append("牆段過多，最終截斷至 36（優先墨跡／近軸長牆，覆蓋優先）。")

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
        for i, (a, b) in enumerate(cubi_wins[:8]):
            wlen = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
            if wlen < 0.55 or wlen > 3.5:
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

    # CAD: CubiCasa windows already merged above — prefer them over heuristics
    if plan_style == "cad" and cubi:
        cubi_win_n = sum(1 for w in windows if str(w.get("id", "")).startswith("win-cubi"))
        if cubi_win_n:
            notes.append(f"CAD 優先保留 CubiCasa 窗 {cubi_win_n}（啟發式僅在不足時補）。")
    need_gap_wins = len(windows) < (2 if plan_style == "cad" else 2)
    gap_doors, gap_wins, gap_notes = _openings_from_gaps(
        walls,
        rooms=rooms,
        allow_gap_windows=need_gap_wins,
        max_gap_windows=6,
    )
    notes.extend(gap_notes)
    if len(doors) < 3:
        doors.extend(gap_doors)
        if gap_doors:
            notes.append("已併用缺口啟發式補門。")
    if need_gap_wins and gap_wins:
        windows.extend(gap_wins)
        notes.append(
            f"模型窗不足（{len(windows) - len(gap_wins)}），"
            f"併用外牆共線缺口窗 {len(gap_wins)}（非 peri 中點）。"
        )
    elif gap_wins:
        notes.append(f"略過缺口窗 {len(gap_wins)}（模型窗已足夠）。")

    # Exterior glyphs: bright-seam + parallel strokes (CAD especially needs these
    # when CubiCasa window count is low after geometric filter).
    win_target = 6 if plan_style == "cad" else 4
    if len(windows) < win_target:
        ink_wins, ink_notes = _windows_from_exterior_ink(
            bgr, walls, rooms, mpp=mpp, plan_style=plan_style,
            max_add=max(2, win_target - len(windows)),
        )
        notes.extend(ink_notes)
        windows.extend(ink_wins)
    if len(windows) < win_target:
        foot = _footprint_mask(bgr, x0, y0, x1, y1)
        par_wins, par_notes = _windows_from_parallel_strokes(
            bgr, walls, rooms, mpp=mpp, foot=foot,
            max_add=max(3, win_target - len(windows)),
        )
        notes.extend(par_notes)
        windows.extend(par_wins)

    # Reject openings far from walls BEFORE peri/access heuristics
    # Looser snap when wall coverage sparse (CAD mid-gray often under-detected)
    loose = len(walls) < 10
    doors, n_drop_d, n_snap_d = _filter_openings_near_walls(
        doors, walls,
        max_dist_m=0.70 if loose else 0.45,
        snap_max_m=1.25 if loose else 0.85,
    )
    windows, n_drop_w, n_snap_w = _filter_openings_near_walls(
        windows, walls,
        max_dist_m=0.80 if loose else 0.55,
        snap_max_m=1.35 if loose else 0.95,
    )
    if n_drop_d or n_drop_w or n_snap_d or n_snap_w:
        notes.append(
            f"開口貼牆：門 snap {n_snap_d}/drop {n_drop_d}，"
            f"窗 snap {n_snap_w}/drop {n_drop_w}。"
        )

    # FORBIDDEN: heuristic perimeter windows (even when model wins exist).
    # Only model detections (YOLO / CubiCasa) and snapped gap openings remain.
    peri_ids = [w for w in windows if str(w.get("id", "")).startswith("win-peri")]
    if peri_ids:
        windows = [w for w in windows if not str(w.get("id", "")).startswith("win-peri")]
    notes.append("已禁止 peri 中點補窗；保留模型／外牆共線缺口／外牆墨跡亮縫窗。")

    doors = _dedupe_openings(doors)
    windows = _dedupe_openings(windows)
    if len(doors) > 8:
        doors = sorted(doors, key=_opening_len, reverse=True)[:8]
        notes.append("門候選過多，截斷至 8。")
    if len(windows) > 8:
        windows = sorted(windows, key=_opening_len, reverse=True)[:8]
        notes.append("窗候選過多，截斷至 8。")

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
