#!/usr/bin/env python3
"""Compose random "hands" of UNO Flip cards as fanned spreads.

Each image picks a random number of cards, a random fan spread angle, a random
card height, a random background (real photos when available), a whole-hand
perspective tilt (the camera looking at the table from an angle), scene
lighting (a light source that brightens one side of the hand, casts a warm or
cool colour over the cards, and leaves a glossy specular reflection on the
plastic faces), and a little camera blur (lens softness plus an occasional
handheld smear). Cards are drawn left-to-right so each subsequent card overlaps
the previous one, like a hand of cards.

Every card is kept fully inside the frame: a hand that fans past an edge is
nudged back into view, and a hand too large for the canvas is scaled down
slightly. A card sliced by the border would get a clipped label and teach the
model that half a card is a whole card, so the generator never lets that happen.

Labels are Ultralytics OBB (oriented bounding box) polygons: one rotated quad
per card, written as `class x1 y1 x2 y2 x3 y3 x4 y4` in normalized coordinates
and ordered around the card.

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
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

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

# Share of every run that is a lone card instead of a fan. A lone card teaches
# the detector what a whole card looks like with nothing overlapping it.
SINGLE_CARD_FRAC = 0.2

# Share of frames that get camera blur. Most photos stay sharp; blurring every
# image would just make the whole set softer and teach the model nothing extra.
BLUR_FRAC = 0.2

# Share of the background photos held out for validation. Val images may only
# use these, so validation runs on surfaces training never saw.
VAL_BG_FRAC = 0.1


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


# Faces per class in a real UNO Flip deck: 108 double-sided cards = 216 faces.
# Per colour there are two each of 1-9, two Reverse, two Skip/Skip Everyone,
# two Draw One/Draw Five, and one Flip (25 cards). The 8 wilds are four
# standard Wild (wild on both sides) and four penalty Wilds (Draw Two on the
# light side, Draw Until on the dark side).
DECK_FACES = {
    **{str(n): 16 for n in range(1, 10)},
    "reverse": 16,
    "flip": 8,
    "skip": 8,
    "skip_all": 8,
    "draw_one": 8,
    "draw_five": 8,
    "wild_color": 8,
    "wild_draw_two": 4,
    "wild_draw_until": 4,
}


def card_weights(paths):
    """Draw weight per sprite so the class mix matches a real deck.

    Sampling uniformly over sprite files over-weights classes that happen to
    have more artwork (four colours x two sides) and gives a wild 1/108 when it
    is really 8/216 of the faces. Each class gets its deck share, split evenly
    across the sprite designs that exist for it.
    """
    classes = [class_of_path(p) for p in paths]
    designs = Counter(classes)
    return [DECK_FACES.get(c, 1) / designs[c] for c in classes]


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


def _split_backgrounds(val_frac):
    """Hold out a stable slice of background photos for validation.

    Val images may only use these photos, so validation measures a hand on an
    unseen surface instead of a re-shuffle of a scene the model has trained on.
    The split uses a fixed seed: every generation pass must agree on it, or
    train and val would share photos again.
    """
    photos = sorted(_photo_paths())
    if not photos or val_frac <= 0:
        return photos, photos
    shuffled = photos[:]
    random.Random(20240101).shuffle(shuffled)
    n_val = min(len(shuffled) - 1, max(1, round(len(shuffled) * val_frac)))
    val = sorted(shuffled[:n_val])
    if not val:  # a single photo cannot be held out
        return photos, photos
    return sorted(shuffled[n_val:]), val


def _cover_crop(img, w, h):
    """Resize a photo to cover the canvas, then take a random crop."""
    iw, ih = img.size
    scale = max(w / iw, h / ih)
    img = img.resize((round(iw * scale), round(ih * scale)), Image.Resampling.BILINEAR)
    x = random.randint(0, img.width - w)
    y = random.randint(0, img.height - h)
    return img.crop((x, y, x + w, y + h))


def make_background(photos=None):
    """Return a random background (a real photo if available, else procedural)."""
    w, h = CANVAS_W, CANVAS_H
    photos = _photo_paths() if photos is None else photos
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


def camera_tilt(size, max_tilt, distance=0.8):
    """Return (pad, coeffs, forward) for a camera looking at the canvas at an angle.

    `max_tilt` is the largest angle (degrees) between the camera axis and the
    table normal; the actual tilt is drawn uniformly from 0 to it. The camera
    sits `distance` canvas widths above the table and looks straight down while
    the canvas is tilted and spun underneath it, so every point shares one
    vanishing point - exactly like a real photo. A random corner quad (the old
    approach) can also shear a card into a parallelogram no camera could make.

    `coeffs` is what PIL's PERSPECTIVE transform expects (output -> input) and
    `forward` maps a padded source point onto the tilted canvas. The result
    lives in a canvas padded by `pad` on each side, so nothing is clipped when
    the tilt pushes an edge outward.

    Returns (0, None, None) when warping is disabled (max_tilt <= 0).
    """
    if max_tilt <= 0:
        return 0, None, None
    w, h = size
    theta = math.radians(random.uniform(0.0, max_tilt))
    phi = random.uniform(0.0, 2.0 * math.pi)
    d = distance * max(w, h)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    cos_p, sin_p = math.cos(phi), math.sin(phi)

    def project(x, y):
        # Tilt the table about its vertical axis, spin it about its normal,
        # then project from a pinhole at (0, 0, d) looking down.
        x_tilted = cos_t * x
        z = -sin_t * x
        x_cam = cos_p * x_tilted - sin_p * y
        y_cam = sin_p * x_tilted + cos_p * y
        depth = d - z
        return d * x_cam / depth, d * y_cam / depth

    quad = [
        project(-w / 2.0, -h / 2.0),
        project(w / 2.0, -h / 2.0),
        project(w / 2.0, h / 2.0),
        project(-w / 2.0, h / 2.0),
    ]
    xs = [x for x, _ in quad]
    ys = [y for _, y in quad]
    pad = max(2, math.ceil(max(max(xs) - min(xs) - w, max(ys) - min(ys) - h) / 2) + 1)
    shift_x = pad + w / 2.0 - (max(xs) + min(xs)) / 2.0
    shift_y = pad + h / 2.0 - (max(ys) + min(ys)) / 2.0
    dst = [(x + shift_x, y + shift_y) for x, y in quad]
    src = [(pad, pad), (pad + w, pad), (pad + w, pad + h), (pad, pad + h)]
    return (
        pad,
        _solve_perspective(dst, src),  # what PIL applies
        _solve_perspective(src, dst),  # padded source -> tilted canvas
    )


def apply_perspective(img, pad, coeffs):
    """Apply a camera tilt (from camera_tilt) to an image."""
    if coeffs is None:
        return img
    w, h = img.size
    size = (w + 2 * pad, h + 2 * pad)
    padded = Image.new("RGBA", size, (0, 0, 0, 0))
    padded.paste(img, (pad, pad))
    return padded.transform(
        size, Image.Transform.PERSPECTIVE, coeffs, resample=Image.Resampling.BILINEAR
    )


def apply_homography(point, coeffs):
    """Map a point through an 8-coefficient perspective transform."""
    x, y = point
    a, b, c, d, e, f, g, h = coeffs
    denom = g * x + h * y + 1.0
    if abs(denom) < 1e-12:
        return (x, y)
    return ((a * x + b * y + c) / denom, (d * x + e * y + f) / denom)


def rotate_expanded(img, angle):
    """Rotate an image counter-clockwise by `angle` and expand to fit.

    Returns (rotated, forward) where `forward` maps a point in the source
    image to the same point in the rotated image. Mapping the points here
    instead of relying on Pillow's expand offset keeps annotation quads exact
    even when the source image has transparent padding around the card.
    """
    w, h = img.size
    theta = math.radians(angle)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    cx, cy = w / 2.0, h / 2.0

    def rotate_point(x, y):
        dx, dy = x - cx, y - cy
        return (cos_t * dx + sin_t * dy, -sin_t * dx + cos_t * dy)

    rel = [rotate_point(x, y) for x, y in ((0, 0), (w, 0), (w, h), (0, h))]
    min_x = min(p[0] for p in rel)
    min_y = min(p[1] for p in rel)
    nw = int(math.ceil(max(p[0] for p in rel) - min_x))
    nh = int(math.ceil(max(p[1] for p in rel) - min_y))

    def forward(x, y):
        rx, ry = rotate_point(x, y)
        return (rx - min_x, ry - min_y)

    # Pillow's AFFINE matrix maps destination -> source:
    #   forward: dst = R (src - c) - min
    #   inverse: src = R^T (dst + min) + c
    a, b = cos_t, -sin_t
    d, e = sin_t, cos_t
    matrix = [
        a,
        b,
        a * min_x + b * min_y + cx,
        d,
        e,
        d * min_x + e * min_y + cy,
    ]
    rotated = img.transform(
        (nw, nh),
        Image.Transform.AFFINE,
        matrix,
        resample=Image.Resampling.BILINEAR,
    )
    return rotated, forward


def _card_aligned_quad(corners, points):
    """Smallest rectangle aligned with the card's own axes bounding `points`.

    Clipping a rotated card against the image frame yields a 3-8 vertex
    polygon, but OBB labels need exactly four points. Fitting the quad to the
    card's own axes (rather than a min-area rect at an arbitrary angle) keeps
    the label's rotation meaningful for later rectification.
    """
    ox, oy = corners[0]
    ux, uy = corners[1][0] - ox, corners[1][1] - oy
    vx, vy = corners[3][0] - ox, corners[3][1] - oy
    ulen = math.hypot(ux, uy)
    vlen = math.hypot(vx, vy)
    if ulen < 1e-9 or vlen < 1e-9:
        return None
    ux, uy = ux / ulen, uy / ulen
    vx, vy = vx / vlen, vy / vlen
    us = [((x - ox) * ux + (y - oy) * uy) for x, y in points]
    vs = [((x - ox) * vx + (y - oy) * vy) for x, y in points]
    u0, u1, v0, v1 = min(us), max(us), min(vs), max(vs)
    return [
        (ox + ux * u + vx * v, oy + uy * u + vy * v)
        for u, v in ((u0, v0), (u1, v0), (u1, v1), (u0, v1))
    ]


def poly_area(points):
    """Unsigned area of a polygon (shoelace formula)."""
    if len(points) < 3:
        return 0.0
    total = 0.0
    for i, (x1, y1) in enumerate(points):
        x0, y0 = points[i - 1]
        total += x0 * y1 - x1 * y0
    return abs(total) / 2.0


def clip_polygon(points, width, height):
    """Clip a polygon to the [0, width] x [0, height] rectangle."""
    def clip(pts, axis, bound, keep_greater):
        out = []
        for i, cur in enumerate(pts):
            prev = pts[i - 1]
            cur_in = cur[axis] >= bound if keep_greater else cur[axis] <= bound
            prev_in = prev[axis] >= bound if keep_greater else prev[axis] <= bound
            if cur_in != prev_in:
                denom = cur[axis] - prev[axis]
                if abs(denom) > 1e-12:
                    t = (bound - prev[axis]) / denom
                    out.append(
                        (
                            prev[0] + t * (cur[0] - prev[0]),
                            prev[1] + t * (cur[1] - prev[1]),
                        )
                    )
            if cur_in:
                out.append(cur)
        return out

    pts = list(points)
    for axis, bound, keep_greater in (
        (0, 0.0, True),
        (0, float(width), False),
        (1, 0.0, True),
        (1, float(height), False),
    ):
        if not pts:
            break
        pts = clip(pts, axis, bound, keep_greater)
    return pts


# Direct light and ambient fill colours per white-balance mood. The direct
# light warms or cools the lit side, and the fill leans the other way, so a
# warm lamp leaves a cool colour cast in the unlit areas instead of only
# brightening the card.
LIGHT_MOODS = (
    ((1.10, 1.00, 0.86), (0.94, 0.97, 1.02)),  # warm lamp, cool fill
    ((0.92, 0.98, 1.12), (1.03, 0.99, 0.95)),  # cool daylight, warm fill
    ((1.02, 1.00, 0.98), (0.98, 0.99, 1.01)),  # neutral
)


def _illumination(w, h, light, falloff, ambient):
    """Per-pixel light level in [ambient, 1], brightest at `light`.

    The light is a point source: level falls off with the squared distance, so
    one corner of a hand can sit in a pool of light while the far side is dim.
    `falloff` is the distance at which the light is half strength, in pixels.
    The field is normalized to its brightest in-frame point, so moving the
    light outside the frame changes where the pool falls, not the exposure.
    """
    xs = np.arange(w, dtype=np.float32) - light[0]
    ys = np.arange(h, dtype=np.float32) - light[1]
    d2 = ys[:, None] ** 2 + xs[None, :] ** 2
    raw = 1.0 / (1.0 + d2 / (falloff * falloff))
    raw /= raw.max()
    return ambient + (1.0 - ambient) * raw


def _gloss(light, w, h, angle, sigmas):
    """Soft specular reflection of the light on the scene.

    A glossy plane mirrors the light at one point, and the size of the blob is
    the light's apparent size, so a window or lamp leaves a broad, slightly
    stretched highlight rather than a pinpoint. `angle` turns that streak and
    `sigmas` are its two radii. The result is a plain field; the caller scales
    it by how reflective each surface is (cards are glossy, the table less so).
    """
    xs = np.arange(w, dtype=np.float32) - light[0]
    ys = np.arange(h, dtype=np.float32) - light[1]
    cos_a, sin_a = math.cos(angle), math.sin(angle)
    u = xs[None, :] * cos_a + ys[:, None] * sin_a
    v = -xs[None, :] * sin_a + ys[:, None] * cos_a
    su, sv = sigmas
    return np.exp(-0.5 * (u * u / (su * su) + v * v / (sv * sv)))


def apply_lighting(background, cards):
    """Light the composited scene as if a real lamp or window lit the table.

    The old pass was a flat brightness/contrast/colour jitter on the finished
    image: every card got the same treatment, lit or not. This one models a
    light source instead:

    * a light near the hand with distance falloff, so the scene has a bright
      side and a dim side;
    * a warm/cool direct colour against a complementary ambient fill, so the
      card picks up a colour cast rather than only a brightness change;
    * a glossy specular reflection across the scene - strong on the plastic
      cards, faint on the table - broad and slightly stretched like the
      reflection of a window or lamp.

    The light field and the highlight cover the background as well as the
    cards, so the whole frame shares one source. Cards are flat and lie on the
    table, so their cast shadow is a negligible sliver - the glossy highlight
    is what sells the light, and that is what this pass spends its effort on.
    `background` and `cards` are RGBA and share one canvas size; the cards are
    composited here. No card moves, so labels are unaffected.
    """
    w, h = background.size
    box = cards.getbbox()
    if box is not None:
        # Put the light (and so the mirror point of the highlight) on a card,
        # not in the empty gap between fanned cards: a reflection that peaks on
        # the table shows no gloss at all. Rejection-sample the card pixels so
        # the hotspot can land anywhere on the hand, not always at its centre.
        alpha_mask = np.asarray(cards.getchannel("A"), dtype=np.uint8)
        light = ((box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0)
        for _ in range(50):
            lx = random.uniform(box[0], box[2] - 1)
            ly = random.uniform(box[1], box[3] - 1)
            if alpha_mask[int(ly), int(lx)] > 127:
                light = (lx, ly)
                break
    else:
        light = (random.uniform(0.2, 0.8) * w, random.uniform(0.2, 0.8) * h)
    falloff = random.uniform(0.70, 1.30) * w
    ambient = random.uniform(0.65, 0.90)
    exposure = random.uniform(0.95, 1.08)
    direct_rgb, ambient_rgb = random.choice(LIGHT_MOODS)

    # Ambient fill sets the floor; the direct light adds the rest, tinted.
    level = _illumination(w, h, light, falloff, ambient)
    direct = np.array(direct_rgb, dtype=np.float32) * exposure
    fill = np.array(ambient_rgb, dtype=np.float32) * ambient
    factor = fill[None, None, :] + (level - ambient)[..., None] * direct[None, None, :]

    base = np.asarray(background.convert("RGB"), dtype=np.float32)
    card = np.asarray(cards, dtype=np.float32)
    alpha = card[..., 3:4] / 255.0
    base = base * (1.0 - alpha) + card[..., :3] * alpha
    lit = base * factor

    # Gloss: a broad sheen plus a tighter hot core, both screen-blended so the
    # highlight can only add light. Cards reflect strongly and the table only
    # faintly, but both are lit, so the reflection sits in the scene instead of
    # being painted onto the cards. Streak angle and radii are random, so the
    # highlight reads as a window, a lamp or a phone flash across the run.
    if box is not None:
        angle = random.uniform(0.0, math.pi)
        long_axis = random.uniform(0.10, 0.22) * w
        short_axis = random.uniform(0.02, 0.05) * w
        reflectivity = alpha * random.uniform(0.55, 0.80)
        reflectivity += (1.0 - alpha) * random.uniform(0.08, 0.18)
        sheen = _gloss(light, w, h, angle, (long_axis, short_axis))[..., None]
        lit += (255.0 - lit) * sheen * reflectivity * direct[None, None, :]
        core = _gloss(
            light, w, h, angle, (long_axis * 0.45, short_axis * 0.45)
        )[..., None]
        lit += (255.0 - lit) * core * reflectivity * 0.5 * direct[None, None, :]

    return Image.fromarray(np.clip(lit, 0.0, 255.0).astype(np.uint8))


def _motion_blur(img, length, angle):
    """Average a few shifted copies along one direction (handheld smear)."""
    steps = max(3, int(round(length)))
    arr = np.asarray(img, dtype=np.float32)
    pad = steps
    padded = np.pad(arr, ((pad, pad), (pad, pad), (0, 0)), mode="edge")
    acc = np.zeros_like(arr)
    for i in range(steps):
        t = i - (steps - 1) / 2.0
        dx = int(round(math.cos(angle) * t))
        dy = int(round(math.sin(angle) * t))
        y, x = pad + dy, pad + dx
        acc += padded[y : y + arr.shape[0], x : x + arr.shape[1]]
    return Image.fromarray((acc / steps).astype(np.uint8))


def _camera_blur(img):
    """Blur one frame in five, as if the camera missed focus.

    Most photos stay perfectly sharp; a fifth get a little lens softness and,
    now and then, a short handheld smear. The blur stays small - the cards must
    remain readable for the labels to keep their meaning - but a mixed set
    teaches the model to cope with a soft photo instead of only crisp renders.
    """
    if random.random() >= BLUR_FRAC:
        return img
    img = img.filter(ImageFilter.GaussianBlur(random.uniform(0.6, 1.8)))
    if random.random() < 0.25:  # a few of the blurred frames also smear
        length = random.uniform(2.5, 6.0)
        img = _motion_blur(img, length, random.uniform(0.0, math.pi))
    return img


def draw_boxes(img, anns):
    """Draw annotation quads on a copy for visual review."""
    img = img.copy()
    draw = ImageDraw.Draw(img)
    for _cls_id, corners in anns:
        draw.line(corners + [corners[0]], fill=(255, 0, 0), width=3)
        for x, y in corners:
            draw.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(255, 0, 0))
    return img


def _fit_hand(quads, w, h, margin=12.0):
    """Transform (scale, tx, ty) that brings the whole hand inside the frame.

    A hand that already fits is left untouched (scale 1, no offset), so the
    usual composition is unchanged. A hand too big for the frame is scaled
    down about its centre and re-centred, so no card is sliced by an edge.
    """
    left = min(x for corners in quads for x, _ in corners)
    right = max(x for corners in quads for x, _ in corners)
    top = min(y for corners in quads for _, y in corners)
    bottom = max(y for corners in quads for _, y in corners)

    if right - left > w - 2 * margin or bottom - top > h - 2 * margin:
        # Too big: shrink about the centre and re-centre in the frame.
        scale = min((w - 2 * margin) / (right - left), (h - 2 * margin) / (bottom - top))
        return (
            scale,
            w / 2.0 - scale * (left + right) / 2.0,
            h / 2.0 - scale * (top + bottom) / 2.0,
        )

    # Fits, so only undo any overhang; hands already inside keep their layout.
    tx = 0.0
    if left < margin:
        tx = margin - left
    elif right > w - margin:
        tx = w - margin - right
    ty = 0.0
    if top < margin:
        ty = margin - top
    elif bottom > h - margin:
        ty = h - margin - bottom
    return 1.0, tx, ty


def _warp_hand(canvas, anns, max_tilt):
    """Apply one camera tilt to the whole rendered hand.

    Simulates looking at the table from an angle: every card goes through the
    same homography, so they keep one common vanishing point and the fan's
    overlaps stay as laid out. `canvas` and `anns` share a coordinate system,
    so the warp moves pixels and label quads together. A tilt can push a corner
    past the border, hence the re-fit into the frame.
    """
    pad, coeffs, fwd = camera_tilt(canvas.size, max_tilt)
    if coeffs is None:
        return canvas, anns

    warped = apply_perspective(canvas, pad, coeffs)
    moved = [
        (cls_id, [apply_homography((x + pad, y + pad), fwd) for x, y in quad])
        for cls_id, quad in anns
    ]
    scale, tx, ty = _fit_hand([quad for _, quad in moved], CANVAS_W, CANVAS_H)
    if scale != 1.0:
        warped = warped.resize(
            (
                max(1, round(warped.width * scale)),
                max(1, round(warped.height * scale)),
            ),
            Image.Resampling.BILINEAR,
        )
    frame = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    frame.paste(warped, (round(tx), round(ty)), warped)
    return frame, [
        (cls_id, [(x * scale + tx, y * scale + ty) for x, y in quad])
        for cls_id, quad in moved
    ]


def _clip_anns(anns, w, h, min_vis=0.5):
    """Clip annotation quads to the canvas and drop mostly-hidden cards.

    A quad that is less than `min_vis` visible (e.g. a card whose centre runs
    off the frame) is dropped instead of leaving a sliver of a label.
    """
    out = []
    for cls_id, corners in anns:
        area = poly_area(corners)
        if area <= 0.0:
            continue
        clipped = clip_polygon(corners, w, h)
        if len(clipped) < 3:
            continue
        if poly_area(clipped) / area < min_vis:
            continue
        # OBB labels take exactly four points, so a frame-clipped card is
        # reduced back to a quad; a fully visible card keeps its original one.
        quad = clipped if len(clipped) == 4 else _card_aligned_quad(corners, clipped)
        if quad is None or len(quad) != 4:
            continue
        out.append((cls_id, quad))
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


def make_hand(card_paths, args, weights=None, photos=None, single=False):
    n = 1 if single else random.randint(args.min_cards, args.max_cards)
    if weights is None:
        weights = card_weights(card_paths)
    # Weighted so the class mix matches a real UNO Flip deck (see DECK_FACES).
    chosen = random.choices(card_paths, weights=weights, k=n)

    spread = random.uniform(args.min_angle, args.max_angle)
    # Ensure at least MIN_SEP_DEG between neighbouring cards, so many-card
    # hands still fan out instead of stacking.
    spread = max(spread, (n - 1) * MIN_SEP_DEG)
    spread = min(spread, MAX_FAN_SPREAD)
    card_h = random.uniform(args.min_card_h, args.max_card_h)
    pivot = (CANVAS_W / 2, CANVAS_H + random.uniform(120, 380))
    radius = CANVAS_H * random.uniform(0.72, 0.88)

    background = make_background(photos)

    # Lay the hand out first: card placement has to be known before rendering
    # so the frame can be shifted to keep the whole hand in view.
    layout = []
    for i, path in enumerate(chosen):
        card = load_sprite(path)
        w, h = card.size
        if min(w, h) < 20:
            continue  # skip degenerate/empty sprites
        cls = class_of_path(path)
        scale = card_h / h
        card = card.resize((round(w * scale), round(card_h)), Image.Resampling.BILINEAR)

        # The label is the whole card, tracked through the rotation below as a
        # quad: an axis-aligned box doubles in area at 45 degrees and makes
        # neighbouring cards in a fan look like they overlap.
        corners = [
            (0, 0),
            (card.width, 0),
            (card.width, card.height),
            (0, card.height),
        ]

        t = 0.5 if n == 1 else i / (n - 1)
        angle = (t - 0.5) * spread + random.uniform(-2.5, 2.5)

        rad = math.radians(angle)
        cx = pivot[0] + radius * math.sin(rad)
        cy = pivot[1] - radius * math.cos(rad)
        layout.append([card, corners, angle, cx, cy, cls])

    # Whole-hand rotation, applied to each card: rotating the cards about the
    # frame centre is the same isometry as rotating a composited layer, but it
    # keeps the sprites sharp and loses nothing before the fit below.
    hand_rot = random.uniform(-args.hand_rot, args.hand_rot) if args.hand_rot > 0 else 0.0

    # Render each card, then fit the arrangement inside the frame. Cards are
    # fanned from a pivot below the frame, so a hand can easily be taller than
    # the canvas; shrinking it beats letting an edge slice the card faces.
    rendered = []  # (sprite, (cx, cy), quad, class_id)
    for card, corners, angle, cx, cy, cls in layout:
        if hand_rot:
            theta = math.radians(hand_rot)
            cos_t, sin_t = math.cos(theta), math.sin(theta)
            ox, oy = CANVAS_W / 2.0, CANVAS_H / 2.0
            ux, uy = cx - ox, cy - oy
            cx = cos_t * ux + sin_t * uy + ox
            cy = -sin_t * ux + cos_t * uy + oy

        rotated, forward = rotate_expanded(card, hand_rot - angle)
        left = cx - rotated.width / 2.0
        top = cy - rotated.height / 2.0
        quad = []
        for x, y in corners:
            fx, fy = forward(x, y)
            quad.append((fx + left, fy + top))
        rendered.append((rotated, (cx, cy), quad, cls))

    scale, tx, ty = (1.0, 0.0, 0.0)
    if rendered:
        scale, tx, ty = _fit_hand([q for _, _, q, _ in rendered], CANVAS_W, CANVAS_H)

    canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    anns = []  # (class_id, [(x, y) * 4]) in image pixel coords
    # Draw left -> right so each card overlaps the one before it.
    for rotated, (cx, cy), quad, cls in rendered:
        if scale != 1.0:
            rotated = rotated.resize(
                (
                    max(1, round(rotated.width * scale)),
                    max(1, round(rotated.height * scale)),
                ),
                Image.Resampling.BILINEAR,
            )
        cx, cy = cx * scale + tx, cy * scale + ty
        quad = [(x * scale + tx, y * scale + ty) for x, y in quad]
        dest = (round(cx - rotated.width / 2), round(cy - rotated.height / 2))
        canvas.alpha_composite(rotated, dest)
        if cls is not None:
            anns.append((CLASS_ID[cls], quad))

    bg = background.convert("RGBA")
    # One perspective warp for the whole hand: cards lying on a table share the
    # camera angle, so they must share one homography. Warping each card on its
    # own gave every card a different vanishing point and made neighbours cross.
    if args.warp > 0 and anns:
        canvas, anns = _warp_hand(canvas, anns, args.warp)
    img = apply_lighting(bg, canvas)
    img = _camera_blur(img)
    anns = _clip_anns(anns, img.width, img.height)
    return img, anns


def _generate_task(task):
    """Generate and save one hand. Runs in a worker process."""
    (
        idx,
        seed,
        card_paths,
        weights,
        params,
        img_dirs,
        lbl_dirs,
        split,
        single,
        debug_dir,
        bg_pools,
    ) = task
    random.seed(seed)
    img, anns = make_hand(card_paths, params, weights, bg_pools[split], single)
    img.save(img_dirs[split] / f"hand_{idx:05d}.png")
    with open(lbl_dirs[split] / f"hand_{idx:05d}.txt", "w") as f:
        iw, ih = img.size
        for cls_id, corners in anns:
            coords = []
            for x, y in corners:
                coords.append(min(1.0, max(0.0, x / iw)))
                coords.append(min(1.0, max(0.0, y / ih)))
            f.write(f"{cls_id} " + " ".join(f"{v:.6f}" for v in coords) + "\n")
    if debug_dir is not None:
        draw_boxes(img, anns).save(debug_dir / f"hand_{idx:05d}.png")
    return idx


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
    ap.add_argument("--count", type=int, default=10, help="total images (train + val)")
    ap.add_argument("--side", default="both", choices=["light", "dark", "both"])
    ap.add_argument("--min-cards", type=int, default=2)
    ap.add_argument("--max-cards", type=int, default=6)
    ap.add_argument("--min-angle", type=float, default=30)
    ap.add_argument("--max-angle", type=float, default=60)
    ap.add_argument("--min-card-h", type=float, default=120)
    ap.add_argument("--max-card-h", type=float, default=720)
    ap.add_argument(
        "--warp",
        type=float,
        default=0.0,
        help=(
            "max camera tilt in degrees (0 disables); simulates looking at "
            "the table from an angle"
        ),
    )
    ap.add_argument(
        "--hand-rot",
        type=float,
        default=180.0,
        help="max whole-hand rotation in degrees (uniform; 180 = any orientation incl. upside-down, 0 disables)",
    )
    ap.add_argument(
        "--full-card",
        action="store_true",
        help=argparse.SUPPRESS,
    )  # deprecated: OBB labels always cover the whole card
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument(
        "--draw", action="store_true", help="also save debug images with boxes"
    )
    ap.add_argument(
        "--val-frac",
        type=float,
        default=0.1,
        help="fraction of the run written to val (train gets the rest)",
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
        default=None,
        help="append mode: first file number (existing images are kept)",
    )
    args = ap.parse_args()

    random.seed(args.seed)

    out_dir = Path(args.out) if args.out else HERE / "hands"
    img_dirs = {s: out_dir / "images" / s for s in ("train", "val")}
    lbl_dirs = {s: out_dir / "labels" / s for s in ("train", "val")}

    # Passing --start-index means "append": existing files stay and new ones
    # are numbered after them. Without it the run replaces the output, so a
    # second run cannot silently mix two generations.
    append = args.start_index is not None
    start = args.start_index or 0
    for d in list(img_dirs.values()) + list(lbl_dirs.values()):
        d.mkdir(parents=True, exist_ok=True)
        if not append:
            for old in d.iterdir():
                if old.is_file():
                    old.unlink()  # remove stale outputs from previous runs

    if append:
        existing = [
            int(p.stem.rsplit("_", 1)[1])
            for d in img_dirs.values()
            for p in d.glob("hand_*.png")
        ]
        if existing and start <= max(existing):
            raise SystemExit(
                f"--start-index {start} would overwrite images up to "
                f"hand_{max(existing):05d}; use --start-index {max(existing) + 1}"
            )

    with open(HERE / "classes.txt", "w") as f:
        f.write("\n".join(CLASSES) + "\n")
    write_data_yaml()

    debug_dir = out_dir / "debug" if args.draw else None
    if debug_dir:
        debug_dir.mkdir(parents=True, exist_ok=True)
        for old in debug_dir.glob("*.png"):
            old.unlink()

    card_paths = load_card_paths(args.side)
    weights = card_weights(card_paths)
    train_bg, val_bg = _split_backgrounds(VAL_BG_FRAC)
    bg_pools = {"train": train_bg, "val": val_bg}

    n_val = round(args.count * args.val_frac) if args.val_frac > 0 else 0
    n_train = args.count - n_val

    # One run covers the whole recipe: fans and lone cards, both splits, val on
    # held-out backgrounds. Shuffle the lone cards so a split does not end with
    # a long run of them.
    rng = random.Random(args.seed)
    plan = []
    for split, n in (("train", n_train), ("val", n_val)):
        singles = round(n * SINGLE_CARD_FRAC)
        flags = [True] * singles + [False] * (n - singles)
        rng.shuffle(flags)
        plan.extend((split, single) for single in flags)

    tasks = []
    for k, (split, single) in enumerate(plan):
        seed = None if args.seed is None else args.seed + k
        tasks.append(
            (
                start + k,
                seed,
                card_paths,
                weights,
                args,
                img_dirs,
                lbl_dirs,
                split,
                single,
                debug_dir,
                bg_pools,
            )
        )

    n_single = sum(1 for _, single in plan if single)
    print(
        f"images:      {n_train} train / {n_val} val "
        f"(--val-frac {args.val_frac:g})"
    )
    print(f"card counts: {n_single} single / {len(plan) - n_single} hands")
    print(
        f"backgrounds: {len(train_bg)} train / {len(val_bg)} val "
        f"({VAL_BG_FRAC:g} held out for val)"
    )
    if append:
        print(f"appending:   starting at hand_{start:05d}")

    _run_tasks(tasks, args.workers, len(plan))

    print(f"{len(plan)} images -> {out_dir}")


if __name__ == "__main__":
    main()
