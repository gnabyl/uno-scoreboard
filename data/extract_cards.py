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

# Class name for each card, indexed by [side][row][col] (left-to-right per
# row). A string is the class name; "" falls back to {side}_r{row}_c{col};
# None marks a cell that is not a card and is skipped.
CARD_NAMES = {
    "light": [
        # r0: wild cards (cells marked None are excluded from the deck)
        [None, "light_wild_color", None, None, None, None,
         "light_wild_draw_two", None, None, None, None,
         None],
        # r1: yellow
        ["light_yellow_1", "light_yellow_2", "light_yellow_3", "light_yellow_4",
         "light_yellow_5", "light_yellow_6", "light_yellow_7", "light_yellow_8",
         "light_yellow_9", "light_yellow_flip", "light_yellow_draw_one",
         "light_yellow_skip"],
        # r2: yellow reverse, then red
        ["light_yellow_reverse", "light_red_1", "light_red_2", "light_red_3",
         "light_red_4", "light_red_5", "light_red_6", "light_red_7", "light_red_8",
         "light_red_9", "light_red_flip", "light_red_draw_one"],
        # r3: red tail, then blue
        ["light_red_skip", "light_red_reverse", "light_blue_1", "light_blue_2",
         "light_blue_3", "light_blue_4", "light_blue_5", "light_blue_6",
         "light_blue_7", "light_blue_8", "light_blue_9", "light_blue_flip"],
        # r4: blue tail, then green
        ["light_blue_draw_one", "light_blue_skip", "light_blue_reverse",
         "light_green_1", "light_green_2", "light_green_3", "light_green_4",
         "light_green_5", "light_green_6", "light_green_7", "light_green_8",
         "light_green_9"],
        # r5: green tail
        ["light_green_flip", "light_green_draw_one", "light_green_skip",
         "light_green_reverse"],
    ],
    "dark": [
        # r0: purple flip, wilds, and skip-all cards
        ["dark_purple_flip", "dark_wild_color", "dark_skip_all", "dark_skip_all",
         "dark_skip_all", "dark_skip_all", "dark_wild_draw_until", "dark_skip_all",
         "dark_skip_all", "dark_skip_all", "dark_skip_all", "dark_skip_all"],
        # r1: orange
        ["dark_orange_1", "dark_orange_2", "dark_orange_3", "dark_orange_4",
         "dark_orange_5", "dark_orange_6", "dark_orange_7", "dark_orange_8",
         "dark_orange_9", "dark_orange_flip", "dark_orange_draw_five",
         "dark_orange_skip_all"],
        # r2: orange reverse, then pink
        ["dark_orange_reverse", "dark_pink_1", "dark_pink_2", "dark_pink_3",
         "dark_pink_4", "dark_pink_5", "dark_pink_6", "dark_pink_7", "dark_pink_8",
         "dark_pink_9", "dark_pink_flip", "dark_pink_draw_five"],
        # r3: pink tail, then purple
        ["dark_pink_skip_all", "dark_pink_reverse", "dark_purple_1", "dark_purple_2",
         "dark_purple_3", "dark_purple_4", "dark_purple_5", "dark_purple_6",
         "dark_purple_7", "dark_purple_8", "dark_purple_9", "dark_purple_flip"],
        # r4: purple tail, then teal
        ["dark_purple_draw_five", "dark_purple_skip_all", "dark_purple_reverse",
         "dark_teal_1", "dark_teal_2", "dark_teal_3", "dark_teal_4", "dark_teal_5",
         "dark_teal_6", "dark_teal_7", "dark_teal_8", "dark_teal_9"],
        # r5: teal tail
        ["dark_teal_flip", "dark_teal_draw_five", "dark_teal_skip_all",
         "dark_teal_reverse"],
    ],
}


def card_class_name(side, row, col):
    """Return the class name for a cell: None to skip, "" if unnamed."""
    names = CARD_NAMES.get(side, [])
    if row < len(names) and col < len(names[row]):
        cell = names[row][col]
        if cell is None:
            return None  # not a card
        if cell:
            return cell
    return ""


def class_counts(side):
    """Return {class_name: number of sprites} for a side."""
    counts = {}
    for row in CARD_NAMES.get(side, []):
        for cell in row:
            if isinstance(cell, str) and cell:
                counts[cell] = counts.get(cell, 0) + 1
    return counts


def load_sheet(path):
    """Return (foreground_mask, rgba_image) with the background transparent."""
    arr = np.asarray(Image.open(path).convert("RGB")).astype(int)
    fg = (np.abs(arr - np.array(BG_COLOR)).max(axis=2) > 0)
    alpha = np.where(fg, 255, 0).astype("uint8")
    rgba = Image.fromarray(np.dstack([arr.astype("uint8"), alpha]), "RGBA")
    return fg, rgba


def column_runs(mask, y0, y1):
    """Return [(x0, x1)] of card columns within a row band."""
    col_has = mask[y0:y1, :].any(axis=0)
    out = []
    start = None
    for x, v in enumerate(col_has):
        if v and start is None:
            start = x
        elif not v and start is not None:
            out.append((start, x - 1))
            start = None
    if start is not None:
        out.append((start, len(col_has) - 1))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sheet", help="path to the combined sprite sheet PNG")
    ap.add_argument("--side", default="card", help="prefix for output files")
    ap.add_argument("--out", default=None, help="output directory")
    args = ap.parse_args()

    sheet_path = Path(args.sheet)
    out_dir = Path(args.out) if args.out else sheet_path.parent / "cards" / args.side
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.png"):
        old.unlink()  # remove stale outputs from previous runs

    fg, img = load_sheet(sheet_path)

    ys, xs = np.where(fg)
    y0, y1 = ys.min(), ys.max()
    cell_h = (y1 - y0 + 1) / GRID_ROWS

    count = 0
    counts = class_counts(args.side)
    seen = {}
    for r in range(GRID_ROWS):
        top = round(y0 + r * cell_h)
        bottom = round(y0 + (r + 1) * cell_h)
        row_cards = 0
        for ci, (left, right) in enumerate(column_runs(fg, top, bottom)):
            cell = img.crop((left, top, right + 1, bottom))
            cell_fg = np.asarray(cell)[..., 3] > 0
            if cell_fg.sum() < MIN_CARD_PIXELS:
                continue  # empty/stray cell
            cls = card_class_name(args.side, r, ci)
            if cls is None:
                continue  # cell marked as not-a-card in CARD_NAMES
            if cls:
                seen[cls] = seen.get(cls, 0) + 1
                if counts[cls] == 1:
                    name = f"{cls}.png"
                else:
                    name = f"{cls}_{seen[cls]:02d}.png"
            else:
                name = f"{args.side}_r{r:02d}_c{ci:02d}.png"
            ys2, xs2 = np.where(cell_fg)
            tight = cell.crop((xs2.min(), ys2.min(), xs2.max() + 1, ys2.max() + 1))
            tight.save(out_dir / name)
            count += 1
            row_cards += 1
        print(f"  row {r}: {row_cards} cards")

    print(f"total cards: {count}")


if __name__ == "__main__":
    main()
