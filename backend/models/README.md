# Detect 模型權重

此目錄放置偵測權重（大型檔勿 commit；已於 `.gitignore` 忽略 `*.pt`／`*.safetensors`／`cubicasa/`）。

| 路徑 | 說明 |
| --- | --- |
| `floorplan-rw-seg.pt` | **優先** room/wall/door/window YOLO-seg（`JessiP23/floorplan-seg-v2`；可被 CPU fine-tune 覆寫） |
| `floorplan-seg.pt` | FloorCAD YOLO-seg（CAD 符號：wall／door／window…，**無 room**；後備） |
| `cubicasa/best.safetensors` | CubiCasa5K ResNet34-UNet（**floor／wall／door／window**；floor→房間連通） |
| `yolo11n-seg.pt` | Ultralytics COCO nano seg（非平面圖；後備） |

## 下載

```bash
cd backend
source .venv/bin/activate
pip install -r requirements.txt
python scripts/download_model.py          # RW-seg + FloorCAD + CubiCasa（預設）
python scripts/download_model.py --no-cubicasa
python scripts/download_model.py --no-floorplan --cubicasa
```

## 啟用

```bash
export DETECT_MODE=yolo
# 可選：DETECT_MODEL_PATH、DETECT_CUBICASA_DIR、DETECT_SCALE_M
uvicorn main:app --reload --host 127.0.0.1 --port 8000
# 或倉庫根目錄：./scripts/dev-local.sh
```

管線：RW-YOLO（room/wall/door/window）＋ OpenCV 外周界 ring／flush openings＋ CubiCasa UNet 後備＋連通性。

## 迴歸

```bash
python scripts/regress_detect.py
# 三張 QA 基線：src/import-plan/fixtures/real-samples/*-b.jpg
```

誠實限制：公開權重偏 CAD；行銷 `*-b.jpg` 仍需疊圖確認。自有資料微調可覆寫 `floorplan-seg.pt`。

## Fine-tune（免費 GPU）

見 [`../training/README.md`](../training/README.md)。訓練後：

```bash
python scripts/install_finetuned_weight.py /path/to/best.pt
export DETECT_MODE=yolo
```
