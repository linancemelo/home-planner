# 【請審】Detect 品質閘 — 三基線 before/after

**Commit 目標**：main（本機 YOLO/CubiCasa/CV 品質；**勿當部署放行**；**不請求「實圖偵測品質審查通過」**）
**基線圖**（`src/import-plan/fixtures/real-samples/`）：

| # | 檔名 | 風格 |
| --- | --- | --- |
| 1 | `2b69218a-b.jpg` | 行銷配傢彩圖（英文房名；低彩度但近黑筆劃） |
| 2 | `964226aa-b.jpg` | 591 行銷彩圖（邊框／浮水印／底欄） |
| 3 | `bb00b5bf-b.jpg` | 室內設計 CAD／灰階標註圖 |

**疊圖**：`backend/fixtures/qa-overlays/`（`before_*.png`＝3d73553、`after_*.png`＝本變更、`diff_*.png`＝並排）

## Before（f42925e）→ After（本變更）

| image | walls | Σ wall L | doors | windows | rooms | peri 窗 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2b69218a-b.jpg | 21→**26** | ~33→**~53 m** | 5→**3** | 6→**7** | 8→**8** | 0→**0** |
| 964226aa-b.jpg | 16→**24** | ~34→**~40 m** | 5→**4** | 7→**3** | 9→**9** | 0→**0** |
| bb00b5bf-b.jpg | 22→**27** | ~37→**~62 m** | 4→**4** | 7→**5** | 9→**9** | 0→**0** |

（peri 中點補窗仍禁止。窗計數非目標；591 窗略降因貼牆過濾更嚴，CAD 以 CubiCasa＋平行筆劃補回。）

### 本輪改動（已實作）
1. **牆墨跡重建**：厚填＋筆劃雙路徑；行銷先 H/V morph 再 CC 中心線（傢具地毯不易過長核）；CAD mid-gray 填牆＋自適應筆劃；Hough `maxLineGap=40` 橋接門洞；軸向投影補長周界／隔間。
2. **風格判定**：低彩度行銷（如 2b）`near_black≥1.2%` 改走 marketing，避免 mid-gray 傢具填當 CAD 牆。
3. **覆蓋優先**：硬上限 22→**36**；共線合併 gap↑；CAD CubiCasa 近軸牆至多 24；外牆段沿墨跡延伸。
4. **房間**：牆段屏障 raster → ortho clip（壁約束多邊形，非純 AABB）；仍粗，開放廳／重疊未解。
5. **窗**：CAD 目標窗數↑時續跑外牆亮縫／平行筆劃；仍禁 peri。

### 誠實 usable %（疊圖目視，非計數）

| image | 估 usable | 依據 |
| --- | ---: | --- |
| 2b69218a-b.jpg | **~50%** | 牆總長↑明顯；部分內隔間紅線變長；**外周界仍碎／缺**；綠房塊仍偏 AABB／重疊；門略降 |
| 964226aa-b.jpg | **~45%** | 牆段數／總長↑；右長牆較穩；**左／底外周界仍大缺**；窗 7→3（真窗 flush 仍弱）；房塊壁約束有試但仍粗 |
| bb00b5bf-b.jpg | **~50%** | 牆總長 ~37→62 m、外牆延伸 7 條；內隔間覆蓋好於 f42925e；**頂／左／部分周界仍缺**；窗 7→5；綠房仍多 AABB 重疊 |

**三圖皆明顯 <85% overlay-usable。計數／總長 alone 不可當通過。不請求部署／不寫審查通過。**

### 牆覆蓋所得（相對 f42925e）
- **總長**：2b +~20 m、964 +~6 m、bb +~25 m（墨跡中心線＋合併＋外牆延伸）。
- **周界**：仍是最大洞——紅線未形成連續外框；優先級 1 未達手描級。
- **傢具抑制**：行銷 H/V-first 減少地毯偽牆；2b 仍偶有穿越床／健身區短段。

### 剩餘缺口 → 下一輪槓桿
1. **真周界骨架**：footprint 輪廓上的厚墨追蹤／角柱連結；強制外框 H/V 長段。
2. **窗 flush**：外牆 glyph 對齊 ink 缺口；CAD CubiCasa 窗幾何過濾放寬但貼牆。
3. **房間**：L 形 ortho 貼齊牆網；開放廳勿多 AABB。
4. **Fine-tune**：GPU 時對行銷圖 fine-tune FloorCAD YOLO。

### 如何重跑
```bash
cd backend && source .venv/bin/activate
python scripts/regress_detect.py
# 疊圖：fixtures/qa-overlays/after_*-b.png / diff_*-b.png
```
