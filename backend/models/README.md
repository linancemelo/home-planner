# Detect 模型權重

此目錄放置 YOLO-seg 權重（勿將大型 `.pt` commit 進 git，已於 `.gitignore` 忽略）。

| 檔名 | 說明 |
| --- | --- |
| `yolo11n-seg.pt` / `yolov8n-seg.pt` | Ultralytics 預訓練 nano seg（COCO；**非**平面圖微調） |
| `floorplan-seg.pt` | （建議）自行微調的平面圖權重，類別含 room/wall/door/window |

## 下載

```bash
cd backend
source .venv/bin/activate
pip install -r requirements.txt
python scripts/download_model.py
# 或：python scripts/download_model.py --name yolov8n-seg.pt
```

## 啟用 YOLO

```bash
export DETECT_MODE=yolo
# 可選：export DETECT_MODEL_PATH=/abs/path/to/floorplan-seg.pt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

無微調權重時管線仍會跑：YOLO 遮罩 best-effort + OpenCV 幾何後處理；結果僅供參考。
