import { useCallback, useEffect, useRef, useState } from 'react';
import { LANGUAGES, useI18n, type Language } from '../i18n';

/**
 * Language picker.
 *
 * Rendered inline in each page header (top-right) instead of floating over the
 * board, so it never overlaps content. The open list drops below the trigger
 * and is right-aligned so it stays on-screen on narrow viewports.
 *
 * A custom listbox is used instead of a native `<select>` so the open list can
 * be themed (native popups ignore the app's dark styling on some platforms).
 * Language names stay in their own language (e.g. "Tiếng Việt") so people can
 * find their choice regardless of the currently active language.
 */
export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { language, setLanguage, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const currentIndex = LANGUAGES.findIndex((option) => option.code === language);
  const current = LANGUAGES[currentIndex] ?? LANGUAGES[0];

  const openList = useCallback((index: number) => {
    setActiveIndex(index);
    setOpen(true);
  }, []);

  const select = useCallback(
    (code: Language) => {
      setLanguage(code);
      setOpen(false);
      buttonRef.current?.focus();
    },
    [setLanguage],
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
    <div ref={rootRef} className={`relative shrink-0 ${className}`}>
      <div className="relative">
        <button
          ref={buttonRef}
          type="button"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-edge bg-panel/95 text-muted shadow-panel transition hover:text-fg focus:outline-none focus-visible:border-accent focus-visible:text-fg sm:h-10 sm:w-10"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`${t('common.language')}: ${current.label}`}
          title={`${t('common.language')}: ${current.label}`}
          onClick={() => (open ? setOpen(false) : openList(currentIndex < 0 ? 0 : currentIndex))}
          onKeyDown={onButtonKeyDown}
        >
          <span className="text-base leading-none" aria-hidden="true">
            🌐
          </span>
        </button>

        {open && (
          <ul
            ref={listRef}
            role="listbox"
            tabIndex={-1}
            aria-label={t('common.language')}
            aria-activedescendant={`lang-option-${LANGUAGES[activeIndex].code}`}
            className="absolute right-0 top-full z-[10001] mt-2 w-max min-w-full list-none rounded-xl border border-edge bg-panel p-1 shadow-modal outline-none"
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
