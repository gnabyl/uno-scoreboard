#!/usr/bin/env python3
"""Compose random "hands" of UNO Flip cards as fanned spreads.

Each image picks a random number of cards, a random fan spread angle, a random
card height, a random background (real photos when available), per-card
perspective warps, and random lighting (brightness/contrast/color). Cards are
drawn left-to-right so
each subsequent card overlaps the previous one, like a hand of cards. YOLO
labels are written for each card's top-left corner region.

Usage:
    python compose_hands.py --count 100
    python compose_hands.py --count 50 --side dark --min-angle 15 --max-angle 80
"""

import argparse
import math
import os
import random
import re
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from extract_cards import CARD_NAMES  # noqa: E402
LIGHT_DIR = HERE / "cards" / "light"
DARK_DIR = HERE / "cards" / "dark"
BACKGROUND_DIR = HERE / "background"

CANVAS_W, CANVAS_H = 1280, 960

# Card types are color/side agnostic: every color-specific class name maps to
# its pure type (number or action). The card FILES keep their color names.
LIGHT_COLORS = ("yellow", "red", "blue", "green")
DARK_COLORS = ("orange", "pink", "purple", "teal")


def type_of(name):
    """Map a color-specific class name to its pure card type."""
    if name.startswith("light_"):
        rest = name[len("light_"):]
        for c in LIGHT_COLORS:
            if rest.startswith(c + "_"):
                return rest[len(c) + 1:]
        return rest
    if name.startswith("dark_"):
        rest = name[len("dark_"):]
        for c in DARK_COLORS:
            if rest.startswith(c + "_"):
                return rest[len(c) + 1:]
        return rest
    return name


CLASSES = []
for _side in ("light", "dark"):
    for _row in CARD_NAMES.get(_side, []):
        for _name in _row:
            if isinstance(_name, str) and _name:
                _t = type_of(_name)
                if _t not in CLASSES:
                    CLASSES.append(_t)
CLASS_ID = {name: i for i, name in enumerate(CLASSES)}

# Minimum angular gap (degrees) between adjacent cards in a hand. Prevents a
# small spread angle from stacking many cards into what looks like one card.
MIN_SEP_DEG = 10.0

# Upper bound on the total fan spread, so the fan never wraps past a full
# semicircle (large hands with a big per-card gap get clamped to this).
MAX_FAN_SPREAD = 110.0


def load_card_paths(side):
    paths = []
    if side in ("light", "both"):
        paths += sorted(LIGHT_DIR.glob("*.png"))
    if side in ("dark", "both"):
        paths += sorted(DARK_DIR.glob("*.png"))
    if not paths:
        raise SystemExit(
            f"no cards found for side={side!r}; run extract_cards.py first"
        )
    return paths


@lru_cache(maxsize=128)
def load_sprite(path):
    """Return a cached decoded card sprite (RGBA)."""
    return Image.open(path).convert("RGBA")


@lru_cache(maxsize=32)
def load_bg(path):
    """Return a cached decoded background photo (RGB)."""
    return Image.open(path).convert("RGB")


def class_of_path(path):
    """Map a card file to its pure card type (strips the _NN suffix)."""
    stem = re.sub(r"_\d{2}$", "", path.stem)
    t = type_of(stem)
    return t if t in CLASS_ID else None


def _random_color():
    return tuple(random.randint(0, 255) for _ in range(3))


_photo_cache = None


def _photo_paths():
    global _photo_cache
    if _photo_cache is None:
        _photo_cache = [
            p
            for p in BACKGROUND_DIR.glob("*")
            if p.suffix.lower() in (".jpg", ".jpeg", ".png")
        ]
    return _photo_cache


def _cover_crop(img, w, h):
    """Resize a photo to cover the canvas, then take a random crop."""
    iw, ih = img.size
    scale = max(w / iw, h / ih)
    img = img.resize((round(iw * scale), round(ih * scale)), Image.Resampling.BILINEAR)
    x = random.randint(0, img.width - w)
    y = random.randint(0, img.height - h)
    return img.crop((x, y, x + w, y + h))


def make_background():
    """Return a random background (a real photo if available, else procedural)."""
    w, h = CANVAS_W, CANVAS_H
    photos = _photo_paths()
    if photos:
        return _cover_crop(load_bg(random.choice(photos)), w, h)
    mode = random.choice(["solid", "gradient", "noise"])
    if mode == "solid":
        return Image.new("RGB", (w, h), _random_color())
    if mode == "gradient":
        top = _random_color()
        bottom = _random_color()
        strip = Image.new("RGB", (1, h))
        for y in range(h):
            t = y / max(1, h - 1)
            strip.putpixel(
                (0, y),
                tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)),
            )
        return strip.resize((w, h))
    noise = Image.effect_noise((w, h), random.uniform(10, 50)).convert("RGB")
    tint = Image.new("RGB", (w, h), _random_color())
    return Image.blend(noise, tint, random.uniform(0.3, 0.7))


