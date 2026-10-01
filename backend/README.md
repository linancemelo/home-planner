# Home Planner — Detect Backend

本機 FastAPI 偵測管線。`POST /api/v1/detect` 回傳結構化戶型 JSON（牆／門／窗／房間多邊形），欄位對齊前端 `Floorplan`（公尺、`coordinateOrigin: bottom-left`）。

## 模式

| `DETECT_MODE` | 行為 |
| --- | --- |
| `mock`（預設） | 決定性樣品兩室布局；`mock: true` |
| `yolo` | ultralytics YOLO-seg + OpenCV 後處理；`mock: false`。載入／推論失敗則回退 mock 並在 `notes` 說明 |

可選：`DETECT_MODEL_PATH=/path/to/weights.pt`（預設尋找 `models/floorplan-seg.pt` → `yolo11n-seg.pt` → `yolov8n-seg.pt`）。

> **誠實限制**：公開倉庫未附平面圖微調權重。預訓練 COCO seg **沒有** room/wall/door/window；此時 YOLO 遮罩僅 best-effort，結構主要靠 OpenCV（連通區域房間 + Hough／多邊形邊牆段 + 缺口門窗啟發式）。要準確請自行微調並放入 `models/floorplan-seg.pt`。

## 契約

- OpenAPI：[`openapi.yaml`](./openapi.yaml)（啟動後也可開 `/docs`）
- JSON Schema：[`schemas/detect-response.schema.json`](./schemas/detect-response.schema.json)
- 範例回應：[`schemas/example-detect-response.json`](./schemas/example-detect-response.json)

### `POST /api/v1/detect`

- Request：`multipart/form-data`，欄位 `file`（PNG／JPEG）
- Response：`DetectResponse`（`kind: "detect-result"`），含 `walls`／`doors`／`windows`／`rooms`、`confidence`、`notes`、`mock`、`mode`

### `GET /health`

`{ "status": "ok", "mode": "mock"|"yolo" }`

## 本機執行

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# mock（預設）
uvicorn main:app --reload --host 127.0.0.1 --port 8000

# YOLO
python scripts/download_model.py
DETECT_MODE=yolo uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

煙測：

```bash
curl -s http://127.0.0.1:8000/health
curl -s -X POST http://127.0.0.1:8000/api/v1/detect \
  -F "file=@fixtures/sample.png;type=image/png" | python -m json.tool | head -40
```

## 前端接線

專案根目錄 `.env.local`（勿 commit）：

```bash
VITE_DETECT_API_URL=http://127.0.0.1:8000
```

- **預設關閉**（unset／空／`off`），避免 Pages 建置對 localhost 空等。
- 啟用後：先 `GET /health`（約 400ms 逾時，後端掛掉即回退），再 `POST`（約 30s 逾時，供 YOLO）；失敗回退啟發式。
- UI 徽章：「後端 YOLO」／「後端 mock」。

CORS 允許：本機 Vite（43123／5173／4173）與 `https://linancemelo.github.io`。

## 之後

- 平面圖微調 seg 權重與類別對齊（見根目錄 `TODO.md`）
- AWS／GPU 部署（同樣見 `TODO.md`）
