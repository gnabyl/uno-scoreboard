// Parsing of the detector's output rows.
//
// The rotated (OBB) model emits one row per detection:
// [cx, cy, w, h, confidence, class_index, angle] in the letterboxed 640x640
// space. The older axis-aligned model emitted [x1, y1, x2, y2, confidence,
// class_index]. The row width tells the two apart, so the app can run
// against either export.

import { corners, quadIoU, rectangleCorners, type Point, type RotatedBox } from './rotatedBox';

/** A detection in the model's own coordinate space. */
export interface RawDetection {
  cls: number;
  conf: number;
  /** The four corners of the card. */
  corners: Point[];
}

/**
 * Overlap above which two detections are the same card.
 *
 * The NMS baked into the graph is class-wise, so this only has to merge one
 * card seen under two different class labels. Measured on real photos, those
 * pairs overlap by 0.86 and more, while two different cards in a fanned hand
 * already reach 0.72 - so the threshold sits in the gap between them.
 */
export const DEFAULT_DEDUPE_IOU = 0.8;

/**
 * Reads the detections out of the model's output tensor.
 */
export function readDetections(
  data: Float32Array,
  rows: number,
  columns: number,
  minConfidence: number,
): RawDetection[] {
  const detections: RawDetection[] = [];

  for (let i = 0; i < rows; i++) {
    const o = i * columns;
    const conf = data[o + 4];
    const cls = Math.round(data[o + 5]);
    if (conf < minConfidence) continue;

    if (columns >= 7) {
      const box: RotatedBox = {
        cx: data[o],
        cy: data[o + 1],
        w: data[o + 2],
        h: data[o + 3],
        angle: data[o + 6],
      };
      if (box.w <= 0 || box.h <= 0) continue;
      detections.push({ cls, conf, corners: corners(box) });
    } else {
      const x1 = data[o];
      const y1 = data[o + 1];
      const x2 = data[o + 2];
      const y2 = data[o + 3];
      if (x2 <= x1 || y2 <= y1) continue;
      detections.push({ cls, conf, corners: rectangleCorners([x1, y1, x2, y2]) });
    }
  }

  return detections;
}

/**
 * Drops the detections that are the same card: the graph's NMS is
 * class-wise, so a card read as two different classes is reported twice. The
 * best-scoring detection of a group wins.
 */
export function dedupeDetections(
  detections: RawDetection[],
  iouThreshold: number = DEFAULT_DEDUPE_IOU,
): RawDetection[] {
  const kept: RawDetection[] = [];

  for (const detection of [...detections].sort((a, b) => b.conf - a.conf)) {
    const duplicate = kept.some(
      (other) => quadIoU(other.corners, detection.corners) > iouThreshold,
    );
    if (!duplicate) kept.push(detection);
  }

  return kept;
}
