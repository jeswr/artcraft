// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { defaultEnv, exerciseLock, persistKeyInIndexedDb, runSelfTest, type SelfTestEnv } from './self-test.js';

const good = (): SelfTestEnv => ({
  isSecureContext: true,
  locks: {},
  indexedDB: {},
  crypto: {},
  exerciseLock: async () => undefined,
  persistKey: async () => undefined,
});

describe('runSelfTest', () => {
  it('passes when everything is available', async () => {
    expect(await runSelfTest(good())).toEqual({ ok: true });
  });

  it.each([
    ['insecure-context', { isSecureContext: false }],
    ['web-locks-missing', { locks: undefined }],
    ['indexeddb-missing', { indexedDB: undefined }],
    ['webcrypto-missing', { crypto: undefined }],
  ] as const)('reports %s and never exercises anything', async (reason, patch) => {
    const persistKey = vi.fn(async () => undefined);
    const exerciseLock = vi.fn(async () => undefined);
    const result = await runSelfTest({ ...good(), ...patch, persistKey, exerciseLock });
    expect(result).toEqual({ ok: false, reason });
    expect(persistKey).not.toHaveBeenCalled();
    expect(exerciseLock).not.toHaveBeenCalled();
  });

  it('reports web-locks-broken and does not store a key', async () => {
    const persistKey = vi.fn(async () => undefined);
    const result = await runSelfTest({ ...good(), exerciseLock: () => Promise.reject(new Error('x')), persistKey });
    expect(result).toEqual({ ok: false, reason: 'web-locks-broken' });
    expect(persistKey).not.toHaveBeenCalled();
  });

  it('reports key-not-persistable when the key cannot make the round trip', async () => {
    const result = await runSelfTest({ ...good(), persistKey: async () => Promise.reject(new Error('DataCloneError')) });
    expect(result).toEqual({ ok: false, reason: 'key-not-persistable' });
  });

  it.each([
    ['exerciseLock', 'web-locks-broken'],
    ['persistKey', 'key-not-persistable'],
  ] as const)('times out a %s that never answers', async (which, reason) => {
    vi.useFakeTimers();
    try {
      const pending = runSelfTest({ ...good(), [which]: () => new Promise<void>(() => undefined) });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await pending).toEqual({ ok: false, reason });
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A lock manager that really excludes: one holder per name. */
function fakeLocks(options: { neverReleases?: boolean; alwaysGrants?: boolean } = {}) {
  const held = new Set<string>();
  return {
    held,
    async request(name: string, a: unknown, b?: unknown): Promise<unknown> {
      const ifAvailable = typeof a === 'object' && a !== null;
      const callback = (ifAvailable ? b : a) as (lock: unknown) => unknown;
      if (ifAvailable) {
        if (held.has(name) && !options.alwaysGrants) return callback(null);
        return callback({ name });
      }
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        if (!options.neverReleases) held.delete(name);
      }
    },
  };
}

describe('exerciseLock', () => {
  it('passes against a lock manager that excludes and releases', async () => {
    const locks = fakeLocks();
    await expect(exerciseLock(locks)).resolves.toBeUndefined();
    expect(locks.held.size).toBe(0);
  });

  it('fails when a held lock is granted a second time', async () => {
    await expect(exerciseLock(fakeLocks({ alwaysGrants: true }))).rejects.toThrow();
  });

  it('fails when the lock is never released', async () => {
    await expect(exerciseLock(fakeLocks({ neverReleases: true }))).rejects.toThrow();
  });
});

describe('persistKeyInIndexedDb', () => {
  it('stores the key, reopens a fresh connection and signs with it', async () => {
    const idb = new IDBFactory();
    await expect(persistKeyInIndexedDb(idb, webcrypto as unknown as Crypto)).resolves.toBeUndefined();
    expect(await idb.databases()).toEqual([]);
  });

  it('fails when the stored key comes back extractable', async () => {
    const subtle = {
      generateKey: async () => ({ privateKey: { type: 'private', extractable: true }, publicKey: {} }),
      sign: async () => new ArrayBuffer(1),
      verify: async () => true,
    };
    // A plain object stands in for the key; fake-indexeddb clones it structurally.
    await expect(persistKeyInIndexedDb(new IDBFactory(), { subtle } as unknown as Crypto)).rejects.toThrow();
  });

  it('fails when the signature does not verify', async () => {
    const real = webcrypto.subtle;
    const subtle = {
      generateKey: real.generateKey.bind(real),
      sign: real.sign.bind(real),
      verify: async () => false,
    };
    await expect(persistKeyInIndexedDb(new IDBFactory(), { subtle } as unknown as Crypto)).rejects.toThrow();
  });
});

describe('defaultEnv', () => {
  it('reports what the window really has', () => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('indexedDB', undefined);
    // Node 24 has its own navigator.locks; a window without Web Locks is stubbed explicitly.
    vi.stubGlobal('navigator', {});
    try {
      const env = defaultEnv();
      expect(env.isSecureContext).toBe(false);
      expect(env.indexedDB).toBeUndefined();
      expect(env.locks).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports the lock manager the window has', () => {
    const locks = {};
    vi.stubGlobal('navigator', { locks });
    try {
      expect(defaultEnv().locks).toBe(locks);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('claims a secure context only when the window says so, and finds the crypto it has', () => {
    vi.stubGlobal('isSecureContext', true);
    try {
      const env = defaultEnv();
      expect(env.isSecureContext).toBe(true);
      expect(env.crypto).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('runs the real key round trip through the global IndexedDB', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    try {
      await expect(defaultEnv().persistKey()).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
