import { describe, expect, it } from 'vitest';
import type { PodSessionConfig } from './config.js';
import { deletePodAuthDatabases, podAuthDatabaseNames } from './wipe.js';

const config: PodSessionConfig = { clientId: 'https://artcraft.example/id.jsonld', redirectUri: 'ai.artcraft.app:/oauth/callback', allowLoopbackHttp: false };
// The names key-value-kit gives pod-auth's stores for `config`.
const namespace = JSON.stringify(['pod-auth', config.clientId, config.redirectUri]);
const ours = ['issuer', 'sessions', 'fence'].map((n) => `@jeswr/key-value:${JSON.stringify(`${namespace}:v2:${n}`)}:`);
const otherClient = `@jeswr/key-value:${JSON.stringify(`${JSON.stringify(['pod-auth', 'https://other.example/id', config.redirectUri])}:v2:sessions`)}:`;

describe('podAuthDatabaseNames', () => {
  it('picks every pod-auth database whatever client or redirect it was made for, and nothing else', () => {
    const all = [...ours, otherClient, 'keyval-store', 'video-editor', 'artcraft-pod-session-self-test'];
    expect(podAuthDatabaseNames(all).sort()).toEqual([...ours, otherClient].sort());
  });
});

describe('deletePodAuthDatabases', () => {
  it('deletes only matching databases', async () => {
    const idb = fakeIdb([...ours, 'video-editor'], 'success');
    expect(await deletePodAuthDatabases(idb)).toBe('wiped');
    expect(idb.deleted.sort()).toEqual([...ours].sort());
  });

  it('counts a blocked delete as deferred', async () => {
    expect(await deletePodAuthDatabases(fakeIdb(ours, 'blocked'))).toBe('deferred');
  });

  it('refuses to claim a wipe when the databases cannot be listed', async () => {
    const idb = { deleteDatabase: () => ({}) as IDBOpenDBRequest };
    await expect(deletePodAuthDatabases(idb)).rejects.toThrow();
  });

  it('reports one blocked database among several as deferred, after trying them all', async () => {
    const idb = fakeIdb(ours, 'success', ours[1]);
    expect(await deletePodAuthDatabases(idb)).toBe('deferred');
    expect(idb.deleted.sort()).toEqual([...ours].sort());
  });

  it('rejects when a database cannot be deleted', async () => {
    await expect(deletePodAuthDatabases(fakeIdb(ours, 'error'))).rejects.toThrow();
  });
});

function fakeIdb(names: string[], mode: 'success' | 'blocked' | 'error', blockedName?: string) {
  const deleted: string[] = [];
  return {
    deleted,
    databases: async () => names.map((name) => ({ name })),
    deleteDatabase(name: string) {
      deleted.push(name);
      const req = {} as IDBOpenDBRequest;
      queueMicrotask(() => {
        if (mode === 'success' && name === blockedName) req.onblocked?.(new Event('blocked') as IDBVersionChangeEvent);
        else if (mode === 'success') req.onsuccess?.(new Event('success'));
        if (mode === 'blocked') req.onblocked?.(new Event('blocked') as IDBVersionChangeEvent);
        if (mode === 'error') req.onerror?.(new Event('error'));
      });
      return req;
    },
  };
}
