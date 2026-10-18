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

test('renders players, rounds and totals', () => {
  render(<RoomBoard code="ABCDEFGH" snapshot={snapshot} onRefresh={() => {}} />);

  expect(screen.getByText('Alice')).toBeInTheDocument();
  expect(screen.getByText('Bob')).toBeInTheDocument();
  expect(screen.getByLabelText('Alice round 1 score')).toBeInTheDocument();
  expect(screen.getByText('Total')).toBeInTheDocument();
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
