import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { HeaderMenu } from './HeaderMenu';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.lang = 'en';
});

test('the landing menu offers languages only', () => {
  render(
    <I18nProvider>
      <MemoryRouter>
        <HeaderMenu />
      </MemoryRouter>
    </I18nProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

  expect(screen.getByRole('group', { name: 'Language' })).toBeInTheDocument();
  expect(screen.getByRole('menuitemradio', { name: 'English' })).toBeInTheDocument();
  expect(screen.getByRole('menuitemradio', { name: 'Tiếng Việt' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: /leave/i })).not.toBeInTheDocument();
});

test('switching language updates the menu and the document', () => {
  render(
    <I18nProvider>
      <MemoryRouter>
        <HeaderMenu />
      </MemoryRouter>
    </I18nProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Tiếng Việt' }));

  expect(document.documentElement.lang).toBe('vi');
  expect(screen.getByRole('button', { name: 'Mở menu' })).toBeInTheDocument();
});

test('the room menu confirms a copied item without closing', () => {
  const onCopyCode = vi.fn();

  render(
    <I18nProvider>
      <MemoryRouter>
        <HeaderMenu code="ABCDEFGH" copied="code" onCopyCode={onCopyCode} onCopyLink={() => {}} />
      </MemoryRouter>
    </I18nProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

  expect(screen.getByRole('group', { name: 'Room' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copied!' }));

  expect(onCopyCode).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('menu')).toBeInTheDocument();
});

test('exports the scoreboard from the room menu', () => {
  const onExportPng = vi.fn();

  render(
    <I18nProvider>
      <MemoryRouter>
        <HeaderMenu
          code="ABCDEFGH"
          onCopyCode={() => {}}
          onCopyLink={() => {}}
          onExportPng={onExportPng}
        />
      </MemoryRouter>
    </I18nProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Export PNG' }));

  expect(onExportPng).toHaveBeenCalledTimes(1);
});

test('disables the export item while the image is generated', () => {
  render(
    <I18nProvider>
      <MemoryRouter>
        <HeaderMenu
          code="ABCDEFGH"
          onCopyCode={() => {}}
          onCopyLink={() => {}}
          onExportPng={() => {}}
          exporting
        />
      </MemoryRouter>
    </I18nProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
  const item = screen.getByRole('menuitem', { name: 'Creating image…' });

  expect(item).toHaveAttribute('aria-disabled', 'true');
  expect(item).toBeDisabled();
});

test('hides the export item until a board is loaded', () => {
  render(
    <I18nProvider>
      <MemoryRouter>
        <HeaderMenu code="ABCDEFGH" onCopyCode={() => {}} onCopyLink={() => {}} />
      </MemoryRouter>
    </I18nProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

  expect(screen.queryByRole('menuitem', { name: /export png/i })).not.toBeInTheDocument();
});

test('leaving from the room menu returns to the landing page', () => {
  render(
    <I18nProvider>
      <MemoryRouter initialEntries={['/r/ABCDEFGH']}>
        <Routes>
          <Route
            path="/r/:code"
            element={<HeaderMenu code="ABCDEFGH" onCopyCode={() => {}} onCopyLink={() => {}} />}
          />
          <Route path="/" element={<div>Landing page</div>} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /leave/i }));

  expect(screen.getByText('Landing page')).toBeInTheDocument();
});
