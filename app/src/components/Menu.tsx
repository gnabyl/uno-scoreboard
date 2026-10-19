import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

/** How an action is announced to assistive tech inside the menu. */
export type MenuActionRole = 'item' | 'radio';

export interface MenuAction {
  /** Stable id, also used for the DOM id behind `aria-activedescendant`. */
  key: string;
  label: string;
  /** Small leading glyph (emoji is fine). Purely decorative. */
  icon?: ReactNode;
  onSelect?: () => void;
  /** `radio` renders a `menuitemradio` with an optional check mark. */
  role?: MenuActionRole;
  checked?: boolean;
  /** Destructive styling (red label). */
  danger?: boolean;
  disabled?: boolean;
  /** Keep the menu open after selecting, e.g. for "Copied!" feedback. */
  keepOpen?: boolean;
}

export interface MenuSection {
  key: string;
  /** Optional caption, shown above the section's actions. */
  label?: string;
  actions: MenuAction[];
}

const ACTION_BASE =
  'flex w-full items-center gap-2.5 rounded-lg border-none bg-transparent px-3 py-2 text-left text-sm font-semibold transition';

const TRIGGER =
  'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-edge bg-panel/95 text-muted shadow-panel transition hover:text-fg focus:outline-none focus-visible:border-accent focus-visible:text-fg sm:h-10 sm:w-10';

const PANEL =
  'absolute right-0 top-full z-[10001] mt-2 max-h-[min(70vh,420px)] w-60 overflow-y-auto rounded-xl border border-edge bg-panel p-1 shadow-modal outline-none';

/**
 * Small popup menu for header actions.
 *
 * Behaves like the language picker it replaces: the trigger and the list are
 * themed by the app, the list closes on outside presses, and the whole menu is
 * operable from the keyboard (arrows, Home/End, Enter/Space, Escape). Focus
 * moves into the list so `aria-activedescendant` tracks the highlighted row
 * without making every row tabbable.
 */
export function Menu({
  label,
  sections,
  className = '',
}: {
  label: string;
  sections: MenuSection[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // Only enabled actions take part in keyboard navigation.
  const actions = useMemo(
    () => sections.flatMap((section) => section.actions.filter((action) => !action.disabled)),
    [sections],
  );

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setActiveKey(null);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  const openMenu = useCallback(() => {
    // Start on the chosen radio (if any) so the active option is obvious.
    const initial = actions.find((action) => action.checked) ?? actions[0];
    setActiveKey(initial?.key ?? null);
    setOpen(true);
  }, [actions]);

  const select = useCallback(
    (action: MenuAction) => {
      if (action.disabled) return;
      action.onSelect?.();
      if (!action.keepOpen) close(true);
    },
    [close],
  );

  // Focus the list when it opens and close on any press outside the widget.
  useEffect(() => {
    if (!open) return undefined;

    panelRef.current?.focus();

    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        close(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  const moveActive = (delta: number) => {
    if (actions.length === 0) return;
    const index = actions.findIndex((action) => action.key === activeKey);
    const next =
      index < 0
        ? delta > 0
          ? 0
          : actions.length - 1
        : (index + delta + actions.length) % actions.length;
    setActiveKey(actions[next].key);
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openMenu();
    } else if (event.key === 'Escape') {
      close(false);
    }
  };

  const onPanelKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      if (actions.length > 0) setActiveKey(actions[0].key);
    } else if (event.key === 'End') {
      event.preventDefault();
      if (actions.length > 0) setActiveKey(actions[actions.length - 1].key);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const active = actions.find((action) => action.key === activeKey);
      if (active) select(active);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  return (
    <div ref={rootRef} className={`relative shrink-0 ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        className={TRIGGER}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        title={label}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <svg
          className="h-5 w-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="17" x2="20" y2="17" />
        </svg>
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="menu"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={activeKey ? `${panelId}-${activeKey}` : undefined}
          className={PANEL}
          onKeyDown={onPanelKeyDown}
        >
          {sections.map((section, sectionIndex) => (
            <div key={section.key} role="group" aria-label={section.label}>
              {sectionIndex > 0 && <div role="separator" className="my-1 h-px bg-edge-soft" />}
              {section.label && (
                <div
                  aria-hidden="true"
                  className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint"
                >
                  {section.label}
                </div>
              )}
              {section.actions.map((action) => {
                const active = action.key === activeKey;
                const isRadio = action.role === 'radio';
                const tone = action.danger
                  ? active
                    ? 'bg-[#2a1416] text-[#ff8a8a]'
                    : 'text-[#ff6b6b] hover:bg-[#2a1416] hover:text-[#ff8a8a]'
                  : active
                    ? 'bg-raised text-fg'
                    : 'text-muted hover:bg-raised hover:text-fg';
                return (
                  <button
                    key={action.key}
                    id={`${panelId}-${action.key}`}
                    type="button"
                    role={isRadio ? 'menuitemradio' : 'menuitem'}
                    aria-checked={isRadio ? Boolean(action.checked) : undefined}
                    aria-disabled={action.disabled || undefined}
                    disabled={action.disabled}
                    className={`${ACTION_BASE} ${tone} disabled:cursor-not-allowed disabled:opacity-45`}
                    onMouseEnter={() => setActiveKey(action.key)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => select(action)}
                  >
                    {action.icon !== undefined && (
                      <span
                        aria-hidden="true"
                        className="w-5 shrink-0 text-center text-base leading-none"
                      >
                        {action.icon}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate">{action.label}</span>
                    {isRadio && action.checked && (
                      <span aria-hidden="true" className="shrink-0 text-accent">
                        ✓
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
