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
        "floorplan-rw-seg.pt",  # room/wall/door/window YOLO-seg (preferred)
        "floorplan-seg.pt",    # FloorCAD symbol seg (fallback)
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





def _wall_mask_centerline_m(
    mask: np.ndarray,
    *,
    height_px: int,
    mpp: float,
) -> tuple[tuple[float, float], tuple[float, float]] | None:
    """Thick wall mask → near-axis centerline segment in metres (PCA)."""
    m = (mask > 0).astype(np.uint8) * 255
    if int(cv2.countNonZero(m)) < 40:
        return None
    ys, xs = np.where(m > 0)
    if xs.size < 20:
        return None
    pts = np.column_stack([xs.astype(np.float64), ys.astype(np.float64)])
    mean = pts.mean(axis=0)
    centered = pts - mean
    cov = centered.T @ centered / max(len(pts) - 1, 1)
    try:
        eigvals, eigvecs = np.linalg.eigh(cov)
        axis = eigvecs[:, int(np.argmax(eigvals))]
    except np.linalg.LinAlgError:
        axis = np.array([1.0, 0.0])
    t = centered @ axis
    t0, t1 = float(t.min()), float(t.max())
    if abs(t1 - t0) < 8:
        return None
    p0 = mean + axis * t0
    p1 = mean + axis * t1
    dx, dy = abs(p1[0] - p0[0]), abs(p1[1] - p0[1])
    if dx >= dy * 1.15:
        ymid = 0.5 * (p0[1] + p1[1])
        xa, xb = float(min(p0[0], p1[0])), float(max(p0[0], p1[0]))
        p0 = np.array([xa, ymid])
        p1 = np.array([xb, ymid])
    elif dy >= dx * 1.15:
        xmid = 0.5 * (p0[0] + p1[0])
        ya, yb = float(min(p0[1], p1[1])), float(max(p0[1], p1[1]))
        p0 = np.array([xmid, ya])
        p1 = np.array([xmid, yb])
    else:
        if min(dx, dy) / max(dx, dy, 1e-6) > 0.45:
            return None
    a = _px_to_m(float(p0[0]), float(p0[1]), height_px=height_px, mpp=mpp)
    b = _px_to_m(float(p1[0]), float(p1[1]), height_px=height_px, mpp=mpp)
    L = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
    if L < 0.35:
        return None
    return a, b

