# 【請審】Detect 品質閘 — 模型優先（RW-YOLO）

**Commit 目標**：main（RW-seg 模型＋融合；**勿當部署放行**；**不請求「實圖偵測品質審查通過」**）  
**基線圖**（`src/import-plan/fixtures/real-samples/`）：

| # | 檔名 | 風格 |
| --- | --- | --- |
| 1 | `2b69218a-b.jpg` | 行銷配傢彩圖（英文房名） |
| 2 | `964226aa-b.jpg` | 591 行銷彩圖（邊框／浮水印／底欄） |
| 3 | `bb00b5bf-b.jpg` | 室內設計 CAD／灰階標註圖 |

**疊圖**：`backend/fixtures/qa-overlays/`（`before_*.png`＝618d038、`after_*.png`＝本變更、`diff_*.png`＝並排）

## 策略（相對 618d038 啟發式高原）

Heuristics alone plateaued (~55–60%). This round prioritizes **model quality**:

1. **搜尋／下載**優於 FloorCAD 的公開權重 → 採用 **`JessiP23/floorplan-seg-v2`**（YOLO11s-seg；classes=`room/wall/door/window/stair/annotation`；gate mAP50≈0.72）。  
   - FloorCAD（符號 35 類）在三基線上 wall/door/window 幾乎為 0。  
   - CubiCasa YOLO-seg（235 類）三基線 0 dets → 捨棄。  
   - CubiCasa SegFormer-v2 mIoU≈0.12 → 捨棄。  
   - MitUNet（wall-only, ~257MB）已下載至本機 candidates，**未接入**（CPU 重、僅牆）。
2. **CPU fine-tune**：合成 48+8 張＋CubiCasa 弱標三基線，YOLO11s-seg **12 epochs / imgsz=416 / CPU ~85s**。  
   - Val（偏合成）box mAP50≈0.86 / mask≈0.67。  
   - **未晉升為主權重**：上線後房間過碎／CAD mega；保留 `floorplan-rw-seg-ft.pt` 供後續 GPU。  
   - **Blocker**：無 GPU；CPU 僅能短訓＋小圖，不足以單獨把行銷域推到 ~85%。
3. **後處理保留**：外周界 ink ring＋開口 flush 至 ring（禁 peri 窗）。
4. **融合**：RW-YOLO 房間／牆／門／窗優先（footprint 過濾＋近軸牆）；CubiCasa UNet／OpenCV 後備。

## After（本變更）計數

| image | walls | doors | windows | rooms | peri 窗 | room 來源 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 2b69218a-b.jpg | **25** | **7** | **5** | **9** | **0** | RW-YOLO |
| 964226aa-b.jpg | **17** | **8** | **3** | **7** | **0** | RW-YOLO |
| bb00b5bf-b.jpg | **22** | **9** | **5** | **9** | **0** | RW-YOLO |

（相對 618d038：開口更多來自 `d-yolo-*`／`win-yolo-*`；房間改 RW 遮罩 AABB；ring 仍閉合。）

### 誠實 usable %（疊圖目視，非計數）

| image | 估 usable | 依據 |
| --- | ---: | --- |
| 2b69218a-b.jpg | **~62–68%** | RW 房塊對齊多數臥／衛／廚；客廳常缺綠框；牆仍 ring+ink 混雜、略歪 |
| 964226aa-b.jpg | **~60–65%** | chrome 房已濾；臥／衛分開；開放廳覆蓋不足；內隔間偏少 |
| bb00b5bf-b.jpg | **~55–62%** | 主臥／客／書有框；餐／廚／衛不穩；ring／內牆仍非手描 |

**三圖皆 <85% overlay-usable。不請求部署／不寫審查通過。**  
整體相對 618d038：**約 +5–10pt**（模型開口＋房塊），**未達 step-change 到 85%**。

### 剩餘缺口 → 下一槓桿
1. **GPU fine-tune**：公開 CubiCasa5k／FloorPlanCAD 子集＋更多行銷圖弱標；imgsz≥896、YOLO11s/m。  
2. Ring 對齊厚牆中心線；禁止對角偽牆殘留。  
3. 開放廳／L 形房：勿只靠 AABB；用牆屏障 clip。  
4. 可選接入 MitUNet wall prior（需授權／CPU 成本評估）。

### 如何重跑
```bash
cd backend && source .venv/bin/activate
python scripts/download_model.py   # RW-seg + FloorCAD + CubiCasa
python scripts/regress_detect.py
# 疊圖：fixtures/qa-overlays/after_*-b.png / diff_*-b.png
```

主權重：`backend/models/floorplan-rw-seg.pt`（= HF `JessiP23/floorplan-seg-v2`）。  
可選 FT 產物：`floorplan-rw-seg-ft.pt`（未預設載入）。
