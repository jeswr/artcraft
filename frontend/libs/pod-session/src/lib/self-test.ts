import type { UnsupportedReason } from './state.js';

export type SelfTestResult = { ok: true } | { ok: false; reason: UnsupportedReason };

export type SelfTestEnv = {
  isSecureContext: boolean;
  locks: unknown;
  indexedDB: unknown;
  crypto: unknown;
  /**
   * Holds a Web Lock, shows a second request cannot take it, releases it and shows a third can.
   * Rejects on any failure. Replaceable in tests.
   */
  exerciseLock: () => Promise<void>;
  /**
   * Stores a freshly generated non-extractable key in IndexedDB, closes the connection, reopens
   * the database on a fresh connection, reads the key back and signs with it, then checks the
   * signature. Rejects on any failure. Replaceable in tests.
   */
  persistKey: () => Promise<void>;
};

const DB_NAME = 'artcraft-pod-session-self-test';
const LOCK_NAME = 'artcraft-pod-session-self-test';
const STORE = 'keys';
const TIMEOUT_MS = 5000;

/**
 * Start-up check of what pod-auth needs: a secure context, Web Locks that really exclude and
 * release, IndexedDB, and a non-extractable CryptoKey that survives close and reopen. A failure
 * disables the feature with a reason instead of letting a sign-in half-work.
 */
export async function runSelfTest(env: SelfTestEnv = defaultEnv()): Promise<SelfTestResult> {
  if (!env.isSecureContext) return { ok: false, reason: 'insecure-context' };
  if (!env.locks) return { ok: false, reason: 'web-locks-missing' };
  if (!env.indexedDB) return { ok: false, reason: 'indexeddb-missing' };
  if (!env.crypto) return { ok: false, reason: 'webcrypto-missing' };
  try {
    await withTimeout(env.exerciseLock(), TIMEOUT_MS);
  } catch {
    return { ok: false, reason: 'web-locks-broken' };
  }
  try {
    await withTimeout(env.persistKey(), TIMEOUT_MS);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'key-not-persistable' };
  }
}

type LockManagerLike = {
  request(name: string, options: { ifAvailable: true }, callback: (lock: unknown) => Promise<unknown> | unknown): Promise<unknown>;
  request(name: string, callback: () => Promise<unknown> | unknown): Promise<unknown>;
};

export function defaultEnv(): SelfTestEnv {
  const g = globalThis as unknown as {
    isSecureContext?: boolean;
    navigator?: { locks?: LockManagerLike };
    indexedDB?: IDBFactory;
    crypto?: Crypto;
  };
  const crypto = g.crypto?.subtle ? g.crypto : undefined;
  return {
    isSecureContext: g.isSecureContext === true,
    locks: g.navigator?.locks,
    indexedDB: g.indexedDB,
    crypto,
    exerciseLock: () => exerciseLock(g.navigator?.locks as LockManagerLike),
    persistKey: () => persistKeyInIndexedDb(g.indexedDB as IDBFactory, crypto as Crypto),
  };
}

/** Exported so tests can run the real procedure against a fake lock manager. */
export async function exerciseLock(locks: LockManagerLike): Promise<void> {
  let whileHeld: unknown = 'not asked';
  await locks.request(LOCK_NAME, async () => {
    await locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
      whileHeld = lock;
    });
  });
  if (whileHeld !== null) throw new Error('a held lock was granted twice');
  let afterRelease = false;
  await locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
    afterRelease = lock !== null;
  });
  if (!afterRelease) throw new Error('the lock was not released');
}

/** Exported so tests can run the real procedure against fake-indexeddb. */
export async function persistKeyInIndexedDb(idb: IDBFactory, crypto: Crypto): Promise<void> {
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256' } as const;
  const pair = await crypto.subtle.generateKey(algorithm, false, ['sign', 'verify']);
  try {
    const writer = await open(idb);
    try {
      await request(writer.transaction(STORE, 'readwrite').objectStore(STORE).put(pair.privateKey, 'k'));
    } finally {
      writer.close();
    }
    // A fresh connection, as after a reload: nothing is shared with the writer.
    const reader = await open(idb);
    try {
      const back = (await request(reader.transaction(STORE, 'readonly').objectStore(STORE).get('k'))) as CryptoKey | undefined;
      if (!back || back.type !== 'private' || back.extractable) throw new Error('key did not round trip');
      const data = new Uint8Array([1, 2, 3]);
      const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, back, data);
      const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, signature, data);
      if (!valid) throw new Error('stored key does not sign');
    } finally {
      reader.close();
    }
  } finally {
    await new Promise<void>((resolve) => {
      const del = idb.deleteDatabase(DB_NAME);
      del.onsuccess = del.onerror = del.onblocked = () => resolve();
    });
  }
}

function open(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
