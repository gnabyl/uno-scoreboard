// Caches the exported model in the browser, so the 10 MB is downloaded once
// instead of on every visit.
//
// The cache is keyed by a version string derived from the blob's metadata
// (`uploadedAt` + size). Uploading a new model therefore invalidates the
// cache on its own - no manual busting, and rolling back to an older model
// works the same way.
//
// Everything here fails soft: when IndexedDB is unavailable (private mode,
// storage blocked) or the quota is exceeded, the app simply downloads the
// model again.

const DB_NAME = 'uno-counter';
const DB_VERSION = 1;
const STORE = 'models';
const KEY = 'uno-flip-detector';

export interface CachedModel {
  /** The version the bytes were downloaded under. */
  version: string;
  bytes: ArrayBuffer;
  savedAt: number;
}

/**
 * The version of a model, from the blob's metadata.
 */
export function modelVersion(uploadedAt?: string | null, size?: number | null): string {
  return `${uploadedAt ?? 'unknown'}-${size ?? 0}`;
}

/**
 * Whether the cached model is the one the server is offering.
 */
export function shouldUseCachedModel(
  cachedVersion: string | null | undefined,
  serverVersion: string,
): boolean {
  if (!serverVersion || !cachedVersion) return false;
  return cachedVersion === serverVersion;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/**
 * The cached model, or null when there is none (or it cannot be read).
 */
export async function getCachedModel(): Promise<CachedModel | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise<CachedModel | null>((resolve) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      request.onsuccess = () => {
        const value = request.result as CachedModel | undefined;
        if (!value || typeof value.version !== 'string' || !(value.bytes instanceof ArrayBuffer)) {
          resolve(null);
          return;
        }
        resolve({ version: value.version, bytes: value.bytes, savedAt: value.savedAt ?? 0 });
      };
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Stores the model under its version. Silently does nothing when the storage
 * is unavailable or full.
 */
export async function putCachedModel(version: string, bytes: ArrayBuffer): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ version, bytes, savedAt: Date.now() } satisfies CachedModel, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // Quota exceeded or storage disabled: the model is downloaded again next
    // time, which is all we lose.
  } finally {
    db.close();
  }
}

/**
 * Drops the cached model.
 */
export async function clearModelCache(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // Nothing to do.
  } finally {
    db.close();
  }
}
