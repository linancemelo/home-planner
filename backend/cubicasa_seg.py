"""CubiCasa5K ResNet34-UNet semantic segmentation (floor/wall/door/window).

Optional companion to YOLO-seg. Weights live at models/cubicasa/best.safetensors
(from Hugging Face Yytsi/floorplan-to-3d-walls). Floor pixels → room candidates
split by wall barriers; wall/door/window masks → geometry after cleanup.

CubiCasa is trained on Nordic CAD SVG rasters; marketing photos are noisier —
we only keep openings / wall centerlines that pass geometric priors.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import cv2
import numpy as np

CLASS_NAMES = ("floor", "wall", "door", "window")
IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)

_MODEL = None
_MODEL_ERROR: str | None = None
_IMAGE_SIZE = 512


def cubicasa_dir() -> Path:
    env = os.environ.get("DETECT_CUBICASA_DIR", "").strip()
    if env:
        return Path(env)
    return Path(__file__).resolve().parent / "models" / "cubicasa"


def cubicasa_available() -> bool:
    d = cubicasa_dir()
    return (d / "best.safetensors").is_file()


def get_cubicasa_error() -> str | None:
    return _MODEL_ERROR


def load_cubicasa(force: bool = False):
    """Load CubiCasa UNet once. Raises on failure."""
    global _MODEL, _MODEL_ERROR
    if _MODEL is not None and not force:
        return _MODEL
    _MODEL_ERROR = None
    d = cubicasa_dir()
    ckpt = d / "best.safetensors"
    if not ckpt.is_file():
        _MODEL_ERROR = f"CubiCasa 權重不存在：{ckpt}"
        raise RuntimeError(_MODEL_ERROR)
    try:
        import torch
        import yaml
        import segmentation_models_pytorch as smp
        from safetensors.torch import load_file
    except Exception as e:  # noqa: BLE001
        _MODEL_ERROR = f"CubiCasa 依賴不足（需 torch/smp/safetensors）：{e}"
        raise RuntimeError(_MODEL_ERROR) from e

    cfg_path = d / "config.yaml"
    encoder = "resnet34"
    if cfg_path.is_file():
        with cfg_path.open() as f:
            cfg = yaml.safe_load(f) or {}
        encoder = (cfg.get("model") or {}).get("encoder_name", encoder)
        size = (cfg.get("data") or {}).get("image_size")
        if isinstance(size, (list, tuple)) and len(size) >= 2:
            global _IMAGE_SIZE
            _IMAGE_SIZE = int(size[0])

    try:
        model = smp.Unet(
            encoder_name=encoder,
            encoder_weights=None,
            in_channels=3,
            classes=len(CLASS_NAMES),
        )
        state = load_file(str(ckpt), device="cpu")
        model.load_state_dict(state)
        model.eval()
        _MODEL = model
        return _MODEL
    except Exception as e:  # noqa: BLE001
        _MODEL_ERROR = f"無法載入 CubiCasa：{e}"
        _MODEL = None
        raise RuntimeError(_MODEL_ERROR) from e


def _letterbox_rgb(bgr: np.ndarray, size: int) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    h, w = bgr.shape[:2]
    scale = min(size / w, size / h)
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    resized = cv2.resize(rgb, (nw, nh), interpolation=cv2.INTER_AREA)
    canvas = np.zeros((size, size, 3), dtype=np.uint8)
    for i, m in enumerate(IMAGENET_MEAN):
        canvas[:, :, i] = int(round(m * 255))
    top = (size - nh) // 2
    left = (size - nw) // 2
    canvas[top : top + nh, left : left + nw] = resized
    return canvas, (left, top, nw, nh)


def predict_mask(bgr: np.ndarray) -> tuple[np.ndarray, tuple[int, int, int, int], list[str]]:
    """Return full-res HxW uint8 class mask (0..3), letterbox rect in 512 space, notes."""
    import torch

    model = load_cubicasa()
    notes: list[str] = []
    size = _IMAGE_SIZE
    canvas, rect = _letterbox_rgb(bgr, size)
    t = torch.from_numpy(canvas).permute(2, 0, 1).contiguous().float().div_(255.0)
    mean = torch.tensor(IMAGENET_MEAN).view(3, 1, 1)
    std = torch.tensor(IMAGENET_STD).view(3, 1, 1)
    t = (t - mean) / std
    with torch.no_grad():
        logits = model(t.unsqueeze(0))
        mask512 = logits.argmax(dim=1).squeeze(0).cpu().numpy().astype(np.uint8)
    left, top, nw, nh = rect
    content = mask512[top : top + nh, left : left + nw]
    h, w = bgr.shape[:2]
    full = cv2.resize(content, (w, h), interpolation=cv2.INTER_NEAREST)
    counts = {CLASS_NAMES[i]: int((full == i).sum()) for i in range(4)}
    notes.append(
        "CubiCasa UNet（floor/wall/door/window）"
        f"：floor={counts['floor']} wall={counts['wall']} "
        f"door={counts['door']} window={counts['window']} px。"
    )
    return full, rect, notes


def _mask_to_opening_segments(
    mask: np.ndarray,
    *,
    height_px: int,
    mpp: float,
    min_area: float = 40.0,
) -> list[tuple[tuple[float, float], tuple[float, float], float]]:
    """Binary mask → list of (a_m, b_m, area_px) opening centerlines."""
    from yolo_pipeline import _px_to_m  # local import to avoid cycle at module load

    m = (mask > 0).astype(np.uint8)
    if m.sum() == 0:
        return []
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k, iterations=2)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k, iterations=1)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    out: list[tuple[tuple[float, float], tuple[float, float], float]] = []
    for i in range(1, n):
        area = float(stats[i, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        x, y, ww, hh = (
            int(stats[i, cv2.CC_STAT_LEFT]),
            int(stats[i, cv2.CC_STAT_TOP]),
            int(stats[i, cv2.CC_STAT_WIDTH]),
            int(stats[i, cv2.CC_STAT_HEIGHT]),
        )
        if ww >= hh:
            ya = y + hh / 2
            a = _px_to_m(float(x), ya, height_px=height_px, mpp=mpp)
            b = _px_to_m(float(x + ww), ya, height_px=height_px, mpp=mpp)
        else:
            xa = x + ww / 2
            a = _px_to_m(xa, float(y + hh), height_px=height_px, mpp=mpp)
            b = _px_to_m(xa, float(y), height_px=height_px, mpp=mpp)
        length = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
        if length < 0.35:
            continue
        out.append((a, b, area))
    return out


def _wall_mask_to_segments(
    wall_mask: np.ndarray,
    *,
    height_px: int,
    width_px: int,
    mpp: float,
) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    from yolo_pipeline import _px_to_m

    m = (wall_mask > 0).astype(np.uint8) * 255
    if m.mean() < 0.5:
        return []
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k, iterations=1)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k, iterations=2)
    # Prefer elongated CCs (structural) over furniture blobs
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    cleaned = np.zeros_like(m)
    for i in range(1, n):
        area = int(st[i, cv2.CC_STAT_AREA])
        ww = int(st[i, cv2.CC_STAT_WIDTH])
        hh = int(st[i, cv2.CC_STAT_HEIGHT])
        aspect = max(ww, hh) / (min(ww, hh) + 1e-6)
        if area < 35:
            continue
        # Drop compact furniture-like blobs unless large area
        if aspect < 1.6 and area < 900:
            continue
        cleaned[lab == i] = 255
    m = cleaned
    if cv2.countNonZero(m) < 80:
        return []
    # Skeleton → Hough (more stable than raw mask Hough on thick fills)
    skel = np.zeros_like(m)
    element = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
    img = m.copy()
    for _ in range(64):
        opened = cv2.morphologyEx(img, cv2.MORPH_OPEN, element)
        temp = cv2.subtract(img, opened)
        eroded = cv2.erode(img, element)
        skel = cv2.bitwise_or(skel, temp)
        img = eroded
        if cv2.countNonZero(img) == 0:
            break
    hough_src = cv2.bitwise_or(skel, cv2.erode(m, k, iterations=1))
    min_len = max(22, int(min(width_px, height_px) * 0.04))
    lines = cv2.HoughLinesP(
        hough_src, 1, np.pi / 180, threshold=28, minLineLength=min_len, maxLineGap=14
    )
    segs: list[tuple[tuple[float, float], tuple[float, float]]] = []
    if lines is None:
        return segs
    for x1, y1, x2, y2 in lines.reshape(-1, 4):
        if abs(int(x2) - int(x1)) < 6:
            x2 = x1
        if abs(int(y2) - int(y1)) < 6:
            y2 = y1
        # Reject strong diagonals
        if abs(int(x2) - int(x1)) >= 8 and abs(int(y2) - int(y1)) >= 8:
            continue
        a = _px_to_m(float(x1), float(y1), height_px=height_px, mpp=mpp)
        b = _px_to_m(float(x2), float(y2), height_px=height_px, mpp=mpp)
        length = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
        if length >= 0.55:
            segs.append((a, b))
    # Cap fragmentation
    if len(segs) > 60:
        segs = sorted(
            segs,
            key=lambda ab: ((ab[0][0] - ab[1][0]) ** 2 + (ab[0][1] - ab[1][1]) ** 2),
            reverse=True,
        )[:40]
    return segs


def _floor_rooms_via_wall_barriers(
    floor: np.ndarray,
    wall: np.ndarray,
    door: np.ndarray,
    *,
    height_px: int,
    mpp: float,
    max_rooms: int = 10,
) -> list[dict[str, Any]]:
    """Split CubiCasa floor with wall(+door) barriers → room polygons (ortho/AABB)."""
    from yolo_pipeline import _ortho_polygon_from_mask, _px_to_m, _vec

    h, w = floor.shape[:2]
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    k3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    free = cv2.morphologyEx(floor, cv2.MORPH_OPEN, k, iterations=1)
    barrier = cv2.bitwise_or(wall, door)
    # Dilate barriers enough to close door necks for CC split
    barrier = cv2.dilate(barrier, k3, iterations=3)
    free = cv2.bitwise_and(free, cv2.bitwise_not(barrier))
    free = cv2.morphologyEx(free, cv2.MORPH_OPEN, k3, iterations=2)
    margin = max(4, min(w, h) // 80)
    free[:margin, :] = 0
    free[-margin:, :] = 0
    free[:, :margin] = 0
    free[:, -margin:] = 0

    # Watershed mega-blobs at distance peaks
    from yolo_pipeline import _split_free_via_watershed

    min_area = (w * h) * 0.012
    masks = _split_free_via_watershed(free, min_area=min_area, max_rooms=max_rooms)
    rooms: list[dict[str, Any]] = []
    scored: list[tuple[float, dict[str, Any]]] = []
    for mask in masks:
        area = int(mask.sum() // 255)
        if area < min_area:
            continue
        poly = _ortho_polygon_from_mask(mask, max_verts=10)
        if poly is None or len(poly) < 3:
            continue
        # Reject thin chrome strips
        xs, ys = poly[:, 0], poly[:, 1]
        bw, bh = float(xs.max() - xs.min()), float(ys.max() - ys.min())
        if bh > 1 and bw / bh >= 5.0 and bh < h * 0.12:
            continue
        if bw > 1 and bh / bw >= 5.0 and bw < w * 0.12:
            continue
        verts = [
            _vec(*_px_to_m(float(x), float(y), height_px=height_px, mpp=mpp))
            for x, y in poly
        ]
        scored.append(
            (
                float(area),
                {
                    "id": f"room-cubi-{len(scored)+1}",
                    "type": "房間",
                    "vertices": verts,
                    "confidence": 0.55,
                },
            )
        )
    scored.sort(key=lambda t: t[0], reverse=True)
    for _, r in scored[:max_rooms]:
        r["id"] = f"room-cubi-{len(rooms)+1}"
        rooms.append(r)
    return rooms


def extract_from_cubicasa(
    bgr: np.ndarray,
    *,
    mpp: float,
) -> dict[str, Any]:
    """Run CubiCasa and return rooms/walls/doors/windows candidates + notes."""
    h, w = bgr.shape[:2]
    mask, _rect, notes = predict_mask(bgr)
    floor = (mask == 0).astype(np.uint8) * 255
    wall = (mask == 1).astype(np.uint8) * 255
    door = (mask == 2).astype(np.uint8) * 255
    window = (mask == 3).astype(np.uint8) * 255

    # Drop floor predictions on white/chrome (ROI mask leaves white outside drawing)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    not_chrome = (gray < 245).astype(np.uint8) * 255
    floor = cv2.bitwise_and(floor, not_chrome)
    wall = cv2.bitwise_and(wall, not_chrome)
    door = cv2.bitwise_and(door, not_chrome)
    window = cv2.bitwise_and(window, not_chrome)

    rooms = _floor_rooms_via_wall_barriers(
        floor, wall, door, height_px=h, mpp=mpp, max_rooms=10
    )
    notes.append(f"CubiCasa floor＋牆屏障→房間候選 {len(rooms)} 個。")

    wall_segs = _wall_mask_to_segments(wall, height_px=h, width_px=w, mpp=mpp)
    notes.append(f"CubiCasa 牆中心線候選 {len(wall_segs)}。")

    door_segs = _mask_to_opening_segments(door, height_px=h, mpp=mpp, min_area=28)
    win_segs = _mask_to_opening_segments(window, height_px=h, mpp=mpp, min_area=28)
    doors_f = []
    for a, b, _area in door_segs:
        L = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
        if 0.5 <= L <= 1.45:
            doors_f.append((a, b))
    wins_f = []
    for a, b, _area in win_segs:
        L = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
        if 0.55 <= L <= 3.5:
            wins_f.append((a, b))
    notes.append(
        f"CubiCasa 開口（幾何過濾後）：門 {len(doors_f)}、窗 {len(wins_f)}。"
    )

    return {
        "rooms": rooms,
        "wall_segs": wall_segs,
        "door_segs": doors_f,
        "window_segs": wins_f,
        "wall_mask": wall,
        "floor_mask": floor,
        "notes": notes,
    }
