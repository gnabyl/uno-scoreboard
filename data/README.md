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

Composites random card arrangements onto backgrounds and writes OBB labels.
One run produces the whole dataset: 80% fanned hands + 20% lone cards, split
into train and val, with val kept on background photos training never sees.

```powershell
# 10,000 images -> 9,000 train / 1,000 val
python compose_hands.py --count 10000 --val-frac 0.1 --warp 25 --workers 4

# Append 10,000 more (existing files are kept, numbering starts at 20000)
python compose_hands.py --count 10000 --val-frac 0.1 --warp 25 --start-index 20000
```

The five knobs worth touching:

| Flag | Default | Meaning |
|---|---|---|
| `--count` | 10 | total images (train + val) |
| `--val-frac` | 0.1 | share written to val (train gets the rest) |
| `--workers` | all cores | parallel processes |
| `--start-index` | none | append mode: first file number; existing files are kept |
| `--warp` | 0.0 | max camera tilt of the whole hand, in degrees |

Everything else has a working default:

| Flag | Default | Meaning |
|---|---|---|
| `--side` | both | `light`, `dark`, or `both` |
| `--min-cards` / `--max-cards` | 2 / 6 | cards per fanned hand (20% of a run is lone cards) |
| `--min-card-h` / `--max-card-h` | 120 / 720 | card height range (px) |
| `--min-angle` / `--max-angle` | 30 / 60 | fan spread (degrees) |
| `--hand-rot` | 180 | whole-hand rotation (any angle; `0` disables) |
| `--seed` | none | reproducible split |
| `--draw` | off | also write debug images with label polygons to `hands/debug/` |

Cards always stay fully inside the frame: a hand that fans past an edge is
nudged back into view, and a hand too large for the canvas is scaled down
slightly. Any card that would be sliced by the border is avoided so each label
is an exact, uncut full-card quad.

Perspective warping applies to the whole hand, not to each card: every card
goes through the same homography, as if the camera looked at the table from an
angle. Per-card warps gave each card its own vanishing point, so neighbours
crossed at angles that cannot happen on a flat table.

`--warp` is the largest tilt in degrees; each image draws a tilt from 0 to that
value, at a random azimuth. `25` is a realistic phone angle: cards keep their
true proportions (median aspect 0.64) and keystone slightly (skew median 0.07,
max 0.31), while the hand as a whole foreshortens the way a camera does. `35`
is the aggressive option. The hand is re-fitted into the frame after the tilt,
so cards remain uncut.

### Lighting

Every image is lit as if a real source - a lamp, a window, a phone flash - sat
near the hand. The pass is not a flat brightness/contrast jitter: a point light
brightens one side of the hand and falls off across the table, a warm or cool
direct colour is balanced against a complementary ambient fill, and the whole
frame picks up a soft specular reflection (a broad sheen plus a tighter hot
core) where the light mirrors off the scene - strong on the glossy plastic
cards, faint on the table. The highlight is streaked at a random angle and
size, so a run contains window bands, lamp blobs and tighter flash hotspots.
No card moves, so the labels stay exact.

### Camera blur

About one frame in five gets a little lens softness: a small Gaussian blur
(0.6-1.8 px, as if autofocus just missed) and, on a quarter of those, a short
directional smear from handheld shake. The other four in five stay sharp. The
blur is deliberately mild so the cards stay readable and the labels remain
meaningful; it is there to teach the model to cope with a soft photo, not to
hide the cards.

### Validation split

`--val-frac` is the share of each run that goes to val. Val images are
composited only on background photos held out for them (10% of the photos,
picked by a fixed seed), so val measures a hand on a surface training never saw
instead of a reshuffle of a training scene.

- The holdout is automatic and stable: every run reserves the same slice, so
  appending more images never leaks a val surface into train.
- `--val-frac 0` writes everything to train.
- Without `--start-index` a run clears the output dirs first. With it, existing
  files are kept and new ones are numbered from that index; the run refuses to
  start if the index would overwrite an existing image.

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
