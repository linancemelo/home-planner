# 【請審】Detect 品質閘 — 三基線 before/after

**Commit 目標**：main（本機 YOLO/CubiCasa/CV 品質；**勿當部署放行**；**不請求「實圖偵測品質審查通過」**）
**基線圖**（`src/import-plan/fixtures/real-samples/`）：

| # | 檔名 | 風格 |
| --- | --- | --- |
| 1 | `2b69218a-b.jpg` | 行銷配傢彩圖（英文房名；低彩度但近黑筆劃） |
| 2 | `964226aa-b.jpg` | 591 行銷彩圖（邊框／浮水印／底欄） |
| 3 | `bb00b5bf-b.jpg` | 室內設計 CAD／灰階標註圖 |

**疊圖**：`backend/fixtures/qa-overlays/`（`before_*.png`＝eab4cd9、`after_*.png`＝本變更、`diff_*.png`＝並排）

## Before（eab4cd9）→ After（本變更）

| image | walls | Σ wall L | doors | windows | rooms | peri 窗 | outer ring |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2b69218a-b.jpg | 40→**27** | ~94→**~76 m** | 6→**7** | 8→**5** | 8→**8** | 0→**0** | **閉合**（13 段／~35 m） |
| 964226aa-b.jpg | 22→**14** | ~42→**~37 m** | 4→**5** | 5→**4** | 9→**8** | 0→**0** | **閉合**（6 段／~22 m） |
| bb00b5bf-b.jpg | 25→**21** | ~51→**~59 m** | 4→**4** | 5→**5** | 9→**9** | 0→**0** | **閉合**（9 段／~24 m） |

（peri 中點補窗仍禁止。窗 flush 僅投影至 `w-ring-*`；2b ΣL↓壓傢具偽段，ring 長度維持。）

### 本輪改動（QA step 2→3）
1. **傢具風險 ΣL**：行銷圖剔除短＋深內部墨跡偽牆；內牆 ΣL 軟上限 ~42 m；厚填 mat 更嚴；保留真外周界 ring。
2. **開口 flush**：門可 flush 近外牆；**窗僅 flush 至 ring**（禁貼內隔間／假 peri）；丟棄零長開口。
3. **細房**：丟掉已含小房的開放廳 mega AABB；以穿越牆切開剩餘大 AABB；牆屏障自由格／ortho clip（防膨脹／過縮）。

### 誠實 usable %（疊圖目視，非計數）

| image | 估 usable | 依據 |
| --- | ---: | --- |
| 2b69218a-b.jpg | **~55–60%** | ring 閉合維持；ΣL 94→76（傢具偽段↓）；窗全在 ring；綠房不再 30m² mega，但仍有鋸齒／未完全貼齊臥衛牆 |
| 964226aa-b.jpg | **~55–60%** | 丟掉開放廳 mega 後臥／衛分開；窗 flush ring；內隔間仍偏少／略偏；未達手描 |
| bb00b5bf-b.jpg | **~50–55%** | ring 閉合、窗在 ring；房塊偏小／碎；CAD 灰牆覆蓋中等；ΣL 略升 |

**三圖皆明顯 <85% overlay-usable。不請求部署／不寫審查通過。**

### 相對 eab4cd9
- **ΣL**：2b 傢具膨脹明顯下降（ring 35 m 不變）；964 略降；bb 略升（內隔間保留較多）。
- **開口**：窗 wallId 皆 ring；peri＝0。
- **房間**：2b／964 無 ≥20 m² mega AABB；仍非手描房界。

### 剩餘缺口 → 下一輪槓桿
1. Ring 對齊真實厚牆中心線；陽台凹凸。
2. 內隔間門洞橋接後少碎段。
3. CAD 房塊勿過縮；L 形 ortho 貼牆網。
4. Fine-tune：GPU 時行銷圖 FloorCAD YOLO。

### 如何重跑
```bash
cd backend && source .venv/bin/activate
python scripts/regress_detect.py
# 疊圖：fixtures/qa-overlays/after_*-b.png / diff_*-b.png
```
