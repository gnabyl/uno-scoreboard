import { createClient } from '@supabase/supabase-js';

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

/** Resolves to a Supabase session, signing in anonymously on first use. */
export function ensureSession(): Promise<any> {
  if (!supabase) {
    return Promise.reject(
      // Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local or the Vercel dashboard.
      new Error('backend is not configured'),
    );
  }

  if (!sessionPromise) {
    sessionPromise = (async () => {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      if (data.session) return data.session;

      const { data: signedIn, error: signInError } = await supabase.auth.signInAnonymously();
      if (signInError) {
        if (
          signInError.code === 'anonymous_provider_disabled' ||
          /anonymous sign-ins are disabled/i.test(signInError.message || '')
        ) {
          throw new Error(
            'Anonymous sign-ins are disabled. Enable them in Supabase → Authentication → Providers → Anonymous.',
          );
        }
        throw signInError;
      }
      return signedIn.session;
    })().catch((err) => {
      sessionPromise = null;
      throw err;
    });
  }

  return sessionPromise;
}
