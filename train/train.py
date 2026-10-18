#!/usr/bin/env python3
"""Train a YOLO model on the generated hands dataset.

Dataset lives in ../data (see data/data.yaml). Results are written to
train/runs/.

Requires: pip install ultralytics

Usage:
    python train.py --epochs 100 --imgsz 640
"""

import argparse
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent  # train/
DATA_DIR = HERE.parent / "data"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="yolov8n.pt", help="base weights to fine-tune")
    ap.add_argument("--epochs", type=int, default=100)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument(
        "--workers",
        type=int,
        default=4,
        help="DataLoader worker processes (lower on Windows if you hit shared-memory errors)",
    )
    ap.add_argument(
        "--patience",
        type=int,
        default=50,
        help="stop early after this many epochs without mAP improvement",
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

    os.chdir(DATA_DIR)  # data.yaml uses relative paths (path: .)

    from ultralytics import YOLO

    if args.resume:
        # Resume from the most recent last.pt; load it as the model so
        # ultralytics restores the checkpoint's own run dir, optimizer and
        # epoch (a fresh project/name would create a new run and start at 1).
        ckpts = sorted(
            (HERE / "runs").glob("uno_flip*/weights/last.pt"),
            key=lambda p: p.stat().st_mtime,
        )
        if not ckpts:
            raise SystemExit(
                "no weights/last.pt found under train/runs to resume from"
            )
        model = YOLO(str(ckpts[-1]))
        model.train(
            data=str(DATA_DIR / "data.yaml"),
            epochs=args.epochs,
            imgsz=args.imgsz,
            batch=args.batch,
            workers=args.workers,
            resume=True,
        )
    else:
        model = YOLO(args.model)
        model.train(
            data=str(DATA_DIR / "data.yaml"),
            epochs=args.epochs,
            imgsz=args.imgsz,
            batch=args.batch,
            workers=args.workers,
            patience=args.patience,
            project=str(HERE / "runs"),
            name="uno_flip",
        )
    if args.export:
        model.export(format="onnx")


if __name__ == "__main__":
    main()
