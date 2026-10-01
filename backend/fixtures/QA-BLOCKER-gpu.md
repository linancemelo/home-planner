# QA BLOCKER — GPU fine-tune required

**Status (2026-10-02 Asia/Taipei):** CPU geometry plateau. **Do not claim ~85% overlay-usable. Do not deploy. Pause further CPU “step-change” claims.**

## Free-GPU path (ready — no paid cloud)

Use the Colab / Kaggle notebook instead of always-on paid GPU:

| Item | Path |
| --- | --- |
| Guide (ZH+EN) | [`backend/training/README.md`](../training/README.md) |
| Notebook | [`backend/training/finetune_floorplan_seg.ipynb`](../training/finetune_floorplan_seg.ipynb) |
| Dataset helper | [`backend/training/prepare_yolo_dataset.py`](../training/prepare_yolo_dataset.py) |
| Install weight | [`backend/scripts/install_finetuned_weight.py`](../scripts/install_finetuned_weight.py) |

**One session:** open the notebook → enable free T4 → Run All → download `best.pt` →  
`python backend/scripts/install_finetuned_weight.py ~/Downloads/best.pt` → `DETECT_MODE=yolo`.

Data: CubiCasa5K COCO (`phungpx/cubicassa5k-coco`, **CC BY-NC 4.0**) + optional weak labels on `*-b.jpg`. Base: `JessiP23/floorplan-seg-v2`. Target imgsz ≥ 640 (896 if VRAM allows).

## Honest ceiling (this overnight CPU attempt)

| Baseline | Style | Est. overlay-usable | Notes |
| --- | --- | ---: | --- |
| `2b69218a-b.jpg` | Marketing furnished EN | **~62–68%** | Ring + some face replace; majority rooms still AABB; open living/entrance misaligned; occasional diagonal artifacts suppressed but not gone |
| `964226aa-b.jpg` | 591 marketing | **~60–66%** | Beds/baths partially split; balcony/corner ring still wrong; missing/sliver faces; chrome filtered |
| `bb00b5bf-b.jpg` | Interior CAD | **~60–68%** | More non-AABB faces after wall-net; title ROI OK; open plan / balcony still coarse vs hand-traced |

**All three remain &lt;70% overlay-usable.** Relative to `40802f5` (thick medial ring): planar face net + AABB→face replace lifts non-AABB counts (≈2/2/3 → **3/4/5**) and seals some junctions, but **not a step-change** to product-quality overlays.

## What CPU already exhausted

1. Outer thick-wall **medial / centerline ring** + flush openings (no peri windows).
2. Furniture-risk interior suppress on marketing.
3. **Planar wall-face room net** (this commit): extend→T-junctions→door-gap bridges→half-edge + sealed raster faces→filter outer/slivers→AABB→face replace; openings snap to junction walls.
4. Open weights: `floorplan-rw-seg.pt` (JessiP23) + CubiCasa UNet companion. FT checkpoint **not** default (overfit risk).

Open-weight seg + classical CV **cannot** reliably read marketing weak walls, furniture ink, or CAD mid-gray fills at the density needed for ~85% usable room nets.

## Required next lever (GPU — free tier first)

Fine-tune segmentation (and preferably room/wall instance heads) on:

- **CubiCasa5k** (and/or FloorPlanCAD) for CAD-like structure — see `backend/training/`
- **Marketing / 591-style weak labels** (even sparse wall + room masks) for colorful furnished plans
- `imgsz` ≥ 896; keep ring/face post-process as geometry regularizer, not as the primary room source

**Budget:** prefer free Colab/Kaggle (≤200 TWD/mo). Do **not** open paid always-on cloud for this path.

**Target after GPU:** ~85% overlay-usable on the three baselines (human spot-check of `diff_*-b.png`), then re-open QA gate. Until then: **blocker stands**.

## Reproduce (CPU only)

```bash
cd backend && source .venv/bin/activate
python scripts/regress_detect.py
python scripts/render_qa_overlays.py
# fixtures/qa-overlays/after_*-b.png  diff_*-b.png
# fixtures/qa-overlays/qa-measured-detail.json
```

**Pause for GPU:** **YES** — but free Colab/Kaggle path is documented under `backend/training/`.
