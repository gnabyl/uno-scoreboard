#!/usr/bin/env python3
"""Live inspector for UNO Flip OBB checkpoints.

Opens a small Tk app that loads the best checkpoint from a training run and
runs it on photos you pick. By default it follows `best.pt` in the newest run
under `train/runs/` and reloads whenever that file changes, so you can watch a
training job improve without stopping it.

Checkpoints are copied before loading: the trainer keeps writing `last.pt`
between epochs and a half-written file would fail to load.

Requires: ultralytics, pillow (both already used for training).

Usage:
    ..\\.venv\\Scripts\\python.exe inspect_model.py
    ..\\.venv\\Scripts\\python.exe inspect_model.py --run runs/uno_flip-3
    ..\\.venv\\Scripts\\python.exe inspect_model.py --run runs/uno_flip-3 --image ..\\test_images\\testimage1.jpg
    ..\\.venv\\Scripts\\python.exe inspect_model.py --checkpoint last --device 0
"""

from __future__ import annotations

import argparse
import math
import os
import queue
import shutil
import tempfile
import time
import traceback
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageTk

HERE = Path(__file__).resolve().parent  # train/
RUNS_DIR = HERE / "runs"

IMAGE_FILETYPES = [
    ("Images", "*.jpg *.jpeg *.png *.webp *.bmp *.tif *.tiff"),
    ("All files", "*.*"),
]

# Bright enough to read on a photo; reused per class.
PALETTE = [
    (255, 82, 82),
    (255, 145, 0),
    (255, 213, 0),
    (124, 212, 42),
    (0, 200, 140),
    (0, 188, 212),
    (64, 145, 255),
    (140, 110, 255),
    (233, 74, 255),
    (255, 82, 148),
]


@dataclass(frozen=True)
class Checkpoint:
    path: Path
    run_dir: Path
    kind: str  # "last" or "best"
    mtime: float

    @property
    def run_name(self) -> str:
        return self.run_dir.name


@dataclass(frozen=True)
class LoadedModel:
    model: Any
    task: str
    epoch: int | None
    load_seconds: float


@dataclass(frozen=True)
class Detection:
    cls: int
    name: str
    conf: float
    cx: float
    cy: float
    w: float
    h: float
    angle: float


@dataclass(frozen=True)
class Prediction:
    image: Image.Image  # annotated copy
    original: Image.Image  # unannotated, kept so boxes can be toggled
    detections: list[Detection]
    seconds: float
    width: int
    height: int


class WrongTaskError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Checkpoint discovery


def _choose_weight(weights_dir: Path, kind: str) -> Path:
    paths = {"last": weights_dir / "last.pt", "best": weights_dir / "best.pt"}
    if kind == "auto":
        for candidate in ("last", "best"):
            if paths[candidate].exists():
                return paths[candidate]
        raise FileNotFoundError(f"no last.pt or best.pt in {weights_dir}")

    path = paths[kind]
    if not path.exists():
        others = ", ".join(p.name for p in paths.values() if p.exists()) or "none"
        raise FileNotFoundError(f"{path.name} not found in {weights_dir} (found: {others})")
    return path


def discover_checkpoint(run_arg: str | None, kind: str, runs_dir: Path) -> Checkpoint:
    """Newest checkpoint in a chosen run, or in the newest run overall."""
    if run_arg:
        path = Path(run_arg).expanduser()
        if not path.exists():
            # Allow --run uno_flip-3 instead of a full path.
            candidate = runs_dir / path
            if candidate.exists():
                path = candidate
        if not path.exists():
            raise FileNotFoundError(f"run or checkpoint not found: {path}")

        if path.is_file():
            run_dir = path.parent.parent if path.parent.name == "weights" else path.parent
            return Checkpoint(path, run_dir, path.stem, path.stat().st_mtime)

        weights_dir = path if path.name == "weights" else path / "weights"
        chosen = _choose_weight(weights_dir, kind)
        return Checkpoint(chosen, path if path.name != "weights" else path.parent, chosen.stem, chosen.stat().st_mtime)

    if not runs_dir.exists():
        raise FileNotFoundError(f"runs directory not found: {runs_dir}")

    candidates: list[Checkpoint] = []
    for weights_dir in sorted(runs_dir.glob("*/weights")):
        try:
            chosen = _choose_weight(weights_dir, kind)
        except FileNotFoundError:
            continue
        candidates.append(
            Checkpoint(chosen, weights_dir.parent, chosen.stem, chosen.stat().st_mtime)
        )

    if not candidates:
        mode = "a .pt checkpoint" if kind == "auto" else f"a {kind}.pt checkpoint"
        raise FileNotFoundError(f"no run under {runs_dir} has {mode}")

    # `last.pt` wins ties because it is the one written every epoch.
    return max(candidates, key=lambda c: (c.mtime, c.kind == "last"))


