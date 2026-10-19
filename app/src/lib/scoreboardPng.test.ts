import { vi } from 'vitest';
import { buildScoreboard } from './scoreboard';
import {
  exportScoreboardPng,
  fitText,
  layoutScoreboard,
  scoreboardFilename,
  type ScoreboardPngOptions,
} from './scoreboardPng';

const measure = (text: string) => text.length * 10;
const labels = { round: 'Round', total: 'Total' };

const players = [
  { id: 'p1', name: 'Alice', seat: 1 },
  { id: 'p2', name: 'Bob', seat: 2 },
  { id: 'p3', name: 'Carol', seat: 3 },
];

const options: ScoreboardPngOptions = {
  scoreboard: buildScoreboard(players, [
    { id: 'r1', seq: 1, scores: { p1: 10, p2: null, p3: 5 } },
    { id: 'r2', seq: 2, scores: { p1: 3, p2: 8, p3: 0 } },
  ]),
  code: 'ABCDEFGH',
  title: 'UNO Scoreboard',
  generated: 'Generated 20 Oct 2026',
  footer: 'Generated from room ABCDEFGH · UNO Flip scoring',
  labels,
};

test('names the file after the room and the local date', () => {
  expect(scoreboardFilename('abcdefgh', new Date(2026, 9, 20))).toBe(
    'uno-scoreboard-ABCDEFGH-2026-10-20.png',
  );
  expect(scoreboardFilename(' a/b ', new Date(2026, 0, 5))).toBe(
    'uno-scoreboard-AB-2026-01-05.png',
  );
});

test('shortens names with an ellipsis instead of clipping them', () => {
  expect(fitText('Bob', 100, measure, '')).toBe('Bob');
  expect(fitText('Alexander', 30, measure, '')).toBe('Al…');
});

test('lays players out as columns and rounds as rows', () => {
  const layout = layoutScoreboard(options.scoreboard, labels, measure);

  expect(layout.roundColumnWidth).toBeGreaterThanOrEqual(72);
  expect(layout.playerColumnWidth).toBeGreaterThanOrEqual(132);
  expect(layout.playerColumnX).toHaveLength(3);
  expect(layout.playerColumnX[0]).toBe(40 + layout.roundColumnWidth);
  expect(layout.playerColumnX[1] - layout.playerColumnX[0]).toBe(layout.playerColumnWidth);
  expect(layout.tableHeight).toBe(54 + 2 * 46 + 52);
  expect(layout.cssWidth).toBe(80 + layout.roundColumnWidth + layout.playerColumnWidth * 3);
  expect(layout.scale).toBe(2);
  expect(layout.nameMaxWidth).toBe(layout.playerColumnWidth - 10 - 8 - 32);
});

test('widens player columns for long names but caps them', () => {
  const longNames = [
    { id: 'p1', name: 'A'.repeat(40), seat: 1 },
    { id: 'p2', name: 'Bob', seat: 2 },
  ];
  const layout = layoutScoreboard(
    buildScoreboard(longNames, [{ id: 'r1', seq: 1, scores: { p1: 5, p2: null } }]),
    labels,
    measure,
  );

  expect(layout.playerColumnWidth).toBe(220);
  expect(layout.nameMaxWidth).toBe(220 - 10 - 8 - 32);
});

test('renders and saves a PNG with the expected filename', async () => {
  const blob = new Blob(['png'], { type: 'image/png' });
  const save = vi.fn();
  const render = vi.fn(() => ({
    toBlob: (callback: (blob: Blob | null) => void) => callback(blob),
    toDataURL: () => 'data:image/png;base64,',
  }));

  const filename = await exportScoreboardPng(options, {
    render,
    save,
    now: () => new Date(2026, 9, 20),
  });

  expect(render).toHaveBeenCalledWith(options);
  expect(save).toHaveBeenCalledWith(blob, 'uno-scoreboard-ABCDEFGH-2026-10-20.png');
  expect(filename).toBe('uno-scoreboard-ABCDEFGH-2026-10-20.png');
});

test('falls back to toDataURL when toBlob is unavailable', async () => {
  const save = vi.fn();
  const render = () => ({
    toDataURL: () => `data:image/png;base64,${btoa('png')}`,
  });

  await exportScoreboardPng(options, { render, save, now: () => new Date(2026, 9, 20) });

  const [blob, filename] = save.mock.calls[0];
  expect(blob).toBeInstanceOf(Blob);
  expect(blob.type).toBe('image/png');
  expect(filename).toBe('uno-scoreboard-ABCDEFGH-2026-10-20.png');
});

test('rejects when the browser cannot produce a blob', async () => {
  const render = () => ({
    toBlob: (callback: (blob: Blob | null) => void) => callback(null),
    toDataURL: () => '',
  });

  await expect(
    exportScoreboardPng(options, {
      render,
      save: vi.fn(),
      now: () => new Date(2026, 9, 20),
    }),
  ).rejects.toThrow('Could not create the image.');
});
