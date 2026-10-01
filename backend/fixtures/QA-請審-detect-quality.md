# 【請審】Detect 品質閘 — planar 牆面房間網（CPU 最後槓桿）

**Commit 目標**：main（CPU planar face net；**勿當部署放行**；**不請求「實圖偵測品質審查通過」**）  
**基線圖**（`src/import-plan/fixtures/real-samples/`）：

| # | 檔名 | 風格 |
| --- | --- | --- |
| 1 | `2b69218a-b.jpg` | 行銷配傢彩圖（英文房名） |
| 2 | `964226aa-b.jpg` | 591 行銷彩圖（邊框／浮水印／底欄） |
| 3 | `bb00b5bf-b.jpg` | 室內設計 CAD／灰階標註圖 |

**疊圖**：`backend/fixtures/qa-overlays/`（`before_*.png`＝40802f5、`after_*.png`＝本變更、`diff_*.png`＝並排）  
**BLOCKER**：見 `backend/fixtures/QA-BLOCKER-gpu.md`（需 GPU fine-tune；本輪 &lt;70%）。

## 策略（相對 40802f5 厚牆中心線 ring）

1. **Planar wall-face room net**：牆段（ring＋內隔間）→ snap／延伸至 T 接點 → 門洞橋接（僅 face）→ half-edge 閉合面＋密封 raster faces → 濾外圍無界面／細條。
2. **AABB→face 置換**：重疊處以牆面多邊形取代盒房（防 under-seg 時不整表替換）。
3. **中心線一致性**：延伸保近軸；剔除長斜向偽段；行銷傢具內牆更緊。
4. **開口**：flush 至接點牆／ring（窗 ring-only；禁 peri）。

## After（本變更）計數

| image | walls | doors | windows | rooms | peri 窗 | non-AABB 房 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2b69218a-b.jpg | **27** | **7** | **6** | **9** | **0** | **3** |
| 964226aa-b.jpg | **23** | **5** | **3** | **8** | **0** | **4** |
| bb00b5bf-b.jpg | **30** | **8** | **4** | **9** | **0** | **5** |

### 誠實 usable %（疊圖目視，非計數）

| image | 估 usable | 依據 |
| --- | ---: | --- |
| 2b69218a-b.jpg | **~62–68%** | face 置換部分盒房；開放廳／玄關仍偏；未達多數真 L 房網 |
| 964226aa-b.jpg | **~60–66%** | 非 AABB 增；陽台角／缺房／細條仍在 |
| bb00b5bf-b.jpg | **~60–68%** | CAD 非 AABB 最多（5/9）；開放區與手描仍有落差 |

**三圖皆 &lt;70% overlay-usable → 寫入 QA-BLOCKER-gpu.md；停止宣稱 CPU 續進可達 ~85%。**  
相對 40802f5：**非 AABB 略升（2/2/3→3/4/5）＋接點密封**，**非 step-change**。

### 房間是否多數非 AABB？
**否（全面）**：2b 仍多數 AABB（6/9）；591 約半；CAD 約半＋（5 non-AABB）。未達「多數盒房全面換成牆面網」。

### 如何重跑
```bash
cd backend && source .venv/bin/activate
python scripts/regress_detect.py
python scripts/render_qa_overlays.py
```

主權重：`backend/models/floorplan-rw-seg.pt`。可選 FT 未預設載入。  
**Pause for GPU: YES.**
