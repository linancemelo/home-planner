# 【請審】Detect 品質閘 — 三基線 before/after

**Commit 目標**：main（本機 YOLO/CubiCasa/CV 品質；**勿當部署放行**；**不請求「實圖偵測品質審查通過」**）
**基線圖**（`src/import-plan/fixtures/real-samples/`）：

| # | 檔名 | 風格 |
| --- | --- | --- |
| 1 | `2b69218a-b.jpg` | 行銷配傢彩圖（英文房名） |
| 2 | `964226aa-b.jpg` | 591 行銷彩圖（邊框／浮水印／底欄） |
| 3 | `bb00b5bf-b.jpg` | 室內設計 CAD／灰階標註圖 |

**疊圖**：`backend/fixtures/qa-overlays/`（`before_*.png`＝3d73553、`after_*.png`＝本變更、`diff_*.png`＝並排）

## Before（3d73553）→ After（本變更）

| image | walls | doors | windows | rooms | peri 窗 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2b69218a-b.jpg | 14→**21** | 4→**5** | 5→**6** | 5→**8** | 0→**0** |
| 964226aa-b.jpg | 6→**16** | 3→**5** | 0→**7** | 5→**9** | 0→**0** |
| bb00b5bf-b.jpg | 11→**22** | 4→**4** | 1→**7** | 5→**9** | 0→**0** |

（peri 中點補窗仍禁止；591／CAD 窗主要來自外牆平行筆劃／缺口／CubiCasa，非 peri。）

### 本輪改動（已實作）
1. **平面圖風格**：以**原圖** sat／近黑筆劃判定 `marketing` vs `cad`（修 ROI 白遮罩後 sat 崩潰、誤走 CAD 中灰邏輯抓傢具）。
2. **房間拓撲**：CubiCasa floor＋牆／門屏障＋watershed；`_ortho_polygon_from_mask`；chrome 過濾後才採用 CubiCasa；房間不再落底欄／title block。
3. **結構牆**：行銷厚墨跡優先；CAD 中灰填牆上限改 ~165（先前 <125 切掉真牆）；CubiCasa 長牆至多併 16；硬上限 22。
4. **窗／門**：模型不足時 → 外牆**共線缺口**窗（非 peri）＋外牆**平行筆劃**窗符號；外牆 extent 只用牆段 bbox（避免 CubiCasa 房框膨脹）。
5. **未做** CPU fine-tune（費時／收益不定）；仍以 CV＋既有 CubiCasa／FloorCAD YOLO 為主。

### 誠實 usable %（疊圖目視，非計數）

| image | 估 usable | 依據 |
| --- | ---: | --- |
| 2b69218a-b.jpg | **~45%** | 臥室有分開綠塊；開放廳仍粗／合併；牆覆蓋↑但仍有傢具對齊與穿越；CubiCasa 窗大致貼外牆 |
| 964226aa-b.jpg | **~40%** | 591 窗計數 0→7（平行筆劃）但部分未貼真窗洞；房塊碎且與真臥／廳邊界弱對齊；牆仍切開放廳／對齊傢具 |
| bb00b5bf-b.jpg | **~45%** | ROI 避開 title；牆覆蓋明顯好於 3d73553；開放廳／餐廳仍多 AABB 重疊；窗 7 中平行筆劃需人工確認是否 flush |

**三圖皆明顯 <85% overlay-usable。計數 alone 不可當通過。不請求部署／不寫審查通過。**

### 剩餘缺口 → 下一輪槓桿
1. **真牆覆蓋**：CAD／行銷手描級 ink skeleton（厚填＋筆劃雙路徑合併後再 Hough）；更強傢具抑制（高局部紋理／短段）。
2. **房間多邊形**：以牆段約束 polygon（不只 watershed AABB）；臥室墨牆切開後 ortho 貼齊。
3. **窗 flush**：平行筆劃需再驗證落在「外牆 ink 上的窗符號」；CAD CubiCasa 窗優先於启发式。
4. **Fine-tune**：有 GPU／標註時對行銷圖 fine-tune FloorCAD YOLO（wall/door/window）；CPU 短训不建議當本閘關卡。
5. **開放平面**：客廳／餐廳／書房不要硬切成多 AABB；允許單一 L 形 ortho。

### 如何重跑
```bash
cd backend && source .venv/bin/activate
python scripts/regress_detect.py
# 疊圖：fixtures/qa-overlays/after_*-b.png / diff_*-b.png
```
