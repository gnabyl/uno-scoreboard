import { createClient } from '@supabase/supabase-js';

import { isAuthError } from './authErrors';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isConfigured = Boolean(url && anonKey);

export const supabase = isConfigured
  ? createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : null;

let sessionPromise: Promise<any> | null = null;

/** Set once the restored session has been checked against the auth server. */
let sessionVerified = false;

/** Drops the stored session without touching the in-flight promise. */
async function clearStoredSession(): Promise<void> {
  sessionVerified = false;
  try {
    // `local` clears this browser's copy only, with no call to the auth server:
    // the session may already be invalid, and a failed round trip would leave
    // the stale token in storage.
    await supabase!.auth.signOut({ scope: 'local' });
  } catch {
    // Nothing else to do - a fresh sign-in replaces whatever is stored.
  }
}

/**
 * Forgets the current session so the next ensureSession() starts over with a
 * new anonymous user. Used when the server rejects the stored session.
 */
export async function resetSession(): Promise<void> {
  sessionPromise = null;
  if (!supabase) return;
  await clearStoredSession();
}

async function signInAnonymously(): Promise<any> {
  const { data, error } = await supabase!.auth.signInAnonymously();
  if (error) {
    if (
      error.code === 'anonymous_provider_disabled' ||
      /anonymous sign-ins are disabled/i.test(error.message || '')
    ) {
      throw new Error(
        'Anonymous sign-ins are disabled. Enable them in Supabase → Authentication → Providers → Anonymous.',
      );
    }
    throw error;
  }
  sessionVerified = true;
  return data.session;
}

async function establishSession(): Promise<any> {
  const { data, error } = await supabase!.auth.getSession();
  if (error) throw error;
  if (!data.session) return signInAnonymously();

  // A stored session outlives the user it belongs to: deleting an anonymous
  // user leaves the browser holding a token that still parses but no longer
  // resolves, and every later request fails with confusing 403/409 errors.
  // Verify it once per page load so the app signs in again instead.
  if (!sessionVerified) {
    const { error: userError } = await supabase!.auth.getUser();
    if (!userError) {
      sessionVerified = true;
    } else if (isAuthError(userError)) {
      await clearStoredSession();
      return signInAnonymously();
    }
    // Otherwise the auth server was unreachable: keep the session and let the
    // request itself report the network failure.
  }

  return data.session;
}

/** Resolves to a Supabase session, signing in anonymously on first use. */
export function ensureSession(): Promise<any> {
  if (!supabase) {
    return Promise.reject(
      // Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local or the Vercel dashboard.
      new Error('backend is not configured'),
    );
  }

  if (!sessionPromise) {
    sessionPromise = establishSession().catch((err) => {
      sessionPromise = null;
      throw err;
    });
  }

  return sessionPromise;
}
