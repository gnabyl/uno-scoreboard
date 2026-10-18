import { fireEvent, render, screen } from '@testing-library/react';
import RoomBoard from './RoomBoard';

jest.mock('./api/localModel', () => ({
  preloadModel: () => Promise.resolve(null),
}));

jest.mock('./api/rooms', () => ({
  addPlayer: jest.fn().mockResolvedValue({ version: 2, playerId: 'x' }),
  addRound: jest.fn().mockResolvedValue({ version: 2, roundId: 'x' }),
  deletePlayer: jest.fn().mockResolvedValue(2),
  deleteRound: jest.fn().mockResolvedValue(2),
  resetRoom: jest.fn().mockResolvedValue(2),
  setScore: jest.fn().mockResolvedValue(2),
}));

const { setScore } = require('./api/rooms');

const snapshot = {
  version: 3,
  me: 'p1',
  players: [
    { id: 'p1', name: 'Alice', seat: 1 },
    { id: 'p2', name: 'Bob', seat: 2 },
  ],
  rounds: [{ id: 'r1', seq: 1, scores: { p1: 10, p2: null } }],
};

beforeEach(() => {
  jest.clearAllMocks();
});

test('renders players, rounds and leaderboard', () => {
  render(<RoomBoard code="ABCDEFGH" snapshot={snapshot} onRefresh={() => {}} />);

  expect(screen.getAllByText('Alice').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Bob').length).toBeGreaterThan(0);
  expect(screen.getByText('Round 1')).toBeInTheDocument();
  expect(screen.getByLabelText('Alice round 1 score')).toBeInTheDocument();
});

test('commits a score edit on blur', () => {
  render(<RoomBoard code="ABCDEFGH" snapshot={snapshot} onRefresh={() => {}} />);

  const input = screen.getByLabelText('Alice round 1 score');
  fireEvent.change(input, { target: { value: '25' } });
  fireEvent.blur(input);

  expect(setScore).toHaveBeenCalledWith('ABCDEFGH', {
    roundId: 'r1',
    playerId: 'p1',
    value: '25',
    baseVersion: 3,
    previousValue: 10,
  });
});

test('has no add-player or reset controls', () => {
  render(<RoomBoard code="ABCDEFGH" snapshot={snapshot} onRefresh={() => {}} />);

  expect(screen.queryByPlaceholderText('Player name')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /reset/i })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /new round/i })).toBeInTheDocument();
});

test('collapses older rounds and keeps the newest open', () => {
  const twoRounds = {
    version: 4,
    me: 'p1',
    players: [{ id: 'p1', name: 'Alice', seat: 1 }],
    rounds: [
      { id: 'r1', seq: 1, scores: { p1: 10 } },
      { id: 'r2', seq: 2, scores: { p1: 5 } },
    ],
  };

  render(<RoomBoard code="ABCDEFGH" snapshot={twoRounds} onRefresh={() => {}} />);

  expect(screen.queryByLabelText('Alice round 1 score')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Alice round 2 score')).toBeInTheDocument();
});