def _solve_perspective(src, dst):
    """Solve for the 8 coefficients of a perspective transform (or None)."""
    n = 8
    a = [[0.0] * (n + 1) for _ in range(n)]
    for i, ((x, y), (u, v)) in enumerate(zip(src, dst)):
        a[2 * i] = [x, y, 1, 0, 0, 0, -x * u, -y * u, u]
        a[2 * i + 1] = [0, 0, 0, x, y, 1, -x * v, -y * v, v]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(a[r][col]))
        if abs(a[piv][col]) < 1e-9:
            return None
        a[col], a[piv] = a[piv], a[col]
        pv = a[col][col]
        for c in range(col, n + 1):
            a[col][c] /= pv
        for r in range(n):
            if r != col:
                f = a[r][col]
                if f:
                    for c in range(col, n + 1):
                        a[r][c] -= f * a[col][c]
    return [a[i][n] for i in range(n)]


def random_perspective(size, max_shift):
    """Return (pad, coeffs) for a random perspective warp of an image of `size`."""
    if max_shift <= 0:
        return 0, None
    w, h = size
    pad = max(2, round(max_shift * max(w, h)))
    src = [(pad, pad), (pad + w, pad), (pad + w, pad + h), (pad, pad + h)]
    dst = [
        (x + random.uniform(-pad, pad), y + random.uniform(-pad, pad))
        for x, y in src
    ]
    return pad, _solve_perspective(src, dst)


def apply_perspective(img, pad, coeffs):
    """Apply a perspective warp (from random_perspective) to an image."""
    if coeffs is None:
        return img
    w, h = img.size
    size = (w + 2 * pad, h + 2 * pad)
    padded = Image.new("RGBA", size, (0, 0, 0, 0))
    padded.paste(img, (pad, pad))
    return padded.transform(
        size, Image.Transform.PERSPECTIVE, coeffs, resample=Image.Resampling.BILINEAR
    )


def apply_lighting(img):
    """Apply random brightness/contrast/color adjustments."""
    img = ImageEnhance.Brightness(img).enhance(random.uniform(0.65, 1.35))
    img = ImageEnhance.Contrast(img).enhance(random.uniform(0.65, 1.35))
    img = ImageEnhance.Color(img).enhance(random.uniform(0.6, 1.5))
    return img


def draw_boxes(img, anns):
    """Draw annotation boxes on a copy for visual review."""
    img = img.copy()
    draw = ImageDraw.Draw(img)
    for _cls_id, x0, y0, x1, y1 in anns:
        draw.rectangle([x0, y0, x1, y1], outline=(255, 0, 0), width=2)
    return img


def rotate_hand(img, anns, angle):
    """Rotate the card canvas in place by `angle` degrees (PIL convention,
    counter-clockwise about the image centre) and transform annotation boxes.

    The canvas keeps its size; card pixels rotated past the canvas edge are
    cropped (realistic partial cards). Annotation boxes are clipped to the
    canvas, and boxes that fall entirely off-canvas are dropped.
    """
    w, h = img.size
    rotated = img.rotate(angle, resample=Image.Resampling.BILINEAR)
    theta = math.radians(angle)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    cx, cy = w / 2, h / 2
    new_anns = []
    for cls_id, x0, y0, x1, y1 in anns:
        xs, ys = [], []
        for x, y in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
            xs.append(cos_t * (x - cx) + sin_t * (y - cy) + cx)
            ys.append(-sin_t * (x - cx) + cos_t * (y - cy) + cy)
        nx0, ny0 = min(xs), min(ys)
        nx1, ny1 = max(xs), max(ys)
        new_anns.append((cls_id, nx0, ny0, nx1, ny1))
    return rotated, new_anns


def _clip_anns(anns, w, h, min_vis=0.5):
    """Clip boxes to the canvas and drop boxes that fall mostly off-canvas.

    A box that is less than `min_vis` visible (e.g. a corner marker whose card
    runs off the frame) is dropped instead of leaving a sliver that bounds
    mostly empty space.
    """
    out = []
    for cls_id, x0, y0, x1, y1 in anns:
        orig_w, orig_h = x1 - x0, y1 - y0
        if orig_w <= 0 or orig_h <= 0:
            continue
        cx0, cy0 = max(0.0, x0), max(0.0, y0)
        cx1, cy1 = min(float(w), x1), min(float(h), y1)
        if cx1 <= cx0 or cy1 <= cy0:
            continue
        visible = ((cx1 - cx0) * (cy1 - cy0)) / (orig_w * orig_h)
        if visible < min_vis:
            continue
        out.append((cls_id, cx0, cy0, cx1, cy1))
    return out


