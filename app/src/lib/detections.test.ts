import { vi } from 'vitest';
import { dedupeDetections, readDetections } from './detections';

const NAMES = [
  'wild_color',
  'wild_draw_two',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'flip',
  'draw_one',
  'skip',
  'reverse',
  'wild_draw_until',
  'draw_five',
  'skip_all',
];

const rotatedRow = (
  cx: number,
  cy: number,
  w: number,
  h: number,
  conf: number,
  cls: number,
  angle = 0,
) => [cx, cy, w, h, conf, cls, angle];

beforeEach(() => {
  // Ignore a VITE_DEDUPE_IOU in the local .env, so the tests always check the
  // shipped default.
  vi.stubEnv('VITE_DEDUPE_IOU', '');
});

test('reads rotated rows as boxes with corners', () => {
  const data = new Float32Array(rotatedRow(100, 50, 40, 20, 0.9, 4, 0));
  const detections = readDetections(data, 1, 7, 0.25);

  expect(detections).toHaveLength(1);
  expect(detections[0].cls).toBe(4);
  expect(detections[0].conf).toBeCloseTo(0.9);
  expect(NAMES[detections[0].cls]).toBe('3');
  expect(detections[0].corners).toHaveLength(4);
});

test('drops rows below the confidence threshold', () => {
  const data = new Float32Array([
    ...rotatedRow(100, 50, 40, 20, 0.1, 4),
    ...rotatedRow(10, 10, 10, 10, 0.8, 5),
  ]);
  const detections = readDetections(data, 2, 7, 0.25);

  expect(detections).toHaveLength(1);
  expect(detections[0].cls).toBe(5);
});

test('drops rows without a usable box', () => {
  const data = new Float32Array([
    ...rotatedRow(100, 50, 0, 20, 0.9, 4),
    ...rotatedRow(10, 10, 10, 10, 0.8, 5),
  ]);
  expect(readDetections(data, 2, 7, 0.25)).toHaveLength(1);
});

test('still understands the older axis-aligned rows', () => {
  const data = new Float32Array([10, 20, 110, 120, 0.9, 3]);
  const detections = readDetections(data, 1, 6, 0.25);

  expect(detections).toHaveLength(1);
  expect(detections[0].cls).toBe(3);
  expect(detections[0].corners[0]).toEqual({ x: 10, y: 20 });
  expect(detections[0].corners[2]).toEqual({ x: 110, y: 120 });
});

test('merges the same card reported under two classes', () => {
  const data = new Float32Array([
    ...rotatedRow(100, 100, 80, 50, 0.95, 14),
    ...rotatedRow(102, 101, 80, 50, 0.9, 15),
  ]);
  const detections = dedupeDetections(readDetections(data, 2, 7, 0.25));

  expect(detections).toHaveLength(1);
  expect(detections[0].cls).toBe(14);
});

test('keeps two different cards that overlap', () => {
  const data = new Float32Array([
    ...rotatedRow(100, 100, 80, 50, 0.95, 14),
    ...rotatedRow(160, 100, 80, 50, 0.9, 15),
  ]);
  const detections = dedupeDetections(readDetections(data, 2, 7, 0.25));

  expect(detections).toHaveLength(2);
});

test('keeps the best-scoring detection of a group', () => {
  const data = new Float32Array([
    ...rotatedRow(100, 100, 80, 50, 0.4, 14),
    ...rotatedRow(100, 100, 80, 50, 0.95, 15),
  ]);
  const detections = dedupeDetections(readDetections(data, 2, 7, 0.25));

  expect(detections).toHaveLength(1);
  expect(detections[0].cls).toBe(15);
});

test('the merge can be switched off with VITE_DEDUPE_IOU=1', () => {
  vi.stubEnv('VITE_DEDUPE_IOU', '1');
  const data = new Float32Array([
    ...rotatedRow(100, 100, 80, 50, 0.95, 14),
    ...rotatedRow(102, 101, 80, 50, 0.9, 15),
  ]);
  const detections = dedupeDetections(readDetections(data, 2, 7, 0.25));

  expect(detections).toHaveLength(2);
});
