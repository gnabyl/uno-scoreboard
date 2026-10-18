import { computeScore, scoreForCard } from './unoScoring';

test('scores number cards by face value', () => {
  expect(scoreForCard('red 7')).toBe(7);
  expect(scoreForCard('blue 0')).toBe(0);
  expect(scoreForCard('green 9')).toBe(9);
});

test('scores action cards as 20 points', () => {
  expect(scoreForCard('blue skip')).toBe(20);
  expect(scoreForCard('yellow reverse')).toBe(20);
  expect(scoreForCard('green draw two')).toBe(20);
  expect(scoreForCard('red draw 2')).toBe(20);
  expect(scoreForCard('flip')).toBe(20);
  expect(scoreForCard('draw_one')).toBe(20);
  expect(scoreForCard('draw_five')).toBe(20);
  expect(scoreForCard('skip_all')).toBe(20);
});

test('scores wild cards as 50 points', () => {
  expect(scoreForCard('wild')).toBe(50);
  expect(scoreForCard('wild draw four')).toBe(50);
  expect(scoreForCard('wild draw 4')).toBe(50);
});

test('computes the total of a hand', () => {
  expect(computeScore(['red 7', 'blue skip', 'wild draw four'])).toBe(77);
  expect(computeScore([])).toBe(0);
  expect(computeScore(null)).toBe(0);
});

test('handles hyphenated class names', () => {
  expect(scoreForCard('red-7')).toBe(7);
  expect(scoreForCard('draw-two')).toBe(20);
  expect(scoreForCard('wild-draw-four')).toBe(50);
  expect(computeScore(['yellow-3', 'draw-two', 'wild-draw-four'])).toBe(73);
});
