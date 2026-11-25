import type { DeleteJournal, DeleteJournalEntry } from '@jeswr/pod-media-store';
import type { FailureReason, ImportState, MirrorAccount, SkipReason } from './types.js';

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
  /** Set when the item came from "copy my existing library", so that run can count and cancel its own. */
  source?: 'import';
  /** The hosted server's creation time of the item (ms), when it was known at admission. */
  hostedCreatedAt?: number;
  /** The same failure kind this many attempts in a row. */
  repeats?: number;
  /** ArtCraft no longer lists this item. The pod copy is kept until the person says otherwise. */
  goneFromArtcraft?: boolean;
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

/** A hosted item named by its token and the hosted server's own creation time (ms). */
export interface ItemMark {
  token: string;
  createdAt: number;
}

/**
 * Where "new" starts for an account: the newest hosted item at first connect, or an empty
 * library. It comes from the hosted side only; no local clock is in it.
 */
export type Baseline = { kind: 'empty' } | ({ kind: 'item' } & ItemMark);

/** The durable record of one "copy my existing library" run. */
export interface ImportRun {
  state: ImportState;
  /** The next listing page to read. */
  cursor?: { page: number };
  walked: number;
  /** True once the listing has been walked as often as it will be; what is left is copying. */
  walkDone?: boolean;
  /** How many full passes over the listing have finished (the first plus catch-ups). */
  passes?: number;
  total?: number | null;
  startedAt?: number;
  finishedAt?: number;
  pausedBy?: 'quota';
}

/** What the walk and the verification pass remember per (WebID, hosted user). */
export interface AccountState {
  baseline?: Baseline;
  /** The newest item of the last walk that ran to its stopping point. */
  mark?: ItemMark;
  /** True once any download from the hosted media host has worked on this install. */
  bytesEverOk?: boolean;
  /** When the hosted deletions were last checked (ms, local clock, scheduling only). */
  verifiedAt?: number;
  /** Library containers the person confirmed are private, for servers that cannot say. */
  confirmedPrivate?: string[];
  /** The last "copy my existing library" run; only a `running` one resumes by itself. */
  import?: ImportRun;
}
export type AccountStatePatch = Partial<Omit<AccountState, 'baseline'>>;

