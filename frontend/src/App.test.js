import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

beforeEach(() => {
  localStorage.clear();
});

test('renders the scoreboard header', () => {
  render(<App />);
  expect(screen.getByText(/UNO Scoreboard/i)).toBeInTheDocument();
});

test('adds a player and a round', () => {
  render(<App />);
  const nameInput = screen.getByPlaceholderText('Player name');
  userEvent.type(nameInput, 'Alice');
  userEvent.click(screen.getByRole('button', { name: /add player/i }));
  expect(screen.getByDisplayValue('Alice')).toBeInTheDocument();

  userEvent.click(screen.getByRole('button', { name: /new round/i }));
  expect(screen.getByText(/Round 1/i)).toBeInTheDocument();
});
