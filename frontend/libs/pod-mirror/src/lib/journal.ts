import type { DeleteJournal, DeleteJournalEntry } from '@jeswr/pod-media-store';
import type { FailureReason, MirrorAccount, SkipReason } from './types.js';

export type RecordState = 'pending' | 'saved' | 'failed' | 'skipped' | 'removing' | 'remove-failed';

/**
 * One item's pairing between the hosted library and the pod. The hosted token lives here and
 * nowhere on the pod. Keyed by (WebID, hosted username, hosted token).
 */
export interface JournalRecord {
  webId: string;
  username: string;
  token: string;
  state: RecordState;
  attempts: number;
  /** Closed reason of the last failure or skip. */
  lastError?: FailureReason | SkipReason;
  /** Earliest time (ms) the next automatic attempt may run. */
  nextAttemptAt?: number;
  descriptionUrl?: string;
  /** Lowercase hex SHA-256 of the stored bytes. */
  sha256?: string;
  /** The hosted thumbnail address with `{WIDTH}` still in it, kept for the backfill. */
  thumbnailTemplate?: string;
  thumbnail?: 'attached' | 'waiting' | 'none';
  thumbnailAttempts?: number;
  thumbnailNextAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type RecordPatch = Partial<Omit<JournalRecord, 'webId' | 'username' | 'token' | 'createdAt'>>;

export interface MirrorJournal {
  get(account: MirrorAccount, token: string): Promise<JournalRecord | undefined>;
  /** Insert only when absent. Returns the stored record and whether this call created it. */
  create(record: JournalRecord): Promise<{ record: JournalRecord; created: boolean }>;
  /** Merge `patch` into an existing record in one transaction; `undefined` when absent. */
  update(account: MirrorAccount, token: string, patch: RecordPatch, now: number): Promise<JournalRecord | undefined>;
  remove(account: MirrorAccount, token: string): Promise<void>;
  list(account: MirrorAccount): Promise<JournalRecord[]>;
  /** The connect-time watermark (ms), set once per account; returns the stored value. */
  ensureWatermark(account: MirrorAccount, now: number): Promise<number>;
  getWatermark(account: MirrorAccount): Promise<number | undefined>;
  /** The pod-media-store's durable delete journal, on the same database. */
  readonly deletes: DeleteJournal;
  /** Purges this account's records and watermark, and every pending delete entry. */
  forgetAccount(account: MirrorAccount): Promise<void>;
  close(): void;
}

export class JournalError extends Error {
  constructor(readonly kind: 'unavailable' | 'newer-version' | 'blocked') {
    super(kind);
    this.name = 'JournalError';
  }
}

export const DB_NAME = 'artcraft-pod-mirror';
export const DB_VERSION = 1;
const ITEMS = 'items';
const MARKS = 'watermarks';
const DELETES = 'deletes';

type ItemKey = [string, string, string];
const itemKey = (a: MirrorAccount, token: string): ItemKey => [a.webId, a.username, token];
const accountRange = (KR: typeof IDBKeyRange, a: MirrorAccount): IDBKeyRange =>
  // Arrays sort after strings and before nothing else we use, so [w, u, ''] .. [w, u, []] covers every token.
  KR.bound([a.webId, a.username, ''], [a.webId, a.username, []]);

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new JournalError('unavailable'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new JournalError('unavailable'));
    tx.onabort = () => reject(new JournalError('unavailable'));
  });
}

/** Creates the stores a version needs; safe to run again over an existing database. */
export function upgradeJournal(db: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) {
    if (!db.objectStoreNames.contains(ITEMS)) db.createObjectStore(ITEMS, { keyPath: ['webId', 'username', 'token'] });
    if (!db.objectStoreNames.contains(MARKS)) db.createObjectStore(MARKS, { keyPath: ['webId', 'username'] });
    if (!db.objectStoreNames.contains(DELETES)) db.createObjectStore(DELETES, { keyPath: 'descriptionUrl' });
  }
}

export interface OpenJournalOptions {
  /** Defaults to the window's IndexedDB. Tests pass a fake. */
  indexedDB?: IDBFactory;
  /** The matching key-range constructor (a fake IndexedDB brings its own). */
  keyRange?: typeof IDBKeyRange;
  name?: string;
}

