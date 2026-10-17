#!/usr/bin/env python3
"""Extract individual UNO Flip card sprites from a 6x12 sprite-sheet grid.

Cards are laid out on a fixed 6-row x 12-column grid. The script finds the
bounding box of all non-background pixels, divides it evenly into 6 rows and
12 columns, and saves each non-empty cell as a transparent-background PNG.

Usage:
    python extract_cards.py flip_light_combine.png --side light
    python extract_cards.py flip_dark_combine.png  --side dark
"""

import argparse
from pathlib import Path

import numpy as np
from PIL import Image

# Sprite-sheet background color. Matched strictly: only exactly this color
# becomes transparent, so the near-black card faces are always kept.
BG_COLOR = (37, 37, 37)

GRID_ROWS = 6
GRID_COLS = 12

# Cells with fewer foreground pixels than this are treated as empty
# (stray anti-aliased pixels), not as cards.
MIN_CARD_PIXELS = 1000


def load_sheet(path):
    """Return (foreground_mask, rgba_image) with the background transparent."""
    arr = np.asarray(Image.open(path).convert("RGB")).astype(int)
    fg = (np.abs(arr - np.array(BG_COLOR)).max(axis=2) > 0)
    alpha = np.where(fg, 255, 0).astype("uint8")
    rgba = Image.fromarray(np.dstack([arr.astype("uint8"), alpha]), "RGBA")
    return fg, rgba


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sheet", help="path to the combined sprite sheet PNG")
    ap.add_argument("--side", default="card", help="prefix for output files")
    ap.add_argument("--out", default=None, help="output directory")
    args = ap.parse_args()

    sheet_path = Path(args.sheet)
    out_dir = Path(args.out) if args.out else sheet_path.parent / "cards" / args.side
    out_dir.mkdir(parents=True, exist_ok=True)

    fg, img = load_sheet(sheet_path)

    ys, xs = np.where(fg)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    cell_w = (x1 - x0 + 1) / GRID_COLS
    cell_h = (y1 - y0 + 1) / GRID_ROWS

    count = 0
    for r in range(GRID_ROWS):
        row_cards = 0
        for c in range(GRID_COLS):
            left = round(x0 + c * cell_w)
            top = round(y0 + r * cell_h)
            right = round(x0 + (c + 1) * cell_w)
            bottom = round(y0 + (r + 1) * cell_h)
            cell = img.crop((left, top, right, bottom))
            cell_fg = np.asarray(cell)[..., 3] > 0
            if cell_fg.sum() < MIN_CARD_PIXELS:
                continue  # empty cell (partial last row)
            ys2, xs2 = np.where(cell_fg)
            tight = cell.crop((xs2.min(), ys2.min(), xs2.max() + 1, ys2.max() + 1))
            tight.save(out_dir / f"{args.side}_r{r:02d}_c{c:02d}.png")
            count += 1
            row_cards += 1
        print(f"  row {r}: {row_cards} cards")

    print(f"total cards: {count}")


if __name__ == "__main__":
    main()
