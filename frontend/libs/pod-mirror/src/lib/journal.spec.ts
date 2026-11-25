import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { DB_NAME, JournalError, upgradeJournal, type JournalRecord, type MirrorJournal, openMirrorJournal, createMemoryMirrorJournal } from './journal.js';
const ACCOUNT = { webId: 'https://alice.example/profile/card#me', username: 'alice_hosted' };

const OTHER_USER = { webId: ACCOUNT.webId, username: 'someone_else' };
const OTHER_POD = { webId: 'https://bob.example/profile/card#me', username: ACCOUNT.username };

const record = (account = ACCOUNT, token = 'm_1', extra: Partial<JournalRecord> = {}): JournalRecord => ({
  ...account,
  token,
  state: 'pending',
  attempts: 0,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

const open = (factory: IDBFactory) => openMirrorJournal({ indexedDB: factory, keyRange: IDBKeyRange });

const open1: MirrorJournal[] = [];
afterEach(() => {
  for (const j of open1.splice(0)) j.close();
});

describe.each([
  ['indexeddb', async (factory: IDBFactory) => open(factory)],
  ['memory', async () => createMemoryMirrorJournal()],
] as const)('%s journal', (_name, make) => {
  const fresh = async () => {
    const journal = await make(new IDBFactory());
    open1.push(journal);
    return journal;
  };

  it('keys records by web id, hosted username and token', async () => {
    const journal = await fresh();
    await journal.create(record(ACCOUNT, 'm_1', { attempts: 1 }));
    await journal.create(record(OTHER_USER, 'm_1', { attempts: 2 }));
    await journal.create(record(OTHER_POD, 'm_1', { attempts: 3 }));
    expect((await journal.get(ACCOUNT, 'm_1'))?.attempts).toBe(1);
    expect((await journal.get(OTHER_USER, 'm_1'))?.attempts).toBe(2);
    expect((await journal.get(OTHER_POD, 'm_1'))?.attempts).toBe(3);
    expect(await journal.list(ACCOUNT)).toHaveLength(1);
  });

  it('creates only when absent and never overwrites', async () => {
    const journal = await fresh();
    expect((await journal.create(record())).created).toBe(true);
    const again = await journal.create(record(ACCOUNT, 'm_1', { state: 'failed' }));
    expect(again.created).toBe(false);
    expect(again.record.state).toBe('pending');
  });

  it('merges a patch, clears undefined fields and stamps the time', async () => {
    const journal = await fresh();
    await journal.create(record(ACCOUNT, 'm_1', { lastError: 'offline', nextAttemptAt: 99 }));
    const next = await journal.update(ACCOUNT, 'm_1', { state: 'saved', descriptionUrl: 'https://p/d', lastError: undefined, nextAttemptAt: undefined }, 500);
    expect(next).toMatchObject({ state: 'saved', descriptionUrl: 'https://p/d', updatedAt: 500, createdAt: 1 });
    expect(next).not.toHaveProperty('lastError');
    expect(await journal.update(ACCOUNT, 'm_missing', { state: 'saved' }, 1)).toBeUndefined();
  });

  it('sets the baseline once per account and keeps walk state apart from it', async () => {
    const journal = await fresh();
    expect(await journal.getAccountState(ACCOUNT)).toBeUndefined();
    const first = { kind: 'item', token: 'm_9', createdAt: 100 } as const;
    expect(await journal.ensureBaseline(ACCOUNT, first)).toEqual(first);
    expect(await journal.ensureBaseline(ACCOUNT, { kind: 'empty' })).toEqual(first);
    expect(await journal.ensureBaseline(OTHER_USER, { kind: 'empty' })).toEqual({ kind: 'empty' });
    await journal.updateAccountState(ACCOUNT, { mark: { token: 'm_10', createdAt: 200 }, bytesEverOk: true, confirmedPrivate: ['https://p/lib/'] });
    await journal.updateAccountState(ACCOUNT, { bytesEverOk: undefined });
    expect(await journal.getAccountState(ACCOUNT)).toEqual({ baseline: first, mark: { token: 'm_10', createdAt: 200 }, confirmedPrivate: ['https://p/lib/'] });
  });

  it('forgetting an account purges its records, state and delete entries and no other account', async () => {
    const journal = await fresh();
    await journal.create(record(ACCOUNT, 'm_1'));
    await journal.create(record(OTHER_USER, 'm_2'));
    await journal.ensureBaseline(ACCOUNT, { kind: 'empty' });
    await journal.ensureBaseline(OTHER_USER, { kind: 'empty' });
    await journal.deletesFor(ACCOUNT.webId, 'https://p/').put({ descriptionUrl: 'https://p/d', shardUrl: 'https://p/', phase: 'intent' });
    await journal.deletesFor(OTHER_POD.webId, 'https://q/').put({ descriptionUrl: 'https://q/d', shardUrl: 'https://q/', phase: 'intent' });
    await journal.forgetAccount(ACCOUNT);
    expect(await journal.list(ACCOUNT)).toEqual([]);
    expect(await journal.getAccountState(ACCOUNT)).toBeUndefined();
    expect(await journal.deletesFor(ACCOUNT.webId, 'https://p/').list()).toEqual([]);
    expect(await journal.list(OTHER_USER)).toHaveLength(1);
    expect(await journal.getAccountState(OTHER_USER)).toEqual({ baseline: { kind: 'empty' } });
    // Another account's half-finished delete is still there.
    expect((await journal.deletesFor(OTHER_POD.webId, 'https://q/').list()).map((e) => e.descriptionUrl)).toEqual(['https://q/d']);
  });

  it('keeps one delete journal per WebID and storage', async () => {
    const journal = await fresh();
    const a = journal.deletesFor(ACCOUNT.webId, 'https://p/');
    const b = journal.deletesFor(ACCOUNT.webId, 'https://other-storage/');
    await a.put({ descriptionUrl: 'https://p/x', shardUrl: 'https://p/', phase: 'intent' });
    await b.put({ descriptionUrl: 'https://p/x', shardUrl: 'https://p/', phase: 'deleted' });
    expect((await a.list()).map((e) => e.phase)).toEqual(['intent']);
    await a.delete('https://p/x');
    expect(await a.list()).toEqual([]);
    expect(await b.list()).toHaveLength(1);
  });

  it('keeps the delete journal as the pod-media-store expects', async () => {
    const journal = await fresh();
    const deletes = journal.deletesFor(ACCOUNT.webId, 'https://p/');
    await deletes.put({ descriptionUrl: 'https://p/a', shardUrl: 'https://p/', phase: 'intent' });
    await deletes.put({ descriptionUrl: 'https://p/a', shardUrl: 'https://p/', phase: 'deleted', binaryUrl: 'https://p/a.png' });
    await deletes.put({ descriptionUrl: 'https://p/b', shardUrl: 'https://p/' });
    expect(await deletes.list()).toHaveLength(2);
    await deletes.delete('https://p/a');
    await deletes.delete('https://p/never');
    expect((await deletes.list()).map((e) => e.descriptionUrl)).toEqual(['https://p/b']);
  });
});

describe('indexeddb journal durability', () => {
  it('survives close and reopen, including the delete journal', async () => {
    const factory = new IDBFactory();
    const first = await open(factory);
    await first.create(record(ACCOUNT, 'm_1', { state: 'saved', descriptionUrl: 'https://p/d' }));
    await first.ensureBaseline(ACCOUNT, { kind: 'item', token: 'm_5', createdAt: 42 });
    await first.deletesFor(ACCOUNT.webId, 'https://p/').put({ descriptionUrl: 'https://p/x', shardUrl: 'https://p/', phase: 'intent' });
    first.close();
    const second = await open(factory);
    open1.push(second);
    expect((await second.get(ACCOUNT, 'm_1'))?.descriptionUrl).toBe('https://p/d');
    expect((await second.getAccountState(ACCOUNT))?.baseline).toEqual({ kind: 'item', token: 'm_5', createdAt: 42 });
    expect(await second.deletesFor(ACCOUNT.webId, 'https://p/').list()).toHaveLength(1);
  });

  it('runs the upgrade over a database that already holds some stores without losing rows', async () => {
    const factory = new IDBFactory();
    const prior = await openRaw(factory, 1, (db) => {
      db.createObjectStore('items', { keyPath: ['webId', 'username', 'token'] });
      // What version 1 also held: a clock-based watermark and one unscoped delete store.
      db.createObjectStore('watermarks', { keyPath: ['webId', 'username'] });
      db.createObjectStore('deletes', { keyPath: 'descriptionUrl' });
    });
    await new Promise<void>((resolve) => {
      const tx = prior.transaction('items', 'readwrite');
      tx.objectStore('items').put(record(ACCOUNT, 'm_old', { state: 'saved' }));
      tx.oncomplete = () => resolve();
    });
    prior.close();
    const upgraded = await openRaw(factory, 2, (db) => upgradeJournal(db, 1));
    expect(Array.from(upgraded.objectStoreNames).sort()).toEqual(['accounts', 'deletes', 'items']);
    const rows = await new Promise<unknown[]>((resolve) => {
      const req = upgraded.transaction('items').objectStore('items').getAll();
      req.onsuccess = () => resolve(req.result);
    });
    expect(rows).toHaveLength(1);
    upgraded.close();
  });

  it('refuses a database written by a newer version, with a closed error', async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve) => {
      const req = factory.open(DB_NAME, 7);
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
    });
    await expect(open(factory)).rejects.toMatchObject({ name: 'JournalError', kind: 'newer-version' });
  });

  it('reports unavailable when there is no IndexedDB', async () => {
    await expect(openMirrorJournal({ indexedDB: undefined, keyRange: undefined })).rejects.toBeInstanceOf(JournalError);
  });

  it('closes itself when another window asks for a version change', async () => {
    const factory = new IDBFactory();
    const journal = await open(factory);
    await journal.create(record());
    // A newer window upgrading must not be blocked by this one.
    await new Promise<void>((resolve, reject) => {
      const req = factory.open(DB_NAME, 3);
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    });
  });
});

function openRaw(factory: IDBFactory, version: number, upgrade: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, version);
    req.onupgradeneeded = () => upgrade(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
