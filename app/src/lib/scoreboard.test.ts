import { buildScoreboard } from './scoreboard';

const players = [
  { id: 'p1', name: 'Alice', seat: 1 },
  { id: 'p2', name: 'Bob', seat: 2 },
  { id: 'p3', name: 'Carol', seat: 3 },
];

test('treats the blank cell as the round winner', () => {
  const board = buildScoreboard(players, [
    { id: 'r1', seq: 1, scores: { p1: 10, p2: null, p3: 5 } },
  ]);

  expect(board.byRound.r1).toEqual({ id: 'r1', sum: 15, winner: 'p2' });
  expect(board.rows[0].cells).toEqual([
    { value: 10, winner: false },
    { value: null, winner: true },
    { value: 5, winner: false },
  ]);
  expect(board.totals).toEqual({ p1: 10, p2: 15, p3: 5 });
  expect(board.leaderIds).toEqual(['p2']);
});

test('counts an explicit 0 as a score, not a winner marker', () => {
  const board = buildScoreboard(players, [
    { id: 'r1', seq: 1, scores: { p1: 10, p2: null, p3: 0 } },
  ]);

  expect(board.byRound.r1.winner).toBe('p2');
  expect(board.rows[0].cells[2]).toEqual({ value: 0, winner: false });
  expect(board.totals).toEqual({ p1: 10, p2: 10, p3: 0 });
  expect(board.leaderIds).toEqual(['p1', 'p2']);
});

test('reports no winner when more than one cell is blank', () => {
  const board = buildScoreboard(players, [
    { id: 'r1', seq: 1, scores: { p1: 10, p2: null, p3: null } },
  ]);

  expect(board.byRound.r1).toEqual({ id: 'r1', sum: 10, winner: null });
  expect(board.rows[0].cells[1]).toEqual({ value: null, winner: false });
  expect(board.totals).toEqual({ p1: 10, p2: 0, p3: 0 });
  expect(board.leaderIds).toEqual(['p1']);
});

test('treats missing score keys as blank cells', () => {
  const board = buildScoreboard(players, [{ id: 'r1', seq: 1, scores: { p1: 12 } }]);

  expect(board.byRound.r1).toEqual({ id: 'r1', sum: 12, winner: null });
  expect(board.totals).toEqual({ p1: 12, p2: 0, p3: 0 });
});

test('adds each round winner bonus to their total', () => {
  const board = buildScoreboard(players, [
    { id: 'r1', seq: 1, scores: { p1: 10, p2: null, p3: 5 } },
    { id: 'r2', seq: 2, scores: { p1: null, p2: 6, p3: 4 } },
  ]);

  expect(board.rows.map((row) => row.index)).toEqual([1, 2]);
  expect(board.totals).toEqual({ p1: 20, p2: 21, p3: 9 });
  expect(board.leaderIds).toEqual(['p2']);
  expect(board.players.map((player) => [player.name, player.leader])).toEqual([
    ['Alice', false],
    ['Bob', true],
    ['Carol', false],
  ]);
});

test('has no leader when every cell is blank or an explicit 0', () => {
  const board = buildScoreboard(players, [
    { id: 'r1', seq: 1, scores: { p1: 0, p2: null, p3: null } },
  ]);

  expect(board.hasData).toBe(false);
  expect(board.leaderIds).toEqual([]);
  expect(board.players.every((player) => !player.leader)).toBe(true);
});

test('handles an empty board', () => {
  const board = buildScoreboard([], []);

  expect(board.rows).toEqual([]);
  expect(board.players).toEqual([]);
  expect(board.hasData).toBe(false);
  expect(board.leaderIds).toEqual([]);
});
