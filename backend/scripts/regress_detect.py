#!/usr/bin/env python3
"""Regression table for YOLO detect on real-samples fixtures.

Prints walls/doors/windows/rooms (+ optional before JSON compare).

Usage (from backend/, venv active, DETECT_MODE implied by direct pipeline call):
  python scripts/regress_detect.py
  python scripts/regress_detect.py --before /tmp/before.json --json /tmp/after.json
  python scripts/regress_detect.py --fixtures ../src/import-plan/fixtures/real-samples
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
DEFAULT_FIXTURES = REPO / "src" / "import-plan" / "fixtures" / "real-samples"


def main() -> int:
    parser = argparse.ArgumentParser(description="Home-planner detect regression table")
    parser.add_argument(
        "--fixtures",
        type=Path,
        default=DEFAULT_FIXTURES,
        help="Directory with *-b.jpg (and other jpg) fixtures",
    )
    parser.add_argument(
        "--glob",
        default="*-b.jpg",
        help="Glob under fixtures (default *-b.jpg = three QA baselines)",
    )
    parser.add_argument("--before", type=Path, default=None, help="Optional before JSON")
    parser.add_argument("--json", type=Path, default=None, help="Write after rows JSON")
    parser.add_argument("--all-jpg", action="store_true", help="Also include other *.jpg")
    args = parser.parse_args()

    sys.path.insert(0, str(ROOT))
    from yolo_pipeline import run_yolo_detect  # noqa: WPS433

    fixtures = Path(args.fixtures)
    if not fixtures.is_dir():
        print(f"fixtures dir missing: {fixtures}", file=sys.stderr)
        return 1

    paths = sorted(fixtures.glob(args.glob))
    if args.all_jpg:
        extra = [p for p in sorted(fixtures.glob("*.jpg")) if p not in paths]
        paths = paths + extra
    if not paths:
        print(f"no images matching {args.glob} in {fixtures}", file=sys.stderr)
        return 1

    before_map: dict[str, dict] = {}
    if args.before and args.before.is_file():
        data = json.loads(args.before.read_text())
        for row in data:
            before_map[row["image"]] = row

    rows: list[dict] = []
    print(
        f"{'image':22} {'walls':>7} {'doors':>7} {'windows':>8} {'rooms':>7} {'conf':>6} {'sec':>6}"
    )
    print("-" * 72)
    for p in paths:
        t0 = time.time()
        result = run_yolo_detect(p.read_bytes(), source_name=p.name)
        dt = time.time() - t0
        row = {
            "image": p.name,
            "walls": len(result["walls"]),
            "doors": len(result["doors"]),
            "windows": len(result["windows"]),
            "rooms": len(result["rooms"]),
            "conf": result.get("confidence"),
            "sec": round(dt, 2),
            "notes_head": (result.get("notes") or [])[:6],
        }
        rows.append(row)
        b = before_map.get(p.name)
        if b:
            def cell(k: str) -> str:
                return f"{b[k]}→{row[k]}"

            print(
                f"{p.name:22} {cell('walls'):>7} {cell('doors'):>7} "
                f"{cell('windows'):>8} {cell('rooms'):>7} {row['conf']!s:>6} {row['sec']:>6}"
            )
        else:
            print(
                f"{p.name:22} {row['walls']:7d} {row['doors']:7d} "
                f"{row['windows']:8d} {row['rooms']:7d} {row['conf']!s:>6} {row['sec']:>6}"
            )

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n")
        print(f"\nwrote {args.json}")

    print("\nQA baselines (*-b.jpg): fewer walls + non-zero windows when openings exist.")
    print("Overlay confirm is NOT a pass — use counts + visual spot-check.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
