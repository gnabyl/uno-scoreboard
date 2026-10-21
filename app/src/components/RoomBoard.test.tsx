import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import RoomBoard from './RoomBoard';
import { addPlayer, setScore } from '../api-helper/rooms';
import { recognizeCards } from '../api-helper/cardRecognition';

vi.mock('../api-helper/localModel', () => ({
  preloadModel: () => Promise.resolve(null),
}));

vi.mock('../api-helper/cardRecognition', () => ({
  recognizeCards: vi.fn(),
}));

vi.mock('../api-helper/rooms', () => ({
  addPlayer: vi.fn().mockResolvedValue({ version: 2, playerId: 'x' }),
  addRound: vi.fn().mockResolvedValue({ version: 2, roundId: 'x' }),
  deletePlayer: vi.fn().mockResolvedValue(2),
  deleteRound: vi.fn().mockResolvedValue(2),
  resetRoom: vi.fn().mockResolvedValue(2),
  setScore: vi.fn().mockResolvedValue(2),
}));

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
  vi.clearAllMocks();
  // jsdom has no canvas implementation; the preview handles a null context.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
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
    value: '-25',
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
  vi.mocked(addPlayer).mockRejectedValueOnce(new Error('Name already taken'));

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

/** Walks through a scan and leaves the modal showing the detected cards. */
async function runScan() {
  vi.mocked(recognizeCards).mockResolvedValue({
    cards: ['reverse', 'draw_five'],
    detections: [
      {
        name: 'reverse',
        conf: 0.96,
        box: [10, 0, 50, 60],
        corners: [
          { x: 10, y: 0 },
          { x: 50, y: 0 },
          { x: 50, y: 60 },
          { x: 10, y: 60 },
        ],
      },
      {
        name: 'draw_five',
        conf: 0.5,
        box: [100, 0, 140, 60],
        corners: [
          { x: 100, y: 0 },
          { x: 140, y: 0 },
          { x: 140, y: 60 },
          { x: 100, y: 60 },
        ],
      },
    ],
    width: 640,
    height: 480,
  });

  render(<RoomBoard code="ABCDEFGH" snapshot={snapshot} onRefresh={() => {}} />);

  const scanButton = screen.getByRole('button', { name: /scan alice's cards for round 1/i });
  await waitFor(() => expect(scanButton).toBeEnabled());
  fireEvent.click(scanButton);

  // On a touch device the scan button opens the file picker; jsdom counts as
  // one, so the photo arrives through the capture input.
  const file = new File(['x'], 'cards.jpg', { type: 'image/jpeg' });
  for (const input of document.querySelectorAll('input[type="file"]')) {
    fireEvent.change(input, { target: { files: [file] } });
  }

  await waitFor(() => expect(screen.getByText('Detected cards')).toBeInTheDocument());
}

test('offers a box toggle on the scan preview', async () => {
  await runScan();

  const toggle = screen.getByRole('checkbox', { name: /show boxes/i });
  expect(toggle).not.toBeChecked();

  fireEvent.click(toggle);
  expect(toggle).toBeChecked();
});

test('applies the scanned score', async () => {
  await runScan();

  fireEvent.click(screen.getByRole('button', { name: /apply score/i }));

  await waitFor(() =>
    expect(setScore).toHaveBeenCalledWith('ABCDEFGH', {
      roundId: 'r1',
      playerId: 'p1',
      value: '-40',
      baseVersion: 3,
      previousValue: 10,
    }),
  );
});
