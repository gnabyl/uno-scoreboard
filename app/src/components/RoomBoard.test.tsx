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
async function runScan(count = 2) {
  const detections = Array.from({ length: count }, (_, i) => ({
    name: i % 2 === 0 ? 'reverse' : 'draw_five',
    conf: 0.9,
    box: [i * 10, 0, i * 10 + 40, 60],
    corners: [
      { x: i * 10, y: 0 },
      { x: i * 10 + 40, y: 0 },
      { x: i * 10 + 40, y: 60 },
      { x: i * 10, y: 60 },
    ],
  }));

  vi.mocked(recognizeCards).mockResolvedValue({
    cards: detections.map((detection) => detection.name),
    detections,
    width: 640,
    height: 480,
    image: new Blob(['photo'], { type: 'image/jpeg' }),
  });

  render(<RoomBoard code="ABCDEFGH" snapshot={snapshot} onRefresh={() => {}} />);

  const scanButton = screen.getByRole('button', { name: /scan alice's cards for round 1/i });
  await waitFor(() => expect(scanButton).toBeEnabled());
  fireEvent.click(scanButton);

  // The photo arrives through one of the file inputs.
  const file = new File(['x'], 'cards.jpg', { type: 'image/jpeg' });
  for (const input of document.querySelectorAll('input[type="file"]')) {
    fireEvent.change(input, { target: { files: [file] } });
  }

  await waitFor(() => expect(screen.getByText(/Detected cards/)).toBeInTheDocument());
}

test('lists every detected card', async () => {
  await runScan(10);

  expect(screen.getByText('Detected cards (10)')).toBeInTheDocument();
  // One row per card, and one box per card on the preview.
  expect(screen.getAllByText('reverse')).toHaveLength(5);
  expect(screen.getAllByText('draw_five')).toHaveLength(5);
});

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

test('scans with the in-page camera instead of the native camera app', async () => {
  // The native camera app runs in another app: Android Chrome reloads the
  // page when it closes, so the in-page camera is the one that is used.
  const stream = { getTracks: () => [] };
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  });
  vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  const inputClick = vi.spyOn(HTMLInputElement.prototype, 'click');

  render(<RoomBoard code="ABCDEFGH" snapshot={snapshot} onRefresh={() => {}} />);

  const scanButton = screen.getByRole('button', { name: /scan alice's cards for round 1/i });
  await waitFor(() => expect(scanButton).toBeEnabled());
  fireEvent.click(scanButton);

  await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
  // No file input was opened, so no other app takes over the screen.
  expect(inputClick).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});
