import {
  bounds,
  corners,
  quadIoU,
  rectangleCorners,
  type Point,
  type RotatedBox,
} from './rotatedBox';

const box = (cx: number, cy: number, w: number, h: number, angle = 0): RotatedBox => ({
  cx,
  cy,
  w,
  h,
  angle,
});

const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

test('an unrotated box has the expected corners', () => {
  const points = corners(box(100, 50, 40, 20));
  expect(points).toEqual([
    { x: 120, y: 60 },
    { x: 120, y: 40 },
    { x: 80, y: 40 },
    { x: 80, y: 60 },
  ]);
});

test('a quarter turn swaps the width and height', () => {
  const points = corners(box(0, 0, 40, 20, Math.PI / 2));
  const [x1, y1, x2, y2] = bounds(points);
  expect(close(x2 - x1, 20)).toBe(true);
  expect(close(y2 - y1, 40)).toBe(true);
});

test('bounds of a rotated box cover the corners', () => {
  const points = corners(box(200, 100, 80, 40, 0.6));
  const [x1, y1, x2, y2] = bounds(points);
  for (const point of points) {
    expect(point.x).toBeGreaterThanOrEqual(x1);
    expect(point.x).toBeLessThanOrEqual(x2);
    expect(point.y).toBeGreaterThanOrEqual(y1);
    expect(point.y).toBeLessThanOrEqual(y2);
  }
});

test('identical boxes have an IoU of one', () => {
  const a = corners(box(10, 10, 20, 10));
  expect(quadIoU(a, a)).toBeCloseTo(1, 6);
});

test('disjoint boxes have an IoU of zero', () => {
  const a = corners(box(0, 0, 10, 10));
  const b = corners(box(100, 100, 10, 10));
  expect(quadIoU(a, b)).toBe(0);
});

test('two boxes overlapping by half have an IoU of a third', () => {
  // 10x10 boxes side by side, overlapping by 5 units: intersection 50,
  // union 150.
  const a = corners(box(5, 5, 10, 10));
  const b = corners(box(10, 5, 10, 10));
  expect(quadIoU(a, b)).toBeCloseTo(50 / 150, 6);
});

test('rotated boxes that only overlap as axis-aligned boxes do not count as overlapping', () => {
  // Two long thin cards crossing at a right angle: their axis-aligned boxes
  // overlap almost completely, the quads do not.
  const a = corners(box(0, 0, 100, 20, 0));
  const b = corners(box(0, 0, 100, 20, Math.PI / 2));
  expect(quadIoU(a, b)).toBeLessThan(0.3);
});

test('an axis-aligned rectangle is treated as a quad', () => {
  const rectangle: Point[] = rectangleCorners([0, 0, 10, 10]);
  expect(quadIoU(rectangle, rectangle)).toBeCloseTo(1, 6);
  expect(quadIoU(rectangle, rectangleCorners([20, 20, 30, 30]))).toBe(0);
});
