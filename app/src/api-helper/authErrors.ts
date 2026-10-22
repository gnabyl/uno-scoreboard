// Session failures reported by PostgREST and the GoTrue auth server.
//
// The app reacts to these by dropping the stored session and signing in again,
// so this must not match ordinary application errors (`not_a_member`, rate
// limits, version/score conflicts, ...): those have their own handling and a
// retry would only repeat them.

interface RequestError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  status?: number | null;
  error_description?: string | null;
}

const AUTH_MESSAGE =
  /invalid jwt|jwt expired|jwt is invalid|user not found|user from sub claim|not authenticated/i;

/**
 * True when the request was rejected because the session no longer maps to a
 * real user, rather than because of the request itself.
 */
export function isAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const { code, message, details, status, error_description } = error as RequestError;

  if (status === 401 || status === 403) return true;
  if (code === 'PGRST301' || code === 'PGRST302') return true;

  // A deleted auth user surfaces as a foreign-key failure when a command tries
  // to record room_members for a user id that no longer exists.
  if (code === '23503') {
    return /room_members[\s\S]*users|users[\s\S]*room_members/i.test(
      `${message ?? ''} ${details ?? ''}`,
    );
  }

  return AUTH_MESSAGE.test(`${message ?? ''} ${error_description ?? ''}`);
}