def _ortho_polygon_from_mask(mask: np.ndarray, *, max_verts: int = 16) -> np.ndarray | None:
    """Rectilinear room outline from free-space mask (L/T allowed).

    Prefer morphologically closed ortho outlines when the blob is non-rectangular
    (fill low → L/T/U); fall back to AABB only for compact rectangular rooms.
    """
    m = (mask > 0).astype(np.uint8) * 255
    if m.max() == 0:
        return None
    # Light close to fill furniture holes inside a room without bridging walls
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    m_closed = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k, iterations=2)
    ys, xs = np.where(m_closed > 0)
    if xs.size < 30:
        return None
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    area = int(xs.size)
    fill = area / max(bw * bh, 1)
    aabb = np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], dtype=np.float64)
    # Only force AABB for very compact / nearly-full rectangles
    if fill >= 0.82 or area < 2500:
        return aabb
    # Non-AABB: ortho-snapped approx (try a few epsilons for L/T)
    best_arr = None
    best_score = -1.0
    for ef in (0.018, 0.024, 0.032, 0.040):
        poly = _approx_polygon(m_closed, epsilon_frac=ef)
        if poly is None or len(poly) < 4:
            continue
        pts = poly.astype(np.float64).tolist()
        snapped = [pts[0][:]]
        for i in range(1, len(pts)):
            px, py = snapped[-1]
            qx, qy = pts[i]
            if abs(qx - px) < abs(qy - py) * 0.45:
                qx = px
            elif abs(qy - py) < abs(qx - px) * 0.45:
                qy = py
            snapped.append([qx, qy])
        if abs(snapped[-1][0] - snapped[0][0]) < 4:
            snapped[-1][0] = snapped[0][0]
        if abs(snapped[-1][1] - snapped[0][1]) < 4:
            snapped[-1][1] = snapped[0][1]
        # Drop near-duplicate verts
        cleaned = [snapped[0]]
        for p in snapped[1:]:
            if abs(p[0] - cleaned[-1][0]) > 3 or abs(p[1] - cleaned[-1][1]) > 3:
                cleaned.append(p)
        arr = np.array(cleaned, dtype=np.float64)
        if len(arr) < 4 or len(arr) > max_verts:
            continue
        poly_area = abs(cv2.contourArea(arr.astype(np.float32).reshape(-1, 1, 2)))
        if poly_area < area * 0.45 or poly_area > area * 1.35:
            continue
        # Prefer more verts when fill is low (true L), else fewer
        score = poly_area / max(area, 1) + (0.08 * min(len(arr), 10) if fill < 0.72 else 0.0)
        if score > best_score:
            best_score = score
            best_arr = arr
    if best_arr is not None:
        return best_arr
    return aabb


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
    out: list[dict[str, Any]] = []
    for w in walls:
        L = _seg_length_m(w)
        if L >= min_len_m:
            out.append(w)
        elif "ring" in str(w.get("id", "")) and L >= 0.40:
            out.append(w)
    return out


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

    def _merge_id(srcs: list[dict[str, Any]], mid: int) -> str:
        """Prefer w-ring / w-ink identity so downstream priority survives merge."""
        ids = [str(s.get("id", "")) for s in srcs]
        if any("ring" in i for i in ids):
            return f"w-ring-m-{mid}"
        if any("ink" in i for i in ids):
            return f"w-ink-m-{mid}"
        return f"w-m-{mid}"

    merged: list[dict[str, Any]] = []
    mid = 0
    for (orient, _), segs in groups.items():
        segs = sorted(segs, key=lambda s: s[1])
        cur_const, cur_t0, cur_t1, src0 = segs[0]
        cur_srcs: list[dict[str, Any]] = [src0]
        for const, t0, t1, ww in segs[1:]:
            if t0 <= cur_t1 + gap_tol_m:
                cur_t1 = max(cur_t1, t1)
                cur_const = (cur_const + const) / 2
                cur_srcs.append(ww)
            else:
                mid += 1
                if orient == "h":
                    a, b = (cur_t0, cur_const), (cur_t1, cur_const)
                else:
                    a, b = (cur_const, cur_t0), (cur_const, cur_t1)
                merged.append(
                    {
                        "id": _merge_id(cur_srcs, mid),
                        "a": _vec(*a),
                        "b": _vec(*b),
                        "thicknessM": WALL_THICKNESS_M,
                        "thicknessAssumed": True,
                        "heightM": CEILING_HEIGHT_M,
                    }
                )
                cur_const, cur_t0, cur_t1 = const, t0, t1
                cur_srcs = [ww]
        mid += 1
        if orient == "h":
            a, b = (cur_t0, cur_const), (cur_t1, cur_const)
        else:
            a, b = (cur_const, cur_t0), (cur_const, cur_t1)
        merged.append(
            {
                "id": _merge_id(cur_srcs, mid),
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



def _flush_openings_to_perimeter_walls(
    items: list[dict[str, Any]],
    walls: list[dict[str, Any]],
    *,
    max_dist_m: float = 0.75,
    ring_only: bool = False,
    min_len_m: float = 0.40,
) -> tuple[list[dict[str, Any]], int]:
    """Project openings onto nearest ring/exterior wall for flush alignment.

    Prefer outer-ring walls (true perimeter windows/doors). When ring_only,
    never snap onto interior ink partitions (avoids fake peri / furniture walls).
    Drop degenerate near-zero openings after projection.
    """
    peri = [w for w in walls if "ring" in str(w.get("id", ""))]
    if not peri and not ring_only:
        # fallback: near-extent walls
        extent = _layout_extent_m(walls, None)
        if extent is None:
            return items, 0
        min_x, min_y, max_x, max_y = extent
        margin = 0.95
        peri = []
        for w in walls:
            mx = (w["a"]["x"] + w["b"]["x"]) / 2
            my = (w["a"]["y"] + w["b"]["y"]) / 2
            if (
                abs(mx - min_x) < margin
                or abs(mx - max_x) < margin
                or abs(my - min_y) < margin
                or abs(my - max_y) < margin
            ):
                peri.append(w)
    if not peri:
        # Keep items but drop zero-length
        out0: list[dict[str, Any]] = []
        for it in items:
            a, b = it["opening"]["a"], it["opening"]["b"]
            L = ((a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2) ** 0.5
            if L >= min_len_m:
                out0.append(it)
        return out0, 0
    out: list[dict[str, Any]] = []
    n_flush = 0
    for it in items:
        oa = (it["opening"]["a"]["x"], it["opening"]["a"]["y"])
        ob = (it["opening"]["b"]["x"], it["opening"]["b"]["y"])
        L0 = ((oa[0] - ob[0]) ** 2 + (oa[1] - ob[1]) ** 2) ** 0.5
        if L0 < min_len_m * 0.5:
            continue  # drop degenerate before flush
        proj = _project_opening_onto_nearest_wall(oa, ob, peri)
        if proj is not None:
            na, nb, wid, d = proj
            L1 = ((na[0] - nb[0]) ** 2 + (na[1] - nb[1]) ** 2) ** 0.5
            if d <= max_dist_m and L1 >= min_len_m:
                it = dict(it)
                it["opening"] = _seg(na, nb)
                it["wallId"] = wid
                n_flush += 1
                out.append(it)
                continue
            if ring_only and d > max_dist_m:
                # Interior / far from ring: drop fake exterior opening
                continue
        if L0 >= min_len_m and not ring_only:
            out.append(it)
        elif L0 >= min_len_m and ring_only:
            # Keep only if already near a ring wall
            dist = _nearest_wall_dist_m(oa, ob, peri)
            if dist <= max_dist_m * 1.15:
                out.append(it)
    return out, n_flush


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
        if "ink" in wid or "skel" in wid or "ring" in wid:
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



def _hv_snap_closed_polyline(pts_xy: np.ndarray, *, angle_tol_deg: float = 20.0) -> np.ndarray:
    """Snap a closed polyline to H/V edges (stair-step diagonals). Returns Nx2."""
    n = len(pts_xy)
    if n < 3:
        return pts_xy.astype(np.float64)
    out: list[np.ndarray] = [pts_xy[0].astype(np.float64)]
    for i in range(n):
        a = out[-1]
        b = pts_xy[(i + 1) % n].astype(np.float64)
        dx, dy = float(b[0] - a[0]), float(b[1] - a[1])
        if abs(dx) < 1.5 and abs(dy) < 1.5:
            continue
        ang = abs(float(np.degrees(np.arctan2(dy, dx)))) % 180.0
        near_h = ang <= angle_tol_deg or ang >= 180.0 - angle_tol_deg
        near_v = abs(ang - 90.0) <= angle_tol_deg
        if near_h:
            y = 0.5 * (a[1] + b[1])
            if abs(out[-1][1] - y) > 2:
                out[-1] = np.array([out[-1][0], y], dtype=np.float64)
            out.append(np.array([b[0], y], dtype=np.float64))
        elif near_v:
            x = 0.5 * (a[0] + b[0])
            if abs(out[-1][0] - x) > 2:
                out[-1] = np.array([x, out[-1][1]], dtype=np.float64)
            out.append(np.array([x, b[1]], dtype=np.float64))
        else:
            if abs(dx) >= abs(dy):
                out.append(np.array([b[0], a[1]], dtype=np.float64))
                out.append(np.array([b[0], b[1]], dtype=np.float64))
            else:
                out.append(np.array([a[0], b[1]], dtype=np.float64))
                out.append(np.array([b[0], b[1]], dtype=np.float64))
    cleaned: list[np.ndarray] = [out[0]]
    for p in out[1:]:
        if abs(p[0] - cleaned[-1][0]) > 2 or abs(p[1] - cleaned[-1][1]) > 2:
            cleaned.append(p)
    if len(cleaned) >= 3:
        a, b = cleaned[-1], cleaned[0]
        if abs(a[0] - b[0]) > 3 or abs(a[1] - b[1]) > 3:
            if abs(a[0] - b[0]) <= abs(a[1] - b[1]):
                cleaned[-1] = np.array([b[0], a[1]], dtype=np.float64)
                if abs(cleaned[-1][1] - b[1]) > 3:
                    cleaned.append(np.array([b[0], b[1]], dtype=np.float64))
            else:
                cleaned[-1] = np.array([a[0], b[1]], dtype=np.float64)
                if abs(cleaned[-1][0] - b[0]) > 3:
                    cleaned.append(np.array([b[0], b[1]], dtype=np.float64))
    return np.asarray(cleaned, dtype=np.float64)


def _refine_contour_pts_to_ink(
    cnt: np.ndarray,
    ink: np.ndarray,
    *,
    max_search: int = 28,
    subsample: int = 400,
) -> np.ndarray:
    """Move footprint contour samples inward to nearest morph-closed ink."""
    pts = cnt.reshape(-1, 2).astype(np.float64)
    if len(pts) < 8:
        return pts
    c_x = float(np.mean(pts[:, 0]))
    c_y = float(np.mean(pts[:, 1]))
    h, w = ink.shape[:2]
    ink_d = cv2.dilate(ink, np.ones((3, 3), np.uint8), iterations=1)
    step = max(1, len(pts) // max(subsample, 50))
    out: list[tuple[float, float]] = []
    for p in pts[::step]:
        px, py = float(p[0]), float(p[1])
        vx, vy = c_x - px, c_y - py
        nrm = (vx * vx + vy * vy) ** 0.5 or 1.0
        ux, uy = vx / nrm, vy / nrm
        best: tuple[float, float] | None = None
        for s in range(0, max_search + 1):
            xx = int(round(px + ux * s))
            yy = int(round(py + uy * s))
            if not (0 <= xx < w and 0 <= yy < h):
                break
            if ink_d[yy, xx] > 0:
                best = (float(xx), float(yy))
                break
        if best is None:
            for r in range(1, 12):
                y0b, y1b = max(0, int(py) - r), min(h, int(py) + r + 1)
                x0b, x1b = max(0, int(px) - r), min(w, int(px) + r + 1)
                ys, xs = np.where(ink_d[y0b:y1b, x0b:x1b] > 0)
                if xs.size:
                    d2 = (xs - (px - x0b)) ** 2 + (ys - (py - y0b)) ** 2
                    k = int(np.argmin(d2))
                    best = (float(xs[k] + x0b), float(ys[k] + y0b))
                    break
        out.append(best if best is not None else (px, py))
    return np.asarray(out, dtype=np.float64)




def _bridge_ring_corners(
    walls: list[dict[str, Any]], *, gap_tol_m: float = 1.25
) -> list[dict[str, Any]]:
    """If two ring endpoints are unmatched within gap_tol, insert H/V corner bridge."""
    if len(walls) < 2:
        return walls
    out = [dict(w) for w in walls]
    # Collect unmatched endpoints
    ends: list[tuple[int, str, float, float]] = []
    for i, w in enumerate(out):
        for end in ("a", "b"):
            x, y = w[end]["x"], w[end]["y"]
            matched = False
            for j, o in enumerate(out):
                if i == j:
                    continue
                for end2 in ("a", "b"):
                    x2, y2 = o[end2]["x"], o[end2]["y"]
                    if (x - x2) ** 2 + (y - y2) ** 2 <= 0.35 ** 2:
                        matched = True
                        break
                if matched:
                    break
            if not matched:
                ends.append((i, end, x, y))
    # Pair unmatched ends that share nearly same x or y
    used = set()
    bridges: list[dict[str, Any]] = []
    for a_i, (i, e1, x1, y1) in enumerate(ends):
        if a_i in used:
            continue
        best = None
        for b_i, (j, e2, x2, y2) in enumerate(ends):
            if b_i <= a_i or b_i in used or i == j:
                continue
            dx, dy = abs(x1 - x2), abs(y1 - y2)
            if dx <= 0.35 and 0.15 < dy <= gap_tol_m:
                # vertical bridge
                d = dy
                if best is None or d < best[0]:
                    best = (d, b_i, j, e2, x1, y1, x2, y2, "v")
            elif dy <= 0.35 and 0.15 < dx <= gap_tol_m:
                d = dx
                if best is None or d < best[0]:
                    best = (d, b_i, j, e2, x1, y1, x2, y2, "h")
        if best is None:
            continue
        _d, b_i, j, e2, x1, y1, x2, y2, orient = best
        used.add(a_i)
        used.add(b_i)
        if orient == "v":
            cx = 0.5 * (x1 + x2)
            a, b = (cx, min(y1, y2)), (cx, max(y1, y2))
        else:
            cy = 0.5 * (y1 + y2)
            a, b = (min(x1, x2), cy), (max(x1, x2), cy)
        bridges.append(
            {
                "id": f"w-ring-bridge-{len(bridges)+1}",
                "a": _vec(*a),
                "b": _vec(*b),
                "thicknessM": WALL_THICKNESS_M,
                "thicknessAssumed": True,
                "heightM": CEILING_HEIGHT_M,
            }
        )
    return out + bridges

def _close_ring_endpoint_gaps(
    walls: list[dict[str, Any]], *, gap_tol_m: float = 0.85
) -> list[dict[str, Any]]:
    """Extend H/V ring segment endpoints to meet neighbors (close small corners)."""
    if len(walls) < 3:
        return walls
    out = [dict(w) for w in walls]
    # For each endpoint, find nearest other endpoint; if within gap_tol and axis-compatible, snap
    for i, w in enumerate(out):
        for end in ("a", "b"):
            x, y = w[end]["x"], w[end]["y"]
            best = None
            best_d = gap_tol_m
            for j, o in enumerate(out):
                if i == j:
                    continue
                for end2 in ("a", "b"):
                    x2, y2 = o[end2]["x"], o[end2]["y"]
                    d = ((x - x2) ** 2 + (y - y2) ** 2) ** 0.5
                    if 1e-6 < d < best_d:
                        best_d = d
                        best = (j, end2, x2, y2)
            if best is None:
                continue
            j, end2, x2, y2 = best
            # Snap both to shared corner: prefer H then V meeting point
            wh = abs(w["a"]["y"] - w["b"]["y"]) < 0.25
            oh = abs(out[j]["a"]["y"] - out[j]["b"]["y"]) < 0.25
            if wh and not oh:
                # w horizontal, o vertical → corner (o.x, w.y)
                cx = out[j]["a"]["x"]  # vertical const x
                cy = w["a"]["y"]
                w[end] = _vec(cx, cy)
                out[j][end2] = _vec(cx, cy)
            elif oh and not wh:
                cx = w["a"]["x"]
                cy = out[j]["a"]["y"]
                w[end] = _vec(cx, cy)
                out[j][end2] = _vec(cx, cy)
            else:
                # same orientation: pull endpoints to midpoint
                mx, my = 0.5 * (x + x2), 0.5 * (y + y2)
                w[end] = _vec(mx, my)
                out[j][end2] = _vec(mx, my)
            out[i] = w
    return out


def _largest_connected_wall_component(
    walls: list[dict[str, Any]], *, gap_tol_m: float = 0.70
) -> list[dict[str, Any]]:
    """Keep the largest endpoint-connected component (drop isolated ring spurs)."""
    n = len(walls)
    if n <= 1:
        return walls
    # Union-find on wall indices via endpoint proximity
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[rj] = ri

    ends = []
    for i, w in enumerate(walls):
        ends.append((i, w["a"]["x"], w["a"]["y"]))
        ends.append((i, w["b"]["x"], w["b"]["y"]))
    tol2 = gap_tol_m * gap_tol_m
    for a in range(len(ends)):
        i, x, y = ends[a]
        for b in range(a + 1, len(ends)):
            j, x2, y2 = ends[b]
            if i == j:
                continue
            if (x - x2) ** 2 + (y - y2) ** 2 <= tol2:
                union(i, j)
    comps: dict[int, list[int]] = {}
    for i in range(n):
        comps.setdefault(find(i), []).append(i)
    best = max(comps.values(), key=len)
    return [walls[i] for i in sorted(best)]


def _walls_form_closed_ring(
    walls: list[dict[str, Any]], *, gap_tol_m: float = 0.55
) -> bool:
    """True if wall endpoints nearly form a single closed loop (≤1 broken corner)."""
    if len(walls) < 3:
        return False
    ends: list[tuple[float, float]] = []
    for w in walls:
        ends.append((w["a"]["x"], w["a"]["y"]))
        ends.append((w["b"]["x"], w["b"]["y"]))
    unmatched = 0
    tol2 = gap_tol_m * gap_tol_m
    for i, (x, y) in enumerate(ends):
        found = False
        for j, (x2, y2) in enumerate(ends):
            if i == j or i // 2 == j // 2:
                continue
            if (x - x2) ** 2 + (y - y2) ** 2 <= tol2:
                found = True
                break
        if not found:
            unmatched += 1
    return unmatched <= 2



def _morph_skeleton(bin_u8: np.ndarray, *, max_iter: int = 80) -> np.ndarray:
    """Morphological skeleton (Zhang-Suen style via open/erode loop)."""
    img = (bin_u8 > 0).astype(np.uint8) * 255
    skel = np.zeros_like(img)
    element = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
    for _ in range(max_iter):
        opened = cv2.morphologyEx(img, cv2.MORPH_OPEN, element)
        temp = cv2.subtract(img, opened)
        eroded = cv2.erode(img, element)
        skel = cv2.bitwise_or(skel, temp)
        img = eroded
        if cv2.countNonZero(img) == 0:
            break
    return skel


def _thick_wall_ink_mask(
    bgr: np.ndarray,
    foot: np.ndarray,
    *,
    plan_style: str = "cad",
) -> np.ndarray:
    """Style-aware thick wall ink (fill+stroke), furniture mats suppressed."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1]
    marketing = plan_style == "marketing"
    k3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    if marketing:
        dark = (blur < 82).astype(np.uint8) * 255
        dark = cv2.bitwise_and(dark, foot)
        dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, k3, iterations=2)
        dist = cv2.distanceTransform(dark, cv2.DIST_L2, 5)
        thick = ((dist >= 1.15) & (dark > 0)).astype(np.uint8) * 255
        # Drop compact furniture solids
        n, lab, st, _ = cv2.connectedComponentsWithStats(thick, connectivity=8)
        ink = np.zeros_like(thick)
        for i in range(1, n):
            area = int(st[i, cv2.CC_STAT_AREA])
            ww = int(st[i, cv2.CC_STAT_WIDTH])
            hh = int(st[i, cv2.CC_STAT_HEIGHT])
            aspect = max(ww, hh) / (min(ww, hh) + 1e-6)
            solidity = area / max(ww * hh, 1)
            if area >= 320 and aspect < 2.6 and solidity > 0.50:
                continue
            if area >= 40 and (aspect >= 1.7 or area >= 220):
                ink[lab == i] = 255
        # Keep elongated stroke edges for thin perimeter
        edges = cv2.Canny(blur, 40, 120)
        darkish = cv2.dilate((blur < 95).astype(np.uint8) * 255, k3, iterations=1)
        stroke = cv2.bitwise_and(cv2.bitwise_and(edges, darkish), foot)
        n2, lab2, st2, _ = cv2.connectedComponentsWithStats(stroke, connectivity=8)
        for i in range(1, n2):
            area = int(st2[i, cv2.CC_STAT_AREA])
            ww = int(st2[i, cv2.CC_STAT_WIDTH])
            hh = int(st2[i, cv2.CC_STAT_HEIGHT])
            aspect = max(ww, hh) / (min(ww, hh) + 1e-6)
            if area >= 18 and aspect >= 3.0 and max(ww, hh) >= 22:
                ink[lab2 == i] = 255
    else:
        dark = ((blur > 25) & (blur < 170) & (sat < 65)).astype(np.uint8) * 255
        dark = cv2.bitwise_and(dark, foot)
        dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, k3, iterations=2)
        dist = cv2.distanceTransform(dark, cv2.DIST_L2, 5)
        thick = ((dist >= 0.95) & (dark > 0)).astype(np.uint8) * 255
        n, lab, st, _ = cv2.connectedComponentsWithStats(dark, connectivity=8)
        ink = np.zeros_like(dark)
        for i in range(1, n):
            area = int(st[i, cv2.CC_STAT_AREA])
            ww = int(st[i, cv2.CC_STAT_WIDTH])
            hh = int(st[i, cv2.CC_STAT_HEIGHT])
            aspect = max(ww, hh) / (min(ww, hh) + 1e-6)
            mean_t = float(dist[lab == i].mean()) if area else 0.0
            if area >= 40 and aspect >= 1.5:
                ink[lab == i] = 255
            elif area >= 160 and mean_t >= 1.0:
                ink[lab == i] = 255
        ink = cv2.bitwise_or(ink, thick)
    ink = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, k3, iterations=2)
    return ink


def _medial_axis_mask(ink: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Distance-transform medial ridge + morphological skeleton of thick ink.

    Returns (medial_u8, dist_f32). Medial sits on thick-wall *centerline*,
    not thin jagged outer edges of wall ink.
    """
    ink_b = (ink > 0).astype(np.uint8) * 255
    if ink_b.max() == 0:
        return ink_b, np.zeros(ink_b.shape, np.float32)
    dist = cv2.distanceTransform(ink_b, cv2.DIST_L2, 5)
    # Ridge: local maxima of distance (dilate compare)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    dil = cv2.dilate(dist, k)
    ridge = ((dist >= dil - 0.15) & (dist >= 1.0) & (ink_b > 0)).astype(np.uint8) * 255
    # Also keep morphological skeleton of thick cores (dist>=1.2)
    thick = ((dist >= 1.2) & (ink_b > 0)).astype(np.uint8) * 255
    skel = _morph_skeleton(thick if thick.max() else ink_b)
    medial = cv2.bitwise_or(ridge, skel)
    # Light dilate so later nearest-medial projections are stable
    medial = cv2.dilate(medial, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)), iterations=1)
    return medial, dist


def _snap_polyline_to_medial(
    pts_xy: np.ndarray,
    medial: np.ndarray,
    dist: np.ndarray,
    *,
    max_search: int = 28,
) -> np.ndarray:
    """Move closed polyline vertices onto nearest thick-wall medial pixel."""
    h, w = medial.shape[:2]
    med_yx = np.column_stack(np.where(medial > 0))  # (y, x)
    if len(med_yx) < 8:
        return pts_xy
    out = []
    for p in pts_xy:
        x, y = float(p[0]), float(p[1])
        xi, yi = int(round(x)), int(round(y))
        best = (x, y)
        best_d = 1e18
        # Prefer high-distance medial pixels (true thick center)
        for r in range(0, max_search + 1, 2):
            y0, y1 = max(0, yi - r), min(h, yi + r + 1)
            x0, x1 = max(0, xi - r), min(w, xi + r + 1)
            roi = medial[y0:y1, x0:x1]
            if roi.max() == 0:
                continue
            ys, xs = np.where(roi > 0)
            for yy, xx in zip(ys, xs):
                gy, gx = y0 + int(yy), x0 + int(xx)
                d = (gx - x) ** 2 + (gy - y) ** 2
                # Bonus for thicker centerline
                d -= 0.35 * float(dist[gy, gx]) ** 2
                if d < best_d:
                    best_d = d
                    best = (float(gx), float(gy))
            if best_d < 1e17 and r >= 4:
                break
        out.append(best)
    return np.array(out, dtype=np.float64)


def _hv_runs_from_medial(
    medial: np.ndarray,
    *,
    height_px: int,
    mpp: float,
    min_run_px: int = 28,
    prefix: str = "w-med",
) -> list[dict[str, Any]]:
    """Vectorize medial axis into long near-H/V centerline segments."""
    if medial.max() == 0 or mpp <= 0:
        return []
    h, w = medial.shape[:2]
    k3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    med = cv2.dilate(medial, k3, iterations=1)
    hw = max(15, int(min(h, w) * 0.020)) | 1
    kh = cv2.getStructuringElement(cv2.MORPH_RECT, (hw, 1))
    kv = cv2.getStructuringElement(cv2.MORPH_RECT, (1, hw))
    horiz = cv2.morphologyEx(med, cv2.MORPH_OPEN, kh)
    vert = cv2.morphologyEx(med, cv2.MORPH_OPEN, kv)
    out: list[dict[str, Any]] = []

    def _runs(mask: np.ndarray, orient: str) -> None:
        nlab, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        for i in range(1, nlab):
            area = int(stats[i, cv2.CC_STAT_AREA])
            if area < min_run_px * 2:
                continue
            ys, xs = np.where(labels == i)
            if xs.size == 0:
                continue
            if orient == "h":
                cy = int(np.median(ys))
                band = np.zeros(w, dtype=bool)
                for yb in range(max(0, cy - 2), min(h, cy + 3)):
                    band |= labels[yb, :] == i
                j = 0
                while j < w:
                    if band[j]:
                        k = j
                        while k < w and band[k]:
                            k += 1
                        if k - j >= min_run_px:
                            a = _px_to_m(float(j), float(cy), height_px=height_px, mpp=mpp)
                            b = _px_to_m(float(k), float(cy), height_px=height_px, mpp=mpp)
                            if _is_structural_edge(a[0], a[1], b[0], b[1], min_len=0.55):
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
                band = np.zeros(h, dtype=bool)
                for xb in range(max(0, cx - 2), min(w, cx + 3)):
                    band |= labels[:, xb] == i
                j = 0
                while j < h:
                    if band[j]:
                        k = j
                        while k < h and band[k]:
                            k += 1
                        if k - j >= min_run_px:
                            a = _px_to_m(float(cx), float(j), height_px=height_px, mpp=mpp)
                            b = _px_to_m(float(cx), float(k), height_px=height_px, mpp=mpp)
                            if _is_structural_edge(a[0], a[1], b[0], b[1], min_len=0.55):
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

    _runs(horiz, "h")
    _runs(vert, "v")
    return out


def _outer_perimeter_ring_walls(
    bgr: np.ndarray,
    *,
    mpp: float,
    x0: int,
    y0: int,
    x1: int,
    y1: int,
    foot: np.ndarray,
    plan_style: str = "cad",
) -> tuple[list[dict[str, Any]], bool, list[str]]:
    """Continuous outer perimeter on thick-wall *centerline* (medial axis).

    1) Thick wall ink (fill+stroke) inside footprint.
    2) Distance-transform medial ridge + skeleton (not thin jagged outer edges).
    3) Footprint / ink outer contour → snap vertices to medial centerline.
    4) approxPolyDP + H/V snap → closed ring of long centerline segments.
    """
    notes: list[str] = []
    h, w = bgr.shape[:2]
    if mpp <= 0 or foot.max() == 0:
        return [], False, notes
    marketing = plan_style == "marketing"
    # Thick ink + medial centerline (not edge-hugging)
    ink_thick = _thick_wall_ink_mask(bgr, foot, plan_style=plan_style)
    kclose = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
    ink_c = cv2.morphologyEx(
        ink_thick, cv2.MORPH_CLOSE, kclose, iterations=2 if marketing else 3
    )
    medial, dist = _medial_axis_mask(ink_c)
    # Fallback soft ink for support probes when medial sparse
    if cv2.countNonZero(medial) < 80:
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        blur = cv2.GaussianBlur(gray, (3, 3), 0)
        hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
        if marketing:
            soft = (blur < 88).astype(np.uint8) * 255
        else:
            soft = ((blur > 25) & (blur < 175) & (hsv[:, :, 1] < 70)).astype(np.uint8) * 255
        soft = cv2.bitwise_and(soft, foot)
        ink_c = cv2.morphologyEx(soft, cv2.MORPH_CLOSE, kclose, iterations=2)
        medial, dist = _medial_axis_mask(ink_c)

    foot_cnts, _ = cv2.findContours(foot, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not foot_cnts:
        return [], False, notes
    foot_cnt = max(foot_cnts, key=cv2.contourArea)
    foot_a = float(cv2.contourArea(foot_cnt))
    src = "foot+medial"
    base_cnt = foot_cnt
    ink_cnts, _ = cv2.findContours(ink_c, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if ink_cnts:
        ink_cnt = max(ink_cnts, key=cv2.contourArea)
        if float(cv2.contourArea(ink_cnt)) >= foot_a * 0.35 and not marketing:
            base_cnt = ink_cnt
            src = "ink+medial"

    # First pull contour onto ink, then onto thick-wall medial centerline
    refined = _refine_contour_pts_to_ink(base_cnt, ink_c, max_search=30)
    if len(refined) < 6:
        notes.append("外周界輪廓頂點不足，略過 ring。")
        return [], False, notes
    refined = _snap_polyline_to_medial(
        refined.astype(np.float64), medial, dist, max_search=32
    )
    refined_cnt = refined.reshape(-1, 1, 2).astype(np.int32)
    peri = float(cv2.arcLength(refined_cnt, True))
    if peri < 80:
        return [], False, notes
    best = refined_cnt
    used_ef = 0.01
    for ef in (0.003, 0.005, 0.007, 0.009, 0.012, 0.015, 0.02, 0.025):
        ap = cv2.approxPolyDP(refined_cnt, ef * peri, True)
        if 8 <= len(ap) <= 30:
            best = ap
            used_ef = ef
            break
        best = ap
        used_ef = ef
    pts = best.reshape(-1, 2).astype(np.float64)
    # Re-snap approx vertices to medial so ring sits on thick centerline
    pts = _snap_polyline_to_medial(pts, medial, dist, max_search=24)
    snapped = _hv_snap_closed_polyline(pts)
    walls: list[dict[str, Any]] = []
    n = len(snapped)
    for i in range(n):
        a = snapped[i]
        b = snapped[(i + 1) % n]
        if i == n - 1 and abs(a[0] - snapped[0][0]) < 2 and abs(a[1] - snapped[0][1]) < 2:
            continue
        am = _px_to_m(float(a[0]), float(a[1]), height_px=h, mpp=mpp)
        bm = _px_to_m(float(b[0]), float(b[1]), height_px=h, mpp=mpp)
        # Force exact H/V in metres
        if abs(am[0] - bm[0]) <= abs(am[1] - bm[1]):
            x = 0.5 * (am[0] + bm[0])
            am = (x, am[1])
            bm = (x, bm[1])
        else:
            y = 0.5 * (am[1] + bm[1])
            am = (am[0], y)
            bm = (bm[0], y)
        L = ((am[0] - bm[0]) ** 2 + (am[1] - bm[1]) ** 2) ** 0.5
        if L < 0.55:
            continue
        # Soft ink support (perimeter may sit on thin stroke)
        probe = {
            "a": _vec(*am),
            "b": _vec(*bm),
        }
        if not _wall_has_ink_support(probe, ink_c, height_px=h, mpp=mpp, min_frac=0.06):
            # Still keep long outer edges — footprint ring is structural even if ink thin
            if L < 1.2:
                continue
        walls.append(
            {
                "id": f"w-ring-{len(walls)+1}",
                "a": _vec(*am),
                "b": _vec(*bm),
                "thicknessM": WALL_THICKNESS_M,
                "thicknessAssumed": True,
                "heightM": CEILING_HEIGHT_M,
            }
        )
    walls, _ = _merge_collinear_walls(
        walls, min_len_m=0.50, gap_tol_m=1.05, axis_tol_m=0.28
    )
    walls = _close_ring_endpoint_gaps(walls, gap_tol_m=0.95)
    walls = _bridge_ring_corners(walls, gap_tol_m=1.35)
    walls = _largest_connected_wall_component(walls, gap_tol_m=0.70)
    # Re-id after merge / gap close / bridges / CC
    for i, wseg in enumerate(walls):
        wseg["id"] = f"w-ring-{i+1}"
    closed = _walls_form_closed_ring(walls, gap_tol_m=0.70)
    # If ink contour failed to close, retry once from footprint (often cleaner outer hull)
    if not closed and "ink" in src:
        refined_f = _refine_contour_pts_to_ink(foot_cnt, ink_c, max_search=30)
        if len(refined_f) >= 6:
            refined_f = _snap_polyline_to_medial(
                refined_f.astype(np.float64), medial, dist, max_search=32
            )
            rc = refined_f.reshape(-1, 1, 2).astype(np.int32)
            peri_f = float(cv2.arcLength(rc, True))
            best_f = rc
            ef_f = 0.01
            for ef in (0.003, 0.005, 0.007, 0.009, 0.012, 0.015, 0.02, 0.025):
                ap = cv2.approxPolyDP(rc, ef * peri_f, True)
                if 8 <= len(ap) <= 30:
                    best_f = ap
                    ef_f = ef
                    break
                best_f = ap
                ef_f = ef
            pts_f = _snap_polyline_to_medial(
                best_f.reshape(-1, 2).astype(np.float64), medial, dist, max_search=24
            )
            snapped_f = _hv_snap_closed_polyline(pts_f)
            walls_f: list[dict[str, Any]] = []
            nf = len(snapped_f)
            for i in range(nf):
                a = snapped_f[i]
                b = snapped_f[(i + 1) % nf]
                if i == nf - 1 and abs(a[0] - snapped_f[0][0]) < 2 and abs(a[1] - snapped_f[0][1]) < 2:
                    continue
                am = _px_to_m(float(a[0]), float(a[1]), height_px=h, mpp=mpp)
                bm = _px_to_m(float(b[0]), float(b[1]), height_px=h, mpp=mpp)
                if abs(am[0] - bm[0]) <= abs(am[1] - bm[1]):
                    x = 0.5 * (am[0] + bm[0])
                    am, bm = (x, am[1]), (x, bm[1])
                else:
                    y = 0.5 * (am[1] + bm[1])
                    am, bm = (am[0], y), (bm[0], y)
                L = ((am[0] - bm[0]) ** 2 + (am[1] - bm[1]) ** 2) ** 0.5
                if L < 0.45:
                    continue
                walls_f.append(
                    {
                        "id": f"w-ring-{len(walls_f)+1}",
                        "a": _vec(*am),
                        "b": _vec(*bm),
                        "thicknessM": WALL_THICKNESS_M,
                        "thicknessAssumed": True,
                        "heightM": CEILING_HEIGHT_M,
                    }
                )
            walls_f, _ = _merge_collinear_walls(
                walls_f, min_len_m=0.50, gap_tol_m=1.05, axis_tol_m=0.28
            )
            walls_f = _close_ring_endpoint_gaps(walls_f, gap_tol_m=0.95)
            walls_f = _bridge_ring_corners(walls_f, gap_tol_m=1.35)
            walls_f = _largest_connected_wall_component(walls_f, gap_tol_m=0.70)
            for i, wseg in enumerate(walls_f):
                wseg["id"] = f"w-ring-{i+1}"
            if _walls_form_closed_ring(walls_f, gap_tol_m=0.70) and len(walls_f) >= 4:
                walls = walls_f
                closed = True
                src = "foot-retry+medial"
                used_ef = ef_f
    tot = sum(_seg_length_m(w) for w in walls)
    notes.append(
        f"外周界 ring（厚牆中心線）：src={src} approxε={used_ef} 段={len(walls)} "
        f"Σ≈{tot:.1f}m {'閉合' if closed else '未完全閉合'}。"
    )
    return walls, closed, notes



def _dedupe_parallel_walls(
    walls: list[dict[str, Any]],
    *,
    axis_tol_m: float = 0.32,
    overlap_slack_m: float = 0.30,
) -> list[dict[str, Any]]:
    """Keep longer wall when two H/V segments are nearly collinear and overlap.

    Never collapse two ring segments against each other (adjacent corners must survive).
    Ring always wins over a parallel non-ring duplicate.
    """
    if len(walls) < 2:
        return walls
    walls = sorted(walls, key=_seg_length_m, reverse=True)
    kept: list[dict[str, Any]] = []
    for w in walls:
        w_ring = "ring" in str(w.get("id", ""))
        mx = (w["a"]["x"] + w["b"]["x"]) / 2
        my = (w["a"]["y"] + w["b"]["y"]) / 2
        wh = abs(w["a"]["y"] - w["b"]["y"]) < 0.28
        dup = False
        for k in kept:
            k_ring = "ring" in str(k.get("id", ""))
            # Adjacent outer-ring edges: never treat as duplicates
            if w_ring and k_ring:
                continue
            kh = abs(k["a"]["y"] - k["b"]["y"]) < 0.28
            if wh != kh:
                continue
            # Require real overlap (not mere near-touch); slack only for tiny float gaps
            slack = 0.08 if (w_ring or k_ring) else overlap_slack_m
            if wh:
                if abs(my - (k["a"]["y"] + k["b"]["y"]) / 2) > axis_tol_m:
                    continue
                wt0, wt1 = sorted([w["a"]["x"], w["b"]["x"]])
                kt0, kt1 = sorted([k["a"]["x"], k["b"]["x"]])
                if min(wt1, kt1) - max(wt0, kt0) > -slack:
                    if w_ring and not k_ring:
                        kept[kept.index(k)] = w
                    dup = True
                    break
            else:
                if abs(mx - (k["a"]["x"] + k["b"]["x"]) / 2) > axis_tol_m:
                    continue
                wt0, wt1 = sorted([w["a"]["y"], w["b"]["y"]])
                kt0, kt1 = sorted([k["a"]["y"], k["b"]["y"]])
                if min(wt1, kt1) - max(wt0, kt0) > -slack:
                    if w_ring and not k_ring:
                        kept[kept.index(k)] = w
                    dup = True
                    break
        if not dup:
            kept.append(w)
    return kept


def _drop_walls_overlapping_ring(
    walls: list[dict[str, Any]],
    ring: list[dict[str, Any]],
    *,
    dist_tol_m: float = 0.38,
) -> list[dict[str, Any]]:
    """Drop non-ring walls that duplicate a ring edge (midpoint near + parallel)."""
    if not ring:
        return walls
    kept: list[dict[str, Any]] = []
    for w in walls:
        wid = str(w.get("id", ""))
        if "ring" in wid:
            kept.append(w)
            continue
        mx = (w["a"]["x"] + w["b"]["x"]) / 2
        my = (w["a"]["y"] + w["b"]["y"]) / 2
        wh = abs(w["a"]["y"] - w["b"]["y"]) < 0.28
        dup = False
        for r in ring:
            rh = abs(r["a"]["y"] - r["b"]["y"]) < 0.28
            if wh != rh:
                continue
            d = _point_seg_dist_m(
                mx, my, r["a"]["x"], r["a"]["y"], r["b"]["x"], r["b"]["y"]
            )
            if d <= dist_tol_m:
                # also require span overlap
                if wh:
                    wt0, wt1 = sorted([w["a"]["x"], w["b"]["x"]])
                    rt0, rt1 = sorted([r["a"]["x"], r["b"]["x"]])
                    if min(wt1, rt1) - max(wt0, rt0) > -0.25:
                        dup = True
                        break
                else:
                    wt0, wt1 = sorted([w["a"]["y"], w["b"]["y"]])
                    rt0, rt1 = sorted([r["a"]["y"], r["b"]["y"]])
                    if min(wt1, rt1) - max(wt0, rt0) > -0.25:
                        dup = True
                        break
        if not dup:
            kept.append(w)
    return kept



def _filter_furniture_risk_walls(
    walls: list[dict[str, Any]],
    *,
    plan_style: str = "cad",
    max_interior: int = 14,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Reduce marketing furniture-risk inflated ΣL while keeping true perimeter.

    Keep all ring segments. For non-ring: prefer long partitions and near-perimeter
    walls; drop short deep-interior ink (beds/sofas/cabinets mistaken as walls).
    CAD plans: light filter only (drop very short deep stubs).
    """
    notes: list[str] = []
    if not walls:
        return walls, notes
    ring = [w for w in walls if "ring" in str(w.get("id", ""))]
    rest = [w for w in walls if "ring" not in str(w.get("id", ""))]
    extent = _layout_extent_m(ring or walls, None)
    if extent is None:
        return walls, notes
    min_x, min_y, max_x, max_y = extent
    kept_int: list[dict[str, Any]] = []
    dropped = 0
    marketing = plan_style == "marketing"
    for w in rest:
        L = _seg_length_m(w)
        mx = (w["a"]["x"] + w["b"]["x"]) / 2
        my = (w["a"]["y"] + w["b"]["y"]) / 2
        d_edge = min(mx - min_x, max_x - mx, my - min_y, max_y - my)
        if marketing:
            # Major partitions always keep
            if L >= 2.2:
                kept_int.append(w)
                continue
            # Near true outer perimeter
            if d_edge <= 1.00 and L >= 1.05:
                kept_int.append(w)
                continue
            # Medium interior partitions (bed/bath walls) — require clearer length
            if L >= 1.45 and d_edge <= 2.20:
                kept_int.append(w)
                continue
            # Keep longer stubs even if deep (real partitions often <2.2m)
            if L >= 1.85:
                kept_int.append(w)
                continue
            # Short deep furniture ghosts (sofas/beds/cabinets) — suppress
            dropped += 1
            continue
        # CAD: keep structural ink; only drop tiny stubs
        if L < 0.85 and d_edge > 2.2:
            dropped += 1
            continue
        kept_int.append(w)
    # Cap interior count — prefer longer near-axis
    if len(kept_int) > max_interior:
        kept_int = sorted(kept_int, key=_seg_length_m, reverse=True)[:max_interior]
        notes.append(
            f"內隔間牆截斷至 {max_interior}（傢具偽段風險；保留較長隔間）。"
        )
    if dropped:
        notes.append(
            f"剔除傢具風險內牆 {dropped} 條（短＋深內部；外周界 ring 全留）。"
        )
    # Extra ΣL guard on marketing: interior total length soft-cap
    if marketing and kept_int:
        int_L = sum(_seg_length_m(w) for w in kept_int)
        if int_L > 42.0:
            kept_int = sorted(kept_int, key=_seg_length_m, reverse=True)
            trimmed: list[dict[str, Any]] = []
            acc = 0.0
            for w in kept_int:
                L = _seg_length_m(w)
                if acc + L > 42.0 and trimmed:
                    break
                trimmed.append(w)
                acc += L
            if len(trimmed) < len(kept_int):
                notes.append(
                    f"行銷內牆 ΣL 軟上限：{int_L:.0f}→{acc:.0f} m（壓傢具偽段）。"
                )
                kept_int = trimmed
    return ring + kept_int, notes


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
            # Drop rectangular furniture mats / beds / sofas (compact + solid)
            if area >= 350 and aspect < 2.8 and solidity > 0.48:
                continue
            if area >= 280 and aspect < 2.0:
                continue
            if area >= 40 and (aspect >= 1.8 or area >= 280):
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
            if widths and float(np.median(widths)) > 14:
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



def _filter_rooms_by_footprint(
    rooms: list[dict[str, Any]],
    foot: np.ndarray,
    *,
    mpp: float,
    height_px: int,
    min_overlap: float = 0.45,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Keep rooms whose AABB overlaps the drawing footprint enough (drop chrome)."""
    notes: list[str] = []
    if not rooms or foot is None or foot.max() == 0 or mpp <= 0:
        return rooms, notes
    h, w = foot.shape[:2]
    kept: list[dict[str, Any]] = []
    dropped = 0
    for r in rooms:
        box = _room_aabb(r)
        if not box:
            dropped += 1
            continue
        min_x, min_y, max_x, max_y = box
        # metres BL → px TL
        x0 = int(max(0, min(w - 1, round(min_x / mpp))))
        x1 = int(max(0, min(w, round(max_x / mpp))))
        y_top = int(max(0, min(h - 1, round(height_px - max_y / mpp))))
        y_bot = int(max(0, min(h, round(height_px - min_y / mpp))))
        if x1 <= x0 or y_bot <= y_top:
            dropped += 1
            continue
        patch = foot[y_top:y_bot, x0:x1]
        if patch.size == 0:
            dropped += 1
            continue
        overlap = float((patch > 0).mean())
        if overlap < min_overlap:
            dropped += 1
            continue
        # Also reject tiny rooms that sit mostly on cream (low ink)
        kept.append(r)
    if dropped:
        notes.append(
            f"剔除 footprint 重疊不足（<{min_overlap:.0%}）房間 {dropped} 個。"
        )
    return kept, notes


def _filter_walls_by_footprint(
    walls: list[dict[str, Any]],
    foot: np.ndarray,
    *,
    mpp: float,
    height_px: int,
    min_hit: float = 0.35,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Drop non-ring walls whose midpoints fall outside the drawing footprint."""
    notes: list[str] = []
    if not walls or foot is None or foot.max() == 0 or mpp <= 0:
        return walls, notes
    h, w = foot.shape[:2]
    kept: list[dict[str, Any]] = []
    dropped = 0
    for wall in walls:
        wid = str(wall.get("id", ""))
        if "ring" in wid:
            kept.append(wall)
            continue
        ax, ay = wall["a"]["x"], wall["a"]["y"]
        bx, by = wall["b"]["x"], wall["b"]["y"]
        hits = 0
        samples = 0
        for t in (0.15, 0.5, 0.85):
            x = ax + (bx - ax) * t
            y = ay + (by - ay) * t
            px = int(round(x / mpp))
            py = int(round(height_px - y / mpp))
            samples += 1
            if 0 <= px < w and 0 <= py < h and foot[py, px] > 0:
                hits += 1
        if samples and hits / samples >= min_hit:
            kept.append(wall)
        else:
            dropped += 1
    if dropped:
        notes.append(f"剔除 footprint 外 YOLO／偽牆 {dropped} 條。")
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

    # Primary walls: continuous outer ring + structural dark-ink partitions
    ring_walls, ring_closed, ring_notes = _outer_perimeter_ring_walls(
        bgr, mpp=mpp, x0=x0, y0=y0, x1=x1, y1=y1, foot=foot, plan_style=plan_style,
    )
    notes.extend(ring_notes)
    ink_cap = 28 if plan_style == "marketing" else 40
    walls, ink_struct = _structural_walls_from_ink(
        bgr, mpp=mpp, x0=x0, y0=y0, x1=x1, y1=y1, foot=foot,
        max_add=ink_cap, plan_style=plan_style,
    )
    # Prefer structural ink for support tests / barriers when richer
    if int(ink_struct.sum() // 255) > int(ink.sum() // 255):
        ink = ink_struct
    # Drop ink fragments that duplicate the outer ring; keep major interior partitions
    before_ink = len(walls)
    walls = _drop_walls_overlapping_ring(walls, ring_walls, dist_tol_m=0.55)
    notes.append(
        f"深色墨跡結構牆段 {before_ink}→{len(walls)}（去重 ring 後；內隔間保留）。"
    )
    if ring_walls:
        walls = ring_walls + walls
        notes.append(
            f"併入外周界 ring {len(ring_walls)} 段"
            f"（{'已閉合' if ring_closed else '未閉合'}）。"
        )
    before_dd = len(walls)
    walls = _dedupe_parallel_walls(walls, axis_tol_m=0.34, overlap_slack_m=0.35)
    if len(walls) < before_dd:
        notes.append(f"平行牆去重：{before_dd}→{len(walls)}。")
    walls, furn0 = _filter_furniture_risk_walls(
        walls, plan_style=plan_style, max_interior=18 if marketing else 22
    )
    notes.extend(furn0)

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
            or str(w.get("id", "")).startswith(("w-room", "w-m-", "w-ink", "w-ring"))
        ]
    else:
        kept_ink = [
            w
            for w in walls
            if _wall_has_ink_support(w, ink, height_px=h, mpp=mpp, min_frac=0.08)
            or str(w.get("id", "")).startswith(("w-ink", "w-skel", "w-m-", "w-ring"))
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
    max_walls = 42
    if len(walls) > max_walls:
        ring_keep = [w for w in walls if "ring" in str(w.get("id", ""))]
        rest = [w for w in walls if "ring" not in str(w.get("id", ""))]

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

        budget = max(0, max_walls - len(ring_keep))
        walls = ring_keep + sorted(rest, key=_wall_keep_key)[:budget]
        notes.append(
            f"牆段過多，已截斷至 {len(walls)} 條（保留 ring {len(ring_keep)}＋墨跡／近軸）。"
        )

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




def _split_aabb_rooms_by_walls(
    rooms: list[dict[str, Any]],
    walls: list[dict[str, Any]],
    *,
    min_room_m2: float = 3.0,
    mega_m2: float = 16.0,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Split coarse mega AABBs along crossing H/V walls (bed/bath separation).

    When free-space CCs stay open-plan (door gaps), cut each large room box by
    interior wall lines that traverse its interior — producing wall-aligned
    sub-rects instead of one living+dining+kitchen mega blob.
    """
    notes: list[str] = []
    if not rooms or not walls:
        return rooms, notes

    def _area_box(b: tuple[float, float, float, float]) -> float:
        return max(0.0, (b[2] - b[0]) * (b[3] - b[1]))

    # Drop mega AABBs that already contain >=2 smaller rooms (nested)
    boxes = [(r, _room_aabb(r)) for r in rooms]
    drop_ids: set[str] = set()
    for r, box in boxes:
        if not box or _area_box(box) < mega_m2:
            continue
        nested = 0
        for r2, b2 in boxes:
            if r2 is r or not b2:
                continue
            if _area_box(b2) >= _area_box(box) * 0.85:
                continue
            # b2 mostly inside box
            ix0 = max(box[0], b2[0]); iy0 = max(box[1], b2[1])
            ix1 = min(box[2], b2[2]); iy1 = min(box[3], b2[3])
            inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
            if inter >= 0.60 * _area_box(b2):
                nested += 1
        if nested >= 2:
            drop_ids.add(str(r.get("id", "")))
    if drop_ids:
        rooms = [r for r in rooms if str(r.get("id", "")) not in drop_ids]
        notes.append(
            f"丟掉已含小房的開放廳 mega AABB {len(drop_ids)} 個（保留細分臥／衛）。"
        )

    out: list[dict[str, Any]] = []
    n_split = 0
    for r in rooms:
        box = _room_aabb(r)
        if not box:
            out.append(r)
            continue
        if _area_box(box) < mega_m2:
            out.append(r)
            continue
        x0, y0, x1, y1 = box
        # Collect cutting lines: H walls with y in (y0+pad, y1-pad) spanning x,
        # and V walls with x in (x0+pad, x1-pad) spanning y.
        pad = 0.45
        v_cuts: list[float] = []  # x positions
        h_cuts: list[float] = []  # y positions
        for w in walls:
            ax, ay = w["a"]["x"], w["a"]["y"]
            bx, by = w["b"]["x"], w["b"]["y"]
            L = ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5
            if L < 1.0:
                continue
            if abs(ay - by) < 0.28:  # horizontal wall → cut vertically? No: H wall splits N/S
                wy = 0.5 * (ay + by)
                if y0 + pad < wy < y1 - pad:
                    wx0, wx1 = sorted([ax, bx])
                    overlap = min(wx1, x1) - max(wx0, x0)
                    if overlap >= max(1.0, 0.45 * (x1 - x0)):
                        h_cuts.append(wy)
            elif abs(ax - bx) < 0.28:  # vertical wall → splits E/W
                wx = 0.5 * (ax + bx)
                if x0 + pad < wx < x1 - pad:
                    wy0, wy1 = sorted([ay, by])
                    overlap = min(wy1, y1) - max(wy0, y0)
                    if overlap >= max(1.0, 0.45 * (y1 - y0)):
                        v_cuts.append(wx)
        # Cluster nearby cuts
        def _cluster(vals: list[float], tol: float = 0.35) -> list[float]:
            if not vals:
                return []
            vals = sorted(vals)
            groups = [[vals[0]]]
            for v in vals[1:]:
                if v - groups[-1][-1] <= tol:
                    groups[-1].append(v)
                else:
                    groups.append([v])
            return [sum(g) / len(g) for g in groups]

        v_cuts = _cluster(v_cuts)
        h_cuts = _cluster(h_cuts)
        if not v_cuts and not h_cuts:
            out.append(r)
            continue
        # Build grid of sub-rects
        xs = [x0] + v_cuts + [x1]
        ys = [y0] + h_cuts + [y1]
        xs = sorted(xs)
        ys = sorted(ys)
        sub: list[tuple[float, float, float, float]] = []
        for i in range(len(xs) - 1):
            for j in range(len(ys) - 1):
                sx0, sx1 = xs[i], xs[i + 1]
                sy0, sy1 = ys[j], ys[j + 1]
                if (sx1 - sx0) < 1.0 or (sy1 - sy0) < 1.0:
                    continue
                if (sx1 - sx0) * (sy1 - sy0) < min_room_m2:
                    continue
                sub.append((sx0, sy0, sx1, sy1))
        if len(sub) < 2:
            out.append(r)
            continue
        # Cap splits per mega room; prefer smaller wall-aligned cells
        sub = sorted(sub, key=_area_box)[:5]
        for sb in sub:
            sx0, sy0, sx1, sy1 = sb
            verts = [
                _vec(sx0, sy0),
                _vec(sx1, sy0),
                _vec(sx1, sy1),
                _vec(sx0, sy1),
            ]
            out.append(
                {
                    "id": f"room-split-{len(out)+1}",
                    "type": str(r.get("type") or "房間"),
                    "vertices": verts,
                    "confidence": min(0.68, float(r.get("confidence") or 0.55) + 0.06),
                    "_split": True,
                }
            )
        n_split += 1
    if not n_split:
        return rooms, notes
    # Prefer split children over leftover overlapping mega parents
    split_rooms = [r for r in out if r.get("_split")]
    plain = [r for r in out if not r.get("_split")]
    final: list[dict[str, Any]] = []
    # Keep all split children first (small → large)
    for r in sorted(split_rooms, key=lambda rr: _area_box(_room_aabb(rr) or (0, 0, 0, 0))):
        box = _room_aabb(r)
        if not box:
            continue
        a = _area_box(box)
        keep = True
        for k in final:
            kb = _room_aabb(k)
            if not kb:
                continue
            ix0 = max(box[0], kb[0]); iy0 = max(box[1], kb[1])
            ix1 = min(box[2], kb[2]); iy1 = min(box[3], kb[3])
            inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
            # Only drop near-duplicate splits
            if inter / max(a, 1e-6) >= 0.80:
                keep = False
                break
        if keep:
            final.append(r)
    # Add plain rooms that are not mostly covered by a split child
    for r in plain:
        box = _room_aabb(r)
        if not box:
            continue
        a = _area_box(box)
        covered = 0.0
        for k in final:
            kb = _room_aabb(k)
            if not kb:
                continue
            ix0 = max(box[0], kb[0]); iy0 = max(box[1], kb[1])
            ix1 = min(box[2], kb[2]); iy1 = min(box[3], kb[3])
            covered += max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
        if covered / max(a, 1e-6) >= 0.50:
            continue  # superseded by splits
        # Only drop huge leftover open-plan that overlaps any split
        if a >= 28.0 and split_rooms and covered / max(a, 1e-6) >= 0.20:
            continue
        final.append(r)
    if len(final) > 10:
        # Prefer smaller/medium rooms (beds/baths) then largest living
        final = sorted(final, key=lambda rr: _area_box(_room_aabb(rr) or (0, 0, 0, 0)))
        # keep up to 8 small+medium, then 2 largest
        small = [r for r in final if _area_box(_room_aabb(r) or (0, 0, 0, 0)) < 18.0][:8]
        big = [r for r in reversed(final) if _area_box(_room_aabb(r) or (0, 0, 0, 0)) >= 18.0][:2]
        final = small + big
        final = final[:10]
    for i, r in enumerate(final):
        r.pop("_split", None)
        r["id"] = f"room-{i+1}"
    notes.append(
        f"以穿越牆切開大 AABB 房間 {n_split} 個→共 {len(final)} 房（臥／衛分間）。"
    )
    return final, notes



def _seg_endpoints(w: dict[str, Any]) -> tuple[tuple[float, float], tuple[float, float]]:
    return (float(w["a"]["x"]), float(w["a"]["y"])), (float(w["b"]["x"]), float(w["b"]["y"]))


def _point_line_proj(
    px: float, py: float, ax: float, ay: float, bx: float, by: float
) -> tuple[float, float, float]:
    """Return (qx, qy, t) projection of P onto infinite line AB; t in [0,1] = segment."""
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 < 1e-12:
        return ax, ay, 0.0
    t = ((px - ax) * dx + (py - ay) * dy) / L2
    return ax + t * dx, ay + t * dy, t


def _cluster_xy(
    pts: list[tuple[float, float]], tol: float
) -> tuple[list[tuple[float, float]], list[int]]:
    """Greedy spatial cluster; returns (representatives, assignment)."""
    reps: list[list[float]] = []
    counts: list[int] = []
    assign: list[int] = []
    for x, y in pts:
        found = -1
        best = tol
        for i, (rx, ry) in enumerate(reps):
            d = ((x - rx) ** 2 + (y - ry) ** 2) ** 0.5
            if d <= best:
                best = d
                found = i
        if found < 0:
            assign.append(len(reps))
            reps.append([x, y])
            counts.append(1)
        else:
            assign.append(found)
            c = counts[found]
            reps[found][0] = (reps[found][0] * c + x) / (c + 1)
            reps[found][1] = (reps[found][1] * c + y) / (c + 1)
            counts[found] = c + 1
    return [(r[0], r[1]) for r in reps], assign


def _extend_walls_to_junctions(
    walls: list[dict[str, Any]],
    *,
    snap_tol_m: float = 0.28,
    extend_max_m: float = 0.70,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Snap endpoints + extend stubs to T-junctions so planar faces close.

    Centerline-consistent: near-miss endpoints merge; dangling ends project onto
    nearby wall bodies within extend_max (door-gap scale), enabling closed faces
    without inventing new wall ink.
    """
    notes: list[str] = []
    if len(walls) < 3:
        return walls, notes

    segs: list[dict[str, Any]] = []
    for w in walls:
        a, b = _seg_endpoints(w)
        if ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5 < 0.15:
            continue
        segs.append(
            {
                "a": [a[0], a[1]],
                "b": [b[0], b[1]],
                "id": str(w.get("id", "")),
                "src": w,
            }
        )
    if len(segs) < 3:
        return walls, notes

    # Pass 1: cluster all endpoints and snap
    pts = [tuple(s["a"]) for s in segs] + [tuple(s["b"]) for s in segs]
    reps, assign = _cluster_xy(pts, snap_tol_m)
    for i, s in enumerate(segs):
        s["a"] = list(reps[assign[i]])
        s["b"] = list(reps[assign[i + len(segs)]])

    # Pass 2: extend dangling endpoints to nearest wall body (T-junction)
    n_ext = 0
    for i, s in enumerate(segs):
        for end_key, other_key in (("a", "b"), ("b", "a")):
            ex, ey = s[end_key]
            ox, oy = s[other_key]
            # Already near another endpoint?
            near_ep = False
            for j, t in enumerate(segs):
                if j == i:
                    continue
                for tk in ("a", "b"):
                    if ((ex - t[tk][0]) ** 2 + (ey - t[tk][1]) ** 2) ** 0.5 <= snap_tol_m:
                        near_ep = True
                        break
                if near_ep:
                    break
            if near_ep:
                continue
            # Direction from other → this end (outward)
            dx, dy = ex - ox, ey - oy
            L = (dx * dx + dy * dy) ** 0.5
            if L < 1e-6:
                continue
            ux, uy = dx / L, dy / L
            best = None  # (dist_along, qx, qy, j)
            for j, t in enumerate(segs):
                if j == i:
                    continue
                ax, ay = t["a"]
                bx, by = t["b"]
                # Try projection of endpoint onto other segment
                qx, qy, tt = _point_line_proj(ex, ey, ax, ay, bx, by)
                if tt < -0.05 or tt > 1.05:
                    continue
                tt_c = max(0.0, min(1.0, tt))
                qx = ax + tt_c * (bx - ax)
                qy = ay + tt_c * (by - ay)
                d = ((ex - qx) ** 2 + (ey - qy) ** 2) ** 0.5
                if d > extend_max_m or d < 1e-4:
                    continue
                # Prefer hits roughly along outward direction
                along = (qx - ex) * ux + (qy - ey) * uy
                if along < -0.05:
                    continue  # mostly behind
                # Lateral component shouldn't dominate for nearly-meeting walls
                lat = abs((qx - ex) * (-uy) + (qy - ey) * ux)
                if lat > max(0.28, d * 0.55) and d > snap_tol_m:
                    continue
                # Keep extension near-axis: don't swing the wall into a diagonal
                new_align = _axis_align_score(ox, oy, qx, qy)
                if new_align < 0.85:
                    continue
                score = d + (0.15 if along < 0 else 0.0)
                if best is None or score < best[0]:
                    best = (score, qx, qy, j, tt_c)
            if best is None:
                continue
            _, qx, qy, j, tt_c = best
            s[end_key][0], s[end_key][1] = qx, qy
            n_ext += 1
            # Record split marker on hit wall for later
            t = segs[j]
            t.setdefault("splits", []).append(tt_c)

    # Pass 3: re-cluster after extensions
    pts = [tuple(s["a"]) for s in segs] + [tuple(s["b"]) for s in segs]
    reps, assign = _cluster_xy(pts, snap_tol_m * 0.95)
    for i, s in enumerate(segs):
        s["a"] = list(reps[assign[i]])
        s["b"] = list(reps[assign[i + len(segs)]])

    # Pass 4: split walls at T-junction parameters + crossing endpoints
    out: list[dict[str, Any]] = []
    for s in segs:
        ax, ay = s["a"]
        bx, by = s["b"]
        params = {0.0, 1.0}
        for tt in s.get("splits") or []:
            if 0.08 < tt < 0.92:
                params.add(float(tt))
        # Also split where other endpoints lie on this segment
        for t in segs:
            if t is s:
                continue
            for tk in ("a", "b"):
                px, py = t[tk]
                qx, qy, tt = _point_line_proj(px, py, ax, ay, bx, by)
                if 0.08 < tt < 0.92:
                    d = ((px - qx) ** 2 + (py - qy) ** 2) ** 0.5
                    if d <= snap_tol_m * 1.05:
                        params.add(tt)
        ordered = sorted(params)
        # Emit sub-segments between consecutive params
        prev = ordered[0]
        for cur in ordered[1:]:
            if cur - prev < 0.04:
                prev = cur
                continue
            p1 = (ax + prev * (bx - ax), ay + prev * (by - ay))
            p2 = (ax + cur * (bx - ax), ay + cur * (by - ay))
            if ((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2) ** 0.5 < 0.20:
                prev = cur
                continue
            nw = dict(s["src"])
            nw["a"] = _vec(p1[0], p1[1])
            nw["b"] = _vec(p2[0], p2[1])
            wid = str(s["id"] or nw.get("id", "w"))
            nw["id"] = f"{wid}-j{len(out)}"
            nw["thicknessM"] = nw.get("thicknessM", WALL_THICKNESS_M)
            nw["thicknessAssumed"] = True
            out.append(nw)
            prev = cur

    # Deduplicate near-identical edges
    out = _dedupe_parallel_walls(out, axis_tol_m=0.18, overlap_slack_m=0.25)
    # Drop strong diagonals introduced by bad T-extends (keep near-axis centerlines)
    kept: list[dict[str, Any]] = []
    dropped_diag = 0
    for w in out:
        ax, ay = float(w["a"]["x"]), float(w["a"]["y"])
        bx, by = float(w["b"]["x"]), float(w["b"]["y"])
        align = _axis_align_score(ax, ay, bx, by)
        L = ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5
        # Allow short diagonals only if very short; long diagonals are furniture/bad extend
        if align < 0.82 and L >= 1.15:
            dropped_diag += 1
            continue
        if align < 0.70:
            dropped_diag += 1
            continue
        kept.append(w)
    out = kept
    if n_ext:
        notes.append(f"牆段延伸至接點 {n_ext} 端（閉合 planar faces）。")
    if dropped_diag:
        notes.append(f"接點圖剔除斜向偽段 {dropped_diag}（保中心線一致性）。")
    notes.append(f"接點圖牆段 {len(walls)}→{len(out)}（snap＋T 切分）。")
    return out, notes


def _poly_signed_area(verts: list[tuple[float, float]]) -> float:
    if len(verts) < 3:
        return 0.0
    a = 0.0
    n = len(verts)
    for i in range(n):
        x1, y1 = verts[i]
        x2, y2 = verts[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return 0.5 * a


def _poly_min_width_approx(verts: list[tuple[float, float]]) -> float:
    """Cheap sliver test: min AABB side after simple extent."""
    if len(verts) < 2:
        return 0.0
    xs = [v[0] for v in verts]
    ys = [v[1] for v in verts]
    return min(max(xs) - min(xs), max(ys) - min(ys))


def _faces_from_halfedges(
    nodes: list[tuple[float, float]],
    edges: list[tuple[int, int]],
) -> list[list[int]]:
    """Walk half-edges (left-turn) to recover bounded planar faces as node cycles."""
    import math

    adj: dict[int, list[tuple[int, float]]] = defaultdict(list)
    for u, v in edges:
        if u == v:
            continue
        ang_uv = math.atan2(nodes[v][1] - nodes[u][1], nodes[v][0] - nodes[u][0])
        ang_vu = math.atan2(nodes[u][1] - nodes[v][1], nodes[u][0] - nodes[v][0])
        adj[u].append((v, ang_uv))
        adj[v].append((u, ang_vu))
    for u in adj:
        adj[u].sort(key=lambda t: t[1])

    # next_halfedge[(u,v)] = (v,w) = leftmost turn from incoming u->v
    next_he: dict[tuple[int, int], tuple[int, int]] = {}
    for v, outs in adj.items():
        if len(outs) < 1:
            continue
        m = len(outs)
        # outs sorted by absolute angle of v->w
        for i, (w, _) in enumerate(outs):
            # Incoming half-edge that arrives via reverse of v->w is w->v.
            # For arriving u->v, we want previous outgoing in CCW order
            # (= clockwise neighbor when walking with interior on left using CW turns,
            #  or CCW — we use: take the previous in sorted angle list from the
            #  reverse of the arrival direction).
            pass
        # Build mapping: for each outgoing v->w, the twin is w->v.
        # When we arrive on u->v, choose outgoing v->w that is the immediate
        # clockwise next from the reverse direction v->u.
        ang_of = {w: ang for w, ang in outs}
        for i, (w, ang_vw) in enumerate(outs):
            # half-edge v->w; its "previous" in CCW sorted list is the right-turn
            # candidate when arriving on w->v ... we fill by arrival below.
            _ = (i, w, ang_vw)

    for v, outs in adj.items():
        m = len(outs)
        if m == 0:
            continue
        # For arrival u->v, reverse direction angle is atan2 of v->u
        for i, (u, _) in enumerate(outs):
            # outs[i] is v->u (the reverse of arrival u->v)
            # Next left-turn outgoing = previous in CCW-sorted list
            prev_i = (i - 1) % m
            w = outs[prev_i][0]
            next_he[(u, v)] = (v, w)

    used: set[tuple[int, int]] = set()
    faces: list[list[int]] = []
    for start in list(next_he.keys()):
        if start in used:
            continue
        cycle_nodes: list[int] = []
        he = start
        guard = 0
        ok = True
        while guard < 500:
            guard += 1
            if he in used:
                if he != start:
                    ok = False
                break
            used.add(he)
            cycle_nodes.append(he[0])
            nxt = next_he.get(he)
            if nxt is None:
                ok = False
                break
            he = nxt
            if he == start:
                break
        else:
            ok = False
        if not ok or len(cycle_nodes) < 3:
            continue
        # Dedup consecutive
        cleaned: list[int] = []
        for n in cycle_nodes:
            if not cleaned or cleaned[-1] != n:
                cleaned.append(n)
        if len(cleaned) >= 3 and cleaned[0] == cleaned[-1]:
            cleaned = cleaned[:-1]
        if len(cleaned) >= 3:
            faces.append(cleaned)
    return faces



def _ortho_cleanup_metres(
    verts: list[tuple[float, float]],
    *,
    angle_tol_deg: float = 22.0,
    min_edge_m: float = 0.18,
) -> list[tuple[float, float]]:
    """Light H/V snap + short-edge collapse for metre-space room polygons."""
    if len(verts) < 3:
        return verts
    import math
    out: list[tuple[float, float]] = [verts[0]]
    n = len(verts)
    for i in range(n):
        a = out[-1]
        b = verts[(i + 1) % n]
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = (dx * dx + dy * dy) ** 0.5
        if L < min_edge_m:
            continue
        ang = abs(math.degrees(math.atan2(dy, dx))) % 180.0
        near_h = ang <= angle_tol_deg or ang >= 180.0 - angle_tol_deg
        near_v = abs(ang - 90.0) <= angle_tol_deg
        if near_h:
            y = 0.5 * (a[1] + b[1])
            out[-1] = (a[0], y)
            out.append((b[0], y))
        elif near_v:
            x = 0.5 * (a[0] + b[0])
            out[-1] = (x, a[1])
            out.append((x, b[1]))
        else:
            # stair-step keep topology
            if abs(dx) >= abs(dy):
                out.append((b[0], a[1]))
                out.append((b[0], b[1]))
            else:
                out.append((a[0], b[1]))
                out.append((b[0], b[1]))
    # collapse near-duplicates
    clean: list[tuple[float, float]] = []
    for p in out:
        if not clean or ((p[0] - clean[-1][0]) ** 2 + (p[1] - clean[-1][1]) ** 2) ** 0.5 >= min_edge_m:
            clean.append(p)
    if len(clean) >= 3 and ((clean[0][0] - clean[-1][0]) ** 2 + (clean[0][1] - clean[-1][1]) ** 2) ** 0.5 < min_edge_m:
        clean = clean[:-1]
    return clean if len(clean) >= 3 else verts



def _rooms_from_sealed_wall_faces(
    walls: list[dict[str, Any]],
    *,
    mpp: float,
    max_rooms: int = 12,
    min_area_m2: float = 1.6,
    seal_m: float = 0.28,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Raster planar faces with extra barrier seal (door-gap close) + sliver filter."""
    notes: list[str] = []
    if not walls or mpp <= 0:
        return [], notes
    xs: list[float] = []
    ys: list[float] = []
    for w in walls:
        xs.extend([w["a"]["x"], w["b"]["x"]])
        ys.extend([w["a"]["y"], w["b"]["y"]])
    if not xs:
        return [], notes
    pad = 0.35
    min_x, max_x = min(xs) - pad, max(xs) + pad
    min_y, max_y = min(ys) - pad, max(ys) + pad
    rw = max(32, int(round((max_x - min_x) / mpp)))
    rh = max(32, int(round((max_y - min_y) / mpp)))
    if rw * rh > 4_000_000:
        return [], notes
    barrier = np.zeros((rh, rw), np.uint8)
    thick = max(3, int(round(seal_m / mpp)))

    def _m_to_r(x: float, y: float) -> tuple[int, int]:
        px = int(round((x - min_x) / mpp))
        py = int(round((max_y - y) / mpp))
        return px, py

    for w in walls:
        p1 = _m_to_r(w["a"]["x"], w["a"]["y"])
        p2 = _m_to_r(w["b"]["x"], w["b"]["y"])
        cv2.line(barrier, p1, p2, 255, thick)
    k3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    # Extra seal so door gaps become face edges without inventing geometry in export
    barrier = cv2.dilate(barrier, k3, iterations=3)
    cv2.rectangle(barrier, (0, 0), (rw - 1, rh - 1), 255, max(3, thick + 1))
    free = cv2.bitwise_not(barrier)
    free = cv2.morphologyEx(free, cv2.MORPH_OPEN, k3, iterations=1)
    n, lab, st, _ = cv2.connectedComponentsWithStats(free, connectivity=4)
    if n <= 2:
        return [], notes
    floor_area = max(1.0, (max_x - min_x) * (max_y - min_y))
    cands: list[tuple[float, int]] = []
    for i in range(1, n):
        area_px = int(st[i, cv2.CC_STAT_AREA])
        area_m2 = area_px * mpp * mpp
        if area_m2 < min_area_m2 or area_m2 > floor_area * 0.70:
            continue
        ww = int(st[i, cv2.CC_STAT_WIDTH])
        hh = int(st[i, cv2.CC_STAT_HEIGHT])
        aspect = max(ww, hh) / (min(ww, hh) + 1e-6)
        if aspect >= 6.5 and min(ww, hh) * mpp < 1.1:
            continue
        cands.append((area_m2, i))
    cands.sort(reverse=True)
    selected: list[int] = []
    for area_m2, i in cands:
        if len(selected) >= max_rooms:
            break
        if area_m2 <= 18.0:
            selected.append(i)
    for area_m2, i in cands:
        if len(selected) >= max_rooms:
            break
        if i not in selected:
            selected.append(i)
    rooms: list[dict[str, Any]] = []
    for i in selected:
        mask = (lab == i).astype(np.uint8) * 255
        poly = _ortho_polygon_from_mask(mask, max_verts=20)
        if poly is None or len(poly) < 4:
            continue
        verts = []
        for x, y in poly:
            mx = min_x + float(x) * mpp
            my = max_y - float(y) * mpp
            verts.append(_vec(mx, my))
        xs2 = [v["x"] for v in verts]
        ys2 = [v["y"] for v in verts]
        if (max(xs2) - min(xs2)) * (max(ys2) - min(ys2)) < min_area_m2:
            continue
        # Sliver reject
        if min(max(xs2) - min(xs2), max(ys2) - min(ys2)) < 0.75:
            continue
        rooms.append(
            {
                "id": f"room-face-{len(rooms)+1}",
                "type": "房間",
                "vertices": verts,
                "confidence": 0.67,
            }
        )
    if rooms:
        notes.append(
            f"密封牆網 planar faces {len(rooms)}（seal≈{seal_m:.2f}m；濾外圍／細條）。"
        )
    return rooms, notes


def _replace_aabb_rooms_with_faces(
    rooms: list[dict[str, Any]],
    face_rooms: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Replace AABB room polygons with overlapping planar faces where possible."""
    notes: list[str] = []
    if not rooms or not face_rooms:
        return rooms, notes
    replaced = 0
    out: list[dict[str, Any]] = []
    used_faces: set[int] = set()
    for r in rooms:
        nverts = len(r.get("vertices") or [])
        box = _room_aabb(r)
        if not box:
            out.append(r)
            continue
        ra = max(1e-6, (box[2] - box[0]) * (box[3] - box[1]))
        # Only replace clear AABBs (4 verts) or near-rects
        if nverts > 4 and nverts >= 6:
            out.append(r)
            continue
        best = None  # (score, fi, face)
        for fi, f in enumerate(face_rooms):
            if fi in used_faces:
                continue
            fb = _room_aabb(f)
            if not fb:
                continue
            ix0 = max(box[0], fb[0]); iy0 = max(box[1], fb[1])
            ix1 = min(box[2], fb[2]); iy1 = min(box[3], fb[3])
            inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
            fa = max(1e-6, (fb[2] - fb[0]) * (fb[3] - fb[1]))
            iou = inter / max(1e-6, ra + fa - inter)
            # Face centroid inside room OR strong overlap
            cx, cy = (fb[0] + fb[2]) / 2, (fb[1] + fb[3]) / 2
            inside = box[0] <= cx <= box[2] and box[1] <= cy <= box[3]
            if inter < 0.22 * min(ra, fa) and not (inside and inter >= 0.18 * fa):
                continue
            fv = len(f.get("vertices") or [])
            # Prefer non-AABB faces and similar area
            area_ratio = min(fa, ra) / max(fa, ra)
            score = iou * 2.0 + (0.40 if fv >= 6 else 0.10) + 0.30 * area_ratio
            if best is None or score > best[0]:
                best = (score, fi, f)
        if best and best[0] >= 0.35:
            _, fi, f = best
            used_faces.add(fi)
            nr = dict(r)
            nr["vertices"] = list(f.get("vertices") or [])
            nr["confidence"] = max(float(r.get("confidence") or 0.5), 0.66)
            # keep id but mark provenance lightly in type stays
            out.append(nr)
            replaced += 1
        else:
            out.append(r)
    # Do not invent extra face rooms on top of a full YOLO set (avoid under-seg wipe)
    # Only add uncovered faces when we have few rooms overall
    if len(out) < 5:
        for fi, f in enumerate(face_rooms):
            if fi in used_faces:
                continue
            fb = _room_aabb(f)
            if not fb:
                continue
            fa = (fb[2] - fb[0]) * (fb[3] - fb[1])
            if fa < 2.0 or fa > 22.0:
                continue
            cx, cy = (fb[0] + fb[2]) / 2, (fb[1] + fb[3]) / 2
            if any(
                (rb := _room_aabb(r)) and rb[0] <= cx <= rb[2] and rb[1] <= cy <= rb[3]
                for r in out
            ):
                continue
            out.append(dict(f))
    if len(out) > 12:
        out = out[:12]
    if replaced:
        notes.append(
            f"AABB→planar face 置換 {replaced}/{len(rooms)}（多數盒房改牆面多邊形）。"
        )
    return out, notes


def _rooms_from_planar_wall_faces(
    walls: list[dict[str, Any]],
    *,
    snap_tol_m: float = 0.28,
    extend_max_m: float = 0.70,
    min_area_m2: float = 1.8,
    max_rooms: int = 12,
    min_width_m: float = 0.85,
    mpp: float | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """Planar wall-face room net: extend→junctions→closed faces→room polygons.

    Returns (rooms, junction_walls, notes). Filters the outer unbounded face and
    sliver faces. Uses (1) door-gap bridges so faces close, (2) half-edge cycles
    when the graph is sealed, (3) thickened centerline raster faces as the robust
    emitter so majority AABB can be replaced when walls meet.
    """
    notes: list[str] = []
    jwalls, jnotes = _extend_walls_to_junctions(
        walls, snap_tol_m=snap_tol_m, extend_max_m=extend_max_m
    )
    notes.extend(jnotes)
    if len(jwalls) < 4:
        return [], jwalls, notes

    # Bridge door-sized endpoint gaps (virtual centerline seals — face finding only)
    bridges: list[dict[str, Any]] = []
    ends: list[tuple[float, float, int, str]] = []  # x,y,wall_idx,end
    for i, w in enumerate(jwalls):
        a, b = _seg_endpoints(w)
        ends.append((a[0], a[1], i, "a"))
        ends.append((b[0], b[1], i, "b"))
    used_end: set[tuple[int, str]] = set()
    for ai, (ax, ay, ia, ea) in enumerate(ends):
        if (ia, ea) in used_end:
            continue
        # Skip if already incident to ≥2 walls (true junction)
        near = 0
        for bx, by, ib, eb in ends:
            if ib == ia and eb == ea:
                continue
            if ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5 <= snap_tol_m:
                near += 1
        if near >= 1:
            continue
        best = None
        wa = jwalls[ia]
        a0, a1 = _seg_endpoints(wa)
        # Outward from this end
        if ea == "a":
            ox, oy = a1[0], a1[1]
        else:
            ox, oy = a0[0], a0[1]
        dx, dy = ax - ox, ay - oy
        L = (dx * dx + dy * dy) ** 0.5
        if L < 1e-6:
            continue
        ux, uy = dx / L, dy / L
        for bx, by, ib, eb in ends:
            if ib == ia or (ib, eb) in used_end:
                continue
            d = ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5
            if d < 0.40 or d > 1.45:
                continue
            # Prefer facing (toward each other)
            along = (bx - ax) * ux + (by - ay) * uy
            if along < d * 0.20:
                continue
            lat = abs((bx - ax) * (-uy) + (by - ay) * ux)
            if lat > 0.55:
                continue
            # Other end outward should roughly face us
            wb = jwalls[ib]
            b0, b1 = _seg_endpoints(wb)
            if eb == "a":
                o2x, o2y = b1[0], b1[1]
            else:
                o2x, o2y = b0[0], b0[1]
            d2x, d2y = bx - o2x, by - o2y
            L2 = (d2x * d2x + d2y * d2y) ** 0.5
            if L2 < 1e-6:
                continue
            u2x, u2y = d2x / L2, d2y / L2
            # Dot of outwards should be negative (facing)
            if ux * u2x + uy * u2y > 0.25:
                continue  # allow near-orthogonal door reveals
            score = d + lat
            if best is None or score < best[0]:
                best = (score, bx, by, ib, eb)
        if best is None:
            continue
        _, bx, by, ib, eb = best
        used_end.add((ia, ea))
        used_end.add((ib, eb))
        bridges.append(
            {
                "id": f"w-bridge-{len(bridges)+1}",
                "a": _vec(ax, ay),
                "b": _vec(bx, by),
                "thicknessM": WALL_THICKNESS_M,
                "thicknessAssumed": True,
            }
        )
    face_walls = jwalls + bridges
    if bridges:
        notes.append(f"門洞橋接 {len(bridges)} 段（僅供 face 閉合；不進最終牆表）。")

    # --- Half-edge geometric faces ---
    geo_rooms: list[dict[str, Any]] = []
    pts = []
    edge_pairs: list[tuple[tuple[float, float], tuple[float, float]]] = []
    for w in face_walls:
        a, b = _seg_endpoints(w)
        pts.extend([a, b])
        edge_pairs.append((a, b))
    reps, _ = _cluster_xy(pts, snap_tol_m * 0.9)
    if len(reps) >= 4:
        def _nid(p: tuple[float, float]) -> int:
            best_i, best_d = 0, 1e9
            for i, r in enumerate(reps):
                d = ((p[0] - r[0]) ** 2 + (p[1] - r[1]) ** 2) ** 0.5
                if d < best_d:
                    best_d = d
                    best_i = i
            return best_i

        edges: list[tuple[int, int]] = []
        seen_e: set[tuple[int, int]] = set()
        for a, b in edge_pairs:
            u, v = _nid(a), _nid(b)
            if u == v:
                continue
            key = (u, v) if u < v else (v, u)
            if key in seen_e:
                continue
            seen_e.add(key)
            edges.append((u, v))
        faces = _faces_from_halfedges(reps, edges)
        extent = _layout_extent_m(jwalls, None)
        floor_area = 1.0
        if extent:
            floor_area = max(1.0, (extent[2] - extent[0]) * (extent[3] - extent[1]))
        scored: list[tuple[float, list[tuple[float, float]], int]] = []
        for fi, f in enumerate(faces):
            verts = [reps[i] for i in f]
            area = abs(_poly_signed_area(verts))
            scored.append((area, verts, fi))
        scored.sort(reverse=True)
        drop_ids: set[int] = set()
        if scored:
            largest_a, _, largest_i = scored[0]
            if largest_a >= floor_area * 0.55 or (
                len(scored) > 1 and largest_a >= scored[1][0] * 2.2
            ):
                drop_ids.add(largest_i)
        for area, verts, fi in scored:
            if fi in drop_ids or area < min_area_m2 or area > floor_area * 0.72:
                continue
            width = _poly_min_width_approx(verts)
            if width < min_width_m:
                continue
            xs = [v[0] for v in verts]
            ys = [v[1] for v in verts]
            aspect = max(max(xs) - min(xs), max(ys) - min(ys)) / max(width, 1e-6)
            if aspect >= 7.5 and area < 6.0:
                continue
            verts = _ortho_cleanup_metres(verts, angle_tol_deg=22.0, min_edge_m=0.18)
            if _poly_signed_area(verts) < 0:
                verts = list(reversed(verts))
            clean: list[tuple[float, float]] = []
            for p in verts:
                if (
                    not clean
                    or ((p[0] - clean[-1][0]) ** 2 + (p[1] - clean[-1][1]) ** 2) ** 0.5 > 0.12
                ):
                    clean.append(p)
            if len(clean) >= 3 and (
                (clean[0][0] - clean[-1][0]) ** 2 + (clean[0][1] - clean[-1][1]) ** 2
            ) ** 0.5 <= 0.12:
                clean = clean[:-1]
            if len(clean) < 3:
                continue
            geo_rooms.append(
                {
                    "id": f"room-face-{len(geo_rooms)+1}",
                    "type": "房間",
                    "vertices": [_vec(x, y) for x, y in clean],
                    "confidence": 0.70,
                }
            )
            if len(geo_rooms) >= max_rooms:
                break
        notes.append(
            f"half-edge faces {len(geo_rooms)}（接點 {len(reps)}／邊 {len(edges)}"
            f"{'＋bridge' if bridges else ''}）。"
        )

    # --- Robust raster faces from thickened centerline junction walls ---
    raster_rooms: list[dict[str, Any]] = []
    use_mpp = float(mpp) if mpp and mpp > 0 else 0.0
    if use_mpp <= 0:
        # estimate from layout extent / typical px — skip raster if unknown
        use_mpp = 0.01
    try:
        raster_rooms, rnotes = _rooms_from_sealed_wall_faces(
            face_walls,
            mpp=use_mpp,
            max_rooms=max_rooms,
            min_area_m2=min_area_m2,
            seal_m=0.32,
        )
        notes.extend(rnotes)
    except Exception as e:  # noqa: BLE001
        notes.append(f"raster-face 略過：{e}")

    # Choose better face set: prefer more rooms without mega under-seg
    def _areas(rs: list[dict[str, Any]]) -> list[float]:
        out = []
        for r in rs:
            box = _room_aabb(r)
            if box:
                out.append(max(0.0, (box[2] - box[0]) * (box[3] - box[1])))
        return sorted(out, reverse=True)

    def _score(rs: list[dict[str, Any]]) -> tuple:
        if not rs:
            return (-1, 0, 0)
        ar = _areas(rs)
        mega = sum(1 for a in ar if a >= 22.0)
        non_aabb = sum(1 for r in rs if len(r.get("vertices") or []) >= 6)
        # higher rooms, fewer mega, more non-aabb
        return (len(rs) - mega * 2, non_aabb, -mega)

    rooms = geo_rooms
    if _score(raster_rooms) > _score(geo_rooms):
        rooms = raster_rooms
        notes.append(
            f"採 raster planar faces {len(rooms)}（優於 half-edge {len(geo_rooms)}）。"
        )
    elif geo_rooms:
        notes.append(f"採 half-edge planar faces {len(rooms)}。")
    # If both weak, merge unique
    if geo_rooms and raster_rooms and len(rooms) < 4:
        merged = list(rooms)
        for b in (raster_rooms if rooms is geo_rooms else geo_rooms):
            bb = _room_aabb(b)
            if not bb:
                continue
            cx, cy = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
            if any(
                (fb := _room_aabb(f))
                and fb[0] <= cx <= fb[2]
                and fb[1] <= cy <= fb[3]
                for f in merged
            ):
                continue
            merged.append(b)
        if len(merged) > len(rooms):
            rooms = merged[:max_rooms]
            notes.append(f"faces 合併 →{len(rooms)}。")

    n_non_aabb = sum(1 for r in rooms if len(r.get("vertices") or []) >= 6)
    notes.append(
        f"planar 牆面房間網 {len(rooms)}（非 AABB={n_non_aabb}；"
        f"jwalls={len(jwalls)}）。"
    )
    return rooms, jwalls, notes



def _rooms_from_wall_barriers(
    walls: list[dict[str, Any]],
    *,
    mpp: float,
    height_px: int,
    max_rooms: int = 10,
    min_area_m2: float = 2.2,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Finer wall-constrained rooms from free-space cells (not one big AABB).

    Rasterize wall barriers, take free CCs, emit ortho polygons. Prefer modest
    enclosed cells (bedrooms/baths) over a single open-plan mega-blob.
    """
    notes: list[str] = []
    if not walls or mpp <= 0:
        return [], notes
    xs: list[float] = []
    ys: list[float] = []
    for w in walls:
        xs.extend([w["a"]["x"], w["b"]["x"]])
        ys.extend([w["a"]["y"], w["b"]["y"]])
    if not xs:
        return [], notes
    pad = 0.35
    min_x, max_x = min(xs) - pad, max(xs) + pad
    min_y, max_y = min(ys) - pad, max(ys) + pad
    rw = max(32, int(round((max_x - min_x) / mpp)))
    rh = max(32, int(round((max_y - min_y) / mpp)))
    if rw * rh > 4_000_000:
        return [], notes
    barrier = np.zeros((rh, rw), np.uint8)
    # Thicker barriers seal door gaps → planar faces / L-rooms from wall graph
    thick = max(3, int(round(0.22 / mpp)))

    def _m_to_r(x: float, y: float) -> tuple[int, int]:
        px = int(round((x - min_x) / mpp))
        py = int(round((max_y - y) / mpp))
        return px, py

    for w in walls:
        p1 = _m_to_r(w["a"]["x"], w["a"]["y"])
        p2 = _m_to_r(w["b"]["x"], w["b"]["y"])
        cv2.line(barrier, p1, p2, 255, thick)
    k3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    # Dilate more to bridge door-sized gaps between partitions
    barrier = cv2.dilate(barrier, k3, iterations=2)
    # Seal outer frame so exterior doesn't flood into rooms
    cv2.rectangle(barrier, (0, 0), (rw - 1, rh - 1), 255, max(3, thick + 1))
    free = cv2.bitwise_not(barrier)
    free = cv2.morphologyEx(free, cv2.MORPH_OPEN, k3, iterations=1)
    n, lab, st, _ = cv2.connectedComponentsWithStats(free, connectivity=4)
    if n <= 2:
        return [], notes
    cands: list[tuple[float, int]] = []
    floor_area = max(1.0, (max_x - min_x) * (max_y - min_y))
    for i in range(1, n):
        area_px = int(st[i, cv2.CC_STAT_AREA])
        area_m2 = area_px * mpp * mpp
        if area_m2 < min_area_m2:
            continue
        # Skip near-full-floor open flood (failed barrier)
        if area_m2 > floor_area * 0.72:
            continue
        ww = int(st[i, cv2.CC_STAT_WIDTH])
        hh = int(st[i, cv2.CC_STAT_HEIGHT])
        aspect = max(ww, hh) / (min(ww, hh) + 1e-6)
        if aspect >= 6.0 and min(ww, hh) * mpp < 1.2:
            continue  # thin corridor strip chrome
        cands.append((area_m2, i))
    cands.sort(reverse=True)
    # Prefer mix: keep smaller enclosed rooms, don't only keep mega living
    selected: list[int] = []
    # First pass: rooms under ~18 m² (beds/baths/studies)
    for area_m2, i in cands:
        if len(selected) >= max_rooms:
            break
        if area_m2 <= 18.0:
            selected.append(i)
    # Second: larger living / open cells if budget remains
    for area_m2, i in cands:
        if len(selected) >= max_rooms:
            break
        if i not in selected:
            selected.append(i)
    rooms: list[dict[str, Any]] = []
    for i in selected:
        mask = (lab == i).astype(np.uint8) * 255
        poly = _ortho_polygon_from_mask(mask, max_verts=16)
        if poly is None or len(poly) < 4:
            continue
        verts = []
        for x, y in poly:
            mx = min_x + float(x) * mpp
            my = max_y - float(y) * mpp
            verts.append(_vec(mx, my))
        # Reject degenerate
        xs2 = [v["x"] for v in verts]
        ys2 = [v["y"] for v in verts]
        if (max(xs2) - min(xs2)) * (max(ys2) - min(ys2)) < min_area_m2:
            continue
        rooms.append(
            {
                "id": f"room-wall-{len(rooms)+1}",
                "type": "房間",
                "vertices": verts,
                "confidence": 0.62,
            }
        )
    if rooms:
        notes.append(
            f"牆屏障自由格房間 {len(rooms)}（貼齊牆網；避免單一開放廳 AABB）。"
        )
    return rooms, notes


def _prefer_finer_rooms(
    existing: list[dict[str, Any]],
    barrier_rooms: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Prefer wall-barrier rooms when they split mega CubiCasa/AABB blobs."""
    notes: list[str] = []
    if not barrier_rooms:
        return existing, notes
    if not existing:
        return barrier_rooms, notes

    def _area(r: dict[str, Any]) -> float:
        box = _room_aabb(r)
        if not box:
            return 0.0
        return max(0.0, (box[2] - box[0]) * (box[3] - box[1]))

    ex_areas = sorted((_area(r) for r in existing), reverse=True)
    br_areas = sorted((_area(r) for r in barrier_rooms), reverse=True)
    mega_ex = sum(1 for a in ex_areas if a >= 20.0)
    mega_br = sum(1 for a in br_areas if a >= 20.0)

    def _nverts(r: dict[str, Any]) -> int:
        return len(r.get("vertices") or [])

    non_aabb_br = sum(1 for r in barrier_rooms if _nverts(r) >= 6)
    non_aabb_ex = sum(1 for r in existing if _nverts(r) >= 6)
    # Reject barrier set if it under-segments into a few mega floods
    # (keep if those few faces are clearly non-AABB L/T wall-graph rooms)
    if len(barrier_rooms) <= 3 and mega_br >= max(1, len(barrier_rooms) - 1):
        if non_aabb_br < 1:
            notes.append(
                f"牆屏障房間過粗（{len(barrier_rooms)} mega），保留既有 {len(existing)}。"
            )
            return existing, notes
    # Planar / barrier faces win when they replace majority AABB with wall faces
    faceish = sum(
        1 for r in barrier_rooms
        if str(r.get("id", "")).startswith("room-face") or _nverts(r) >= 6
    )
    # Never replace a fine split with a coarse mega-face set
    if (
        len(barrier_rooms) < len(existing)
        and mega_br >= mega_ex
        and len(existing) >= 5
        and len(barrier_rooms) <= 4
    ):
        notes.append(
            f"略過過粗 planar／barrier（{len(barrier_rooms)}≤4 vs 既有 {len(existing)}）。"
        )
        # fall through to hybrid
    elif len(barrier_rooms) >= 3 and (
        (mega_ex >= 1 and mega_br < mega_ex)
        or (ex_areas and ex_areas[0] >= 22.0 and br_areas and br_areas[0] < ex_areas[0] * 0.80)
        or (len(barrier_rooms) >= max(4, len(existing)) and mega_br <= mega_ex)
        or (non_aabb_br >= 1 and non_aabb_br >= non_aabb_ex and len(barrier_rooms) >= 4)
        or (non_aabb_br >= 2 and mega_br <= mega_ex + 1)
        # Step-change: majority of rooms are planar faces / non-AABB
        or (
            faceish >= max(4, (len(barrier_rooms) + 1) // 2)
            and mega_br <= mega_ex
            and len(barrier_rooms) >= max(5, len(existing) - 1)
        )
        or (faceish >= 5 and len(barrier_rooms) >= len(existing))
        or (
            non_aabb_br >= max(3, non_aabb_ex + 1)
            and len(barrier_rooms) >= max(5, len(existing) - 1)
            and mega_br <= mega_ex
        )
    ):
        notes.append(
            f"房間改採牆圖／planar face 分割 {len(existing)}→{len(barrier_rooms)}"
            f"（非 AABB={non_aabb_br}／faces≈{faceish}；取代多數 AABB）。"
        )
        return barrier_rooms, notes
    # Hybrid: start from existing, replace mega with barrier cells that overlap them
    out: list[dict[str, Any]] = []
    used_br: set[int] = set()
    for r in existing:
        ar = _area(r)
        box = _room_aabb(r)
        if not box:
            continue
        if ar < 18.0:
            out.append(dict(r))
            continue
        # Mega AABB: try to replace with overlapping barrier rooms
        replacements = []
        for bi, b in enumerate(barrier_rooms):
            if bi in used_br:
                continue
            bb = _room_aabb(b)
            if not bb:
                continue
            ix0 = max(box[0], bb[0]); iy0 = max(box[1], bb[1])
            ix1 = min(box[2], bb[2]); iy1 = min(box[3], bb[3])
            inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
            if inter >= 0.35 * _area(b) and _area(b) < ar * 0.85:
                replacements.append((bi, b))
        if len(replacements) >= 2:
            for bi, b in replacements:
                used_br.add(bi)
                out.append(dict(b))
        else:
            out.append(dict(r))
    # Add unused small barrier rooms not covered
    for bi, b in enumerate(barrier_rooms):
        if bi in used_br or _area(b) >= 18.0:
            continue
        bb = _room_aabb(b)
        if not bb:
            continue
        cx, cy = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
        if any(
            (ab := _room_aabb(r)) and ab[0] <= cx <= ab[2] and ab[1] <= cy <= ab[3]
            for r in out
        ):
            continue
        out.append(dict(b))
    if len(out) > 10:
        out = sorted(out, key=_area, reverse=True)[:10]
    for i, r in enumerate(out):
        r["id"] = f"room-{i+1}"
    if len(out) != len(existing) or mega_ex >= 2:
        notes.append(
            f"房間牆約束微調：{len(existing)}→{len(out)}（拆 mega／補小房）。"
        )
        return out, notes
    return existing, notes


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
    thick = max(3, int(round(0.18 / mpp)))

    def _m_to_r(x: float, y: float) -> tuple[int, int]:
        px = int(round((x - min_x) / mpp))
        # y up in metres → row down
        py = int(round((max_y - y) / mpp))
        return px, py

    for w in walls:
        p1 = _m_to_r(w["a"]["x"], w["a"]["y"])
        p2 = _m_to_r(w["b"]["x"], w["b"]["y"])
        cv2.line(barrier, p1, p2, 255, thick)
    k3c = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    barrier = cv2.dilate(barrier, k3c, iterations=1)  # seal door gaps for faces
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
        # Expand enough for L/T wall-faces that stick out of coarse AABB
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
        poly = _ortho_polygon_from_mask(clip, max_verts=16)
        if poly is None or len(poly) < 4:
            out.append(r)
            continue
        # Convert raster poly → metres
        verts = []
        for x, y in poly:
            mx = min_x + float(x) * mpp
            my = max_y - float(y) * mpp
            verts.append(_vec(mx, my))
        # Reject clip that inflates past original AABB or collapses too hard
        ox0, oy0, ox1, oy1 = box
        o_area = max(1e-6, (ox1 - ox0) * (oy1 - oy0))
        nxs = [v["x"] for v in verts]
        nys = [v["y"] for v in verts]
        n_area = max(0.0, (max(nxs) - min(nxs)) * (max(nys) - min(nys)))
        # Allow L/T orthos that shrink AABB fill (non-AABB wall faces)
        if n_area > o_area * 1.35 or n_area < o_area * 0.40:
            out.append(r)
            continue
        nr = dict(r)
        nr["vertices"] = verts
        nr["confidence"] = min(0.74, float(r.get("confidence") or 0.55) + 0.10)
        out.append(nr)
        improved += 1
    if improved:
        notes.append(
            f"房間多邊形以牆圖約束 {improved}/{len(rooms)}（非 AABB／L 形 ortho）。"
        )
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

    # RW taxonomy (room/wall/door/window) → lower conf + larger imgsz.
    # FloorCAD furniture-heavy taxonomy → slightly higher conf to cut false walls.
    name_set = {str(n).strip().lower() for n in names.values()}
    has_rw_taxonomy = {"wall", "door", "window"}.issubset(name_set) and (
        "room" in name_set or any(n.startswith("space") for n in name_set)
    )
    if has_rw_taxonomy:
        conf_thr = 0.16
        imgsz = 896
        notes.append("YOLO 權重為 room/wall/door/window 分類；imgsz=896 conf≥0.16。")
    elif has_floorplan_classes:
        conf_thr = 0.22
        imgsz = 640
    else:
        conf_thr = 0.28
        imgsz = 640
    try:
        results = model.predict(
            bgr, verbose=False, conf=conf_thr, iou=0.45, imgsz=imgsz
        )
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
                room_poly = None
                if mask_data is not None and mi < len(mask_data):
                    raw_mask = mask_data[mi]
                    if raw_mask.shape[0] != h or raw_mask.shape[1] != w:
                        raw_mask = cv2.resize(
                            raw_mask, (w, h), interpolation=cv2.INTER_LINEAR
                        )
                    room_poly = _ortho_polygon_from_mask(
                        (raw_mask > 0.5).astype(np.uint8) * 255, max_verts=16
                    )
                if room_poly is None:
                    room_poly = poly
                if room_poly is None:
                    continue
                verts_m = [
                    _px_to_m(float(x), float(y), height_px=h, mpp=mpp)
                    for x, y in room_poly
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
                a_m = b_m = None
                if mask_data is not None and mi < len(mask_data):
                    raw_mask = mask_data[mi]
                    if raw_mask.shape[0] != h or raw_mask.shape[1] != w:
                        raw_mask = cv2.resize(
                            raw_mask, (w, h), interpolation=cv2.INTER_LINEAR
                        )
                    cl = _wall_mask_centerline_m(
                        (raw_mask > 0.5).astype(np.uint8) * 255,
                        height_px=h,
                        mpp=mpp,
                    )
                    if cl is not None:
                        a_m, b_m = cl
                if a_m is None:
                    if poly is not None and len(poly) >= 2:
                        verts_m = [
                            _px_to_m(float(x), float(y), height_px=h, mpp=mpp)
                            for x, y in poly
                        ]
                        best = (
                            0.0,
                            verts_m[0],
                            verts_m[1] if len(verts_m) > 1 else verts_m[0],
                        )
                        for i in range(len(verts_m)):
                            a, b = verts_m[i], verts_m[(i + 1) % len(verts_m)]
                            d = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
                            if d > best[0]:
                                best = (d, a, b)
                        a_m, b_m = best[1], best[2]
                    else:
                        a_m, b_m = _box_to_wall_segment_m(
                            xyxy[mi], height_px=h, mpp=mpp
                        )
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

    # Prefer richer room topology — RW YOLO rooms first, then CubiCasa, then OpenCV
    rooms = cv_rooms
    roi_m = (
        x0 * mpp,
        (h - y1) * mpp,
        x1 * mpp,
        (h - y0) * mpp,
    )
    yolo_rooms_f, yr_notes = _filter_chrome_rooms(yolo_rooms, roi_m=roi_m)
    notes.extend(yr_notes)
    foot_for_rooms = _footprint_mask(bgr, x0, y0, x1, y1)
    yolo_rooms_f, fp_notes = _filter_rooms_by_footprint(
        yolo_rooms_f, foot_for_rooms, mpp=mpp, height_px=h, min_overlap=0.50
    )
    notes.extend(fp_notes)
    if len(yolo_rooms_f) > 10:
        def _area(r):
            box = _room_aabb(r)
            if not box:
                return 0.0
            return (box[2] - box[0]) * (box[3] - box[1])
        yolo_rooms_f = sorted(yolo_rooms_f, key=_area, reverse=True)[:10]
        notes.append("RW-YOLO 房間過多，保留面積最大 10 個。")
    used_yolo_rooms = False
    if has_rw_taxonomy and len(yolo_rooms_f) >= 3:
        # Reject YOLO room set if any room is huge vs footprint (chrome mega-box)
        foot_area_m2 = float((foot_for_rooms > 0).sum()) * (mpp ** 2)
        areas = []
        for r in yolo_rooms_f:
            box = _room_aabb(r)
            if box:
                areas.append((box[2] - box[0]) * (box[3] - box[1]))
        mega = sum(1 for a in areas if foot_area_m2 > 1 and a > foot_area_m2 * 0.42)
        if mega >= 2 or (areas and max(areas) > max(foot_area_m2 * 0.55, 40.0)):
            notes.append(
                f"RW-YOLO 房間含 mega／chrome（mega={mega}），改 CubiCasa/OpenCV。"
            )
        else:
            rooms = yolo_rooms_f
            used_yolo_rooms = True
            notes.append(
                f"房間採用 RW-YOLO 遮罩（{len(yolo_rooms_f)}；CubiCasa/OpenCV 作後備）。"
            )
    if (not used_yolo_rooms) and cubi and cubi.get("rooms"):
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
    elif (not used_yolo_rooms) and yolo_rooms_f and len(yolo_rooms_f) >= max(3, len(cv_rooms)):
        rooms = yolo_rooms_f
        used_yolo_rooms = True
        notes.append("房間採用 YOLO 遮罩。")
    rooms, chrome2 = _filter_chrome_rooms(rooms, roi_m=roi_m)
    notes.extend(chrome2)

    walls = list(cv_walls)
    if yolo_walls:
        # RW taxonomy: trust YOLO walls more (centerlines); FloorCAD: longer only
        min_yolo_L = 0.55 if has_rw_taxonomy else 0.8
        long_yolo = []
        for yw in yolo_walls:
            if _seg_length_m(yw) < min_yolo_L:
                continue
            # Near-axis only — drop diagonal furniture/noise walls
            ax, ay, bx, by = yw["a"]["x"], yw["a"]["y"], yw["b"]["x"], yw["b"]["y"]
            if abs(ax - bx) >= 0.35 and abs(ay - by) >= 0.35:
                continue
            long_yolo.append(yw)
        foot_w = _footprint_mask(bgr, x0, y0, x1, y1)
        long_yolo, yw_fp = _filter_walls_by_footprint(
            long_yolo, foot_w, mpp=mpp, height_px=h, min_hit=0.40
        )
        notes.extend(yw_fp)
        if has_rw_taxonomy and len(long_yolo) >= 6:
            walls = walls + long_yolo
            notes.append(
                f"RW-YOLO 牆為主結構併入 {len(long_yolo)}（minL={min_yolo_L}）。"
            )
        elif long_yolo:
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
    # Drop remaining non-structural short diagonals (never drop outer ring)
    walls = [
        w
        for w in walls
        if "ring" in str(w.get("id", ""))
        or _is_structural_edge(
            w["a"]["x"], w["a"]["y"], w["b"]["x"], w["b"]["y"], min_len=0.55
        )
    ]
    # Extend near-exterior wall segments along ink (close perimeter gaps)
    walls, peri_ext_notes = _extend_perimeter_walls_along_ink(
        walls, bgr, mpp=mpp, content_roi=(x0, y0, x1, y1), plan_style=plan_style
    )
    notes.extend(peri_ext_notes)
    # Re-inject outer ring so later merges/caps cannot erase the continuous perimeter
    foot_final = _footprint_mask(bgr, x0, y0, x1, y1)
    ring2, ring2_closed, ring2_notes = _outer_perimeter_ring_walls(
        bgr, mpp=mpp, x0=x0, y0=y0, x1=x1, y1=y1, foot=foot_final, plan_style=plan_style,
    )
    if ring2:
        # Replace any prior ring segments with the fresh closed ring (avoid double-count)
        walls = [w for w in walls if "ring" not in str(w.get("id", ""))]
        walls = _drop_walls_overlapping_ring(walls, ring2, dist_tol_m=0.55)
        walls = ring2 + walls
        walls = _dedupe_parallel_walls(walls, axis_tol_m=0.34, overlap_slack_m=0.35)
        notes.append(
            f"最終重申外周界 ring {len(ring2)} 段（{'閉合' if ring2_closed else '未閉合'}）。"
        )
    # Supplement interior partitions from thick-wall medial H/V runs
    try:
        ink_m = _thick_wall_ink_mask(bgr, foot_final, plan_style=plan_style)
        medial_m, _ = _medial_axis_mask(ink_m)
        med_walls = _hv_runs_from_medial(
            medial_m, height_px=h, mpp=mpp, min_run_px=max(24, int(min(h, w) * 0.04)),
            prefix="w-med",
        )
        if med_walls:
            ring_now = [w for w in walls if "ring" in str(w.get("id", ""))]
            med_walls = _drop_walls_overlapping_ring(med_walls, ring_now, dist_tol_m=0.50)
            med_walls, _ = _merge_collinear_walls(
                med_walls, min_len_m=0.70, gap_tol_m=0.85, axis_tol_m=0.20
            )
            # Keep longer medial interiors only; cap to avoid CAD ΣL inflation
            med_walls = [w for w in med_walls if _seg_length_m(w) >= 1.15]
            med_walls = sorted(med_walls, key=_seg_length_m, reverse=True)[:8]
            before = len(walls)
            walls = walls + med_walls
            walls = _dedupe_parallel_walls(walls, axis_tol_m=0.32, overlap_slack_m=0.30)
            added = max(0, len(walls) - before)
            if added > 0:
                notes.append(f"厚牆中心線內隔間併入 {added} 段（medial H/V）。")
    except Exception as e:  # noqa: BLE001
        notes.append(f"medial 內隔間略過：{e}")
    # Drop furniture-risk interior ink (esp. marketing 2b ΣL inflation)
    # Tighter on marketing so planar faces aren't sliced by sofa/bed ghosts
    max_int = 12 if plan_style == "marketing" else 20
    walls, furn_notes = _filter_furniture_risk_walls(
        walls, plan_style=plan_style, max_interior=max_int
    )
    notes.extend(furn_notes)
    # Drop zero-length / tiny stubs (never drop multi-segment ring identity bulk)
    walls = [
        w for w in walls
        if "ring" in str(w.get("id", "")) or _seg_length_m(w) >= 0.70
    ]
    walls = [w for w in walls if _seg_length_m(w) >= 0.40]
    # Planar wall-face room net: extend→junctions→closed faces (filter outer)
    face_rooms, jwalls, face_notes = _rooms_from_planar_wall_faces(
        walls,
        snap_tol_m=0.30 if plan_style == "marketing" else 0.26,
        extend_max_m=0.75 if plan_style == "cad" else 0.65,
        min_area_m2=1.6,
        max_rooms=12,
        min_width_m=0.80,
        mpp=mpp,
    )
    notes.extend(face_notes)
    if jwalls and len(jwalls) >= max(4, len(walls) // 2):
        # Prefer junction-consistent centerlines for openings + barrier faces
        # Keep ring ids: remapped ids still contain "ring" substring from source
        walls = jwalls
    # Split mega open-plan AABBs along crossing interior walls (beds/baths)
    rooms, split_notes = _split_aabb_rooms_by_walls(
        rooms, walls, min_room_m2=2.5, mega_m2=14.0
    )
    notes.extend(split_notes)
    # Wall-constrained room polygons (after structural walls settle)
    rooms, room_wall_notes = _constrain_rooms_by_walls(
        rooms, walls, mpp=mpp, height_px=h, content_roi=(x0, y0, x1, y1)
    )
    notes.extend(room_wall_notes)
    # Finer rooms from wall free-space cells (when barriers close)
    barrier_rooms, br_notes = _rooms_from_wall_barriers(
        walls, mpp=mpp, height_px=h, max_rooms=12, min_area_m2=1.6
    )
    notes.extend(br_notes)
    # Prefer planar faces over raster barriers when they do not under-segment
    def _mega_count(rs: list) -> int:
        n = 0
        for r in rs:
            box = _room_aabb(r)
            if box and (box[2] - box[0]) * (box[3] - box[1]) >= 22.0:
                n += 1
        return n

    face_ok = bool(face_rooms) and (
        len(face_rooms) >= max(5, len(rooms) - 2)
        and _mega_count(face_rooms) <= max(1, _mega_count(rooms))
        and sum(1 for r in face_rooms if len(r.get("vertices") or []) >= 6) >= 2
    )
    if face_ok:
        # Merge: planar faces primary; add barrier rooms not overlapping faces
        merged_faces = list(face_rooms)
        for b in barrier_rooms:
            bb = _room_aabb(b)
            if not bb:
                continue
            cx, cy = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
            covered = any(
                (fb := _room_aabb(f))
                and fb[0] <= cx <= fb[2]
                and fb[1] <= cy <= fb[3]
                for f in merged_faces
            )
            if not covered:
                merged_faces.append(b)
        if len(merged_faces) > 12:
            merged_faces = sorted(
                merged_faces,
                key=lambda r: (
                    -len(r.get("vertices") or []),
                    -(
                        ((_room_aabb(r) or (0, 0, 0, 0))[2] - (_room_aabb(r) or (0, 0, 0, 0))[0])
                        * ((_room_aabb(r) or (0, 0, 0, 0))[3] - (_room_aabb(r) or (0, 0, 0, 0))[1])
                    ),
                ),
            )[:12]
        barrier_rooms = merged_faces
        notes.append(
            f"planar faces 主導房間網 {len(face_rooms)}＋補 barrier "
            f"→{len(barrier_rooms)}。"
        )
    elif face_rooms:
        notes.append(
            f"planar faces {len(face_rooms)} 未主導（防 under-seg vs 既有 {len(rooms)}）；"
            f"交由 prefer／hybrid。"
        )
        # Still offer faces to prefer_finer_rooms as candidates via barrier list append
        # without wiping finer YOLO rooms: extend barrier_rooms with non-overlapping faces
        extra = []
        for f in face_rooms:
            fb = _room_aabb(f)
            if not fb:
                continue
            cx, cy = (fb[0] + fb[2]) / 2, (fb[1] + fb[3]) / 2
            if any(
                (bb := _room_aabb(b))
                and bb[0] <= cx <= bb[2]
                and bb[1] <= cy <= bb[3]
                for b in barrier_rooms
            ):
                continue
            # Also skip if covered by existing YOLO room centroid nest
            if any(
                (rb := _room_aabb(r))
                and rb[0] <= cx <= rb[2]
                and rb[1] <= cy <= rb[3]
                and (rb[2] - rb[0]) * (rb[3] - rb[1]) < 18.0
                for r in rooms
            ):
                continue
            extra.append(f)
        if extra:
            barrier_rooms = list(barrier_rooms) + extra
            notes.append(f"planar faces 補入 barrier 候選 +{len(extra)}。")
    rooms, pref_notes = _prefer_finer_rooms(rooms, barrier_rooms)
    notes.extend(pref_notes)
    # Re-clip after preference
    if split_notes or pref_notes or br_notes:
        rooms, room_wall_notes2 = _constrain_rooms_by_walls(
            rooms, walls, mpp=mpp, height_px=h, content_roi=(x0, y0, x1, y1)
        )
        notes.extend(room_wall_notes2)
    # Replace remaining AABB rooms with planar faces where they overlap
    if face_rooms:
        rooms, repl_notes = _replace_aabb_rooms_with_faces(rooms, face_rooms)
        notes.extend(repl_notes)
    # Coverage-first cap: keep long near-axis structural walls (was 22; too aggressive)
    if len(walls) > 42:
        ring_keep = [w for w in walls if "ring" in str(w.get("id", ""))]
        rest = [w for w in walls if "ring" not in str(w.get("id", ""))]

        def _wall_keep_key(w: dict[str, Any]) -> tuple:
            wid = str(w.get("id", ""))
            L = _seg_length_m(w)
            align = _axis_align_score(
                w["a"]["x"], w["a"]["y"], w["b"]["x"], w["b"]["y"]
            )
            if "ink" in wid or wid.startswith("w-m-"):
                prio = 0
            elif "yolo" in wid:
                prio = 0 if has_rw_taxonomy else 1
            elif "cubi" in wid:
                prio = 0 if plan_style == "cad" else 1
            elif "skel" in wid:
                prio = 1
            elif "room" in wid:
                prio = 2
            else:
                prio = 1
            return (prio, -align, -L)

        budget = max(0, 42 - len(ring_keep))
        walls = ring_keep + sorted(rest, key=_wall_keep_key)[:budget]
        notes.append(
            f"牆段過多，最終截斷至 {len(walls)}（保留全部 ring {len(ring_keep)}＋墨跡／近軸）。"
        )

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

    # Flush openings onto perimeter / ring walls (real windows/doors on ring)
    doors, n_flush_d = _flush_openings_to_perimeter_walls(
        doors, walls, max_dist_m=0.80, ring_only=False, min_len_m=0.50
    )
    # Windows: ring-only flush — no fake peri / no interior ink attachment
    windows, n_flush_w = _flush_openings_to_perimeter_walls(
        windows, walls, max_dist_m=0.95, ring_only=True, min_len_m=0.55
    )
    if n_flush_d or n_flush_w:
        notes.append(
            f"開口 flush 外周界：門 {n_flush_d}、窗 {n_flush_w}（窗僅 ring）。"
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
