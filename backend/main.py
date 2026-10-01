"""Home Planner detect API — mock or YOLO-seg + OpenCV."""

from __future__ import annotations

import os
from typing import Annotated

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from mock_layout import build_mock_detect_response

DETECT_MODE = os.environ.get("DETECT_MODE", "mock").strip().lower() or "mock"
if DETECT_MODE not in ("mock", "yolo"):
    DETECT_MODE = "mock"

app = FastAPI(
    title="Home Planner Detect API",
    version="0.2.0",
    description=(
        "Floor-plan detection. POST /api/v1/detect accepts a multipart image "
        "and returns structured JSON (walls/doors/windows/rooms). "
        "Env DETECT_MODE=mock|yolo (default mock). YOLO uses ultralytics seg + OpenCV; "
        "falls back to mock if the model fails to load."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:43123",
        "http://localhost:43123",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:4173",
        "http://localhost:4173",
        "https://linancemelo.github.io",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


def _effective_mode() -> str:
    return DETECT_MODE


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "mode": _effective_mode()}


def _image_size(data: bytes) -> tuple[int, int]:
    """Read PNG/JPEG dimensions without heavy deps (struct sniff)."""
    if len(data) < 24:
        raise HTTPException(status_code=400, detail="檔案太小，無法讀取影像尺寸")
    # PNG
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        w = int.from_bytes(data[16:20], "big")
        h = int.from_bytes(data[20:24], "big")
        if w > 0 and h > 0:
            return w, h
    # JPEG SOF
    if data[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xC0, 0xC1, 0xC2):
                h = int.from_bytes(data[i + 5 : i + 7], "big")
                w = int.from_bytes(data[i + 7 : i + 9], "big")
                if w > 0 and h > 0:
                    return w, h
            if marker == 0xD9:
                break
            if marker in (0xD8, 0x01) or (0xD0 <= marker <= 0xD7):
                i += 2
                continue
            length = int.from_bytes(data[i + 2 : i + 4], "big")
            i += 2 + length
    # Fallback: assume reasonable size so mock still returns
    return 800, 600


def _run_detect(data: bytes, filename: str) -> dict:
    if DETECT_MODE == "yolo":
        try:
            from yolo_pipeline import run_yolo_detect

            return run_yolo_detect(data, source_name=filename)
        except Exception as e:  # noqa: BLE001
            width, height = _image_size(data)
            payload = build_mock_detect_response(
                source_name=filename,
                image_width_px=width,
                image_height_px=height,
            )
            reason = str(e)
            fallback_notes = [
                f"YOLO 載入／推論失敗，已回退 mock：{reason}",
                "請確認已 pip install -r requirements.txt，並執行 "
                "python scripts/download_model.py 或設置 DETECT_MODEL_PATH。",
            ]
            payload["notes"] = fallback_notes + list(payload.get("notes") or [])
            meta = payload.get("meta") or {}
            meta["notes"] = fallback_notes + list(meta.get("notes") or [])
            payload["meta"] = meta
            payload["mock"] = True
            payload["mode"] = "mock"
            payload["fallbackFromYolo"] = True
            return payload

    width, height = _image_size(data)
    payload = build_mock_detect_response(
        source_name=filename,
        image_width_px=width,
        image_height_px=height,
    )
    payload["mode"] = "mock"
    return payload


@app.post("/api/v1/detect")
async def detect(
    file: Annotated[UploadFile, File(description="Floor-plan image (PNG/JPEG)")],
) -> JSONResponse:
    if not file.content_type or not file.content_type.startswith("image/"):
        # Some clients omit content-type; still accept by extension
        name = (file.filename or "").lower()
        if not any(name.endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".webp", ".gif")):
            if file.content_type and file.content_type not in (
                "application/octet-stream",
                "",
            ):
                raise HTTPException(
                    status_code=415,
                    detail=f"僅接受影像檔，收到 content-type={file.content_type}",
                )

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="空檔案")
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="影像超過 25 MB")

    payload = _run_detect(data, file.filename or "upload.png")
    return JSONResponse(content=payload)


@app.get("/")
def root() -> dict[str, str]:
    return {
        "service": "home-planner-detect",
        "docs": "/docs",
        "health": "/health",
        "detect": "POST /api/v1/detect",
        "mode": _effective_mode(),
    }
