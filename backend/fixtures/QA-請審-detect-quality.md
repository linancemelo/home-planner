# 【請審】Detect 品質閘 — 三基線 before/after

**Commit 目標**：main（本機 YOLO/CubiCasa/CV 品質；**勿當部署放行**；**不請求「實圖偵測品質審查通過」**）
**基線圖**（`src/import-plan/fixtures/real-samples/`）：

| # | 檔名 | 風格 |
| --- | --- | --- |
| 1 | `2b69218a-b.jpg` | 行銷配傢彩圖（英文房名；低彩度但近黑筆劃） |
| 2 | `964226aa-b.jpg` | 591 行銷彩圖（邊框／浮水印／底欄） |
| 3 | `bb00b5bf-b.jpg` | 室內設計 CAD／灰階標註圖 |

**疊圖**：`backend/fixtures/qa-overlays/`（`before_*.png`＝3d73553、`after_*.png`＝本變更、`diff_*.png`＝並排）

## Before（71e87e2）→ After（本變更）

| image | walls | Σ wall L | doors | windows | rooms | peri 窗 | outer ring |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2b69218a-b.jpg | 26→**40** | ~53→**~94 m** | 3→**6** | 7→**8** | 8→**8** | 0→**0** | **閉合**（14 段／~35 m） |
| 964226aa-b.jpg | 24→**22** | ~40→**~42 m** | 4→**4** | 3→**5** | 9→**9** | 0→**0** | **閉合**（7 段／~22 m） |
| bb00b5bf-b.jpg | 27→**25** | ~62→**~51 m** | 4→**4** | 5→**5** | 9→**9** | 0→**0** | **閉合**（13 段／~25 m） |

（peri 中點補窗仍禁止。2b ΣL↑含較多內隔間墨跡段，非純周界；計數 alone 不可當通過。）

### 本輪改動（已實作）
1. **連續外周界 ring**：footprint／墨跡 morph-close → 最大外輪廓 → 頂點向內吸附墨跡 → approxPolyDP（smart ε）→ H/V snap → 端點補角／橋接 → 最大連通分量 → 閉合 ring（`w-ring-*`）。
2. **內隔間**：既有厚填＋筆劃 H/V／Hough／軸向投影保留；與 ring 平行去重（ring 互不塌縮）。
3. **開口 flush**：門／窗投影至 ring／近外牆段。
4. **壁約束房間**：既有 wall-barrier raster clip 保留；ring 重申後再 clip。
5. **保護**：共線合併保留 `w-ring`／`w-ink` 身分；最終截斷永不丟 ring；避免 double-inject。

### 誠實 usable %（疊圖目視，非計數）

| image | 估 usable | 依據 |
| --- | ---: | --- |
| 2b69218a-b.jpg | **~55–60%** | 外周界算法閉合（magenta）；內隔間覆蓋↑；仍有陽台鋸齒／偏移；綠房塊仍偏 AABB；ΣL~94 偏樂觀（傢具偽段風險） |
| 964226aa-b.jpg | **~55–60%** | 外框 7 段閉合、紅線對黑牆重疊明顯好於碎段時代；內隔間仍缺／碎；窗 flush 略好；未達手描級 |
| bb00b5bf-b.jpg | **~50–55%** | ring 閉合（扣孤立 spur 後）；左工作陽台／部分外緣視覺仍偏簡化；內隔間仍碎；CAD 灰牆重疊中等 |

**三圖皆明顯 <85% overlay-usable。算法「閉合」≠ 手描級外框。不請求部署／不寫審查通過。**

### 牆覆蓋所得（相對 71e87e2）
- **周界**：最大洞已補上閉合 ring（三圖 endpoint-closed）；視覺仍有簡化／偏移，非手描。
- **總長**：964／bb 與前輪相近；2b ↑（內隔間＋ring，需目視防傢具偽牆）。
- **開口**：flush 至外周界有記；peri 窗仍 0。

### 剩餘缺口 → 下一輪槓桿
1. Ring 對齊真實厚牆中心線（非 footprint 軟邊）；陽台凹凸更準。
2. 內隔間長脊：門洞橋接後少碎段、少傢具穿越。
3. 房間 L 形 ortho 貼齊牆網；開放廳勿多 AABB。
4. Fine-tune：GPU 時對行銷圖 fine-tune FloorCAD YOLO。

### 如何重跑
```bash
cd backend && source .venv/bin/activate
python scripts/regress_detect.py
# 疊圖：fixtures/qa-overlays/after_*-b.png / diff_*-b.png
```
