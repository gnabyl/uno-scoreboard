#!/usr/bin/env python3
"""Draw OBB labels over existing dataset images for visual review.

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
            if len(parts) not in (5, 9):
                continue
            cls = int(parts[0])
            color = COLORS[cls % len(COLORS)]
            name = CLASSES[cls] if cls < len(CLASSES) else str(cls)
            if len(parts) == 9:
                # OBB quad: class x1 y1 x2 y2 x3 y3 x4 y4 (normalized)
                pts = [
                    (float(parts[i]) * W, float(parts[i + 1]) * H)
                    for i in range(1, 9, 2)
                ]
                draw.line(pts + [pts[0]], fill=color, width=3)
                for x, y in pts:
                    draw.ellipse([x - 3, y - 3, x + 3, y + 3], fill=color)
                label_at = (pts[0][0] + 2, max(0, pts[0][1] - 16))
            else:
                # Legacy axis-aligned box: class cx cy w h (normalized)
                cx, cy, w, h = (float(v) for v in parts[1:])
                x1, y1 = (cx - w / 2) * W, (cy - h / 2) * H
                x2, y2 = (cx + w / 2) * W, (cy + h / 2) * H
                draw.rectangle([x1, y1, x2, y2], outline=color, width=3)
                label_at = (x1 + 2, max(0, y1 - 16))
            draw.text(label_at, name, fill=color)
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