def write_data_yaml():
    """Write data.yaml for Ultralytics YOLO training."""
    lines = [
        "path: .",
        "train: hands/images/train",
        "val: hands/images/val",
        f"nc: {len(CLASSES)}",
        f"names: {CLASSES}",
    ]
    (HERE / "data.yaml").write_text("\n".join(lines) + "\n")


def make_hand(card_paths, args):
    n = random.randint(args.min_cards, args.max_cards)
    chosen = [random.choice(card_paths) for _ in range(n)]

    spread = random.uniform(args.min_angle, args.max_angle)
    # Ensure at least MIN_SEP_DEG between neighbouring cards, so many-card
    # hands still fan out instead of stacking.
    spread = max(spread, (n - 1) * MIN_SEP_DEG)
    spread = min(spread, MAX_FAN_SPREAD)
    card_h = random.uniform(args.min_card_h, args.max_card_h)
    pivot = (CANVAS_W / 2, CANVAS_H + random.uniform(120, 380))
    radius = CANVAS_H * random.uniform(0.72, 0.88)

    background = make_background()
    canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    anns = []  # (class_id, x0, y0, x1, y1) in image pixel coords

    # Draw left -> right so each card overlaps the one before it.
    for i, path in enumerate(chosen):
        card = load_sprite(path)
        w, h = card.size
        if min(w, h) < 20:
            continue  # skip degenerate/empty sprites
        cls = class_of_path(path)
        scale = card_h / h
        card = card.resize((round(w * scale), round(card_h)), Image.Resampling.BILINEAR)

        # Marker covering the top-left corner region of the card.
        mw, mh = card.size
        marker = Image.new("RGBA", (mw, mh), (0, 0, 0, 0))
        cw = max(1, round(mw * args.corner_w))
        ch = max(1, round(mh * args.corner_h))
        ox = round(mw * args.corner_x)
        oy = round(mh * args.corner_y)
        marker.paste(Image.new("RGBA", (cw, ch), (255, 255, 255, 255)), (ox, oy))

        pad, coeffs = random_perspective(card.size, args.warp)
        card = apply_perspective(card, pad, coeffs)
        marker = apply_perspective(marker, pad, coeffs)

        t = 0.5 if n == 1 else i / (n - 1)
        angle = (t - 0.5) * spread + random.uniform(-2.5, 2.5)

        rad = math.radians(angle)
        cx = pivot[0] + radius * math.sin(rad)
        cy = pivot[1] - radius * math.cos(rad)

        rotated = card.rotate(-angle, expand=True, resample=Image.Resampling.BILINEAR)
        rotated_marker = marker.rotate(-angle, expand=True, resample=Image.Resampling.BILINEAR)
        dest = (round(cx - rotated.width / 2), round(cy - rotated.height / 2))
        canvas.alpha_composite(rotated, dest)

        if cls is not None:
            bbox = rotated_marker.getchannel("A").getbbox()
            if bbox:
                bx0, by0, bx1, by1 = bbox
                anns.append(
                    (
                        CLASS_ID[cls],
                        dest[0] + bx0,
                        dest[1] + by0,
                        dest[0] + bx1,
                        dest[1] + by1,
                    )
                )

    bg = background.convert("RGBA")
    if args.hand_rot > 0:
        canvas, anns = rotate_hand(
            canvas, anns, random.uniform(-args.hand_rot, args.hand_rot)
        )
    bg.alpha_composite(canvas)
    img = apply_lighting(bg.convert("RGB"))
    anns = _clip_anns(anns, img.width, img.height)
    return img, anns


def _generate_task(task):
    """Generate and save one hand. Runs in a worker process."""
    (
        k,
        seed,
        card_paths,
        params,
        img_dirs,
        lbl_dirs,
        val_frac,
        debug_dir,
        start_index,
    ) = task
    random.seed(seed)
    img, anns = make_hand(card_paths, params)
    split = "val" if random.random() < val_frac else "train"
    idx = start_index + k
    img.save(img_dirs[split] / f"hand_{idx:05d}.png")
    with open(lbl_dirs[split] / f"hand_{idx:05d}.txt", "w") as f:
        iw, ih = img.size
        for cls_id, x0, y0, x1, y1 in anns:
            cx = (x0 + x1) / 2 / iw
            cy = (y0 + y1) / 2 / ih
            bw = (x1 - x0) / iw
            bh = (y1 - y0) / ih
            f.write(f"{cls_id} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}\n")
    if debug_dir is not None:
        draw_boxes(img, anns).save(debug_dir / f"hand_{idx:05d}.png")
    return k


