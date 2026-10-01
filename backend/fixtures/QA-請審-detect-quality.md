# 【請審】Detect 品質閘 — 三基線 before/after

**Commit 目標**：main（本機 YOLO E2E 品質；**勿當部署放行**；**不請求「實圖偵測品質審查通過」**）
**基線圖**（`src/import-plan/fixtures/real-samples/`）：

| # | 檔名 | 風格 |
| --- | --- | --- |
| 1 | `2b69218a-b.jpg` | 行銷配傢彩圖（英文房名） |
| 2 | `964226aa-b.jpg` | 591 行銷彩圖（邊框／浮水印／底欄） |
| 3 | `bb00b5bf-b.jpg` | 室內設計 CAD／灰階標註圖 |

**疊圖**：`backend/fixtures/qa-overlays/`（`before_*.png`＝3cbf570、`after_*.png`＝本變更、`diff_*.png`＝並排）

## Before（3cbf570）→ After（本變更）

| image | walls | doors | windows | rooms | peri 窗 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2b69218a-b.jpg | 20→**14** | 6→**4** | 4→**5** | 8→**5** | 0→**0** |
| 964226aa-b.jpg | 13→**6** | 1→**3** | 0→**0** | 1→**5** | 0→**0** |
| bb00b5bf-b.jpg | 20→**11** | 3→**4** | 2→**1** | 6→**5** | 1→**0** |

（591／CAD 窗僅模型偵測；本輪 **零** `win-peri-*`／缺口啟發式窗。）

### 本輪強制幾何規則（已實作）
1. **垂直標題／側欄裁切**：`_crop_vertical_title_columns` 以 quiet gutter 去掉 CAD 左尺寸欄／右 title block（bb：`x1=1833`，原 2401）。
2. **繪圖 footprint**：奶油底／裝飾外再收斂 ROI；分析前 `_mask_outside_roi`。
3. **禁止啟發式 peri／gap 窗**：僅 YOLO／CubiCasa 模型窗；`_perimeter_windows` 永為 no-op。
4. **結構牆優先**：CAD 用中灰 wall-fill → skeleton＋近軸 Hough；行銷用深色墨跡＋Canny；**略過鋸齒房間邊當牆**（墨跡足夠時）。
5. **房間**：watershed 切大門口頸＋**AABB**（避免傢具鋸齒多邊形）；重疊合併；上限 7。
6. **穿越淨空**：非 ink 牆抽樣深入房間則剔除；ink／skel 牆保留（避免粗 AABB 誤殺真牆）。
7. **連通性**：doorless 小房優先補門，預算≤4。

### 對應 QA 子彈（誠實）

| QA 點 | 結果 |
| --- | --- |
| **CAD 右垂直標題欄吃進幾何** | **改善**：quiet gutter 裁到 x1≈1833；房間／牆不再落在 BH title block。疊圖請看 `diff_bb00b5bf-b.png`。 |
| **禁止 heuristic peri 窗** | **已修**：三基線 peri＝0；bb 由 1 peri→僅 `win-cubi-1`。 |
| **鋸齒房間邊穿越淨空／傢具** | **改善**：不再大量 promote 房間多邊形邊；牆改近軸結構墨跡；AABB 房。仍可能有少數傢具對齊短段。 |
| **591 塌成 1 不合理房間** | **改善**：1→**5** AABB 房（watershed＋footprint）。尚未對齊每間真實臥／衛邊界。 |
| **2b 牆切客廳／餐廳＋doorless** | **改善**：牆 20→14、穿越過濾；access 補門最多 4（本輪 2）。開放廳仍可能被粗 AABB 蓋住。 |
| **開口貼牆** | **維持**：snap／drop 遠距開口。 |

### 如何重跑迴歸
```bash
cd backend && source .venv/bin/activate
export DETECT_MODE=yolo
python scripts/regress_detect.py
# 疊圖：fixtures/qa-overlays/after_*-b.png / diff_*-b.png
```

### 剩餘缺口（誠實 — 未達 ~85% overlay 可用則勿標通過）
- **未宣稱 ~85% 疊圖可用／未請求部署／未寫「實圖偵測品質審查通過」**。
- 591：窗仍 0（模型未見則不發明）；牆偏少且偶有穿越傢具段；房＝粗 AABB。
- CAD：開放廳／餐廳仍可能被單一綠框覆蓋；結構牆覆蓋率仍低於人工線稿。
- 2b：開放區房間切分仍粗；CubiCasa 窗需人工疊圖確認貼牆。
- 未做行銷圖 YOLO fine-tune。
- **疊圖確認 ≠ 合格**；請以計數＋`diff_*.png` 人工抽樣為準。
