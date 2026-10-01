# 室內裝修設計（Home Planner）

繁體中文（台灣）介面

純前端的室內裝修設計工具：在 2D 平面圖上擺放家具、拆改牆體、測量尺寸，一鍵切換到 Three.js 3D 場景，可鳥瞰或第一人稱漫遊。

> **出處說明**：本專案為獨立重寫，靈感與行為對齊開源 MIT 專案 [wy51ai/floorplan-3d](https://github.com/wy51ai/floorplan-3d)（戶型裝修設計）。不是該倉庫的 fork 轉存；介面與程式識別名稱已重新整理，並改為 React + Vite + TypeScript 模組化結構。保留 MIT 授權與上游致謝。

## Phase 1 功能

**2D 平面佈置**
- 原始戶型 1:60 / 1:100，尺寸單位 mm
- 左側家具庫拖入 60+ 家具家電
- 移動、旋轉（Shift 自由角度）、調整尺寸，貼牆吸附
- 測量工具、拆改非承重牆、圖層開關
- 復原 / 重做，方案自動存於瀏覽器 `localStorage`（鍵名 `home-planner-scheme-v1`）

**3D 場景**
- 鳥瞰 / 漫遊，斜視 / 俯視，點房間列表飛到該房
- 全高牆 / 剖切牆、日照滑桿、夜景燈光
- 與 2D 方案即時同步

**方案與統計**
- 房間面積（m²＋坪）與地面材料選擇
- 匯出 PNG、匯出 / 匯入方案 JSON（與上游 schema 相容）
- 「從平面圖建立」：上傳平面圖 → 牆／門／窗辨識 → 疊圖預覽 → 確認寫入（可「還原範例戶型」）


## Phase 2：從平面圖建立

1. 選單 **檔案 → 從平面圖建立**，選擇 JPG／PNG（嚴格 CAD 標註或行銷／配傢風格皆可試）。
2. 瀏覽器端 canvas 偵測牆／門／窗（**NTS**：圖上印的尺寸不採信；比例由牆厚假設 **0.12 m** 反推；看不清的開口不猜）。
3. 疊圖預覽：原圖＋牆（黑）／門（紅）／窗（藍）／挖洞（灰虛線）。
4. **確認寫入**後以資料驅動的 `PlanBlueprint` 取代範例戶型幾何，清空家具，留在 2D 平面模式繼續擺放。
5. **檔案 → 還原範例戶型**可回到內建三室兩廳。

方案 JSON 匯出／匯入仍只含 `furniture`／`rooms`／`demolished`／`measures`（與上游相容）；戶型幾何另存於 `localStorage` 鍵 `home-planner-blueprint-v1`。

偵測煙測：`npm run test:detect`（使用 `src/import-plan/fixtures`）。

### 本機 Detect 後端（FastAPI mock）

- 目錄：`backend/`（契約見 `backend/openapi.yaml`、`backend/README.md`）。
- `POST /api/v1/detect`：multipart 上傳影像 → **完整**結構化 JSON（牆／門／窗／房間多邊形；公尺、左下原點）。**目前為決定性 mock，尚未 YOLO。**
- 前端：`VITE_DETECT_API_URL`（預設 `http://127.0.0.1:8000`；設 `off` 關閉）。匯入精靈優先呼叫後端，失敗回退啟發式／AI。
- 啟動：`cd backend && source .venv/bin/activate && uvicorn main:app --reload --port 8000`

### AI 輔助辨識（架構先行）


- 路徑：`image → 啟發式 detect →（可選）AiFloorplanProposal → assembleFromAiAndDetect（規則／連通性）→ 疊圖確認`。
- **AI 只出提案**（房間／OCR／門窗候選），**不**輸出最終 `Floorplan` JSON；組裝與拓樸規則在 `src/import-plan/ai/`。
- 未設定金鑰時離線跑啟發式＋規則（UI 徽章「啟發式」）。設定 `VITE_OPENAI_API_KEY` 或 `VITE_GEMINI_API_KEY`（見 `.env.example`）後走 stub 提供者（徽章「AI+規則」）；實際 Vision HTTP 之後再接。
- 組裝／連通性煙測：`npm run test:ai`。

## 快速開始

```bash
npm install
npm run dev
# http://127.0.0.1:43123/home-planner/
```

建置：

```bash
npm run build
npm run preview
```

GitHub Pages `base` 為 `/home-planner/`。

## 快捷鍵

| 按鍵 | 作用 |
| --- | --- |
| `T` | 切換 2D / 3D |
| `V` / `M` / `X` | 選擇 / 測量 / 拆改牆體 |
| `R` / `Shift+R` | 選中家具順時針 / 逆時針旋轉 90° |
| `Delete` / `Backspace` | 刪除選中家具 |
| `Ctrl/⌘ + D` | 複製選中家具 |
| `Ctrl/⌘ + Z`，`Ctrl/⌘ + Shift + Z` | 復原，重做 |
| `F` | 適應視窗 |
| `+` / `-` | 放大 / 縮小 |
| `[` / `]` | 展開 / 收起左右面板 |
| `Shift + F` | 全螢幕 |
| `Esc` | 取消目前操作 |
| 漫遊：`WASD` / 方向鍵，`Shift`，`E` | 移動，快走，開關門 |

## 技術棧

- React 19 + Vite + TypeScript
- 2D：SVG；3D：Three.js r160（npm，非 CDN）
- 方案 JSON schema 與 wy51ai/floorplan-3d 匯出相容（便於 Phase 2 對接）

## 待辦

詳見 [TODO.md](TODO.md)：造價／預算估算、多語系、Phase 2 後續（斜牆／房間分割等）。

## 授權

[MIT](LICENSE) — 含上游 wy51ai/floorplan-3d 致謝。
