# Data pipeline

Synthetic dataset generator for the UNO Flip card detector. It extracts card
sprites from sprite sheets, downloads background photos, and composites
"hands" of fanned cards into YOLO-format training images + labels.

## Requirements

- Python 3.10+
- `Pillow`, `numpy`

(The data scripts run on the base interpreter — not the training venv, which
has ultralytics/torch.)

## Scripts

### 1. `extract_cards.py` — sprite extraction

Slices the 6×12 sprite sheets into per-card transparent PNGs.

```powershell
python extract_cards.py flip_light_combine.png --side light
python extract_cards.py flip_dark_combine.png  --side dark
```

Output: `cards/light/*.png` (54 cards) and `cards/dark/*.png` (54 cards),
named by class (e.g. `light_blue_7.png`, `dark_pink_flip.png`). Run once.

### 2. `download_backgrounds.py` — backgrounds

```powershell
python download_backgrounds.py 300   # 300 images into background/
```

Falls back to the DTD texture dataset when no Pexels API key is set.

### 3. `compose_hands.py` — generate the dataset

Composites random fanned hands onto backgrounds and writes YOLO labels.

```powershell
# Full dataset (fanned hands, full-card boxes):
python compose_hands.py --count 8000 --full-card

# Append single-card images (individual cards):
python compose_hands.py --count 2000 --min-cards 1 --max-cards 1 --full-card --start-index 8000 --keep-existing
```

Key flags:

| Flag | Default | Meaning |
|---|---|---|
| `--count` | 10 | images to generate |
| `--side` | both | `light`, `dark`, or `both` |
| `--min-cards` / `--max-cards` | 2 / 6 | cards per hand |
| `--min-card-h` / `--max-card-h` | 120 / 720 | card height range (px) |
| `--min-angle` / `--max-angle` | 6 / 17 | fan spread (degrees) |
| `--hand-rot` | 180 | whole-hand rotation (any angle; `0` disables) |
| `--warp` | 0.0 | perspective distortion (fraction of card size) |
| `--full-card` | off | annotate the whole card (one box/card) instead of the top-left corner |
| `--corner-w/h/x/y` | 0.30/0.20/0.06/0.05 | corner box geometry (when not `--full-card`) |
| `--val-frac` | 0.1 | validation split |
| `--workers` | all cores | parallel processes |
| `--seed` | none | reproducible split |
| `--draw` | off | also write debug images with boxes to `hands/debug/` |
| `--start-index` | 0 | filename offset (for appending) |
| `--keep-existing` | off | don't clear output dirs (append mode) |

Output: `hands/images/{train,val}/*.png` + `hands/labels/{train,val}/*.txt`,
plus `data.yaml` and `classes.txt` (18 type-only classes).

### 4. `preview_dataset.py` — visual check

Draws the YOLO boxes over existing dataset images.

```powershell
python preview_dataset.py --split train --count 10
```

Output: `hands/preview/<split>/`.

### 5. `sweep_scale.py` — inference scale sweep

Runs the trained model over one photo at multiple scales (diagnostic).

```powershell
python sweep_scale.py path/to/photo.jpg
```

## Classes (color-agnostic, order matters)

`wild_color, wild_draw_two, 1, 2, 3, 4, 5, 6, 7, 8, 9, flip, draw_one, skip,
reverse, wild_draw_until, draw_five, skip_all`

This order is baked into `classes.txt` and the frontend's `CLASS_NAMES`.
