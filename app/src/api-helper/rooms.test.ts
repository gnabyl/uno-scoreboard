import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc, ensureSession, resetSession } = vi.hoisted(() => ({
  rpc: vi.fn(),
  ensureSession: vi.fn(),
  resetSession: vi.fn(),
}));

vi.mock('./supabase', () => ({
  isConfigured: true,
  supabase: { rpc },
  ensureSession,
  resetSession,
}));

import { RoomApiError, VersionConflictError, createRoom, getRoom, resetRoom } from './rooms';

const SNAPSHOT = { code: 'ABCDEFGH', version: 7, me: 'p1', players: [], rounds: [] };

const JWT_EXPIRED = { code: 'PGRST301', message: 'JWT expired' };
const DELETED_USER_FK = {
  code: '23503',
  message:
    'insert or update on table "room_members" violates foreign key constraint "room_members_user_id_fkey"',
  details: 'Key (user_id)=(0f1e) is not present in table "users".',
};

beforeEach(() => {
  vi.resetAllMocks();
  ensureSession.mockResolvedValue({ user: { id: 'u1' } });
  resetSession.mockResolvedValue(undefined);
});

describe('call() session recovery', () => {
  it('signs in again and retries once when the session was rejected', async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: JWT_EXPIRED })
      .mockResolvedValueOnce({ data: SNAPSHOT, error: null });

    await expect(getRoom('ABCDEFGH')).resolves.toMatchObject({ version: 7 });

    expect(resetSession).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenLastCalledWith('get_room', { p_code: 'ABCDEFGH' });
  });

  it('retries a command whose user was deleted mid-session', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: DELETED_USER_FK }).mockResolvedValueOnce({
      data: { code: 'ABCDEFGH', version: 1, playerId: 'p1' },
      error: null,
    });

    await expect(createRoom('Ada')).resolves.toMatchObject({ code: 'ABCDEFGH' });
    expect(resetSession).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('gives up after one retry instead of looping', async () => {
    rpc.mockResolvedValue({ data: null, error: JWT_EXPIRED });

    await expect(getRoom('ABCDEFGH')).rejects.toMatchObject({
      name: 'RoomApiError',
      code: 'session_expired',
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(resetSession).toHaveBeenCalledTimes(1);
  });

  it('does not touch the session for a version conflict', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'PT409', message: 'version_conflict', details: '4' },
    });

    await expect(resetRoom('ABCDEFGH', 3)).rejects.toBeInstanceOf(VersionConflictError);

    expect(resetSession).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('does not retry a missing room', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'P0002', message: 'room_not_found' } });

    await expect(getRoom('ABCDEFGH')).rejects.toMatchObject({ code: 'not_found' });

    expect(resetSession).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the caller is simply not a member', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'not_a_member' } });

    await expect(getRoom('ABCDEFGH')).rejects.toMatchObject({ code: 'not_a_member' });

    expect(resetSession).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('reports other failures unchanged', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PT429', message: 'rate_limited' } });

    const err = await getRoom('ABCDEFGH').catch((e) => e);
    expect(err).toBeInstanceOf(RoomApiError);
    expect(err.code).toBe('rate_limited');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
