# 【請審】Detect 品質閘 — 三基線 before/after

**Commit 目標**：main（本機 YOLO E2E 品質；勿當部署放行）
**基線圖**（`src/import-plan/fixtures/real-samples/`）：

| # | 檔名 | 風格 |
| --- | --- | --- |
| 1 | `2b69218a-b.jpg` | 行銷配傢彩圖（英文房名） |
| 2 | `964226aa-b.jpg` | 591 行銷彩圖（邊框／浮水印／底欄）— **本輪硬失敗優先** |
| 3 | `bb00b5bf-b.jpg` | 室內設計 CAD／灰階標註圖 |

同目錄另有 `furnished-en.jpg`、`interior-design-cad.jpg`、`marketing-591.jpg`（非本次三基線）。

## Before（e1fa320）→ After（本變更）

| image | walls | doors | windows | rooms |
| --- | ---: | ---: | ---: | ---: |
| 2b69218a-b.jpg | 32→**20** | 7→**6** | 5→**4** | 7→**8** |
| 964226aa-b.jpg | 15→**13** | 2→**1** | 4→**0** | 2→**1** |
| bb00b5bf-b.jpg | 32→**20** | 6→**3** | 3→**2** | 6→**6** |

### 本輪強制幾何規則（已實作）
1. **分析前裁切繪圖區**：`_detect_content_roi` 去掉白邊、高彩度行銷色條／底欄、再以 Canny busy 收斂至室內平面圖繪圖；`_mask_outside_roi` 在 YOLO／CubiCasa／OpenCV **之前**把標題／頁眉／橫幅／chrome 塗白。591 尤關鍵。
2. **開口必須貼牆**：中點距最近牆 >0.45 m（門）／>0.55 m（窗）先嘗試 snap≤0.85–0.95 m，否則剔除。
3. **禁止 peri window spam**：僅當已有 YOLO／CubiCasa 真實窗時才允許少量外牆補窗；零真實開口 → 不發明一圈 peri。
4. **房間／牆不吃 chrome**：細長底欄／邊框 blob 剔除；ROI 外牆段剔除。
5. **牆不穿越淨空**：抽樣點深入某房且不靠近任何房界 → 偽牆剔除（嵌套房間邊保留）。
6. **寧少勿濫**：硬上限 **20**（原 32）；截斷優先房間邊／合併牆，骨架／碎牆靠後；行銷高彩度略過 CAD 骨架 Hough。

### 對應 QA 子彈（誠實）

| QA 點 | 結果 |
| --- | --- |
| **591 HARD**：牆／房貼邊框與底部行銷橫幅 | **已修**：底欄 ROI 裁掉；banner 細長房不再出現；房間 y 起於繪圖區內。外框仍可能偏貼繪圖外牆（行銷圖本質限制）。 |
| **591**：4 扇 peri 窗全是啟發式 | **已修**：`windows=0`（無真實窗偵測就不補 peri）。 |
| **591**：開口遠離牆 | **已修**：遠距 CubiCasa 門剔除／snap；剩餘門 dist≈0.23 m。 |
| **2b**：硬上限 32 | **已修**：截斷至 **20**，優先房間邊。 |
| **2b**：牆切過開放區 | **改善**：穿越淨空過濾；抽樣 leftover≠cut。傢具噪仍可能殘留短段。 |
| **2b**：窗 mid→牆 0.6–1 m／過寬開口 | **已修**：snap／drop；長度門檻收緊。 |
| **2b**：多門為 access patch | **改善**：外框大房略過；補門預算≤2（仍可能有 1–2 個 access）。 |
| **bb**：cap 32、peri、CubiCasa 門過窄、connectivity patch | **改善**：cap 20；peri 僅 1（有 cubi 窗才補）；門寬≥0.6 m；access≤2。 |

### 如何重跑迴歸
```bash
cd backend && source .venv/bin/activate
export DETECT_MODE=yolo
python scripts/regress_detect.py
# 可選：python scripts/regress_detect.py --before /path/to/before.json --json /tmp/after.json
```

### 剩餘缺口（誠實）
- 未做自有行銷圖 YOLO fine-tune（本輪明確 optional／略過）。
- 591 行銷圖房間常併成 1 個大 free-space blob；窗若模型沒看到就維持 0（優於 peri spam）。
- CAD 灰階圖骨架牆仍可能補到上限附近；已優先房間邊並過濾穿越。
- 浮水印文字仍在繪圖區內，無法靠 ROI 去掉。
- **疊圖確認 ≠ 合格**；請以計數＋人工抽樣為準。本輪**不請求部署**。
