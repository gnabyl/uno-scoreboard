import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { LANGUAGES, useI18n } from '../i18n';
import { Menu, type MenuSection } from './Menu';

/**
 * Header actions for both pages.
 *
 * The landing page only has language choices; a room adds sharing and leaving.
 * Everything lives in one menu so the header stays a single control next to the
 * title, on desktop and mobile alike.
 */
export function HeaderMenu({
  code = null,
  copied = null,
  onCopyCode,
  onCopyLink,
  onExportPng,
  exporting = false,
  className = '',
}: {
  code?: string | null;
  /** Which item was copied most recently, so it can confirm inline. */
  copied?: 'code' | 'link' | null;
  onCopyCode?: () => void;
  onCopyLink?: () => void;
  /** Downloads the scoreboard as a PNG; omitted until the board is loaded. */
  onExportPng?: () => void;
  /** True while the PNG is being generated. */
  exporting?: boolean;
  className?: string;
}) {
  const { language, setLanguage, t } = useI18n();
  const navigate = useNavigate();

  const sections = useMemo<MenuSection[]>(() => {
    const result: MenuSection[] = [];

    if (code && onCopyCode && onCopyLink) {
      result.push({
        key: 'room',
        label: t('menu.room'),
        actions: [
          {
            key: 'copy-code',
            label: copied === 'code' ? t('common.copied') : t('room.copyCode'),
            icon: '📋',
            keepOpen: true,
            onSelect: onCopyCode,
          },
          {
            key: 'copy-link',
            label: copied === 'link' ? t('common.copied') : t('room.copyLink'),
            icon: '🔗',
            keepOpen: true,
            onSelect: onCopyLink,
          },
          ...(onExportPng
            ? [
                {
                  key: 'export-png',
                  label: exporting ? t('room.exporting') : t('room.exportPng'),
                  icon: '🖼️',
                  disabled: exporting,
                  onSelect: onExportPng,
                },
              ]
            : []),
        ],
      });
    }

    result.push({
      key: 'language',
      label: t('common.language'),
      actions: LANGUAGES.map((option) => ({
        key: `language-${option.code}`,
        label: option.label,
        role: 'radio' as const,
        checked: option.code === language,
        onSelect: () => setLanguage(option.code),
      })),
    });

    if (code) {
      result.push({
        key: 'session',
        actions: [
          {
            key: 'leave',
            label: t('room.leave'),
            icon: '🚪',
            danger: true,
            onSelect: () => navigate('/'),
          },
        ],
      });
    }

    return result;
  }, [
    code,
    copied,
    exporting,
    language,
    navigate,
    onCopyCode,
    onCopyLink,
    onExportPng,
    setLanguage,
    t,
  ]);

  return <Menu label={t('menu.open')} sections={sections} className={className} />;
}