# ---------------------------------------------------------------------------
# Model loading / inference (runs on a worker thread)


def load_checkpoint(checkpoint: Checkpoint) -> LoadedModel:
    """Snapshot the checkpoint, then load it so a live trainer can't corrupt the read."""
    from ultralytics import YOLO

    started = time.perf_counter()
    last_error: Exception | None = None

    for attempt in range(4):
        fd, tmp_name = tempfile.mkstemp(prefix="uno-inspect-", suffix=".pt")
        os.close(fd)
        tmp_path = Path(tmp_name)
        try:
            shutil.copy2(checkpoint.path, tmp_path)
            model = YOLO(str(tmp_path))

            task = getattr(model, "task", None)
            if task != "obb":
                raise WrongTaskError(
                    f"{checkpoint.path.name} is a '{task}' model, not an OBB model"
                )

            epoch = None
            ckpt = getattr(model, "ckpt", None)
            if isinstance(ckpt, dict):
                value = ckpt.get("epoch")
                if isinstance(value, (int, float)):
                    epoch = int(value) + 1  # ultralytics stores the epoch 0-based

            return LoadedModel(
                model=model,
                task=task,
                epoch=epoch,
                load_seconds=time.perf_counter() - started,
            )
        except WrongTaskError:
            raise
        except Exception as exc:  # partial file, permission, torch load error
            last_error = exc
            if attempt < 3:
                time.sleep(0.6 * (attempt + 1))
        finally:
            try:
                tmp_path.unlink()
            except OSError:
                pass

    raise RuntimeError(
        f"could not load {checkpoint.path} - the trainer may still be writing it "
        f"({last_error})"
    ) from last_error


def _reading_order(detections: list[Detection]) -> list[Detection]:
    """Rows top-to-bottom, cards left-to-right, like the frontend app."""
    if len(detections) < 2:
        return list(detections)

    heights = sorted(d.h for d in detections)
    mid = len(heights) // 2
    median_h = (
        heights[mid]
        if len(heights) % 2
        else (heights[mid - 1] + heights[mid]) / 2
    )
    tolerance = max(median_h * 0.5, 1.0)

    rows: list[dict[str, Any]] = []
    for det in sorted(detections, key=lambda d: (d.cy, d.cx)):
        if rows and abs(det.cy - rows[-1]["cy"]) <= tolerance:
            row = rows[-1]
            row["items"].append(det)
            row["cy"] = sum(item.cy for item in row["items"]) / len(row["items"])
        else:
            rows.append({"cy": det.cy, "items": [det]})

    ordered: list[Detection] = []
    for row in rows:
        ordered.extend(sorted(row["items"], key=lambda d: (d.cx, d.cy)))
    return ordered


def _obb_corners(det: Detection) -> list[tuple[float, float]]:
    cos_a, sin_a = math.cos(det.angle), math.sin(det.angle)
    hw, hh = det.w / 2.0, det.h / 2.0
    corners = []
    for dx, dy in ((-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)):
        corners.append(
            (det.cx + dx * cos_a - dy * sin_a, det.cy + dx * sin_a + dy * cos_a)
        )
    return corners


