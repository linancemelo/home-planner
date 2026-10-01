# 【請審】Detect 品質閘 — 厚牆中心線 ring＋牆圖非 AABB 房

**Commit 目標**：main（CPU 幾何槓桿；**勿當部署放行**；**不請求「實圖偵測品質審查通過」**）  
**基線圖**（`src/import-plan/fixtures/real-samples/`）：

| # | 檔名 | 風格 |
| --- | --- | --- |
| 1 | `2b69218a-b.jpg` | 行銷配傢彩圖（英文房名） |
| 2 | `964226aa-b.jpg` | 591 行銷彩圖（邊框／浮水印／底欄） |
| 3 | `bb00b5bf-b.jpg` | 室內設計 CAD／灰階標註圖 |

**疊圖**：`backend/fixtures/qa-overlays/`（`before_*.png`＝85f5836、`after_*.png`＝本變更、`diff_*.png`＝並排）

## 策略（相對 85f5836 RW-YOLO）

GPU fine-tune **blocked**。本輪僅 CPU：

1. **Ring → 厚牆中心線**：距離變換 medial ridge＋skeleton；外輪廓頂點 snap 至 medial（非薄鋸齒外緣）；H/V 長段閉合 ring。
2. **非 AABB／L 形房**：牆圖屏障 planar faces → ortho polygon（放寬 fill／verts）；YOLO AABB 以牆屏障 clip；barrier 房優先條件放寬。
3. **權重**：主權重維持 `floorplan-rw-seg.pt`（JessiP23）＋ CubiCasa companion；**不晉升** `floorplan-rw-seg-ft.pt`（過擬合）。
4. **開口**：門／窗 flush 至中心線 ring（窗 ring-only；禁 peri）。

## After（本變更）計數

| image | walls | doors | windows | rooms | peri 窗 | non-AABB 房 | ring |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2b69218a-b.jpg | **25** | **7** | **5** | **9** | **0** | **2** | 閉合／中心線 |
| 964226aa-b.jpg | **17** | **7** | **3** | **8** | **0** | **2** | 閉合／中心線 |
| bb00b5bf-b.jpg | **24** | **9** | **4** | **9** | **0** | **3** | 閉合／中心線 |

（窗 wallId 多在 `w-ring-*`；medial 內隔間有上限以免 CAD ΣL 膨脹。）

### 誠實 usable %（疊圖目視，非計數）

| image | 估 usable | 依據 |
| --- | ---: | --- |
| 2b69218a-b.jpg | **~62–68%** | ring 貼厚牆中心線、開口 flush；綠房仍多 AABB，僅少數 L／多邊；重疊／對角外牆未完全吃進房界 |
| 964226aa-b.jpg | **~60–66%** | chrome 已濾；臥／衛分開；開放廳仍偏盒；左斜牆 ring 有跟、房塊未貼齊 |
| bb00b5bf-b.jpg | **~58–65%** | CAD ring 中心線＋部分非 AABB；左陽台鋸齒殘；房塊仍偏盒／未手描 |

**三圖皆 <85% overlay-usable。不請求部署／不寫審查通過。**  
相對 85f5836：**幾何對齊略升（ring 中心線＋少數牆圖 L 房）**，**未達 step-change**。

### 房間是否 non-AABB？
**部分是**：每圖約 2–3 房為 ≥6 頂點 ortho／L 形（牆圖 clip）；**多數房仍為 AABB**（YOLO 遮罩矩形＋臥衛本身近矩形）。非全面 planar-subdivision 房網。

### 剩餘缺口 → 下一槓桿
1. **GPU fine-tune**（仍 blocked）：CubiCasa5k／行銷弱標、imgsz≥896。
2. 牆圖全面 face 房間（勿只 clip AABB）；開放廳真 L 形。
3. CAD 陽台凹凸／斜牆房間頂點跟 ring。
4. 內隔間門洞橋接後少碎段。

### 如何重跑
```bash
cd backend && source .venv/bin/activate
python scripts/regress_detect.py
# 疊圖：fixtures/qa-overlays/after_*-b.png / diff_*-b.png
```

主權重：`backend/models/floorplan-rw-seg.pt`（= HF `JessiP23/floorplan-seg-v2`）。  
可選 FT：`floorplan-rw-seg-ft.pt`（**未預設載入**）。
