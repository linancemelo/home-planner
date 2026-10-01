#!/usr/bin/env bash
# One-command local detect backend (YOLO) for home-planner.
# Frontend: see notes at the end (separate terminal).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/backend"
cd "$BACKEND"

echo "==> home-planner local detect (DETECT_MODE=yolo)"

if [[ ! -d .venv ]]; then
  echo "Creating venv…"
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

echo "Installing deps…"
pip install -q -r requirements.txt

if [[ ! -f models/floorplan-seg.pt && ! -f models/yolo11n-seg.pt && ! -f models/yolov8n-seg.pt ]]; then
  echo "Model weights missing — downloading…"
  python scripts/download_model.py || true
elif [[ ! -f models/floorplan-seg.pt ]]; then
  echo "Optional: python scripts/download_model.py  # FloorCAD floorplan-seg.pt"
fi

export DETECT_MODE="${DETECT_MODE:-yolo}"
# Optional assumed outer layout width in metres (scaleTrusted stays false):
# export DETECT_SCALE_M=10

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"

echo ""
echo "Starting uvicorn  DETECT_MODE=$DETECT_MODE  http://${HOST}:${PORT}"
echo "Docs: http://${HOST}:${PORT}/docs   Health: http://${HOST}:${PORT}/health"
echo ""
echo "── Frontend (other terminal) ─────────────────────────────────"
echo "  cd \"$ROOT\""
echo "  echo 'VITE_DETECT_API_URL=http://127.0.0.1:8000' > .env.local"
echo "  npm install && npm run dev"
echo "  → http://127.0.0.1:43123/home-planner/"
echo "  Import wizard badge should show「後端 YOLO」when health is ok."
echo "──────────────────────────────────────────────────────────────"
echo ""

exec uvicorn main:app --reload --host "$HOST" --port "$PORT"
