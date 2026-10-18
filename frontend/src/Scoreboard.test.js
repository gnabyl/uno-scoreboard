import { fireEvent, render, screen } from '@testing-library/react';
import Scoreboard from './Scoreboard';

beforeEach(() => {
  localStorage.clear();
});

test('renders the scoreboard header', () => {
  render(<Scoreboard />);
  expect(screen.getByText(/UNO Scoreboard/i)).toBeInTheDocument();
});

test('adds a player and a round', () => {
  render(<Scoreboard />);

  fireEvent.change(screen.getByPlaceholderText('Player name'), {
    target: { value: 'Alice' },
  });
  fireEvent.click(screen.getByRole('button', { name: /add player/i }));
  expect(screen.getByDisplayValue('Alice')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /new round/i }));
  expect(screen.getByLabelText(/remove round 1/i)).toBeInTheDocument();
  expect(screen.getByText('1')).toBeInTheDocument();
});