@lru_cache(maxsize=32)
def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for name in ("segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def annotate(
    image: Image.Image,
    detections: list[Detection],
    visible: list[int] | None = None,
) -> Image.Image:
    base = image.convert("RGBA")
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    line_width = max(2, round(min(base.size) / 320))
    font_size = max(13, round(min(base.size) / 42))
    font = _font(font_size)
    pad = max(3, font_size // 4)

    for index in range(len(detections)) if visible is None else visible:
        det = detections[index]
        color = PALETTE[det.cls % len(PALETTE)]
        points = _obb_corners(det)
        draw.polygon(points, fill=color + (48,))
        draw.line(points + [points[0]], fill=color + (255,), width=line_width, joint="curve")

        text = f"{det.name} {det.conf:.2f}"
        bbox = draw.textbbox((0, 0), text, font=font)
        text_w, text_h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]

        left = min(xs)
        top = min(ys) - text_h - pad * 2
        if top < 0:
            top = min(max(ys) + pad, base.height - text_h - pad * 2)
        left = min(max(left, 0), max(base.width - text_w - pad * 2, 0))

        draw.rectangle(
            [left, top, left + text_w + pad * 2, top + text_h + pad * 2],
            fill=color + (225,),
        )
        draw.text((left + pad, top + pad - bbox[1]), text, font=font, fill=(12, 12, 12, 255))

    return Image.alpha_composite(base, overlay).convert("RGB")


def run_prediction(
    model: Any,
    image_path: Path,
    confidence: float,
    imgsz: int,
    device: str,
) -> Prediction:
    started = time.perf_counter()

    # Pass the PIL image (not a path) so EXIF rotation is applied to the same
    # pixels that get drawn on.
    with Image.open(image_path) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
    width, height = image.size

    results = model.predict(
        source=image,
        imgsz=imgsz,
        conf=confidence,
        device=device,
        verbose=False,
    )
    result = results[0]
    obb = getattr(result, "obb", None)

    names = getattr(model, "names", {}) or {}
    if not isinstance(names, dict):
        names = dict(enumerate(names))

    detections: list[Detection] = []
    if obb is not None and len(obb):
        xywhr = obb.xywhr.cpu().numpy()
        confs = obb.conf.cpu().numpy()
        classes = obb.cls.cpu().numpy()
        for (cx, cy, w, h, angle), conf, cls in zip(xywhr, confs, classes):
            cls_index = int(round(float(cls)))
            detections.append(
                Detection(
                    cls=cls_index,
                    name=str(names.get(cls_index, cls_index)),
                    conf=float(conf),
                    cx=float(cx),
                    cy=float(cy),
                    w=float(w),
                    h=float(h),
                    angle=float(angle),
                )
            )

    detections = _reading_order(detections)
    return Prediction(
        image=annotate(image, detections),
        original=image,
        detections=detections,
        seconds=time.perf_counter() - started,
        width=width,
        height=height,
    )


# ---------------------------------------------------------------------------
# Tk app


