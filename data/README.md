# Data pipeline

Synthetic dataset generator for the UNO Flip card detector. It extracts card
sprites from sprite sheets, downloads background photos, and composites
"hands" of fanned cards into training images + Ultralytics OBB labels.

## Requirements

- Python 3.10+
- `Pillow`, `numpy`

(The data scripts run on the base interpreter - not the training venv, which
has ultralytics/torch.)

## Scripts

### 1. `extract_cards.py` - sprite extraction

Slices the 6×12 sprite sheets into per-card transparent PNGs.

```powershell
python extract_cards.py flip_light_combine.png --side light
python extract_cards.py flip_dark_combine.png  --side dark
```

Output: `cards/light/*.png` (54 cards) and `cards/dark/*.png` (54 cards),
named by class (e.g. `light_blue_7.png`, `dark_pink_flip.png`). Run once.

### 2. `download_backgrounds.py` - backgrounds

```powershell
python download_backgrounds.py 300   # 300 images into background/
```

Falls back to the DTD texture dataset when no Pexels API key is set.

### 3. `compose_hands.py` - generate the dataset

Composites random fanned hands onto backgrounds and writes OBB labels.

```powershell
# Fanned hands:
python compose_hands.py --count 8000

# Append single-card images (individual cards):
python compose_hands.py --count 2000 --min-cards 1 --max-cards 1 --start-index 8000 --keep-existing
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
| `--val-frac` | 0.1 | validation split |
| `--val-bg-frac` | 0.1 | background photos reserved for val only |
| `--workers` | all cores | parallel processes |
| `--seed` | none | reproducible split |
| `--draw` | off | also write debug images with label polygons to `hands/debug/` |
| `--start-index` | 0 | filename offset (for appending) |
| `--keep-existing` | off | don't clear output dirs (append mode) |

Cards always stay fully inside the frame: a hand that fans past an edge is
nudged back into view, and a hand too large for the canvas is scaled down
slightly. Any card that would be sliced by the border is avoided so each label
is an exact, uncut full-card quad.

### Validation split

`--val-frac` picks which images are val, and `--val-bg-frac` reserves a slice
of the background photos that **only val images may use**. Without that, every
val surface also appears in training (1000 photos over 8000 images), so val
only measures how well the model fit the synthetic scenes.

- The held-out slice is chosen with a fixed seed, so all generation passes
  agree on it. Keep `--val-bg-frac` the same across passes.
- `--val-frac` and `--val-bg-frac` are independent. `--val-frac 0` sends every
  image to train but still reserves the val photos for a later val pass; pass
  `--val-bg-frac 0` if that run should use every photo.
- `--val-bg-frac 0` shares every photo (old behaviour, leaks backgrounds).
- `0.1` leaves 100 of 1000 photos for val; `0.2` gives val more variety.

To keep all images for training, generate val in its own pass:

```powershell
python compose_hands.py --count 8000 --val-frac 0
python compose_hands.py --count 2000 --min-cards 1 --max-cards 1 --start-index 8000 --val-frac 0 --keep-existing
python compose_hands.py --count 800 --start-index 10000 --val-frac 1 --keep-existing
python compose_hands.py --count 200 --min-cards 1 --max-cards 1 --start-index 10800 --val-frac 1 --keep-existing
```

Output: `hands/images/{train,val}/*.png` + `hands/labels/{train,val}/*.txt`,
plus `data.yaml` and `classes.txt` (18 type-only classes).

### Label format

One rotated box per card, in Ultralytics OBB format:

```
class x1 y1 x2 y2 x3 y3 x4 y4
```

- 9 whitespace-separated values per line, coordinates normalized to `[0, 1]`
  by image width/height.
- The four points are the card's corners in order around the card, so they
  trace a (possibly perspective-skewed) quadrilateral.
- Each label covers the whole card and is never cut by the frame: cards that
  would run off an edge are nudged or scaled back into view before compositing.
- These labels are not convertible from the old 5-value
  `class cx cy w h` boxes (the rotation was already lost), so the dataset
  must be regenerated.

Use an OBB model to train on them, e.g. `yolo26n-obb.pt` - the detection
(`yolo26n.pt` / `yolov8n.pt`) loaders expect 5-value labels and will reject
this format.

### 4. `preview_dataset.py` - visual check

Draws the OBB label polygons over existing dataset images.

```powershell
python preview_dataset.py --split train --count 10
```

Output: `hands/preview/<split>/`.

### 5. `sweep_scale.py` - inference scale sweep

Runs the trained model over one photo at multiple scales (diagnostic).

```powershell
python sweep_scale.py path/to/photo.jpg
```

## Classes (color-agnostic, order matters)

`wild_color, wild_draw_two, 1, 2, 3, 4, 5, 6, 7, 8, 9, flip, draw_one, skip,
reverse, wild_draw_until, draw_five, skip_all`

This order is baked into `classes.txt` and the frontend's `CLASS_NAMES`.

### Class mix

Cards are sampled by class with the same odds as a real 108-card UNO Flip deck
(216 faces), then a random sprite design is picked inside that class, so a
class with more artwork does not become more common:

| Class | Deck share | | Class | Deck share |
|---|---|---|---|---|
| 1-9 | 7.4% each | | skip / skip_all | 3.7% each |
| reverse | 7.4% | | draw_one / draw_five | 3.7% each |
| flip | 3.7% | | wild_color | 3.7% |
| | | | wild_draw_two / wild_draw_until | 1.9% each |
