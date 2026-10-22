import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUser: vi.fn(),
  signOut: vi.fn(),
  signInAnonymously: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth }),
}));

const STORED = { access_token: 'old', user: { id: 'stale' } };
const FRESH = { access_token: 'new', user: { id: 'fresh' } };

const USER_DELETED = {
  status: 403,
  code: 'user_not_found',
  message: 'User from sub claim in JWT does not exist',
};

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
  auth.signOut.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function load() {
  return import('./supabase');
}

describe('ensureSession()', () => {
  it('signs in anonymously when nothing is stored', async () => {
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    auth.signInAnonymously.mockResolvedValue({ data: { session: FRESH }, error: null });

    const { ensureSession } = await load();

    await expect(ensureSession()).resolves.toBe(FRESH);
    expect(auth.getUser).not.toHaveBeenCalled();
  });

  it('replaces a stored session whose user no longer exists', async () => {
    auth.getSession.mockResolvedValue({ data: { session: STORED }, error: null });
    auth.getUser.mockResolvedValue({ data: { user: null }, error: USER_DELETED });
    auth.signInAnonymously.mockResolvedValue({ data: { session: FRESH }, error: null });

    const { ensureSession } = await load();

    await expect(ensureSession()).resolves.toBe(FRESH);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(auth.signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it('keeps a valid stored session and only verifies it once', async () => {
    auth.getSession.mockResolvedValue({ data: { session: STORED }, error: null });
    auth.getUser.mockResolvedValue({ data: { user: STORED.user }, error: null });

    const { ensureSession } = await load();

    await expect(ensureSession()).resolves.toBe(STORED);
    await expect(ensureSession()).resolves.toBe(STORED);

    expect(auth.getUser).toHaveBeenCalledTimes(1);
    expect(auth.signInAnonymously).not.toHaveBeenCalled();
  });

  it('keeps the session when the auth server is unreachable', async () => {
    auth.getSession.mockResolvedValue({ data: { session: STORED }, error: null });
    auth.getUser.mockResolvedValue({
      data: { user: null },
      error: new TypeError('Failed to fetch'),
    });

    const { ensureSession } = await load();

    await expect(ensureSession()).resolves.toBe(STORED);
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(auth.signInAnonymously).not.toHaveBeenCalled();
  });

  it('explains when anonymous sign-ins are disabled', async () => {
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    auth.signInAnonymously.mockResolvedValue({
      data: { session: null },
      error: {
        code: 'anonymous_provider_disabled',
        message: 'Anonymous sign-ins are disabled',
      },
    });

    const { ensureSession } = await load();

    await expect(ensureSession()).rejects.toThrow(/anonymous sign-ins are disabled/i);
  });
});

describe('resetSession()', () => {
  it('clears the stored session so the next call signs in again', async () => {
    auth.getSession
      .mockResolvedValueOnce({ data: { session: STORED }, error: null })
      .mockResolvedValueOnce({ data: { session: null }, error: null });
    auth.getUser.mockResolvedValue({ data: { user: STORED.user }, error: null });
    auth.signInAnonymously.mockResolvedValue({ data: { session: FRESH }, error: null });

    const { ensureSession, resetSession } = await load();

    await expect(ensureSession()).resolves.toBe(STORED);

    await resetSession();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });

    await expect(ensureSession()).resolves.toBe(FRESH);
    expect(auth.signInAnonymously).toHaveBeenCalledTimes(1);
  });
});
