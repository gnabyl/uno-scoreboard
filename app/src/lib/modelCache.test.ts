import { describe, expect, test } from 'vitest';
import {
  clearModelCache,
  getCachedModel,
  modelVersion,
  putCachedModel,
  shouldUseCachedModel,
} from './modelCache';

test('the version is built from the blob metadata', () => {
  expect(modelVersion('2026-10-21T09:44:50.000Z', 10085956)).toBe(
    '2026-10-21T09:44:50.000Z-10085956',
  );
});

test('a version can still be built without metadata', () => {
  expect(modelVersion(null, null)).toBe('unknown-0');
  expect(modelVersion(undefined, undefined)).toBe('unknown-0');
});

test('the cached model is used when the versions match', () => {
  expect(shouldUseCachedModel('v1-100', 'v1-100')).toBe(true);
});

test('the cached model is dropped when the server offers another one', () => {
  expect(shouldUseCachedModel('v1-100', 'v2-200')).toBe(false);
});

test('the cached model is not used without a version to compare', () => {
  expect(shouldUseCachedModel('v1-100', '')).toBe(false);
  expect(shouldUseCachedModel(null, 'v1-100')).toBe(false);
  expect(shouldUseCachedModel(undefined, 'v1-100')).toBe(false);
});

describe('without IndexedDB', () => {
  test('reading the cache gives nothing instead of throwing', async () => {
    expect(await getCachedModel()).toBeNull();
  });

  test('writing the cache does not throw', async () => {
    await expect(putCachedModel('v1', new ArrayBuffer(8))).resolves.toBeUndefined();
  });

  test('clearing the cache does not throw', async () => {
    await expect(clearModelCache()).resolves.toBeUndefined();
  });
});
