import { LANGUAGES, useI18n, type Language } from '../i18n';

/**
 * Floating language picker pinned to the bottom-left corner.
 *
 * The offset lines the switcher up with the `+ New round` button in the room
 * view: that button sits 40px above the board's bottom edge (`mb-10`), which in
 * turn clears the page padding (16px, or 24px from `sm`) - hence 56px / 64px.
 * It also keeps the picker above the fixed LogPanel bar at the very bottom.
 * Language names stay in their own language (e.g. "Tiếng Việt") so people can
 * find their choice regardless of the currently active language.
 */
export function LanguageSwitcher() {
  const { language, setLanguage, t } = useI18n();

  return (
    <label className="fixed bottom-14 left-4 z-[10000] inline-flex items-center gap-1.5 rounded-xl border border-edge bg-panel/95 px-2.5 py-1.5 shadow-panel backdrop-blur-sm sm:bottom-16">
      <span className="sr-only">{t('common.language')}</span>
      <span className="text-sm leading-none" aria-hidden="true">
        🌐
      </span>
      <select
        className="cursor-pointer rounded-lg border-none bg-transparent text-xs font-semibold text-muted outline-none"
        value={language}
        onChange={(event) => setLanguage(event.target.value as Language)}
      >
        {LANGUAGES.map((option) => (
          <option key={option.code} value={option.code} className="bg-panel text-fg">
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
