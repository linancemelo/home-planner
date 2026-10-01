# Free-GPU fine-tune — floorplan YOLO-seg

**繁中 + English brief.** Train wall / door / window / room segmentation on **Google Colab** or **Kaggle** (free GPU), then copy `best.pt` back to this repo’s backend. No paid always-on cloud required. Budget target ≤200 TWD/mo → stay on free tiers first.

| 項目 | 說明 |
| --- | --- |
| 目標類別 | `room` `wall` `door` `window`（另可有 `stair` `annotation`） |
| 基底權重 | Hugging Face `JessiP23/floorplan-seg-v2`（→ 本機 `models/floorplan-rw-seg.pt`）或 Ultralytics `yolo11s-seg.pt` |
| 主要資料 | CubiCasa5K COCO mirror：`phungpx/cubicassa5k-coco` |
| 授權 | **CC BY-NC 4.0**（非商業／研究用 fine-tune；商用請另審） |
| 輸出 | `runs/segment/.../weights/best.pt` → 安裝為 `backend/models/floorplan-rw-seg.pt` |
| 推論 | `DETECT_MODE=yolo`（可選 `DETECT_MODEL_PATH`） |

---

## 一分鐘上手（非專家）

### A. Google Colab（建議）

1. 開啟 [Google Colab](https://colab.research.google.com/) → **檔案 → 上傳筆記本** → 選本目錄的 `finetune_floorplan_seg.ipynb`。  
   或把整個 `backend/training/` 推上 GitHub 後用：  
   `https://colab.research.google.com/github/<you>/home-planner/blob/main/backend/training/finetune_floorplan_seg.ipynb`
2. **執行階段 → 變更執行階段類型 → T4 GPU**（免費額度；忙碌時改 Kaggle）。
3. 由上到下 **全部執行**。預設：`max_train=800`、`imgsz=640`（VRAM 夠會自動試 896）、約 **30 epochs**。
4. 結束後左側下載 `best.pt`（或跑最後一格打包 zip）。

**預期時間（Colab T4，約略）**

| 設定 | 時間 |
| --- | --- |
| 合成 smoke（驗證流程） | ~3–8 分鐘 |
| CubiCasa 子集 800 圖 × 30 ep，imgsz 640 | ~1.5–3 小時 |
| 子集 + imgsz 896 / 更多 epochs | ~3–6 小時（注意免費斷線） |

### B. Kaggle

1. New Notebook → **GPU T4/P100** → Upload `finetune_floorplan_seg.ipynb`（或 Copy & Edit）。
2. 設定 `PLATFORM = "kaggle"`（筆記本內常數）後 Run All。
3. Output 下載 `best.pt`。

### C. 裝回本機 backend

```bash
cd backend
source .venv/bin/activate   # 若尚未建立：python -m venv .venv && pip install -r requirements.txt
python scripts/install_finetuned_weight.py ~/Downloads/best.pt
# 預設覆寫 models/floorplan-rw-seg.pt（會先備份 .bak）

export DETECT_MODE=yolo
# 若檔名不是預設，再設：
# export DETECT_MODEL_PATH="$(pwd)/models/floorplan-rw-seg.pt"
uvicorn main:app --reload --host 127.0.0.1 --port 8000
# 或倉庫根目錄：./scripts/dev-local.sh

python scripts/regress_detect.py
```

也可用手動複製：

```bash
cp ~/Downloads/best.pt backend/models/floorplan-rw-seg.pt
# 或保留原 RW 權重，另存：
# cp ~/Downloads/best.pt backend/models/floorplan-rw-seg-ft.pt
# export DETECT_MODEL_PATH=.../floorplan-rw-seg-ft.pt
```

---

## English brief

1. Open `finetune_floorplan_seg.ipynb` in **Colab** or **Kaggle**, enable a free **GPU**.
2. Run all cells: installs deps → downloads CubiCasa5K COCO (CC BY-NC) → converts to YOLO-seg → fine-tunes YOLO11s-seg from `JessiP23/floorplan-seg-v2` (or Ultralytics base) at **imgsz ≥ 640** (896 if VRAM allows).
3. Download `best.pt`, then on your machine:  
   `python backend/scripts/install_finetuned_weight.py /path/to/best.pt`
4. Start API with `DETECT_MODE=yolo`. Preferred weight path: `backend/models/floorplan-rw-seg.pt` (or set `DETECT_MODEL_PATH`).

Optional weak labels: notebook can pseudo-label `src/import-plan/fixtures/real-samples/*-b.jpg` if you upload those three images.

If CubiCasa download fails, the notebook falls back to a tiny **synthetic** set so you can still validate the train → export loop (not for quality).

---

## Files

| Path | Role |
| --- | --- |
| `finetune_floorplan_seg.ipynb` | Colab/Kaggle one-click train |
| `prepare_yolo_dataset.py` | CubiCasa → YOLO-seg + weak labels + synthetic fallback |
| `../scripts/install_finetuned_weight.py` | Copy weight + verify `DETECT_MODE=yolo` loads it |
| `../fixtures/QA-BLOCKER-gpu.md` | Why GPU FT is the quality gate |

## License reminder

CubiCasa5K: **CC BY-NC 4.0** (Kalervo et al., SCIA 2019). The HF dataset `phungpx/cubicassa5k-coco` inherits upstream terms. Do **not** use this fine-tune path for commercial products without clearing rights. Ultralytics YOLO is AGPL-3.0 — see Ultralytics license for distribution of derivatives.

## Tips / 斷線與額度

- Colab 閒置會斷線：長訓用「保持活動」或拆成 resume（筆記本有 `RESUME` 開關）。
- 免費 GPU 忙碌時改 Kaggle，或隔日再試；**不要**為此開付費雲端實例（本路徑刻意避開）。
- 行銷圖要明顯變好：務必打開弱標（上傳 `*-b.jpg`）並在 CubiCasa 子集上多跑幾個 epoch。
- 品質閘仍見 `backend/fixtures/QA-BLOCKER-gpu.md`：三張基線 overlay-usable 目標 ~85% 才重開 QA。
