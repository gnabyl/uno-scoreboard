import { parseRoomCode } from './roomCode';

test('accepts a bare code', () => {
  expect(parseRoomCode('ABCDEFGH')).toBe('ABCDEFGH');
  expect(parseRoomCode('  abcdefgh ')).toBe('abcdefgh');
});

test('extracts a code from a room link', () => {
  expect(parseRoomCode('https://uno.example/r/ABCDEFGH')).toBe('ABCDEFGH');
  expect(parseRoomCode('https://uno.example/r/ABCDEFGH/')).toBe('ABCDEFGH');
  expect(parseRoomCode('uno.example/r/ABCDEFGH')).toBe('ABCDEFGH');
});

test('extracts a code from a query parameter', () => {
  expect(parseRoomCode('https://uno.example/?code=ABCDEFGH')).toBe('ABCDEFGH');
  expect(parseRoomCode('https://uno.example/?room=ABCDEFGH')).toBe('ABCDEFGH');
});

test('returns empty for empty input', () => {
  expect(parseRoomCode('')).toBe('');
  expect(parseRoomCode(null)).toBe('');
});