export interface MirrorJournal {
  get(account: MirrorAccount, token: string): Promise<JournalRecord | undefined>;
  /** Insert only when absent. Returns the stored record and whether this call created it. */
  create(record: JournalRecord): Promise<{ record: JournalRecord; created: boolean }>;
  /** Merge `patch` into an existing record in one transaction; `undefined` when absent. */
  update(account: MirrorAccount, token: string, patch: RecordPatch, now: number): Promise<JournalRecord | undefined>;
  remove(account: MirrorAccount, token: string): Promise<void>;
  list(account: MirrorAccount): Promise<JournalRecord[]>;
  /**
   * True when any record on this device, of ANY WebID and hosted account, other than `except`,
   * still pairs with this pod description and is not itself on its way out (`removing` or
   * `remove-failed`). Content-hash naming makes several hosted tokens share one pod copy; this is
   * the check a delete needs before it may take the copy with it. It cannot see other devices.
   */
  isPairedElsewhere(descriptionUrl: string, except: MirrorAccount & { token: string }): Promise<boolean>;
  getAccountState(account: MirrorAccount): Promise<AccountState | undefined>;
  /** Sets the baseline once per account; returns the stored one. */
  ensureBaseline(account: MirrorAccount, baseline: Baseline): Promise<Baseline>;
  /** Merges into the account's state; an `undefined` value clears that field. */
  updateAccountState(account: MirrorAccount, patch: AccountStatePatch): Promise<void>;
  /**
   * The pod-media-store's durable delete journal for one WebID and storage. Views of other
   * WebIDs or storages never see or drop these entries.
   */
  deletesFor(webId: string, storage: string): DeleteJournal;
  /** Purges this account's records and state, and the delete entries of its WebID only. */
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
export const DB_VERSION = 3;
const BY_DESCRIPTION = 'descriptionUrl';
/** States that no longer hold a pod copy up: the hosted item is gone and the copy is going. */
const LEAVING: ReadonlySet<string> = new Set(['removing', 'remove-failed']);
const ITEMS = 'items';
const ACCOUNTS = 'accounts';
const DELETES = 'deletes';

type StoredDelete = DeleteJournalEntry & { scope: string; webId: string };
const scopeOf = (webId: string, storage: string) => JSON.stringify([webId, storage]);

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
export function upgradeJournal(db: IDBDatabase, oldVersion: number, tx?: IDBTransaction): void {
  if (oldVersion < 1) {
    if (!db.objectStoreNames.contains(ITEMS)) db.createObjectStore(ITEMS, { keyPath: ['webId', 'username', 'token'] });
  }
  if (oldVersion < 2) {
    // Version 1 kept one unscoped delete store and a clock-based watermark; neither shipped.
    for (const name of ['watermarks', DELETES]) if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
    db.createObjectStore(ACCOUNTS, { keyPath: ['webId', 'username'] });
    db.createObjectStore(DELETES, { keyPath: ['scope', 'descriptionUrl'] });
  }
  if (oldVersion < 3 && tx) {
    // Looks up "who else pairs with this pod copy" without reading every row. Records without a
    // descriptionUrl are simply not in the index.
    const items = tx.objectStore(ITEMS);
    if (!items.indexNames.contains(BY_DESCRIPTION)) items.createIndex(BY_DESCRIPTION, 'descriptionUrl');
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
    open.onupgradeneeded = (event) => upgradeJournal(open.result, event.oldVersion, open.transaction ?? undefined);
    open.onsuccess = () => resolve(open.result);
    open.onblocked = () => reject(new JournalError('blocked'));
    open.onerror = () => reject(new JournalError(open.error?.name === 'VersionError' ? 'newer-version' : 'unavailable'));
  });
  // A version change from another window must not wedge this one.
  db.onversionchange = () => db.close();

  const deletesFor = (webId: string, storage: string): DeleteJournal => {
    const scope = scopeOf(webId, storage);
    return {
      async put(entry: DeleteJournalEntry) {
        const tx = db.transaction(DELETES, 'readwrite');
        tx.objectStore(DELETES).put({ ...entry, scope, webId } satisfies StoredDelete);
        await done(tx);
      },
      async delete(descriptionUrl: string) {
        const tx = db.transaction(DELETES, 'readwrite');
        tx.objectStore(DELETES).delete([scope, descriptionUrl]);
        await done(tx);
      },
      async list() {
        const tx = db.transaction(DELETES, 'readonly');
        const all = (await request(tx.objectStore(DELETES).getAll())) as StoredDelete[];
        return all.filter((entry) => entry.scope === scope).map(({ scope: _scope, webId: _webId, ...entry }) => entry);
      },
    };
  };

  const stateKey = (a: MirrorAccount) => [a.webId, a.username];
  const readState = async (account: MirrorAccount): Promise<AccountState | undefined> => {
    const tx = db.transaction(ACCOUNTS, 'readonly');
    const found = (await request(tx.objectStore(ACCOUNTS).get(stateKey(account)))) as (AccountState & MirrorAccount) | undefined;
    if (!found) return undefined;
    const { webId: _w, username: _u, ...state } = found;
    return state;
  };

