import { useCallback, useEffect, useRef, useState } from 'react';
import { LANGUAGES, useI18n, type Language } from '../i18n';

/**
 * Floating language picker pinned to the bottom-left corner.
 *
 * The offset lines the switcher up with the `+ New round` button in the room
 * view: that button sits 40px above the board's bottom edge (`mb-10`), which in
 * turn clears the page padding (16px, or 24px from `sm`) - hence 56px / 64px.
 * It also keeps the picker above the fixed LogPanel bar at the very bottom.
 *
 * A custom listbox is used instead of a native `<select>` so the open list can
 * be themed (native popups ignore the app's dark styling on some platforms).
 * Language names stay in their own language (e.g. "Tiếng Việt") so people can
 * find their choice regardless of the currently active language.
 */
export function LanguageSwitcher() {
  const { language, setLanguage, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const currentIndex = LANGUAGES.findIndex((option) => option.code === language);
  const current = LANGUAGES[currentIndex] ?? LANGUAGES[0];

  const openList = useCallback(
    (index: number) => {
      setActiveIndex(index);
      setOpen(true);
    },
    []
  );

  const select = useCallback(
    (code: Language) => {
      setLanguage(code);
      setOpen(false);
      buttonRef.current?.focus();
    },
    [setLanguage]
  );

  // Move focus into the list so keyboard navigation works, and close on any
  // pointer press outside the widget.
  useEffect(() => {
    if (!open) return undefined;

    listRef.current?.focus();

    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const onButtonKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openList(currentIndex < 0 ? 0 : currentIndex);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) setOpen(false);
      else openList(currentIndex < 0 ? 0 : currentIndex);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  const onListKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % LANGUAGES.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + LANGUAGES.length) % LANGUAGES.length);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select(LANGUAGES[activeIndex].code);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="fixed bottom-14 left-4 z-[10000] sm:bottom-16">
      <div className="relative">
        <button
          ref={buttonRef}
          type="button"
          className="inline-flex items-center gap-1.5 rounded-xl border border-edge bg-panel/95 px-2.5 py-1.5 text-xs font-semibold text-muted shadow-panel backdrop-blur-sm transition hover:text-fg focus:outline-none focus-visible:border-accent focus-visible:text-fg"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`${t('common.language')}: ${current.label}`}
          onClick={() => (open ? setOpen(false) : openList(currentIndex < 0 ? 0 : currentIndex))}
          onKeyDown={onButtonKeyDown}
        >
          <span className="text-sm leading-none" aria-hidden="true">
            🌐
          </span>
          <span>{current.label}</span>
          <span className="text-[10px] leading-none" aria-hidden="true">
            {open ? '▴' : '▾'}
          </span>
        </button>

        {open && (
          <ul
            ref={listRef}
            role="listbox"
            tabIndex={-1}
            aria-label={t('common.language')}
            aria-activedescendant={`lang-option-${LANGUAGES[activeIndex].code}`}
            className="absolute bottom-full left-0 z-[10001] mb-2 w-max min-w-full list-none rounded-xl border border-edge bg-panel p-1 shadow-modal outline-none"
            onKeyDown={onListKeyDown}
          >
            {LANGUAGES.map((option, index) => {
              const selected = option.code === language;
              const active = index === activeIndex;
              return (
                <li
                  key={option.code}
                  id={`lang-option-${option.code}`}
                  role="option"
                  aria-selected={selected}
                  className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                    active ? 'bg-raised text-fg' : 'text-muted'
                  } ${selected ? 'text-accent' : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => select(option.code)}
                >
                  <span>{option.label}</span>
                  {selected && (
                    <span aria-hidden="true" className="text-accent">
                      ✓
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
