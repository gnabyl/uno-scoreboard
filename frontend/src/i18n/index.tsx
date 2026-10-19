import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { en, vi, type TranslationKey } from './translations';

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'vi', label: 'Tiếng Việt' },
] as const;

export type Language = (typeof LANGUAGES)[number]['code'];

/** Values substituted into `{placeholder}` tokens in a translation. */
export type TranslateParams = Record<string, string | number>;
export type TranslateFn = (key: TranslationKey, params?: TranslateParams) => string;

const dictionaries: Record<Language, Record<TranslationKey, string>> = { en, vi };

/** localStorage key holding the user's explicit language choice. */
const STORAGE_KEY = 'uno.lang';
const DEFAULT_LANGUAGE: Language = 'en';

function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((language) => language.code === value);
}

/** BCP-47 style tag -> supported language, e.g. `vi-VN` -> `vi`. */
function matchLanguage(tag: unknown): Language | null {
  const base = String(tag ?? '')
    .trim()
    .toLowerCase()
    .split('-')[0];
  return isLanguage(base) ? base : null;
}

/**
 * Picks the initial language: an explicit stored choice wins, otherwise the
 * browser's preferred languages are checked in order, then English.
 */
export function detectLanguage(): Language {
  if (typeof window === 'undefined') return DEFAULT_LANGUAGE;

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLanguage(stored)) return stored;
  } catch {
    // localStorage can be unavailable (private mode, blocked cookies) - ignore.
  }

  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of preferred) {
    const match = matchLanguage(tag);
    if (match) return match;
  }

  return DEFAULT_LANGUAGE;
}

/** Substitutes `{name}` tokens; unknown tokens are left untouched. */
export function format(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    params[name] === undefined ? match : String(params[name]),
  );
}

/** Translates a single key for a given language, falling back to English. */
export function translate(
  language: Language,
  key: TranslationKey,
  params?: TranslateParams,
): string {
  const template = dictionaries[language]?.[key] ?? en[key] ?? key;
  return format(template, params);
}

interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: TranslateFn;
}

const I18nContext = createContext<I18nContextValue>({
  language: DEFAULT_LANGUAGE,
  setLanguage: () => {},
  t: (key, params) => translate(DEFAULT_LANGUAGE, key, params),
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => detectLanguage());

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Persisting is best-effort; the in-memory choice still applies.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = translate(language, 'app.title');
  }, [language]);

  const value = useMemo<I18nContextValue>(
    () => ({
      language,
      setLanguage,
      t: (key, params) => translate(language, key, params),
    }),
    [language, setLanguage],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Full i18n context: the active language plus the setter. */
export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

/** The translate function alone - the common case in components. */
export function useTranslation(): TranslateFn {
  return useContext(I18nContext).t;
}
