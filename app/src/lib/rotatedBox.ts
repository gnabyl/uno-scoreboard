// Geometry helpers for oriented (rotated) bounding boxes.
//
// The detector is an OBB model: it predicts a centre, a width, a height and
// a rotation, and the cards in a hand are fanned, so their boxes are tilted.
// Comparing them with plain axis-aligned boxes would report a huge overlap
// between two cards that are clearly separate, so the overlap is computed
// on the real quads.
//
// The corner order and the angle convention match ultralytics'
// `xywhr2xyxyxyxy`, so the numbers coming out of the ONNX graph can be used
// as-is.

export interface Point {
  x: number;
  y: number;
}

/** A rotated box, in the parameterization the model emits. */
export interface RotatedBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Rotation in radians, measured from the width axis. */
  angle: number;
}

/**
 * The four corners of a rotated box, clockwise in image coordinates.
 */
export function corners(box: RotatedBox): Point[] {
  const cos = Math.cos(box.angle);
  const sin = Math.sin(box.angle);
  const halfWidth = box.w / 2;
  const halfHeight = box.h / 2;
  // v1 runs along the rotated width axis, v2 across it.
  const v1x = halfWidth * cos;
  const v1y = halfWidth * sin;
  const v2x = -halfHeight * sin;
  const v2y = halfHeight * cos;
  return [
    { x: box.cx + v1x + v2x, y: box.cy + v1y + v2y },
    { x: box.cx + v1x - v2x, y: box.cy + v1y - v2y },
    { x: box.cx - v1x - v2x, y: box.cy - v1y - v2y },
    { x: box.cx - v1x + v2x, y: box.cy - v1y + v2y },
  ];
}

/** The corners of an axis-aligned box, as a quad. */
export function rectangleCorners(box: [number, number, number, number]): Point[] {
  const [x1, y1, x2, y2] = box;
  return [
    { x: x1, y: y1 },
    { x: x2, y: y1 },
    { x: x2, y: y2 },
    { x: x1, y: y2 },
  ];
}

/** The axis-aligned bounds of a set of corners: `[x1, y1, x2, y2]`. */
export function bounds(points: Point[]): [number, number, number, number] {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function signedArea(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function polygonArea(points: Point[]): number {
  return Math.abs(signedArea(points));
}

/**
 * Clips a convex polygon against another convex polygon (Sutherland-Hodgman).
 * The result is the overlapping area, as a polygon.
 */
function clipPolygon(subject: Point[], clip: Point[]): Point[] {
  // `inside` depends on the winding order of the clip polygon, so the sign
  // is taken from the polygon itself rather than assumed.
  const orientation = signedArea(clip) >= 0 ? 1 : -1;
  let output = subject;

  for (let i = 0; i < clip.length && output.length > 0; i++) {
    const edgeStart = clip[i];
    const edgeEnd = clip[(i + 1) % clip.length];
    const input = output;
    output = [];

    for (let j = 0; j < input.length; j++) {
      const current = input[j];
      const previous = input[(j + input.length - 1) % input.length];
      const currentInside = isInside(current, edgeStart, edgeEnd, orientation);
      const previousInside = isInside(previous, edgeStart, edgeEnd, orientation);

      if (currentInside) {
        if (!previousInside) output.push(intersect(previous, current, edgeStart, edgeEnd));
        output.push(current);
      } else if (previousInside) {
        output.push(intersect(previous, current, edgeStart, edgeEnd));
      }
    }
  }

  return output;
}

function isInside(point: Point, a: Point, b: Point, orientation: number): boolean {
  const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
  return orientation * cross >= 0;
}

function intersect(p1: Point, p2: Point, a: Point, b: Point): Point {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = b.x - a.x;
  const d2y = b.y - a.y;
  const denominator = d1x * d2y - d1y * d2x;
  if (Math.abs(denominator) < 1e-12) return p2;
  const t = ((a.x - p1.x) * d2y - (a.y - p1.y) * d2x) / denominator;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}

/**
 * Intersection over union of two convex quads.
 */
export function quadIoU(a: Point[], b: Point[]): number {
  const areaA = polygonArea(a);
  const areaB = polygonArea(b);
  if (areaA <= 0 || areaB <= 0) return 0;
  const intersection = polygonArea(clipPolygon(a, b));
  const union = areaA + areaB - intersection;
  return union > 0 ? intersection / union : 0;
}
