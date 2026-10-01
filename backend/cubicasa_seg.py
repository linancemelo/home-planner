"""CubiCasa5K ResNet34-UNet semantic segmentation (floor/wall/door/window).

Optional companion to YOLO-seg. Weights live at models/cubicasa/best.safetensors
(from Hugging Face Yytsi/floorplan-to-3d-walls). Floor pixels → room candidates;
wall/door/window masks → geometry after morphological cleanup.

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
    if m.mean() < 1:
        return []
    # Suppress speckles / floor bleed
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k, iterations=1)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k, iterations=2)
    # Drop if wall fraction too high (noisy marketing bleed)
    frac = float(m.mean()) / 255.0
    if frac > 0.12 or cv2.countNonZero(m) > (m.shape[0] * m.shape[1] * 0.12):
        return []  # too noisy — skip CubiCasa walls
    min_len = max(28, int(min(width_px, height_px) * 0.05))
    lines = cv2.HoughLinesP(
        m, 1, np.pi / 180, threshold=40, minLineLength=min_len, maxLineGap=16
    )
    segs: list[tuple[tuple[float, float], tuple[float, float]]] = []
    if lines is None:
        return segs
    if len(lines) > 80:
        return []  # fragmented — defer to OpenCV room edges
    for x1, y1, x2, y2 in lines.reshape(-1, 4):
        if abs(int(x2) - int(x1)) < 6:
            x2 = x1
        if abs(int(y2) - int(y1)) < 6:
            y2 = y1
        a = _px_to_m(float(x1), float(y1), height_px=height_px, mpp=mpp)
        b = _px_to_m(float(x2), float(y2), height_px=height_px, mpp=mpp)
        length = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
        if length >= 0.6:
            segs.append((a, b))
    return segs


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

    # Rooms from floor connected components (ignore border padding bleed)
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    free = cv2.morphologyEx(floor, cv2.MORPH_OPEN, k, iterations=1)
    margin = max(4, min(w, h) // 80)
    free[:margin, :] = 0
    free[-margin:, :] = 0
    free[:, :margin] = 0
    free[:, -margin:] = 0
    n, labels, stats, _ = cv2.connectedComponentsWithStats(free, 8)
    min_area = (w * h) * 0.02
    rooms: list[dict[str, Any]] = []
    from yolo_pipeline import _approx_polygon, _px_to_m, _vec

    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        poly = _approx_polygon((labels == i).astype(np.uint8) * 255, epsilon_frac=0.015)
        if poly is None or len(poly) < 3:
            continue
        verts = [
            _vec(*_px_to_m(float(x), float(y), height_px=h, mpp=mpp)) for x, y in poly
        ]
        rooms.append(
            {
                "id": f"room-cubi-{len(rooms)+1}",
                "type": "房間",
                "vertices": verts,
                "confidence": 0.5,
            }
        )
    notes.append(f"CubiCasa floor→房間候選 {len(rooms)} 個。")

    wall_segs = _wall_mask_to_segments(wall, height_px=h, width_px=w, mpp=mpp)
    notes.append(f"CubiCasa 牆中心線候選 {len(wall_segs)}（過噪則捨棄）。")

    door_segs = _mask_to_opening_segments(door, height_px=h, mpp=mpp, min_area=35)
    win_segs = _mask_to_opening_segments(window, height_px=h, mpp=mpp, min_area=40)
    # Geometric priors: doors ~0.55–1.35 m, windows ~0.7–3.0 m
    doors_f = []
    for a, b, _area in door_segs:
        L = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
        if 0.5 <= L <= 1.5:
            doors_f.append((a, b))
    wins_f = []
    for a, b, _area in win_segs:
        L = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
        if 0.65 <= L <= 3.2:
            wins_f.append((a, b))
    notes.append(
        f"CubiCasa 開口（幾何過濾後）：門 {len(doors_f)}、窗 {len(wins_f)}。"
    )

    return {
        "rooms": rooms,
        "wall_segs": wall_segs,
        "door_segs": doors_f,
        "window_segs": wins_f,
        "notes": notes,
    }