  return {
    deletesFor,
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
    async isPairedElsewhere(descriptionUrl, except) {
      const tx = db.transaction(ITEMS, 'readonly');
      const items = tx.objectStore(ITEMS);
      // A database upgraded without the index (it should not be) is scanned instead.
      const rows = (await request(
        items.indexNames.contains(BY_DESCRIPTION) ? items.index(BY_DESCRIPTION).getAll(KR.only(descriptionUrl)) : items.getAll(),
      )) as JournalRecord[];
      return rows.some((row) => pairsWith(row, descriptionUrl, except));
    },
    getAccountState: readState,
    async ensureBaseline(account, baseline) {
      const tx = db.transaction(ACCOUNTS, 'readwrite');
      const store = tx.objectStore(ACCOUNTS);
      const existing = (await request(store.get(stateKey(account)))) as (AccountState & MirrorAccount) | undefined;
      if (existing?.baseline) return existing.baseline;
      store.put({ ...existing, webId: account.webId, username: account.username, baseline });
      await done(tx);
      return baseline;
    },
    async updateAccountState(account, patch) {
      const tx = db.transaction(ACCOUNTS, 'readwrite');
      const store = tx.objectStore(ACCOUNTS);
      const existing = (await request(store.get(stateKey(account)))) as (AccountState & MirrorAccount) | undefined;
      const next = { ...existing, ...patch, webId: account.webId, username: account.username } as AccountState & MirrorAccount;
      for (const [key, value] of Object.entries(patch)) if (value === undefined) delete (next as unknown as Record<string, unknown>)[key];
      store.put(next);
      await done(tx);
    },
    async forgetAccount(account) {
      const tx = db.transaction([ITEMS, ACCOUNTS, DELETES], 'readwrite');
      tx.objectStore(ITEMS).delete(accountRange(KR, account));
      tx.objectStore(ACCOUNTS).delete(stateKey(account));
      const deletes = tx.objectStore(DELETES);
      const cursor = deletes.openCursor();
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) return;
        if ((at.value as StoredDelete).webId === account.webId) at.delete();
        at.continue();
      };
      await done(tx);
    },
    close() {
      db.close();
    },
  };
}

function pairsWith(row: JournalRecord, descriptionUrl: string, except: MirrorAccount & { token: string }): boolean {
  if (row.descriptionUrl !== descriptionUrl || LEAVING.has(row.state)) return false;
  return !(row.webId === except.webId && row.username === except.username && row.token === except.token);
}

/** An in-memory journal with the same behaviour, for the engine's tests. Keeps nothing. */
export function createMemoryMirrorJournal(): MirrorJournal {
  const items = new Map<string, JournalRecord>();
  const states = new Map<string, AccountState>();
  const pending = new Map<string, StoredDelete>();
  const key = (a: MirrorAccount, token: string) => JSON.stringify([a.webId, a.username, token]);
  const accountKey = (a: MirrorAccount) => JSON.stringify([a.webId, a.username]);
  return {
    deletesFor(webId, storage) {
      const scope = scopeOf(webId, storage);
      const at = (url: string) => JSON.stringify([scope, url]);
      return {
        async put(entry) {
          pending.set(at(entry.descriptionUrl), { ...entry, scope, webId });
        },
        async delete(url) {
          pending.delete(at(url));
        },
        async list() {
          return [...pending.values()].filter((entry) => entry.scope === scope).map(({ scope: _s, webId: _w, ...entry }) => entry);
        },
      };
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
    async isPairedElsewhere(descriptionUrl, except) {
      return [...items.values()].some((row) => pairsWith(row, descriptionUrl, except));
    },
    async getAccountState(a) {
      const found = states.get(accountKey(a));
      return found && structuredClone(found);
    },
    async ensureBaseline(a, baseline) {
      const existing = states.get(accountKey(a));
      if (existing?.baseline) return existing.baseline;
      states.set(accountKey(a), { ...existing, baseline });
      return baseline;
    },
    async updateAccountState(a, patch) {
      const next = { ...states.get(accountKey(a)), ...patch } as AccountState;
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (next as unknown as Record<string, unknown>)[k];
      states.set(accountKey(a), structuredClone(next));
    },
    async forgetAccount(a) {
      for (const [k, r] of [...items]) if (r.webId === a.webId && r.username === a.username) items.delete(k);
      states.delete(accountKey(a));
      for (const [k, entry] of [...pending]) if (entry.webId === a.webId) pending.delete(k);
    },
    close() {},
  };
}
