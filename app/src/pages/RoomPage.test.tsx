import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { getRoom } from '../api-helper/rooms';
import { exportScoreboardPng } from '../lib/scoreboardPng';
import RoomPage from './RoomPage';

vi.mock('../api-helper/rooms', () => ({
  getRoom: vi.fn(),
  joinRoom: vi.fn(),
  subscribeToRoom: vi.fn(() => () => {}),
  normalizeRoomCode: (value: string) =>
    String(value ?? '')
      .trim()
      .toUpperCase(),
  addPlayer: vi.fn(),
  addRound: vi.fn(),
  deletePlayer: vi.fn(),
  deleteRound: vi.fn(),
  setScore: vi.fn(),
}));

vi.mock('../components/RoomBoard', () => ({
  default: () => <div>Board</div>,
}));

vi.mock('../lib/scoreboardPng', () => ({
  exportScoreboardPng: vi.fn().mockResolvedValue('uno-scoreboard-ABCDEFGH.png'),
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

function renderRoom() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={['/r/ABCDEFGH']}>
        <Routes>
          <Route path="/r/:code" element={<RoomPage />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(getRoom).mockResolvedValue(snapshot);
});

test('exports the loaded scoreboard from the header menu', async () => {
  renderRoom();

  await screen.findByText('Board');
  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Export PNG' }));

  await waitFor(() => expect(exportScoreboardPng).toHaveBeenCalledTimes(1));

  const options = vi.mocked(exportScoreboardPng).mock.calls[0][0];
  expect(options).toMatchObject({
    code: 'ABCDEFGH',
    title: 'UNO Scoreboard',
    labels: { round: 'Round', total: 'Total' },
  });
  expect(options.scoreboard.totals).toEqual({ p1: 10, p2: 10 });
  expect(options.footer).toContain('ABCDEFGH');
});

test('shows an error when the image cannot be generated', async () => {
  vi.mocked(exportScoreboardPng).mockRejectedValueOnce(new Error('boom'));

  renderRoom();

  await screen.findByText('Board');
  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Export PNG' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not create the image. Try again.',
  );
});
