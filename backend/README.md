# Home Planner — Detect Backend（mock）

本目錄是本機 FastAPI 偵測管線 stub。**尚未接 YOLO／OpenCV**；`POST /api/v1/detect` 回傳決定性 mock 戶型 JSON（牆／門／窗／房間多邊形），欄位對齊前端 `Floorplan`（公尺、`coordinateOrigin: bottom-left`）並多帶 `rooms[]`。

## 契約

- OpenAPI：[`openapi.yaml`](./openapi.yaml)（也可啟動後開 `/docs`）
- JSON Schema：[`schemas/detect-response.schema.json`](./schemas/detect-response.schema.json)
- 範例回應：[`schemas/example-detect-response.json`](./schemas/example-detect-response.json)

### `POST /api/v1/detect`

- Request：`multipart/form-data`，欄位 `file`（PNG／JPEG）
- Response：`DetectResponse`（`kind: "detect-result"`），含：
  - `meta`（`metersPerPixel`、`scaleTrusted: false`、`units: meters`、影像尺寸…）
  - `walls` / `doors` / `windows`（與 `src/import-plan/floorplan.ts` 同形）
  - `rooms[]`：`{ id, type, vertices[], confidence? }`（`type` 如「客廳」）
  - `confidence`、`notes`、`mock: true`

### `GET /health`

`{ "status": "ok", "mode": "mock" }`

## 本機執行

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

煙測：

```bash
curl -s http://127.0.0.1:8000/health
curl -s -X POST http://127.0.0.1:8000/api/v1/detect \
  -F "file=@fixtures/sample.png;type=image/png" | head -c 400
```

## 前端接線

在專案根目錄 `.env.local`（勿 commit 金鑰）：

```bash
VITE_DETECT_API_URL=http://127.0.0.1:8000
```

- 預設即 `http://127.0.0.1:8000`；設成空字串或 `off` 可關閉後端路徑。
- 匯入精靈會先嘗試後端；失敗則回退啟發式（＋可選 AI 提案）。
- UI 徽章：「後端 mock」／「啟發式」／「AI+規則」。

CORS 允許：本機 Vite（43123／5173／4173）與 `https://linancemelo.github.io`。

## 之後（尚未實作）

- YOLO segmentation + OpenCV 幾何後處理（見根目錄 `TODO.md` AWS／GPU 部署項）
- `opencv-python-headless`、`ultralytics` 等依賴之後再加入 `requirements.txt`
