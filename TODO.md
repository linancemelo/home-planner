# 待辦（TODO）

Phase 1／2 之後、尚未實作或已自 UI 撤下的項目。

## 造價／預算估算
- 地面材料單價（元／m²）與含損耗造價試算
- 房間／全屋材料成本合計（原右側面板「地面材料估算」）
- 預算／報價匯出（若需要可另接本地幣別，勿再預設人民幣）

## 多語系
- 語言切換器（簡中／英文等）
- 完整 i18n 字串表；目前僅繁體中文（台灣）對外顯示
- 內部仍保留部分 `data-en`／`tr()`／`s2t`  dormant 管線，方便日後接回

## Phase 2 後續（平面圖匯入已上線）
- 接上 OpenAI / Gemini Vision HTTP（金鑰已預留 `VITE_*`；目前為 stub）
- AI 提案與啟發式牆段的更細合併（結構 hint 轉牆、尺度對齊）
- 斜牆／非軸對齊牆的更好近似（目前近水平／垂直約 8° 內吸附，其餘略過）
- 房間自動分割與 OCR 房名標註
- 匯入後互動微調牆／門／窗


## 本機 Detect 後端（FastAPI mock → YOLO）
- [x] API 契約 + FastAPI mock（`backend/`，`POST /api/v1/detect`）
- [ ] 以 YOLO segmentation + OpenCV 取代 mock（牆／門／窗／房間）
- [ ] `opencv-python-headless`、`ultralytics` 等依賴與模型權重版本鎖定
- [ ] 房間自動分割與 OCR 房名標註（後端產出 `rooms[].type`）
- [ ] 匯入後互動微調牆／門／窗

## AWS 雲端部署（延後／TODO）
- [ ] S3：上傳原圖與偵測產物（預簽名 URL）
- [ ] ECR：偵測服務容器映像
- [ ] EC2 或 ECS／Fargate 跑 FastAPI（GPU 實例若跑 YOLO）
- [ ] ALB + ACM：HTTPS 終止、路徑 `/api/v1/*`
- [ ] Secrets Manager／SSM：模型路徑、API 金鑰（勿放 `VITE_*`）
- [ ] GPU quota／spot：訓練與推論配額申請
- [ ] CloudWatch 日誌與告警；費用與流量上限
- [ ] CORS 生產網域與 GitHub Pages 對齊
- [ ] CI：建置映像 → 推 ECR → 滾動更新（勿自動上 gh-pages 除非明確要求）

