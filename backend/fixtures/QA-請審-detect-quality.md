# 【請審】Detect 品質閘 — 三基線 before/after

**Commit 目標**：main（本機 YOLO E2E 品質；勿當部署放行）
**基線圖**（`src/import-plan/fixtures/real-samples/`）：

| # | 檔名 | 風格 |
| --- | --- | --- |
| 1 | `2b69218a-b.jpg` | 行銷配傢彩圖（英文房名） |
| 2 | `964226aa-b.jpg` | 591 行銷彩圖（邊框／浮水印） |
| 3 | `bb00b5bf-b.jpg` | 室內設計 CAD／灰階標註圖 |

同目錄另有 `furnished-en.jpg`、`interior-design-cad.jpg`、`marketing-591.jpg`（非本次三基線）。

## Before（740585a 管線）→ After（本變更）

| image | walls | doors | windows | rooms |
| --- | ---: | ---: | ---: | ---: |
| 2b69218a-b.jpg | 64→**32** | 5→**7** | 0→**5** | 7→7 |
| 964226aa-b.jpg | 63→**15** | 2→2 | 0→**4** | 2→2 |
| bb00b5bf-b.jpg | 62→**32** | 3→**6** | 2→**3** | 6→6 |

### 改善摘要
- **偽牆減少**：房間多邊形邊為主牆；略過行銷圖骨架 Hough；CubiCasa 過碎牆捨棄；硬上限 32。
- **門／窗不再卡 0**：CubiCasa 開口幾何過濾＋缺口（門 0.55–1.25 m／窗 0.9–2.6 m）＋外牆啟發式窗＋連通性補門。
- **模型**：保留 FloorCAD `floorplan-seg.pt`；新增 CubiCasa UNet `models/cubicasa/best.safetensors`（floor/wall/door/window）。

### 如何重跑迴歸
```bash
cd backend && source .venv/bin/activate
export DETECT_MODE=yolo
python scripts/regress_detect.py
# 可選：python scripts/regress_detect.py --before /path/to/before.json --json /tmp/after.json
```

### 剩餘缺口（誠實）
- 未做自有行銷圖 YOLO fine-tune（CPU 本機過重）；房間 `type` 仍無 OCR。
- 外牆窗啟發式可能多估；CAD 灰階圖牆仍偏碎（截斷 32）。
- CubiCasa 對行銷彩圖牆 mask 易噪，僅採用過濾後開口。
- **疊圖確認 ≠ 合格**；請以計數＋人工抽樣為準。
