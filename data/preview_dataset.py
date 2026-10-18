#!/usr/bin/env python3
"""Draw YOLO labels over existing dataset images for visual review.

Usage:
    python preview_dataset.py --split train --count 10
    python preview_dataset.py --split val --count 5 --seed 1

Outputs annotated images to hands/preview/<split>/ (or --out).
"""

import argparse
import random
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
HANDS = HERE / "hands"

CLASSES = (HERE / "classes.txt").read_text().splitlines()

COLORS = [
    "#ff4d4d", "#4dff4d", "#4d8bff", "#ffd24d", "#ff4ddd",
    "#4dffdd", "#d2ff4d", "#dd4dff", "#ffffff", "#ff884d",
]


def draw_labels(img_path, label_path):
    img = Image.open(img_path).convert("RGB")
    draw = ImageDraw.Draw(img)
    W, H = img.size
    if label_path.exists():
        for line in label_path.read_text().splitlines():
            parts = line.split()
            if len(parts) != 5:
                continue
            cls = int(parts[0])
            cx, cy, w, h = (float(v) for v in parts[1:])
            x1, y1 = (cx - w / 2) * W, (cy - h / 2) * H
            x2, y2 = (cx + w / 2) * W, (cy + h / 2) * H
            color = COLORS[cls % len(COLORS)]
            draw.rectangle([x1, y1, x2, y2], outline=color, width=3)
            name = CLASSES[cls] if cls < len(CLASSES) else str(cls)
            draw.text((x1 + 2, max(0, y1 - 16)), name, fill=color)
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="train", choices=["train", "val"])
    ap.add_argument("--count", type=int, default=10)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    img_dir = HANDS / "images" / args.split
    lbl_dir = HANDS / "labels" / args.split
    out_dir = Path(args.out) if args.out else HANDS / "preview" / args.split
    out_dir.mkdir(parents=True, exist_ok=True)

    paths = sorted(img_dir.glob("*.png"))
    rng.shuffle(paths)
    for p in paths[: args.count]:
        out = out_dir / p.name
        draw_labels(p, lbl_dir / f"{p.stem}.txt").save(out)
        print(out.name)


if __name__ == "__main__":
    main()
