#!/usr/bin/env python3
"""Train a YOLO OBB model on the generated hands dataset.

Dataset lives in ../data (see data/data.yaml). Results are written to
train/runs/.

The labels are rotated boxes, so the checkpoint must be an OBB model
(yolo26n-obb.pt). Detection weights such as yolo26n.pt or yolov8n.pt have a
different head and would see no labels; train.py checks that up front.

Requires: pip install ultralytics

Usage:
    python train.py --epochs 100 --export
"""

import argparse
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent  # train/
DATA_DIR = HERE.parent / "data"
WEIGHTS_DIR = HERE.parent / "weights"

DEFAULT_WEIGHTS = "yolo26n-obb.pt"

# Pinned augmentations - not flags, because neither is ever right here:
# - mosaic tiles four photos into one sample, so cards get sliced at the tile
#   seams and labels are clipped to the tile; the generator already produces
#   crowded, overlapping hands at varied sizes.
# - a horizontal flip is not a real card: every class is a glyph, and
#   mirroring a 6 produces a fake 9.
PINNED_AUGMENT = {"mosaic": 0.0, "fliplr": 0.0}

# Values per label line for each Ultralytics task, used to catch a detect
# checkpoint being pointed at OBB labels (and vice versa).
TASK_LABEL_FIELDS = {"detect": 5, "obb": 9}


def default_model():
    """Prefer a local copy of the base weights, else let ultralytics fetch it."""
    local = WEIGHTS_DIR / DEFAULT_WEIGHTS
    return str(local) if local.exists() else DEFAULT_WEIGHTS


def resolve_model(spec):
    """Make a relative checkpoint path absolute before chdir'ing to data/.

    Bare names (`yolo26n-obb.pt`, `yolo26n-obb.yaml`) are left alone so
    ultralytics can resolve or download them.
    """
    path = Path(spec)
    return str(path.resolve()) if len(path.parts) > 1 else spec


def label_field_count():
    """Values per line in the first non-empty training label, or None."""
    labels = sorted((DATA_DIR / "hands" / "labels" / "train").glob("*.txt"))
    for path in labels:
        with open(path) as f:
            for line in f:
                if line.split():
                    return len(line.split())
    return None


def check_task(model):
    """Fail with a readable message when the model head cannot read the labels."""
    fields = label_field_count()
    if fields is None:
        raise SystemExit(
            "no training labels found under data/hands/labels/train - "
            "run data/compose_hands.py first"
        )
    task = getattr(model, "task", None)
    expected = TASK_LABEL_FIELDS.get(task)
    if expected is not None and expected != fields:
        hint = (
            f"pass an OBB checkpoint (e.g. --model {DEFAULT_WEIGHTS})"
            if fields == 9
            else "pass a detection checkpoint (e.g. --model yolo26n.pt)"
        )
        raise SystemExit(
            f"this checkpoint is a '{task}' model but the dataset has "
            f"{fields}-value labels; {hint}"
        )


def find_resume_model():
    """Newest last.pt whose task is OBB (older runs may be detect models)."""
    from ultralytics import YOLO

    candidates = sorted(
        (HERE / "runs").glob("uno_flip*/weights/last.pt"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for path in candidates:
        model = YOLO(str(path))
        if getattr(model, "task", None) == "obb":
            return model
    raise SystemExit(
        "no OBB checkpoint to resume from under train/runs "
        "(earlier runs used detection weights)"
    )


def export_onnx(weights, imgsz):
    """Export best weights to ONNX without baked NMS.

    YOLO26 heads are end-to-end, so the graph emits raw rows and the app does
    its own rotated, class-agnostic dedupe (ultralytics' built-in NMS is
    per-class, which is what produced duplicate boxes on real photos).
    """
    from ultralytics import YOLO

    out = YOLO(str(weights)).export(format="onnx", imgsz=imgsz, nms=False)
    print(f"exported {out}")
    print("  output (1, 300, 7): cx, cy, w, h, conf, class, angle (radians)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--model",
        default=default_model(),
        help=f"base weights to fine-tune (must be OBB, default {DEFAULT_WEIGHTS})",
    )
    ap.add_argument("--epochs", type=int, default=100)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument(
        "--workers",
        type=int,
        default=2,
        help="DataLoader worker processes (raise it if the GPU waits on data; Windows can hit shared-memory limits)",
    )
    ap.add_argument(
        "--patience",
        type=int,
        default=50,
        help="stop early after this many epochs without mAP improvement",
    )
    ap.add_argument(
        "--lr",
        type=float,
        default=None,
        help=(
            "initial learning rate (default: ultralytics' own schedule); a "
            "lower value such as 0.001 is the usual choice when fine-tuning "
            "an existing checkpoint"
        ),
    )
    ap.add_argument(
        "--device",
        default=None,
        help="training device, e.g. 0 or cpu (default: let ultralytics choose)",
    )
    ap.add_argument(
        "--resume",
        action="store_true",
        help="resume from the latest checkpoint (weights/last.pt) in the run dir",
    )
    ap.add_argument(
        "--export", action="store_true", help="export to ONNX after training"
    )
    args = ap.parse_args()

    # Resolve the checkpoint path BEFORE chdir'ing into data/: a relative path
    # like runs/uno_flip-3/weights/best.pt is given relative to the shell's
    # working directory, not to data/, so resolving it later would look for
    # data/runs/... and fail.
    model_spec = resolve_model(args.model)

    os.chdir(DATA_DIR)  # data.yaml uses relative paths (path: .)

    from ultralytics import YOLO

    model = find_resume_model() if args.resume else YOLO(model_spec)
    check_task(model)

    train_args = dict(
        data=str(DATA_DIR / "data.yaml"),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        workers=args.workers,
        device=args.device,
        **PINNED_AUGMENT,
    )
    if args.lr is not None:
        train_args["lr0"] = args.lr

    if args.resume:
        # Loading last.pt as the model makes ultralytics restore that run's
        # dir, optimizer and epoch; a fresh project/name would start over.
        model.train(**train_args, resume=True)
    else:
        model.train(
            **train_args,
            patience=args.patience,
            project=str(HERE / "runs"),
            name="uno_flip",
        )

    if args.export:
        save_dir = Path(model.trainer.save_dir)
        best = save_dir / "weights" / "best.pt"
        if not best.exists():
            best = save_dir / "weights" / "last.pt"
        if not best.exists():
            raise SystemExit(f"no checkpoint to export in {save_dir}")
        export_onnx(best, args.imgsz)


if __name__ == "__main__":
    main()