class InspectorApp:
    def __init__(self, root: tk.Tk, args: argparse.Namespace) -> None:
        self.root = root
        self.args = args
        self.runs_dir = args.runs_dir

        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="uno-inspect")
        self.events: queue.Queue[tuple[Any, ...]] = queue.Queue()

        self.model: Any | None = None
        self.loaded: Checkpoint | None = None
        self.epoch: int | None = None
        self.loading = False
        self.reload_when_idle = False
        self.retry_after = 0.0
        self.load_gen = 0
        self.predict_gen = 0

        self.image_path: Path | None = None
        self.annotated: Image.Image | None = None
        self.original: Image.Image | None = None
        self.prediction: Prediction | None = None
        self.box_enabled: list[bool] = []
        self._photo: ImageTk.PhotoImage | None = None
        self._render_job: str | None = None

        self._build_ui()
        self.root.after(50, self._drain_events)
        self.root.after(int(max(args.interval, 0.5) * 1000), self._poll)

        if args.image:
            path = Path(args.image).expanduser()
            if path.exists():
                self.image_path = path
                self.root.title(f"{path.name} - UNO Flip checkpoint inspector")
            else:
                self._error(f"Image not found: {path}")

        self.root.after(100, lambda: self._follow(force=True))

    # -- layout ------------------------------------------------------------

    def _build_ui(self) -> None:
        self.root.title("UNO Flip checkpoint inspector")
        screen_w = self.root.winfo_screenwidth()
        screen_h = self.root.winfo_screenheight()
        width = min(1400, max(1000, screen_w - 80))
        height = min(840, max(620, screen_h - 120))
        self.root.geometry(f"{width}x{height}")
        self.root.minsize(1000, 620)

        toolbar = ttk.Frame(self.root, padding=(8, 7))
        toolbar.pack(side="top", fill="x")

        actions = ttk.Frame(toolbar)
        actions.pack(fill="x")
        ttk.Button(actions, text="Open photo...", command=self._open_image).pack(side="left")
        ttk.Button(actions, text="Rerun", command=self._rerun).pack(side="left", padx=(6, 0))
        ttk.Button(actions, text="Reload checkpoint", command=self._reload).pack(
            side="left", padx=(6, 0)
        )
        ttk.Button(actions, text="Save annotated...", command=self._save_annotated).pack(
            side="left", padx=(6, 0)
        )

        options = ttk.Frame(toolbar)
        options.pack(fill="x", pady=(7, 0))

        ttk.Label(options, text="Confidence").pack(side="left")
        self.conf_var = tk.DoubleVar(value=self.args.conf)
        self.conf_scale = ttk.Scale(
            options,
            from_=0.05,
            to=0.9,
            variable=self.conf_var,
            length=150,
            command=self._conf_changed,
        )
        self.conf_scale.pack(side="left", padx=(6, 4))
        self.conf_scale.bind("<ButtonRelease-1>", lambda _event: self._rerun())
        self.conf_label = ttk.Label(options, text=f"{self.args.conf:.2f}", width=5)
        self.conf_label.pack(side="left")

        ttk.Separator(options, orient="vertical").pack(side="left", fill="y", padx=12)

        self.follow_var = tk.BooleanVar(value=not self.args.no_follow)
        ttk.Checkbutton(
            options,
            text="Follow newest checkpoint",
            variable=self.follow_var,
        ).pack(side="left")

        ttk.Separator(options, orient="vertical").pack(side="left", fill="y", padx=12)

        ttk.Label(options, text="Weights").pack(side="left")
        self.checkpoint_var = tk.StringVar(value=self.args.checkpoint)
        checkpoint_box = ttk.Combobox(
            options,
            textvariable=self.checkpoint_var,
            values=("auto", "last", "best"),
            state="readonly",
            width=6,
        )
        checkpoint_box.pack(side="left", padx=(6, 0))
        checkpoint_box.bind("<<ComboboxSelected>>", self._checkpoint_kind_changed)

        ttk.Separator(options, orient="vertical").pack(side="left", fill="y", padx=12)
        ttk.Label(options, text="Boxes").pack(side="left")
        ttk.Button(options, text="All", width=4, command=self._show_all_boxes).pack(
            side="left", padx=(6, 0)
        )
        ttk.Button(options, text="None", width=5, command=self._hide_all_boxes).pack(
            side="left", padx=(4, 0)
        )

        self.info_var = tk.StringVar(value="Looking for a checkpoint...")
        info = ttk.Label(
            self.root,
            textvariable=self.info_var,
            padding=(10, 3),
            anchor="w",
            foreground="#333333",
        )
        info.pack(side="top", fill="x")

        panes = ttk.Panedwindow(self.root, orient="horizontal")
        panes.pack(side="top", fill="both", expand=True)

        left = ttk.Frame(panes)
        right = ttk.Frame(panes, padding=(8, 4), width=440)
        right.pack_propagate(False)
        panes.add(left, weight=1)
        panes.add(right, weight=0)

        self.canvas = tk.Canvas(left, background="#1b1b1b", highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<Configure>", self._schedule_render)

        self.result_var = tk.StringVar(value="No photo loaded.")
        ttk.Label(
            right,
            textvariable=self.result_var,
            wraplength=395,
            justify="left",
            font=("Segoe UI", 10, "bold"),
        ).pack(side="top", fill="x", pady=(0, 6))

        table = ttk.Frame(right)
        table.pack(side="top", fill="both", expand=True)
        table.columnconfigure(0, weight=1)
        table.rowconfigure(0, weight=1)

        columns = ("box", "card", "conf", "angle", "cx", "cy", "w", "h")
        self.tree = ttk.Treeview(table, columns=columns, show="headings", height=22)
        headings = {
            "box": ("Box", 38),
            "card": ("Card", 90),
            "conf": ("Conf", 46),
            "angle": ("Angle", 46),
            "cx": ("x", 42),
            "cy": ("y", 42),
            "w": ("w", 40),
            "h": ("h", 40),
        }
        for key, (label, width) in headings.items():
            self.tree.heading(key, text=label)
            anchor = "w" if key == "card" else "e" if key != "box" else "center"
            self.tree.column(key, width=width, minwidth=34, anchor=anchor, stretch=key == "card")
        self.tree.tag_configure("hidden", foreground="#999999")
        scrollbar = ttk.Scrollbar(table, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scrollbar.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        scrollbar.grid(row=0, column=1, sticky="ns")
        self.tree.bind("<Button-1>", self._tree_click)
        self.tree.bind("<space>", self._tree_space)

        ttk.Label(
            right,
            text="Click a Box cell (or press Space) to hide/show that card's box. Angle is in degrees; no class-agnostic dedupe is applied.",
            wraplength=405,
            justify="left",
            foreground="#666666",
        ).pack(side="bottom", fill="x", pady=(6, 0))

        self.status_var = tk.StringVar(value="Ready.")
        ttk.Label(
            self.root,
            textvariable=self.status_var,
            padding=(8, 3),
            relief="sunken",
            anchor="w",
        ).pack(side="bottom", fill="x")

        self.root.bind("<Control-o>", lambda _event: self._open_image())
        self.root.bind("<F5>", lambda _event: self._reload())
        self.root.bind("<Control-s>", lambda _event: self._save_annotated())
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    # -- checkpoint loading ------------------------------------------------

    def _follow(self, force: bool = False) -> None:
        if self.loading:
            return
        try:
            checkpoint = discover_checkpoint(
                self.args.run, self.args.checkpoint, self.runs_dir
            )
        except OSError as exc:
            if force or self.model is None:
                self.info_var.set(str(exc))
                self._error(str(exc))
            return

        if force or self.model is None or checkpoint != self.loaded:
            if time.time() >= self.retry_after:
                self._start_load(checkpoint)
        else:
            self._show_checkpoint(checkpoint)

    def _start_load(self, checkpoint: Checkpoint) -> None:
        self.loading = True
        self.load_gen += 1
        self.predict_gen += 1  # discard any inference still in flight
        gen = self.load_gen

        self._show_checkpoint(checkpoint)
        self._status(
            f"Loading {checkpoint.run_name}/{checkpoint.path.name} "
            f"on {self.args.device}..."
        )
        self.pool.submit(self._load_job, gen, checkpoint)

    def _load_job(self, gen: int, checkpoint: Checkpoint) -> None:
        try:
            loaded = load_checkpoint(checkpoint)
            self.events.put(("load_ok", gen, checkpoint, loaded))
        except Exception as exc:
            self.events.put(
                ("load_err", gen, checkpoint, exc, traceback.format_exc())
            )

    def _show_checkpoint(self, checkpoint: Checkpoint) -> None:
        epoch = ""
        if self.loaded == checkpoint and self.epoch is not None:
            epoch = f" - epoch {self.epoch}"
        stamp = datetime.fromtimestamp(checkpoint.mtime).strftime("%Y-%m-%d %H:%M:%S")
        self.info_var.set(
            f"{checkpoint.run_name} / {checkpoint.path.name}{epoch}  -  "
            f"saved {stamp}  -  task obb  -  device {self.args.device}"
        )

    # -- inference ---------------------------------------------------------

    def _rerun(self) -> None:
        if self.loading:
            return
        if self.model is None:
            self._follow(force=True)
            return
        if self.image_path is None:
            self._status("Open a photo first.")
            return
        self._start_predict()

    def _start_predict(self) -> None:
        if self.model is None or self.image_path is None or self.loading:
            return

        self.predict_gen += 1
        gen = self.predict_gen
        model = self.model
        path = self.image_path
        confidence = float(self.conf_var.get())

        self._status(
            f"Running {path.name} at confidence {confidence:.2f} on {self.args.device}..."
        )
        self.pool.submit(
            self._predict_job, gen, model, path, confidence
        )

    def _predict_job(self, gen: int, model: Any, path: Path, confidence: float) -> None:
        try:
            prediction = run_prediction(
                model,
                path,
                confidence,
                self.args.imgsz,
                self.args.device,
            )
            self.events.put(("pred_ok", gen, path, prediction))
        except Exception as exc:
            self.events.put(
                ("pred_err", gen, path, exc, traceback.format_exc())
            )

    def _open_image(self) -> None:
        path = filedialog.askopenfilename(
            title="Choose a photo",
            filetypes=IMAGE_FILETYPES,
            initialdir=str(self.image_path.parent if self.image_path else HERE.parent / "test_images"),
        )
        if not path:
            return

        self.image_path = Path(path)
        self.root.title(f"{self.image_path.name} - UNO Flip checkpoint inspector")
        self._status(f"Loaded {self.image_path.name}")

        if self.model is None:
            self._follow(force=True)
        else:
            self._start_predict()

    # -- event pump --------------------------------------------------------

    def _drain_events(self) -> None:
        while True:
            try:
                event = self.events.get_nowait()
            except queue.Empty:
                break

            kind = event[0]
            if kind == "load_ok":
                _, gen, checkpoint, loaded = event
                if gen != self.load_gen:
                    continue
                self.loading = False
                self.retry_after = 0.0
                self.model = loaded.model
                self.loaded = checkpoint
                self.epoch = loaded.epoch
                self._show_checkpoint(checkpoint)
                self._status(
                    f"Loaded {checkpoint.path} in {loaded.load_seconds:.1f}s."
                )
                if self.image_path is not None and not self.reload_when_idle:
                    self._start_predict()
                if self.reload_when_idle:
                    self.reload_when_idle = False
                    self.root.after(50, self._reload)

            elif kind == "load_err":
                _, gen, checkpoint, exc, trace = event
                if gen != self.load_gen:
                    continue
                self.loading = False
                self.retry_after = time.time() + 8.0
                if self.model is not None and self.loaded is not None:
                    self._show_checkpoint(self.loaded)
                self._error(f"Could not load {checkpoint.path}: {exc}")
                if self.follow_var.get():
                    self._status(
                        f"Could not load {checkpoint.path.name}: {exc} - retrying shortly."
                    )
                print(trace, flush=True)
                if self.reload_when_idle:
                    self.reload_when_idle = False
                    self.root.after(50, self._reload)

            elif kind == "pred_ok":
                _, gen, path, prediction = event
                if gen != self.predict_gen:
                    continue
                self.prediction = prediction
                self.original = prediction.original
                self.annotated = prediction.image
                self.box_enabled = [True] * len(prediction.detections)
                self._render_canvas()
                self._fill_results(path, prediction)
                self._status(
                    f"{len(prediction.detections)} cards in "
                    f"{prediction.seconds * 1000:.0f} ms on {self.args.device}."
                )

            elif kind == "pred_err":
                _, gen, path, exc, trace = event
                if gen != self.predict_gen:
                    continue
                self._error(f"Inference failed on {path.name}: {exc}")
                print(trace, flush=True)

        self.root.after(50, self._drain_events)

    def _poll(self) -> None:
        if self.follow_var.get():
            self._follow()
        self.root.after(int(max(self.args.interval, 0.5) * 1000), self._poll)

    # -- rendering ---------------------------------------------------------

    def _fill_results(self, path: Path, prediction: Prediction) -> None:
        self.tree.delete(*self.tree.get_children())
        for index, det in enumerate(prediction.detections):
            self.tree.insert(
                "",
                "end",
                iid=str(index),
                values=self._row_values(index, det),
                tags=() if self.box_enabled[index] else ("hidden",),
            )

        counts = Counter(det.name for det in prediction.detections)
        if counts:
            detail = ", ".join(f"{name} x{count}" for name, count in counts.most_common())
            summary = f"{len(prediction.detections)} cards: {detail}"
        else:
            summary = (
                f"No cards above confidence {float(self.conf_var.get()):.2f} "
                f"({prediction.width}x{prediction.height})."
            )
        self.result_var.set(
            f"{path.name} ({prediction.width}x{prediction.height})\n{summary}"
        )

    def _row_values(self, index: int, det: Detection) -> tuple[str, ...]:
        return (
            "on" if self.box_enabled[index] else "off",
            det.name,
            f"{det.conf:.3f}",
            f"{math.degrees(det.angle):.1f}",
            f"{det.cx:.0f}",
            f"{det.cy:.0f}",
            f"{det.w:.0f}",
            f"{det.h:.0f}",
        )

    def _refresh_row(self, index: int) -> None:
        if self.prediction is None or not 0 <= index < len(self.prediction.detections):
            return
        det = self.prediction.detections[index]
        self.tree.item(
            str(index),
            values=self._row_values(index, det),
            tags=() if self.box_enabled[index] else ("hidden",),
        )

    def _tree_click(self, event: Any) -> str | None:
        if self.tree.identify_region(event.x, event.y) not in ("cell", "tree"):
            return None
        if self.tree.identify_column(event.x) != "#1":
            return None
        iid = self.tree.identify_row(event.y)
        if iid:
            self._toggle_box(int(iid))
            return "break"
        return None

    def _tree_space(self, _event: Any) -> str:
        for iid in self.tree.selection():
            self._toggle_box(int(iid))
        return "break"

    def _toggle_box(self, index: int) -> None:
        if self.prediction is None or not 0 <= index < len(self.box_enabled):
            return
        self.box_enabled[index] = not self.box_enabled[index]
        self._refresh_row(index)
        self._reannotate()

    def _show_all_boxes(self) -> None:
        self._set_all_boxes(True)

    def _hide_all_boxes(self) -> None:
        self._set_all_boxes(False)

    def _set_all_boxes(self, enabled: bool) -> None:
        if self.prediction is None:
            self._status("Open a photo first.")
            return
        self.box_enabled = [enabled] * len(self.prediction.detections)
        for index in range(len(self.box_enabled)):
            self._refresh_row(index)
        self._reannotate()
        self._status(f"{'Showing' if enabled else 'Hiding'} all card boxes.")

    def _reannotate(self) -> None:
        if self.prediction is None or self.original is None:
            return
        visible = [index for index, enabled in enumerate(self.box_enabled) if enabled]
        self.annotated = annotate(
            self.original, self.prediction.detections, visible
        )
        self._render_canvas()

    def _schedule_render(self, _event: Any = None) -> None:
        if self._render_job is not None:
            self.root.after_cancel(self._render_job)
        self._render_job = self.root.after(90, self._render_canvas)

    def _render_canvas(self) -> None:
        self._render_job = None
        self.canvas.delete("all")
        width = self.canvas.winfo_width()
        height = self.canvas.winfo_height()

        if self.annotated is None:
            if width > 10 and height > 10:
                self.canvas.create_text(
                    width / 2,
                    height / 2,
                    text="Open a photo to inspect the checkpoint",
                    fill="#888888",
                    font=("Segoe UI", 14),
                )
            return

        if width < 10 or height < 10:
            return

        image_w, image_h = self.annotated.size
        scale = min(width / image_w, height / image_h)
        target = (
            max(1, round(image_w * scale)),
            max(1, round(image_h * scale)),
        )
        display = self.annotated
        if target != self.annotated.size:
            display = self.annotated.resize(target, Image.Resampling.LANCZOS)

        self._photo = ImageTk.PhotoImage(display)
        self.canvas.create_image(width / 2, height / 2, anchor="center", image=self._photo)

    # -- actions -----------------------------------------------------------

    def _conf_changed(self, _value: str = "") -> None:
        self.conf_label.configure(text=f"{self.conf_var.get():.2f}")

    def _reload(self) -> None:
        if self.loading:
            self.reload_when_idle = True
            self._status("Will reload when the current load finishes.")
            return
        self.retry_after = 0.0
        self._follow(force=True)

    def _checkpoint_kind_changed(self, _event: Any = None) -> None:
        self.args.checkpoint = self.checkpoint_var.get()
        self.retry_after = 0.0
        self._reload()

    def _save_annotated(self) -> None:
        if self.annotated is None:
            messagebox.showinfo("Nothing to save", "Run a photo first.")
            return

        source = self.image_path or Path("photo")
        initial = source.with_name(f"{source.stem}_annotated.jpg")
        path = filedialog.asksaveasfilename(
            title="Save annotated photo",
            initialdir=str(initial.parent),
            initialfile=initial.name,
            defaultextension=".jpg",
            filetypes=[("JPEG", "*.jpg"), ("PNG", "*.png")],
        )
        if not path:
            return

        try:
            target = Path(path)
            if target.suffix.lower() in (".jpg", ".jpeg"):
                self.annotated.save(target, quality=95, subsampling=0)
            else:
                self.annotated.save(target)
            self._status(f"Saved {target}")
        except Exception as exc:
            self._error(f"Could not save: {exc}")

    # -- helpers -----------------------------------------------------------

    def _status(self, text: str) -> None:
        self.status_var.set(text)

    def _error(self, text: str) -> None:
        self.status_var.set(text)
        print(text, flush=True)

    def _on_close(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=True)
        self.root.destroy()


# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Inspect the newest UNO Flip OBB checkpoint on photos while training runs.",
    )
    parser.add_argument(
        "--run",
        help="run directory or .pt file (default: newest run under --runs-dir)",
    )
    parser.add_argument(
        "--checkpoint",
        choices=("auto", "last", "best"),
        default="best",
        help="which weight to use in the run (default: best.pt; auto = last.pt, else best.pt)",
    )
    parser.add_argument(
        "--runs-dir",
        type=Path,
        default=RUNS_DIR,
        help=f"directory holding ultralytics runs (default: {RUNS_DIR})",
    )
    parser.add_argument("--conf", type=float, default=0.25, help="confidence threshold")
    parser.add_argument("--imgsz", type=int, default=640, help="inference image size")
    parser.add_argument(
        "--device",
        default="cpu",
        help="ultralytics device: cpu, 0, 0,1 (default: cpu, so training keeps the GPU)",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=3.0,
        help="seconds between checkpoint checks (default: 3)",
    )
    parser.add_argument("--image", type=Path, help="photo to open at startup")
    parser.add_argument(
        "--no-follow",
        action="store_true",
        help="do not auto-reload when the checkpoint changes",
    )
    args = parser.parse_args()

    if not 0.0 <= args.conf <= 1.0:
        parser.error("--conf must be between 0 and 1")
    if args.imgsz <= 0:
        parser.error("--imgsz must be positive")
    if args.interval <= 0:
        parser.error("--interval must be positive")
    return args


def main() -> None:
    args = parse_args()
    # Crisper text on high-DPI Windows displays; harmless elsewhere.
    try:
        import ctypes

        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass

    root = tk.Tk()
    InspectorApp(root, args)
    root.mainloop()


if __name__ == "__main__":
    main()
