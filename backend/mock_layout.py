"""Deterministic mock floor-plan layout (metres, bottom-left origin).

Does NOT run YOLO / OpenCV — returns a fixed sample apartment scaled to
the uploaded image's pixel size via metersPerPixel.
"""

from __future__ import annotations

from typing import Any


# Sample layout in metres (bottom-left origin). Outer box ~8.0 × 5.5 m.
# Internal partition at x=4.2 separates 客廳 (left) and 臥室 (right).
WALL_THICKNESS_M = 0.12
CEILING_HEIGHT_M = 2.8
SILL_HEIGHT_M = 0.9

# Outer walls (centerline segments)
_OUTER = [
    ("w-south", (0.0, 0.0), (8.0, 0.0)),
    ("w-east", (8.0, 0.0), (8.0, 5.5)),
    ("w-north", (8.0, 5.5), (0.0, 5.5)),
    ("w-west", (0.0, 5.5), (0.0, 0.0)),
]
# Internal wall with door gap
_INNER = ("w-partition", (4.2, 0.0), (4.2, 5.5))


def _vec(x: float, y: float) -> dict[str, float]:
    return {"x": round(x, 4), "y": round(y, 4)}


def _seg(a: tuple[float, float], b: tuple[float, float]) -> dict[str, Any]:
    return {"a": _vec(*a), "b": _vec(*b)}


def build_mock_detect_response(
    *,
    source_name: str,
    image_width_px: int,
    image_height_px: int,
) -> dict[str, Any]:
    """Build a full DetectResponse dict aligned with frontend Floorplan + rooms."""
    # Fit layout into image: use horizontal span 8.0 m across width with margin.
    layout_w_m = 8.0
    layout_h_m = 5.5
    margin_frac = 0.08
    usable_w = image_width_px * (1.0 - 2 * margin_frac)
    meters_per_pixel = layout_w_m / max(usable_w, 1.0)
    # Offset so layout sits with margin (still bottom-left metres).
    ox = image_width_px * margin_frac * meters_per_pixel
    oy = image_height_px * margin_frac * meters_per_pixel

    def shift(p: tuple[float, float]) -> tuple[float, float]:
        return (p[0] + ox, p[1] + oy)

    walls: list[dict[str, Any]] = []
    for wid, a, b in _OUTER:
        walls.append(
            {
                "id": wid,
                "a": _vec(*shift(a)),
                "b": _vec(*shift(b)),
                "thicknessM": WALL_THICKNESS_M,
                "thicknessAssumed": True,
                "heightM": CEILING_HEIGHT_M,
            }
        )
    # Partition as two segments with door gap in the middle
    gap_lo, gap_hi = 2.0, 2.9  # door opening on partition
    walls.append(
        {
            "id": "w-partition-s",
            "a": _vec(*shift((4.2, 0.0))),
            "b": _vec(*shift((4.2, gap_lo))),
            "thicknessM": WALL_THICKNESS_M,
            "thicknessAssumed": True,
            "heightM": CEILING_HEIGHT_M,
        }
    )
    walls.append(
        {
            "id": "w-partition-n",
            "a": _vec(*shift((4.2, gap_hi))),
            "b": _vec(*shift((4.2, 5.5))),
            "thicknessM": WALL_THICKNESS_M,
            "thicknessAssumed": True,
            "heightM": CEILING_HEIGHT_M,
        }
    )

    door_opening = (shift((4.2, gap_lo)), shift((4.2, gap_hi)))
    hinge = shift((4.2, gap_lo))
    leaf = abs(gap_hi - gap_lo)
    doors = [
        {
            "id": "d-inner-1",
            "kind": "swing",
            "wallId": "w-partition-s",
            "opening": _seg(*door_opening),
            "confidence": 0.92,
            "swing": {
                "hinge": _vec(*hinge),
                "leafLengthM": round(leaf, 4),
                "openDirection": "cw",
                "arcQuarter": True,
            },
        },
        {
            "id": "d-entry-1",
            "kind": "swing",
            "wallId": "w-south",
            "opening": _seg(shift((1.2, 0.0)), shift((2.1, 0.0))),
            "confidence": 0.88,
            "swing": {
                "hinge": _vec(*shift((1.2, 0.0))),
                "leafLengthM": 0.9,
                "openDirection": "ccw",
                "arcQuarter": True,
            },
        },
    ]

    windows = [
        {
            "id": "win-west-1",
            "wallId": "w-west",
            "opening": _seg(shift((0.0, 1.5)), shift((0.0, 3.5))),
            "confidence": 0.9,
            "sillHeightM": SILL_HEIGHT_M,
            "sillHeightAssumed": True,
        },
        {
            "id": "win-east-1",
            "wallId": "w-east",
            "opening": _seg(shift((8.0, 1.8)), shift((8.0, 3.8))),
            "confidence": 0.86,
            "sillHeightM": SILL_HEIGHT_M,
            "sillHeightAssumed": True,
        },
    ]

    # Room polygons (interior, inset slightly from wall centerlines)
    inset = 0.06
    living_verts = [
        shift((0.0 + inset, 0.0 + inset)),
        shift((4.2 - inset, 0.0 + inset)),
        shift((4.2 - inset, 5.5 - inset)),
        shift((0.0 + inset, 5.5 - inset)),
    ]
    bedroom_verts = [
        shift((4.2 + inset, 0.0 + inset)),
        shift((8.0 - inset, 0.0 + inset)),
        shift((8.0 - inset, 5.5 - inset)),
        shift((4.2 + inset, 5.5 - inset)),
    ]

    rooms = [
        {
            "id": "room-living",
            "type": "客廳",
            "vertices": [_vec(*p) for p in living_verts],
            "confidence": 0.91,
        },
        {
            "id": "room-bedroom",
            "type": "臥室",
            "vertices": [_vec(*p) for p in bedroom_verts],
            "confidence": 0.89,
        },
    ]

    notes = [
        "後端 mock 回傳（尚未執行 YOLO／OpenCV）。",
        "單位：公尺；座標原點：圖面左下（bottom-left）。",
        f"比例由影像寬度反推 metersPerPixel≈{meters_per_pixel:.5f}（scaleTrusted=false）。",
        f"天花板假設 {CEILING_HEIGHT_M} m；牆厚假設 {WALL_THICKNESS_M} m；窗台假設 {SILL_HEIGHT_M} m。",
        "房間為 mock 兩室（客廳／臥室）；真實分割之後以 YOLO seg 取代。",
    ]

    confidences = [0.92, 0.88, 0.9, 0.86, 0.91, 0.89]
    overall = round(sum(confidences) / len(confidences), 3)

    return {
        "version": 1,
        "kind": "detect-result",
        "meta": {
            "sourceName": source_name or "upload.png",
            "imageWidthPx": image_width_px,
            "imageHeightPx": image_height_px,
            "metersPerPixel": round(meters_per_pixel, 6),
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
        "mock": True,
    }