def _run_tasks(tasks, workers, count):
    """Run task generation with optional multiprocessing and progress."""
    t0 = time.time()
    step = max(1, count // 20)
    done = 0
    if workers <= 1:
        for task in tasks:
            _generate_task(task)
            done += 1
            if done % step == 0 or done == count:
                _print_progress(done, count, t0)
    else:
        chunksize = max(1, count // (workers * 4))
        with ProcessPoolExecutor(max_workers=workers) as ex:
            for _ in ex.map(_generate_task, tasks, chunksize=chunksize):
                done += 1
                if done % step == 0 or done == count:
                    _print_progress(done, count, t0)


def _print_progress(done, total, t0):
    elapsed = time.time() - t0
    rate = done / elapsed if elapsed > 0 else 0.0
    eta = (total - done) / rate if rate > 0 else 0.0
    print(
        f"  {done}/{total} ({100 * done / total:.0f}%)  "
        f"{rate:.1f} hand/s  ETA {eta:.0f}s"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=10, help="images to generate")
    ap.add_argument("--side", default="both", choices=["light", "dark", "both"])
    ap.add_argument("--min-cards", type=int, default=2)
    ap.add_argument("--max-cards", type=int, default=6)
    ap.add_argument("--min-angle", type=float, default=6)
    ap.add_argument("--max-angle", type=float, default=17)
    ap.add_argument("--min-card-h", type=float, default=120)
    ap.add_argument("--max-card-h", type=float, default=720)
    ap.add_argument(
        "--warp",
        type=float,
        default=0.0,
        help="max perspective corner shift as a fraction of card size (0 disables)",
    )
    ap.add_argument(
        "--hand-rot",
        type=float,
        default=180.0,
        help="max whole-hand rotation in degrees (uniform; 180 = any orientation incl. upside-down, 0 disables)",
    )
    ap.add_argument(
        "--corner-w",
        type=float,
        default=0.30,
        help="top-left corner box width as a fraction of card width",
    )
    ap.add_argument(
        "--corner-h",
        type=float,
        default=0.20,
        help="top-left corner box height as a fraction of card height",
    )
    ap.add_argument(
        "--corner-x",
        type=float,
        default=0.06,
        help="top-left corner box left offset as a fraction of card width",
    )
    ap.add_argument(
        "--corner-y",
        type=float,
        default=0.05,
        help="top-left corner box top offset as a fraction of card height",
    )
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument(
        "--draw", action="store_true", help="also save debug images with boxes"
    )
    ap.add_argument(
        "--val-frac",
        type=float,
        default=0.1,
        help="fraction of images held out for validation",
    )
    ap.add_argument(
        "--workers",
        type=int,
        default=os.cpu_count() or 1,
        help="parallel worker processes (default: all CPU cores)",
    )
    ap.add_argument("--out", default=None)
    ap.add_argument(
        "--start-index",
        type=int,
        default=0,
        help="numbering offset for output files (use with --keep-existing to append)",
    )
    ap.add_argument(
        "--keep-existing",
        action="store_true",
        help="do not clear existing files in the output dirs (append mode)",
    )
    args = ap.parse_args()

    random.seed(args.seed)

    out_dir = Path(args.out) if args.out else HERE / "hands"
    img_dirs = {s: out_dir / "images" / s for s in ("train", "val")}
    lbl_dirs = {s: out_dir / "labels" / s for s in ("train", "val")}
    for d in list(img_dirs.values()) + list(lbl_dirs.values()):
        d.mkdir(parents=True, exist_ok=True)
        if not args.keep_existing:
            for old in d.iterdir():
                if old.is_file():
                    old.unlink()  # remove stale outputs from previous runs

    with open(HERE / "classes.txt", "w") as f:
        f.write("\n".join(CLASSES) + "\n")
    write_data_yaml()

    debug_dir = out_dir / "debug" if args.draw else None
    if debug_dir:
        debug_dir.mkdir(parents=True, exist_ok=True)
        for old in debug_dir.glob("*.png"):
            old.unlink()

    card_paths = load_card_paths(args.side)

    tasks = []
    for k in range(args.count):
        seed = None if args.seed is None else args.seed + k
        tasks.append(
            (
                k,
                seed,
                card_paths,
                args,
                img_dirs,
                lbl_dirs,
                args.val_frac,
                debug_dir,
                args.start_index,
            )
        )

    _run_tasks(tasks, args.workers, args.count)

    print(f"{args.count} hands -> {out_dir}")


if __name__ == "__main__":
    main()
