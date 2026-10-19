import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { Menu, type MenuSection } from './Menu';

function setup(sections?: MenuSection[]) {
  const onCopy = vi.fn();
  const onEnglish = vi.fn();
  const onVietnamese = vi.fn();

  const defaultSections: MenuSection[] = [
    {
      key: 'room',
      label: 'Room',
      actions: [{ key: 'copy', label: 'Copy code', icon: '📋', keepOpen: true, onSelect: onCopy }],
    },
    {
      key: 'language',
      label: 'Language',
      actions: [
        { key: 'en', label: 'English', role: 'radio', checked: true, onSelect: onEnglish },
        { key: 'vi', label: 'Tiếng Việt', role: 'radio', checked: false, onSelect: onVietnamese },
      ],
    },
  ];

  render(<Menu label="Open menu" sections={sections ?? defaultSections} />);

  return { onCopy, onEnglish, onVietnamese };
}

test('opens from the trigger and renders sections and items', () => {
  setup();

  expect(screen.queryByRole('menu')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

  expect(screen.getByRole('menu')).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Room' })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: 'Copy code' })).toBeInTheDocument();
  expect(screen.getByRole('menuitemradio', { name: 'English' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

test('closes when the trigger is pressed again', () => {
  setup();
  const trigger = screen.getByRole('button', { name: 'Open menu' });

  fireEvent.click(trigger);
  fireEvent.click(trigger);

  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});

test('runs the action and closes the menu, except for keepOpen items', () => {
  const { onCopy } = setup();

  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy code' }));

  expect(onCopy).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('menu')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Tiếng Việt' }));

  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});

test('supports arrow keys, Home/End and Enter selection', () => {
  const { onVietnamese } = setup();

  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
  const menu = screen.getByRole('menu');

  // Opens on the checked radio.
  expect(menu).toHaveAttribute(
    'aria-activedescendant',
    screen.getByRole('menuitemradio', { name: 'English' }).id,
  );

  fireEvent.keyDown(menu, { key: 'ArrowDown' });
  expect(menu).toHaveAttribute(
    'aria-activedescendant',
    screen.getByRole('menuitemradio', { name: 'Tiếng Việt' }).id,
  );

  fireEvent.keyDown(menu, { key: 'Enter' });

  expect(onVietnamese).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});

test('wraps keyboard navigation with Home and End', () => {
  setup();

  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
  const menu = screen.getByRole('menu');

  fireEvent.keyDown(menu, { key: 'End' });
  expect(menu).toHaveAttribute(
    'aria-activedescendant',
    screen.getByRole('menuitemradio', { name: 'Tiếng Việt' }).id,
  );

  fireEvent.keyDown(menu, { key: 'Home' });
  expect(menu).toHaveAttribute(
    'aria-activedescendant',
    screen.getByRole('menuitem', { name: 'Copy code' }).id,
  );
});

test('skips disabled actions when navigating', () => {
  const disabled = vi.fn();
  setup([
    {
      key: 'list',
      actions: [
        { key: 'a', label: 'First', onSelect: vi.fn() },
        { key: 'b', label: 'Disabled', disabled: true, onSelect: disabled },
        { key: 'c', label: 'Last', onSelect: vi.fn() },
      ],
    },
  ]);

  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
  const menu = screen.getByRole('menu');

  fireEvent.keyDown(menu, { key: 'ArrowDown' });
  expect(menu).toHaveAttribute(
    'aria-activedescendant',
    screen.getByRole('menuitem', { name: 'Last' }).id,
  );

  fireEvent.keyDown(menu, { key: 'Enter' });
  expect(disabled).not.toHaveBeenCalled();
});

test('closes on Escape and returns focus to the trigger', () => {
  setup();
  const trigger = screen.getByRole('button', { name: 'Open menu' });

  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

test('closes on a pointer press outside the widget', () => {
  setup();

  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
  fireEvent.pointerDown(document.body);

  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});
