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

export function describeRoomError(err: { code?: string | null; message?: string } | null | undefined): string {
  switch (err?.code) {
    case 'rate_limited':
      return 'Too many attempts. Wait a minute and try again.';
    case 'not_found':
      return 'Room not found. Check the code and try again.';
    case 'not_a_member':
      return 'Join this room to see it.';
    case 'invalid_code':
      return 'Room codes are 8 characters (no 0, O, 1, I or L).';
    case 'score_conflict':
      return 'Another player changed that score.';
    case 'version_conflict':
      return 'The room changed since you loaded it. Try again.';
    default:
      return err?.message || 'Something went wrong.';
  }
}
