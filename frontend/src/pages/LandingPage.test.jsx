import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LandingPage from './LandingPage';

test('offers host and join entry points', () => {
  render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>
  );

  expect(screen.getByRole('heading', { name: /host a game/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /join a game/i })).toBeInTheDocument();
  expect(
    screen.getByPlaceholderText(/ABCDEFGH or room link/i)
  ).toBeInTheDocument();
});
