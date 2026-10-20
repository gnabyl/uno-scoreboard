import { sortByReadingOrder } from './cardOrdering';

const card = (name: string, x1: number, y1: number, x2: number, y2: number) => ({
  name,
  box: [x1, y1, x2, y2],
});

const names = (cards: Array<{ name: string }>) => cards.map(({ name }) => name);

test('orders cards left to right, then row by row', () => {
  const detections = [
    card('bottom-right', 200, 300, 290, 400),
    card('top-right', 200, 100, 290, 200),
    card('bottom-left', 20, 305, 110, 405),
    card('top-left', 20, 95, 110, 195),
  ];

  expect(names(sortByReadingOrder(detections))).toEqual([
    'top-left',
    'top-right',
    'bottom-left',
    'bottom-right',
  ]);
});

test('keeps slightly unaligned cards in the same row', () => {
  const detections = [
    card('right', 160, 140, 250, 240),
    card('left', 20, 100, 110, 200),
    card('below', 20, 260, 110, 360),
  ];

  expect(names(sortByReadingOrder(detections))).toEqual(['left', 'right', 'below']);
});

test('returns an empty list unchanged', () => {
  expect(sortByReadingOrder([])).toEqual([]);
});

test('does not mutate the input order', () => {
  const detections = [card('right', 200, 0, 290, 100), card('left', 20, 0, 110, 100)];

  sortByReadingOrder(detections);

  expect(names(detections)).toEqual(['right', 'left']);
});