/** Opens the durable journal. It survives sign-out; only `forgetAccount` purges it. */
export async function openMirrorJournal(options: OpenJournalOptions = {}): Promise<MirrorJournal> {
  const factory = options.indexedDB ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  const KR = options.keyRange ?? (globalThis as { IDBKeyRange?: typeof IDBKeyRange }).IDBKeyRange;
  if (!factory || !KR) throw new JournalError('unavailable');
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    let open: IDBOpenDBRequest;
    try {
      open = factory.open(options.name ?? DB_NAME, DB_VERSION);
    } catch {
      reject(new JournalError('unavailable'));
      return;
    }
    open.onupgradeneeded = (event) => upgradeJournal(open.result, event.oldVersion);
    open.onsuccess = () => resolve(open.result);
    open.onblocked = () => reject(new JournalError('blocked'));
    open.onerror = () => reject(new JournalError(open.error?.name === 'VersionError' ? 'newer-version' : 'unavailable'));
  });
  // A version change from another window must not wedge this one.
  db.onversionchange = () => db.close();

  const deletes: DeleteJournal = {
    async put(entry: DeleteJournalEntry) {
      const tx = db.transaction(DELETES, 'readwrite');
      tx.objectStore(DELETES).put({ ...entry });
      await done(tx);
    },
    async delete(descriptionUrl: string) {
      const tx = db.transaction(DELETES, 'readwrite');
      tx.objectStore(DELETES).delete(descriptionUrl);
      await done(tx);
    },
    async list() {
      const tx = db.transaction(DELETES, 'readonly');
      return (await request(tx.objectStore(DELETES).getAll())) as DeleteJournalEntry[];
    },
  };

  return {
    deletes,
    async get(account, token) {
      const tx = db.transaction(ITEMS, 'readonly');
      return (await request(tx.objectStore(ITEMS).get(itemKey(account, token)))) as JournalRecord | undefined;
    },
    async create(record) {
      const tx = db.transaction(ITEMS, 'readwrite');
      const store = tx.objectStore(ITEMS);
      const existing = (await request(store.get(itemKey(record, record.token)))) as JournalRecord | undefined;
      if (existing) return { record: existing, created: false };
      store.put({ ...record });
      await done(tx);
      return { record, created: true };
    },
    async update(account, token, patch, now) {
      const tx = db.transaction(ITEMS, 'readwrite');
      const store = tx.objectStore(ITEMS);
      const existing = (await request(store.get(itemKey(account, token)))) as JournalRecord | undefined;
      if (!existing) return undefined;
      const next: JournalRecord = { ...existing, ...patch, updatedAt: now };
      // `undefined` in a patch clears the field.
      for (const [key, value] of Object.entries(patch)) if (value === undefined) delete (next as unknown as Record<string, unknown>)[key];
      store.put(next);
      await done(tx);
      return next;
    },
    async remove(account, token) {
      const tx = db.transaction(ITEMS, 'readwrite');
      tx.objectStore(ITEMS).delete(itemKey(account, token));
      await done(tx);
    },
    async list(account) {
      const tx = db.transaction(ITEMS, 'readonly');
      return (await request(tx.objectStore(ITEMS).getAll(accountRange(KR, account)))) as JournalRecord[];
    },
    async ensureWatermark(account, now) {
      const tx = db.transaction(MARKS, 'readwrite');
      const store = tx.objectStore(MARKS);
      const existing = (await request(store.get([account.webId, account.username]))) as { at: number } | undefined;
      if (existing) return existing.at;
      store.put({ webId: account.webId, username: account.username, at: now });
      await done(tx);
      return now;
    },
    async getWatermark(account) {
      const tx = db.transaction(MARKS, 'readonly');
      const found = (await request(tx.objectStore(MARKS).get([account.webId, account.username]))) as { at: number } | undefined;
      return found?.at;
    },
    async forgetAccount(account) {
      const tx = db.transaction([ITEMS, MARKS, DELETES], 'readwrite');
      tx.objectStore(ITEMS).delete(accountRange(KR, account));
      tx.objectStore(MARKS).delete([account.webId, account.username]);
      tx.objectStore(DELETES).clear();
      await done(tx);
    },
    close() {
      db.close();
    },
  };
}

/** An in-memory journal with the same behaviour, for the engine's tests. Keeps nothing. */
export function createMemoryMirrorJournal(): MirrorJournal {
  const items = new Map<string, JournalRecord>();
  const marks = new Map<string, number>();
  const pending = new Map<string, DeleteJournalEntry>();
  const key = (a: MirrorAccount, token: string) => JSON.stringify([a.webId, a.username, token]);
  const accountKey = (a: MirrorAccount) => JSON.stringify([a.webId, a.username]);
  return {
    deletes: {
      async put(entry) {
        pending.set(entry.descriptionUrl, { ...entry });
      },
      async delete(url) {
        pending.delete(url);
      },
      async list() {
        return [...pending.values()];
      },
    },
    async get(a, t) {
      const r = items.get(key(a, t));
      return r && { ...r };
    },
    async create(record) {
      const existing = items.get(key(record, record.token));
      if (existing) return { record: { ...existing }, created: false };
      items.set(key(record, record.token), { ...record });
      return { record, created: true };
    },
    async update(a, t, patch, now) {
      const existing = items.get(key(a, t));
      if (!existing) return undefined;
      const next: JournalRecord = { ...existing, ...patch, updatedAt: now };
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (next as unknown as Record<string, unknown>)[k];
      items.set(key(a, t), next);
      return { ...next };
    },
    async remove(a, t) {
      items.delete(key(a, t));
    },
    async list(a) {
      return [...items.values()].filter((r) => r.webId === a.webId && r.username === a.username).map((r) => ({ ...r }));
    },
    async ensureWatermark(a, now) {
      const k = accountKey(a);
      const found = marks.get(k);
      if (found !== undefined) return found;
      marks.set(k, now);
      return now;
    },
    async getWatermark(a) {
      return marks.get(accountKey(a));
    },
    async forgetAccount(a) {
      for (const [k, r] of [...items]) if (r.webId === a.webId && r.username === a.username) items.delete(k);
      marks.delete(accountKey(a));
      pending.clear();
    },
    close() {},
  };
}
