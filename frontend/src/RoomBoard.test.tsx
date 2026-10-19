import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const { addPlayer, setScore } = require('./api/rooms');

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

test('shows new-round and add-player controls but no reset control', () => {
  render(<RoomBoard code="ABCDEFGH" snapshot={snapshot} onRefresh={() => {}} />);

  expect(screen.getByRole('button', { name: /new player/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /reset/i })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /new round/i })).toBeInTheDocument();
});

test('adds a player from the modal', async () => {
  render(<RoomBoard code="ABCDEFGH" snapshot={snapshot} onRefresh={() => {}} />);

  fireEvent.click(screen.getByRole('button', { name: /new player/i }));
  fireEvent.change(screen.getByLabelText('New player name'), {
    target: { value: '  Carol  ' },
  });
  fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

  await waitFor(() => expect(addPlayer).toHaveBeenCalledWith('ABCDEFGH', 'Carol', 3));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('clears the name when the add-player modal is reopened', () => {
  render(<RoomBoard code="ABCDEFGH" snapshot={snapshot} onRefresh={() => {}} />);

  fireEvent.click(screen.getByRole('button', { name: /new player/i }));
  fireEvent.change(screen.getByLabelText('New player name'), {
    target: { value: 'Carol' },
  });
  fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
  fireEvent.click(screen.getByRole('button', { name: /new player/i }));

  expect(screen.getByLabelText('New player name')).toHaveValue('');
});

test('keeps the modal open and shows the error when adding fails', async () => {
  addPlayer.mockRejectedValueOnce(new Error('Name already taken'));

  render(<RoomBoard code="ABCDEFGH" snapshot={snapshot} onRefresh={() => {}} />);

  fireEvent.click(screen.getByRole('button', { name: /new player/i }));
  fireEvent.change(screen.getByLabelText('New player name'), {
    target: { value: 'Carol' },
  });
  fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Name already taken'));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

test('treats an explicit 0 as a score instead of a winner', () => {
  const zeroRound = {
    version: 4,
    me: 'p1',
    players: [
      { id: 'p1', name: 'Alice', seat: 1 },
      { id: 'p2', name: 'Bob', seat: 2 },
    ],
    rounds: [{ id: 'r1', seq: 1, scores: { p1: 10, p2: 0 } }],
  };

  render(<RoomBoard code="ABCDEFGH" snapshot={zeroRound} onRefresh={() => {}} />);

  expect(screen.queryByText('Bob won')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Bob round 1 score')).toHaveValue(0);
});

test('treats a persisted 0 for a late player as a score, not a win', () => {
  const snapshotWithZeroRow = {
    version: 4,
    me: 'p1',
    players: [
      { id: 'p1', name: 'Alice', seat: 1 },
      { id: 'p2', name: 'Bob', seat: 2 },
      { id: 'p3', name: 'Carol', seat: 3 },
    ],
    rounds: [{ id: 'r1', seq: 1, scores: { p1: 10, p2: null, p3: 0 } }],
  };

  render(<RoomBoard code="ABCDEFGH" snapshot={snapshotWithZeroRow} onRefresh={() => {}} />);

  expect(screen.getByText('Bob won')).toBeInTheDocument();
  expect(screen.getByLabelText('Carol round 1 score')).toHaveValue(0);
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
