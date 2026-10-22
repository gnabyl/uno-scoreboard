import { describe, expect, it } from 'vitest';

import { isAuthError } from './authErrors';

describe('isAuthError', () => {
  it('recognises token failures from PostgREST', () => {
    expect(isAuthError({ code: 'PGRST301', message: 'JWT expired' })).toBe(true);
    expect(isAuthError({ code: 'PGRST302', message: 'Anonymous access is disabled' })).toBe(true);
  });

  it('recognises the auth server rejecting a deleted user', () => {
    expect(
      isAuthError({
        status: 403,
        code: 'user_not_found',
        message: 'User from sub claim in JWT does not exist',
      }),
    ).toBe(true);
    expect(isAuthError({ status: 401, message: 'unauthorized' })).toBe(true);
  });

  it('recognises the foreign-key failure of a deleted user', () => {
    expect(
      isAuthError({
        code: '23503',
        message:
          'insert or update on table "room_members" violates foreign key constraint "room_members_user_id_fkey"',
        details: 'Key (user_id)=(0f1e) is not present in table "users".',
      }),
    ).toBe(true);
  });

  it('ignores a foreign-key failure somewhere else', () => {
    expect(
      isAuthError({
        code: '23503',
        message: 'insert or update on table "scores"',
        details: 'Key (round_id)=(x)',
      }),
    ).toBe(false);
  });

  it('leaves application errors for their own handling', () => {
    expect(isAuthError({ code: '42501', message: 'not_a_member' })).toBe(false);
    expect(isAuthError({ code: 'PT409', message: 'version_conflict' })).toBe(false);
    expect(isAuthError({ code: 'P0002', message: 'room_not_found' })).toBe(false);
    expect(isAuthError({ code: 'PT429', message: 'rate_limited' })).toBe(false);
    expect(isAuthError({ code: '22023', message: 'invalid_name' })).toBe(false);
  });

  it('does not treat a dropped connection as a bad session', () => {
    expect(isAuthError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
    expect(isAuthError('nope')).toBe(false);
  });
});
