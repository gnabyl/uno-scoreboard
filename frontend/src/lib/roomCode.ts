export function parseRoomCode(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    const fromQuery = url.searchParams.get('code') || url.searchParams.get('room');
    if (fromQuery) return fromQuery.trim();
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length > 0) return segments[segments.length - 1];
  } catch {
    // not an absolute URL — parse it as a bare code or path below
  }

  const segments = raw.split(/[/?#]/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : raw;
}

import type { TranslateFn } from '../i18n';

export function describeRoomError(
  err: { code?: string | null; message?: string } | null | undefined,
  t: TranslateFn
): string {
  switch (err?.code) {
    case 'rate_limited':
      return t('error.rateLimited');
    case 'not_found':
      return t('error.notFound');
    case 'not_a_member':
      return t('error.notAMember');
    case 'invalid_code':
      return t('error.invalidCode');
    case 'score_conflict':
      return t('error.scoreConflict');
    case 'version_conflict':
      return t('error.versionConflict');
    default:
      // Server messages are not localized, but they are more specific than a
      // generic fallback, so prefer them when present.
      return err?.message || t('error.generic');
  }
}
