# Detect 模型權重

此目錄放置 YOLO-seg 權重（勿將大型 `.pt` commit 進 git，已於 `.gitignore` 忽略）。

| 檔名 | 說明 |
| --- | --- |
| `floorplan-seg.pt` | （建議）平面圖相關權重。`download_model.py` 預設從 Hugging Face `mudasir13cs/floorcad-yolov8n-seg` 複製至此（CAD 符號：wall/door/window…，非 room） |
| `yolo11n-seg.pt` / `yolov8n-seg.pt` | Ultralytics 預訓練 nano seg（COCO；**非**平面圖） |

## 下載

```bash
cd backend
source .venv/bin/activate
pip install -r requirements.txt
python scripts/download_model.py
# 僅 COCO：python scripts/download_model.py --no-floorplan
```

## 啟用 YOLO

```bash
export DETECT_MODE=yolo
# 可選：export DETECT_MODEL_PATH=/abs/path/to/weights.pt
# 可選：export DETECT_SCALE_M=10
uvicorn main:app --reload --host 127.0.0.1 --port 8000
# 或倉庫根目錄：./scripts/dev-local.sh
```

無專用微調時：YOLO 框／遮罩 + OpenCV 幾何後處理；結果請疊圖確認。
