import {
  type AttachThumbnailInput,
  defaultSniff,
  type ExposureState,
  type MediaStoreError,
  type PutInput,
  type PutOutcome,
  type ResumeSummary,
  type Result,
  type Sniffer,
} from '@jeswr/pod-media-store';
import { thumbnailMutation } from './assets-store.js';
import { BytesError, blobHead, type FetchPublicBytes } from './bytes.js';
import type { Baseline, ImportRun, ItemMark, JournalRecord, MirrorJournal, RecordPatch } from './journal.js';
import { type AssetInput, type AssetKind, classify, type Expected, parseDate, referenceTokens, thumbnailUrl, toAssetInput } from './mapping.js';
import type {
  FailureReason,
  HostedClient,
  HostedMediaFile,
  HostedPrompt,
  ImportStatus,
  ItemState,
  MirrorAccount,
  MirrorCounts,
  MirrorEventSource,
  MirrorSourceEvent,
  MirrorSummary,
  NetworkPort,
  PauseReason,
  ReconcileResult,
  SessionPort,
  SkipReason,
  VerifyResult,
} from './types.js';

/** The part of `@jeswr/pod-media-store`'s store the mirror uses. */
export interface PodStorePort {
  put(input: PutInput<AssetInput>): Promise<Result<PutOutcome>>;
  attachThumbnail(descriptionUrl: string, input: AttachThumbnailInput): Promise<Result<unknown>>;
  remove(descriptionUrl: string, signal?: AbortSignal): Promise<Result<void>>;
  resumePending(signal?: AbortSignal): Promise<Result<ResumeSummary>>;
  /**
   * Finds or creates the library and probes it, before anything is written. `url` is null when the
   * library does not exist and the storage root is not provably private: nothing was created.
   */
  ensureLibrary(signal?: AbortSignal): Promise<Result<LibraryReport>>;
  /** The container the exposure check is about: the library, or the storage root before it exists. */
  exposureTarget(): string | null;
}

export type OpenStoreResult = { ok: true; store: PodStorePort } | { ok: false; reason: 'offline' | 'failed' };
export interface LibraryReport {
  url: string | null;
  created: boolean;
  exposure: ExposureState;
  /** The container the probe was asked about. */
  probed: string;
}

export interface OpenStoreOptions {
  /**
   * Asked by the store, per container, when the probe cannot tell. True only for a container
   * the person confirmed (a child of a confirmed container counts).
   */
  allowUnknownExposureFor: (containerUrl: string) => boolean;
}
/** Builds the store from the session's fetch. Called again after every reconnect. */
export type OpenStore = (signal: AbortSignal, options: OpenStoreOptions) => Promise<OpenStoreResult>;

export interface PodMirrorOptions {
  account: MirrorAccount;
  journal: MirrorJournal;
  hosted: HostedClient;
  openStore: OpenStore;
  fetchPublicBytes: FetchPublicBytes;
  session: SessionPort;
  network?: NetworkPort;
  events?: MirrorEventSource;
  sniff?: Sniffer;
  /** Hosted records that are intermediate system files (none are known from the model today). */
  isIntermediate?: (file: HostedMediaFile) => boolean;
  concurrency?: number;
  maxBytes?: number;
  maxThumbnailBytes?: number;
  /** Attempts after which a failure that might be a block (not an outage) becomes `failed`. */
  blockedAttempts?: number;
  /** Check journalled items against the hosted library this often; 0 turns it off. */
  verifyIntervalMs?: number;
  /** On start, verify only if the last pass was longer ago than this. */
  verifyOnStartAfterMs?: number;
  /** Items looked up in one hosted batch call during verification. */
  verifyChunk?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  thumbnailDelaysMs?: readonly number[];
  pageSize?: number;
  maxReconcilePages?: number;
  /** Walk the listing again this often while running; 0 turns it off. */
  reconcileIntervalMs?: number;
  /** Wait before a `changed` event's walk, so a burst becomes one. */
  changedDebounceMs?: number;
  now?: () => number;
  random?: () => number;
}

type WorkKind = 'copy' | 'remove' | 'thumb';
interface Work {
  kind: WorkKind;
  due: number;
  seq: number;
  /** 0 for live items, 1 for the import's: live work is always taken first. */
  priority: number;
}

/** The store's own default binary limit; the mirror holds items to the same ceiling. */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

const DEFAULTS = {
  concurrency: 2,
  /** Handed to the store as a Blob, which the session's fetch sends without buffering it. */
  maxBytes: DEFAULT_MAX_BYTES,
  maxThumbnailBytes: 5 * 1024 * 1024,
  blockedAttempts: 3,
  verifyIntervalMs: 24 * 60 * 60_000,
  verifyOnStartAfterMs: 60 * 60_000,
  verifyChunk: 50,
  baseDelayMs: 5_000,
  maxDelayMs: 15 * 60_000,
  thumbnailDelaysMs: [30_000, 120_000, 600_000, 3_600_000, 21_600_000] as readonly number[],
  pageSize: 100,
  maxReconcilePages: 100,
  reconcileIntervalMs: 0,
  changedDebounceMs: 1_500,
};

/** Failed downloads, with none ever working, after which the media host is called unreachable. */
const BLOCKED_AFTER_FAILURES = 6;

/** After this many failed attempts an item waits a day between tries instead of a quarter of an hour. */
const LONG_WAIT_AFTER = 12;
const LONG_WAIT_MS = 24 * 60 * 60_000;

/** The same deterministic store failure this many times in a row ends an item until it is retried. */
const DETERMINISTIC_REPEATS = 3;
const DETERMINISTIC_REASONS: ReadonlySet<string> = new Set([
  'description-too-large',
  'invalid-input',
  'description-invalid',
  'description-unparseable',
  'not-a-document',
  'shard-title',
  'no-validator',
  'name-unavailable',
]);

/**
 * What a pod's "too big" answer means, from the store's reasons under kind `too-large`:
 * `insufficient-storage` (HTTP 507: the pod is full) and `payload-too-large` (HTTP 413: this one
 * body is too big, whatever the space). Any other reason (`storage`, from a store that does not
 * tell the two apart) is treated as one item refused, and two different items in a row are taken
 * for a full pod.
 */
export type PodRefusal = 'no-space' | 'item' | 'unclear';
export function podRefusal(error: MediaStoreError): PodRefusal | undefined {
  if (error.kind !== 'too-large') return undefined;
  switch (error.reason) {
    case 'insufficient-storage':
      return 'no-space';
    case 'payload-too-large':
      return 'item';
    case 'storage':
      return 'unclear';
    default:
      return undefined;
  }
}

/** Passes over the listing after the first, to catch items that slid past it while it was read. */
const CATCH_UP_PASSES = 3;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** How a failure is handled: wait and retry for ever, stop at once, or stop after this many attempts. */
type Policy = 'transient' | 'terminal' | number;

export function backoffDelay(attempts: number, baseMs: number, maxMs: number, random: () => number): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempts - 1));
  return Math.round(exponential * (0.8 + 0.4 * random()));
}

/** The journal's account for a hosted user on one API origin. */
export function journalAccount(account: MirrorAccount, host: string): MirrorAccount {
  return { webId: account.webId, username: host ? `${account.username}|${host}` : account.username };
}

/** Copies the hosted library to the pod, one item at a time, and remembers how each went. */
export class PodMirror {
  /** The hosted username as the hosted side knows it; `o.account` carries it with the API origin, for the journal. */
  private readonly hostedUser: string;
  private readonly hostedHost: string;
  private readonly o: Required<Omit<PodMirrorOptions, 'network' | 'events' | 'isIntermediate' | 'sniff'>> &
    Pick<PodMirrorOptions, 'network' | 'events' | 'isIntermediate'> & { sniff: Sniffer };
  private readonly records = new Map<string, JournalRecord>();
  private readonly states = new Map<string, ItemState>();
  /** Tokens per pod description: several hosted items can share one copy. */
  private readonly pairings = new Map<string, Set<string>>();
  private readonly work = new Map<string, Work>();
  private readonly inflight = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly hints = new Map<string, HostedMediaFile>();
  private readonly deleted = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribers: (() => void)[] = [];
  private readonly confirmed = new Set<string>();

  private running = false;
  private forgotten = false;
  private seq = 0;
  private version = 0;
  private cachedSummary: MirrorSummary | null = null;
  private baseline: Baseline | undefined;
  private store: PodStorePort | null = null;
  private exposureOk = false;
  private blocked: 'exposed' | 'exposure-unknown' | 'storage-unsafe' | null = null;
  /** The library container `ensureLibrary` reported; the only container that can be confirmed. */
  private libraryUrl: string | null = null;
  private target: string | null = null;
  private storeAttempts = 0;
  private resumed = false;
  private preparing: Promise<void> | null = null;
  private reconciling: Promise<ReconcileResult> | null = null;
  private verifying: Promise<VerifyResult> | null = null;
  private lifecycle: AbortController | null = null;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private prepareTimer: ReturnType<typeof setTimeout> | null = null;
  private changedTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;
  private verifyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly refusedItems = new Set<string>();
  private bytesEverOk = false;
  /** Downloads that have failed in a row, with none ever having worked on this install. */
  private byteFailures = 0;
  private importRun: ImportRun = { state: 'idle', walked: 0 };
  private importWalker: Promise<void> | null = null;
  private importTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly importWaiters: (() => void)[] = [];

  constructor(options: PodMirrorOptions) {
    this.o = {
      ...DEFAULTS,
      now: () => Date.now(),
      random: () => Math.random(),
      ...stripUndefined(options),
      sniff: options.sniff ?? defaultSniff,
    } as PodMirror['o'];
    // A journal is only ever used with the hosted API origin it was made for, so another
    // backend can never match an item.
    this.hostedUser = options.account.username;
    this.hostedHost = options.hosted.currentHost();
    this.o.account = journalAccount(options.account, this.hostedHost);
  }

  /** Loads the journal, then begins copying whatever is pending. Does not wait for the copies. */
  async start(): Promise<void> {
    if (this.running || this.forgotten) return;
    this.running = true;
    this.lifecycle = new AbortController();
    this.resumed = false;
    const { account, journal } = this.o;
    const state = await journal.getAccountState(account);
    this.baseline = state?.baseline;
    this.bytesEverOk = state?.bytesEverOk === true;
    this.byteFailures = 0;
    this.importRun = state?.import ? { ...state.import } : { state: 'idle', walked: 0 };
    this.confirmed.clear();
    for (const url of state?.confirmedPrivate ?? []) this.confirmed.add(url);
    this.records.clear();
    this.states.clear();
    this.pairings.clear();
    for (const record of await journal.list(account)) {
      this.records.set(record.token, record);
      this.states.set(record.token, stateFromRecord(record));
      this.index(record);
      // A restart tries again at once: waiting out a backoff from a previous run helps nobody.
      this.schedule(record, true);
    }
    if (!this.running) return;
    this.unsubscribers.push(this.o.session.subscribe(() => this.onSessionChange()));
    if (this.o.network) this.unsubscribers.push(this.o.network.subscribe(() => this.onNetworkChange()));
    if (this.o.events) this.unsubscribers.push(this.o.events.subscribe((event) => this.onEvent(event)));
    this.changed();
    void this.prepare().then(() => this.reconcile().catch(() => undefined));
    void this.verify(false, this.o.verifyOnStartAfterMs).catch(() => undefined);
    this.armInterval();
    this.armVerify();
    // A run that was going when the app closed goes on; one that was not never starts by itself.
    this.launchImport();
  }

  /** Stops copying and aborts what is in flight. The journal keeps every item's state. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    for (const off of this.unsubscribers.splice(0)) off();
    this.lifecycle?.abort();
    for (const { controller } of this.inflight.values()) controller.abort();
    for (const timer of [this.pumpTimer, this.prepareTimer, this.changedTimer, this.intervalTimer, this.verifyTimer]) if (timer) clearTimeout(timer);
    this.pumpTimer = this.prepareTimer = this.changedTimer = this.intervalTimer = this.verifyTimer = null;
    this.wakeImport();
    await Promise.allSettled([...this.inflight.values()].map((entry) => entry.done));
    await Promise.allSettled([this.preparing, this.reconciling, this.verifying, this.importWalker]);
    this.store = null;
    this.exposureOk = false;
    this.changed();
  }

  /** Adds one hosted item (by its token) to the queue. Safe to call again for the same item. */
  async enqueue(token: string): Promise<void> {
    await this.admit(token, undefined);
  }

  /** Tries one failed (or backing-off) item again now, and lifts an exposure pause to re-check it. */
  async retry(token: string): Promise<void> {
    if (!(await this.retryOne(token))) return;
    this.recheck();
  }

  /** Tries every item that ended `failed` (or could not be removed, or had a bad date) again. */
  async retryAllFailed(): Promise<number> {
    let count = 0;
    for (const record of [...this.records.values()]) {
      const retryable = record.state === 'failed' || record.state === 'remove-failed' || (record.state === 'skipped' && record.lastError === 'bad-date');
      if (retryable && (await this.retryOne(record.token))) count++;
    }
    if (count > 0) this.recheck();
    return count;
  }

  /** Lifts an exposure pause and asks the pod again. */
  recheckExposure(): void {
    this.recheck();
  }

  /**
   * The person says the container the check was about is private, for a server whose rules the
   * check cannot read. Remembered per container and WebID; the store is then opened with the
   * explicit allow option. It never covers an `exposed` answer.
   */
  async confirmPrivate(): Promise<boolean> {
    // Never the storage root: only the library container the store reports.
    const library = this.libraryUrl;
    if (this.blocked !== 'exposure-unknown' || library === null) return false;
    this.confirmed.add(library);
    await this.o.journal.updateAccountState(this.o.account, { confirmedPrivate: [...this.confirmed] }).catch(() => undefined);
    this.recheck();
    return true;
  }

  /** Walks the hosted listing newest first and queues what is not yet journalled. */
  reconcile(): Promise<ReconcileResult> {
    if (!this.running) return Promise.resolve({ enqueued: 0, pages: 0, stoppedBy: 'not-running', orderUnverified: false });
    this.reconciling ??= this.walk().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  /**
   * Checks journalled `saved` items against the hosted library, in chunks: on start (if the last
   * pass was over an hour ago), then at most once a day (unless `force`). An item the hosted side definitively no longer has gets its pod copy
   * removed. An error, an offline moment or an item that is someone else's never removes anything.
   */
  verify(force = false, minGapMs = this.o.verifyIntervalMs): Promise<VerifyResult> {
    if (!this.running) return Promise.resolve({ checked: 0, flagged: 0, stoppedBy: 'not-running' });
    this.verifying ??= this.verifyPass(force, minGapMs).finally(() => {
      this.verifying = null;
    });
    return this.verifying;
  }

  stateOf(token: string): ItemState | undefined {
    return this.states.get(token);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A snapshot that is the same object until something visible changes. */
  summary(): MirrorSummary {
    if (this.cachedSummary?.version === this.version) return this.cachedSummary;
    const counts: MirrorCounts = { saved: 0, pending: 0, failed: 0, skipped: 0, removing: 0 };
    let gone = 0;
    for (const record of this.records.values()) if (record.state === 'saved' && record.goneFromArtcraft) gone++;
    for (const state of this.states.values()) {
      if (state.kind === 'saved') counts.saved++;
      else if (state.kind === 'pending') counts.pending++;
      else if (state.kind === 'failed' || state.kind === 'remove-failed') counts.failed++;
      else if (state.kind === 'skipped') counts.skipped++;
      else counts.removing++;
    }
    const paused = this.pauseReason();
    this.cachedSummary = {
      version: this.version,
      running: this.running,
      paused,
      exposureTarget: paused === 'exposed' || paused === 'exposure-unknown' || paused === 'storage-unsafe' ? this.target : null,
      counts,
      import: this.importStatus(),
      goneFromArtcraft: gone,
      mediaHostBlocked: this.mediaHostBlocked(),
    };
    return this.cachedSummary;
  }

  /** Stops, and purges this account's journal records, state and pending deletes. */
  async forgetAccount(): Promise<void> {
    this.forgotten = true;
    await this.stop();
    await this.o.journal.forgetAccount(this.o.account);
    this.records.clear();
    this.states.clear();
    this.pairings.clear();
    this.work.clear();
    this.hints.clear();
    this.deleted.clear();
    this.importRun = { state: 'idle', walked: 0 };
    this.changed();
  }

  /** Resolves when nothing is in flight, preparing or reconciling (work waiting on a timer does not count). */
  async idle(): Promise<void> {
    for (;;) {
      const pending = [...this.inflight.values()].map((entry) => entry.done);
      if (this.preparing) pending.push(this.preparing);
      if (this.reconciling) pending.push(this.reconciling.then(() => undefined, () => undefined));
      if (this.verifying) pending.push(this.verifying.then(() => undefined, () => undefined));
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  // ---- intake -------------------------------------------------------------------------

  private async admit(token: string, hint: HostedMediaFile | undefined, skipped?: SkipReason, source?: 'import'): Promise<boolean> {
    if (this.forgotten || typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false;
    const now = this.o.now();
    const fresh: JournalRecord = {
      ...this.o.account,
      token,
      state: skipped ? 'skipped' : 'pending',
      attempts: 0,
      ...(skipped ? { lastError: skipped } : {}),
      ...(source ? { source } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const { record, created } = await this.o.journal.create(fresh);
    // A delete that came in for a copy still in flight must survive a duplicate "added" event.
    if (created) this.deleted.delete(token);
    if (!created && this.records.has(token)) return false;
    this.records.set(token, record);
    this.states.set(token, stateFromRecord(record));
    this.index(record);
    if (hint) this.hints.set(token, hint);
    this.schedule(record);
    this.changed();
    this.pump();
    return created;
  }

  private onEvent(event: MirrorSourceEvent): void {
    if (event.type === 'added') for (const token of event.tokens) void this.admit(token, undefined).catch(() => undefined);
    else if (event.type === 'deleted') {
      // Only a delete the person made in this app, for the hosted user and API origin this
      // mirror belongs to, takes a pod copy with it.
      if (this.sameIdentity()) void this.onHostedDeleted(event.token).catch(() => undefined);
    }
    else {
      if (this.changedTimer) clearTimeout(this.changedTimer);
      this.changedTimer = setTimeout(() => {
        this.changedTimer = null;
        void this.reconcile().catch(() => undefined);
      }, this.o.changedDebounceMs);
    }
  }

  /**
   * The newest hosted item (by the hosted server's own creation time) when the account first
   * connected, or "empty". Everything newer is the mirror's business; everything older is not.
   * No local clock is involved.
   */
  private async ensureBaseline(): Promise<Baseline | undefined> {
    if (this.baseline) return this.baseline;
    if (!this.canTalk()) return undefined;
    const signal = this.lifecycle?.signal;
    const listed = await this.o.hosted.listUserMediaFiles(0, this.o.pageSize, signal).catch(() => ({ ok: false as const, kind: 'unavailable' as const }));
    if (!listed.ok) return undefined;
    let found: Baseline | undefined;
    if (listed.value.items.length === 0) found = { kind: 'empty' };
    else {
      let newest: ItemMark | undefined;
      for (const file of listed.value.items) {
        const at = parseDate(file.created_at)?.getTime();
        if (at !== undefined && (!newest || at > newest.createdAt)) newest = { token: file.token, createdAt: at };
      }
      if (newest) found = { kind: 'item', ...newest };
    }
    if (!found || !this.running) return undefined;
    this.baseline = await this.o.journal.ensureBaseline(this.o.account, found);
    return this.baseline;
  }

  /**
   * A walk stops only at the last completed walk's newest item, or at the connect baseline.
   * Journalled items inside that range are skipped, never an end: a typed event can journal
   * the newest item while older ones are still unseen. An interrupted walk is not resumed
   * from a page: the next one starts from the newest item again (listing is cheap, a gap is not),
   * and the mark moves only when a walk ran all the way down.
   */
  private async walk(): Promise<ReconcileResult> {
    const result: ReconcileResult = { enqueued: 0, pages: 0, stoppedBy: 'end', orderUnverified: false };
    const { journal, account } = this.o;
    const signal = this.lifecycle?.signal;
    const baseline = await this.ensureBaseline();
    if (!baseline) return { ...result, stoppedBy: this.running ? 'hosted-unavailable' : 'not-running' };
    const state = await journal.getAccountState(account);
    const mark = state?.mark;
    const baselineItem = baseline.kind === 'item' ? baseline : undefined;
    const boundary = Math.max(mark?.createdAt ?? Number.NEGATIVE_INFINITY, baselineItem?.createdAt ?? Number.NEGATIVE_INFINITY);
    let previous = Number.POSITIVE_INFINITY;
    let newest: ItemMark | undefined;

    const finish = async (stoppedBy: ReconcileResult['stoppedBy']): Promise<ReconcileResult> => {
      const complete = stoppedBy === 'mark' || stoppedBy === 'baseline' || stoppedBy === 'end';
      if (complete && newest) await journal.updateAccountState(account, { mark: newest }).catch(() => undefined);
      return { ...result, stoppedBy };
    };

    for (let page = 0; page < this.o.maxReconcilePages; page++) {
      if (!this.running) return finish('not-running');
      if (!this.canTalk()) return finish('hosted-unavailable');
      const listed = await this.o.hosted.listUserMediaFiles(page, this.o.pageSize, signal).catch(() => ({ ok: false as const, kind: 'unavailable' as const }));
      if (!listed.ok) return finish('hosted-unavailable');
      result.pages++;
      const { items, totalPages } = listed.value;
      if (items.length === 0) return finish('end');
      for (const file of items) {
        const created = parseDate(file.created_at)?.getTime();
        if (created !== undefined) {
          if (created > previous) result.orderUnverified = true;
          previous = created;
        }
      }
      for (const file of items) {
        if (!this.running) return finish('not-running');
        const created = parseDate(file.created_at)?.getTime();
        if (!newest && created !== undefined) newest = { token: file.token, createdAt: created };
        if (!result.orderUnverified) {
          if (mark && file.token === mark.token) return finish('mark');
          if (baselineItem && file.token === baselineItem.token) return finish('baseline');
        }
        if (this.records.has(file.token) || (await journal.get(account, file.token))) continue;
        if (created === undefined) {
          // A date that cannot be read must not let the item bypass the baseline, or be lost.
          if (await this.admit(file.token, undefined, 'bad-date')) result.enqueued++;
          continue;
        }
        if (created < boundary && !result.orderUnverified) return finish(mark && mark.createdAt >= (baselineItem?.createdAt ?? Number.NEGATIVE_INFINITY) ? 'mark' : 'baseline');
        if (created < boundary) continue;
        if (await this.admit(file.token, file)) result.enqueued++;
      }
      if (totalPages !== null && page + 1 >= totalPages) return finish('end');
    }
    return finish('page-cap');
  }

  private armInterval(): void {
    if (!this.running || this.o.reconcileIntervalMs <= 0) return;
    this.intervalTimer = setTimeout(() => {
      void this.reconcile().catch(() => undefined).finally(() => this.armInterval());
    }, this.o.reconcileIntervalMs);
  }

  private armVerify(): void {
    if (!this.running || this.o.verifyIntervalMs <= 0) return;
    this.verifyTimer = setTimeout(() => {
      void this.verify().catch(() => undefined).finally(() => this.armVerify());
    }, this.o.verifyIntervalMs);
  }

  // ---- copy my existing library -----------------------------------------------------------

  /**
   * How many items the hosted library holds, when two cheap calls can say (the first and the
   * last page). Null when it cannot be known now.
   */
  async estimateImport(): Promise<{ total: number | null }> {
    if (!this.canTalk()) return { total: null };
    const signal = this.lifecycle?.signal;
    const size = this.o.pageSize;
    const first = await this.o.hosted.listUserMediaFiles(0, size, signal).catch(() => undefined);
    if (!first?.ok) return { total: null };
    const pages = first.value.totalPages;
    if (pages === null) return { total: first.value.items.length < size ? first.value.items.length : null };
    if (pages <= 1) return { total: first.value.items.length };
    const last = await this.o.hosted.listUserMediaFiles(pages - 1, size, signal).catch(() => undefined);
    return { total: last?.ok ? (pages - 1) * size + last.value.items.length : null };
  }

  /**
   * Starts walking the whole hosted library, past the connect baseline, handing every item the
   * journal does not know to the same queue. Items already copied or skipped are left alone.
   * An earlier cancelled or finished run starts again from the first page.
   */
  async startImport(total: number | null = null): Promise<boolean> {
    if (!this.running || this.forgotten) return false;
    if (this.importRun.state === 'running') return true;
    if (this.importRun.state === 'paused') return this.resumeImport();
    this.importRun = { state: 'running', walked: 0, total, startedAt: this.o.now(), cursor: { page: 0 } };
    await this.saveImport();
    this.launchImport();
    return true;
  }

  /** Stops reading the listing. Items already queued still finish; resume goes on from the cursor. */
  async pauseImport(): Promise<void> {
    if (this.importRun.state !== 'running') return;
    this.importRun = { ...this.importRun, state: 'paused' };
    delete this.importRun.pausedBy;
    await this.saveImport();
    this.wakeImport();
  }

  async resumeImport(): Promise<boolean> {
    if (!this.running || this.importRun.state !== 'paused') return false;
    this.importRun = { ...this.importRun, state: 'running' };
    delete this.importRun.pausedBy;
    await this.saveImport();
    this.launchImport();
    this.pump();
    return true;
  }

  /**
   * Stops for good. Copies already made stay; items of this run that have not started are
   * dropped from the journal, so a later run picks them up again.
   */
  async cancelImport(): Promise<void> {
    if (this.importRun.state !== 'running' && this.importRun.state !== 'paused') return;
    this.importRun = { ...this.importRun, state: 'cancelled', finishedAt: this.o.now() };
    delete this.importRun.pausedBy;
    delete this.importRun.cursor;
    await this.saveImport();
    this.wakeImport();
    for (const record of [...this.records.values()]) {
      if (record.source === 'import' && record.state === 'pending' && !this.inflight.has(record.token)) await this.dropRecord(record.token);
    }
  }

  private mediaHostBlocked(): boolean {
    return !this.bytesEverOk && this.byteFailures >= BLOCKED_AFTER_FAILURES && this.pauseReason() === null;
  }

  private importStatus(): ImportStatus {
    const status: ImportStatus = {
      state: this.importRun.state,
      pausedBy: this.importRun.pausedBy ?? null,
      walked: this.importRun.walked,
      total: this.importRun.total ?? null,
      saved: 0,
      skipped: 0,
      failed: 0,
      pending: 0,
      startedAt: this.importRun.startedAt ?? null,
      finishedAt: this.importRun.finishedAt ?? null,
    };
    for (const record of this.records.values()) {
      if (record.source !== 'import') continue;
      if (record.state === 'saved') status.saved++;
      else if (record.state === 'skipped') status.skipped++;
      else if (record.state === 'failed' || record.state === 'remove-failed') status.failed++;
      else status.pending++;
    }
    return status;
  }

  private async saveImport(): Promise<void> {
    await this.o.journal.updateAccountState(this.o.account, { import: { ...this.importRun } }).catch(() => undefined);
    this.changed();
  }

  private wakeImport(): void {
    if (this.importTimer) clearTimeout(this.importTimer);
    this.importTimer = null;
    for (const wake of this.importWaiters.splice(0)) wake();
  }

  private launchImport(): void {
    if (this.importWalker || this.importRun.state !== 'running' || !this.running) return;
    this.importWalker = this.importLoop()
      .catch(() => undefined)
      .finally(() => {
        this.importWalker = null;
        this.changed();
      });
  }

  /** Waits until the engine can take more and the queue is not already long. False: stop walking. */
  private async importReady(): Promise<boolean> {
    for (;;) {
      if (!this.running || this.importRun.state !== 'running') return false;
      if (this.pauseReason() === null && this.importBacklog() < this.o.pageSize) return true;
      await new Promise<void>((resolve) => this.importWaiters.push(resolve));
    }
  }

  /** Import items that are in flight or due now; ones waiting out a backoff do not hold the walk back. */
  private importBacklog(): number {
    const now = this.o.now();
    let count = 0;
    for (const record of this.records.values()) {
      if (record.source !== 'import' || record.state !== 'pending') continue;
      if (this.inflight.has(record.token) || (record.nextAttemptAt ?? 0) <= now) count++;
    }
    return count;
  }

  private importPending(): number {
    let count = 0;
    for (const record of this.records.values()) if (record.source === 'import' && record.state === 'pending') count++;
    return count;
  }

  /** The run is done when the listing has been walked as often as it will be and nothing it brought in is still waiting. */
  private async finishImportIfDone(): Promise<void> {
    if (this.importRun.state !== 'running' || !this.importRun.walkDone || this.importPending() > 0) return;
    this.importRun = { ...this.importRun, state: 'done', finishedAt: this.o.now() };
    delete this.importRun.cursor;
    await this.saveImport();
  }

  private async importLoop(): Promise<void> {
    const { hosted, journal, account } = this.o;
    const running = () => this.running && this.importRun.state === 'running';
    if (this.importRun.walkDone) return this.finishImportIfDone();
    // One page back: deletions made while the run was down move older items up a page.
    let page = Math.max(0, (this.importRun.cursor?.page ?? 0) - 1);
    let passes = this.importRun.passes ?? 0;
    this.importRun.walked = Math.min(this.importRun.walked, page * this.o.pageSize);
    let failures = 0;
    let admitted = 0;
    const retryLater = async (): Promise<void> => {
      failures++;
      const delay = backoffDelay(failures, this.o.baseDelayMs, this.o.maxDelayMs, this.o.random);
      await new Promise<void>((resolve) => {
        this.importTimer = setTimeout(resolve, delay);
        this.importWaiters.push(resolve);
      });
    };
    for (;;) {
      if (!(await this.importReady())) return;
      // Items newer than the connect baseline are the live walk's; they are never the import's.
      const baseline = await this.ensureBaseline();
      if (!baseline) {
        await retryLater();
        continue;
      }
      const listed = await hosted.listUserMediaFiles(page, this.o.pageSize, this.lifecycle?.signal).catch(() => ({ ok: false as const, kind: 'unavailable' as const }));
      if (!running()) return;
      if (!listed.ok) {
        await retryLater();
        continue;
      }
      failures = 0;
      const { items, totalPages } = listed.value;
      for (const file of items) {
        if (!running()) return;
        if (passes === 0) this.importRun.walked++;
        if (this.records.has(file.token) || (await journal.get(account, file.token))) continue;
        admitted++;
        const created = parseDate(file.created_at)?.getTime();
        const old = created === undefined || (baseline.kind === 'item' && created <= baseline.createdAt);
        if (!old) await this.admit(file.token, file);
        else if (created === undefined) await this.admit(file.token, undefined, 'bad-date', 'import');
        else await this.admit(file.token, file, undefined, 'import');
        // A cancel that came in during the admission leaves nothing of this run behind.
        if (!running() && this.records.get(file.token)?.source === 'import' && !this.inflight.has(file.token)) await this.dropRecord(file.token);
      }
      page++;
      const endOfPass = items.length === 0 || (totalPages !== null && page >= totalPages);
      if (!endOfPass) {
        this.importRun.cursor = { page };
        await this.saveImport();
        continue;
      }
      // Deletions while the walk went on can slide items past it: go over the listing again,
      // and stop when a pass finds nothing new (at most `CATCH_UP_PASSES` more).
      passes++;
      if (passes > 1 && admitted === 0) passes = CATCH_UP_PASSES + 1;
      if (passes <= CATCH_UP_PASSES) {
        page = 0;
        admitted = 0;
        this.importRun = { ...this.importRun, cursor: { page: 0 }, passes };
        await this.saveImport();
        continue;
      }
      this.importRun = { ...this.importRun, walkDone: true, passes };
      delete this.importRun.cursor;
      await this.saveImport();
      return this.finishImportIfDone();
    }
  }

  /** The pod is full: the item waits (it is not the item's fault) and a running import pauses. */
  private async quotaHit(token: string, signal: AbortSignal): Promise<void> {
    if (this.importRun.state === 'running') {
      this.importRun = { ...this.importRun, state: 'paused', pausedBy: 'quota' };
      await this.saveImport();
      this.wakeImport();
    }
    return this.failTask(token, 'copy', 'store', signal, 'transient');
  }

  /** The pod refused this one item for its size. It is final for the item and affects nothing else. */
  private async refusedByPod(token: string): Promise<void> {
    await this.skip(token, 'too-large-for-pod');
  }

  /** A 413 or 507 that cannot be told apart: one item is skipped, a second different one means the pod is full. */
  private async refusedUnclear(token: string, signal: AbortSignal): Promise<void> {
    if (this.refusedItems.size > 0 && !this.refusedItems.has(token)) {
      this.refusedItems.clear();
      return this.quotaHit(token, signal);
    }
    this.refusedItems.add(token);
    await this.skip(token, 'too-large-for-pod');
  }

  // ---- delete pairing -------------------------------------------------------------------

  private async onHostedDeleted(token: string): Promise<void> {
    const record = this.records.get(token);
    if (!record) return;
    if (this.inflight.has(token)) {
      // Not aborted: a put cut off after the pod accepted it would leave a copy nothing points
      // at. It finishes, then the removal follows.
      this.deleted.add(token);
      return;
    }
    await this.beginRemoval(record);
  }

  private async beginRemoval(record: JournalRecord): Promise<void> {
    if (record.descriptionUrl && (record.state === 'saved' || record.state === 'removing' || record.state === 'remove-failed' || record.state === 'pending')) {
      await this.patch(record.token, { state: 'removing', attempts: 0, repeats: undefined, nextAttemptAt: undefined, lastError: undefined });
      this.pump();
      return;
    }
    // Nothing reached the pod: the item has no copy to pair with.
    await this.dropRecord(record.token);
  }

  /** The hosted user and API origin that are signed in right now are the ones this mirror is for. */
  private sameIdentity(): boolean {
    return this.o.hosted.currentUsername() === this.hostedUser && this.o.hosted.currentHost() === this.hostedHost;
  }

  /**
   * Looks for saved items the hosted side no longer lists, in chunks. It never deletes: an item
   * whose own lookup says "not found" is only marked, and its pod copy stays until the person
   * asks for it to go (`removeGoneFromPod`). A different hosted user or API origin, an outage
   * or going offline stops the pass before anything is marked.
   */
  private async verifyPass(force: boolean, minGapMs: number): Promise<VerifyResult> {
    const { journal, account, hosted } = this.o;
    const result: VerifyResult = { checked: 0, flagged: 0, stoppedBy: 'done' };
    const state = await journal.getAccountState(account);
    if (!force && state?.verifiedAt !== undefined && this.o.now() - state.verifiedAt < minGapMs) return { ...result, stoppedBy: 'too-soon' };
    // A lookup made as a different hosted user, or on another backend, would call every item "gone".
    if (!this.sameIdentity()) return { ...result, stoppedBy: 'hosted-unavailable' };
    const signal = this.lifecycle?.signal;
    const saved = [...this.records.values()].filter((record) => record.state === 'saved').map((record) => record.token);
    for (let at = 0; at < saved.length; at += this.o.verifyChunk) {
      if (!this.canTalk()) return { ...result, stoppedBy: this.running ? 'hosted-unavailable' : 'not-running' };
      const chunk = saved.slice(at, at + this.o.verifyChunk);
      const batch = await hosted.getMediaFiles(chunk, signal).catch(() => ({ ok: false as const, kind: 'unavailable' as const }));
      if (!batch.ok || !this.sameIdentity()) return { ...result, stoppedBy: 'hosted-unavailable' };
      const present = new Set(batch.value.map((file) => file.token));
      result.checked += chunk.length;
      for (const token of chunk) {
        if (present.has(token)) {
          await this.markPresent(token);
          continue;
        }
        // Absent from a batch is a hint. Only the item's own lookup answering "not found" counts.
        const own = await hosted.getMediaFile(token, signal).catch(() => ({ ok: false as const, kind: 'unavailable' as const }));
        if (!own.ok && own.kind === 'unavailable') return { ...result, stoppedBy: 'hosted-unavailable' };
        if (own.ok) {
          await this.markPresent(token);
          continue;
        }
        if (!this.canTalk()) return { ...result, stoppedBy: this.running ? 'hosted-unavailable' : 'not-running' };
        if (!this.sameIdentity()) return { ...result, stoppedBy: 'hosted-unavailable' };
        const record = this.records.get(token);
        if (record?.state !== 'saved') continue;
        if (!record.goneFromArtcraft) await this.patch(token, { goneFromArtcraft: true });
        result.flagged++;
      }
    }
    await journal.updateAccountState(account, { verifiedAt: this.o.now() }).catch(() => undefined);
    return result;
  }

  private async markPresent(token: string): Promise<void> {
    if (this.records.get(token)?.goneFromArtcraft) await this.patch(token, { goneFromArtcraft: undefined });
  }

  /**
   * The person's explicit choice: remove the pod copies of items ArtCraft no longer lists. The
   * only path that deletes on the strength of a lookup, and only after a confirmation in the UI.
   */
  async removeGoneFromPod(): Promise<number> {
    if (!this.running || !this.sameIdentity()) return 0;
    let count = 0;
    for (const record of [...this.records.values()]) {
      if (record.state !== 'saved' || !record.goneFromArtcraft) continue;
      await this.onHostedDeleted(record.token);
      count++;
    }
    return count;
  }

  // ---- scheduling ---------------------------------------------------------------------

  private schedule(record: JournalRecord, restart = false): void {
    this.work.delete(record.token);
    const due = restart && record.attempts < 3 ? 0 : record.nextAttemptAt ?? 0;
    const priority = record.source === 'import' ? 1 : 0;
    if (record.state === 'pending') this.work.set(record.token, { kind: 'copy', due, seq: this.seq++, priority });
    else if (record.state === 'removing') this.work.set(record.token, { kind: 'remove', due, seq: this.seq++, priority: 0 });
    else if (record.state === 'saved' && record.thumbnail === 'waiting') this.work.set(record.token, { kind: 'thumb', due: record.thumbnailNextAt ?? 0, seq: this.seq++, priority });
  }

  private pauseReason(): PauseReason | null {
    if (!this.running) return 'stopped';
    if (!this.o.session.isConnected()) return 'session';
    if (this.o.network && !this.o.network.isOnline()) return 'offline';
    if (this.blocked) return this.blocked;
    if (!this.store || !this.exposureOk) return 'store-unavailable';
    return null;
  }

  private canTalk(): boolean {
    return this.running && this.o.session.isConnected() && (this.o.network?.isOnline() ?? true);
  }

  private pump(): void {
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
    if (this.pauseReason() !== null) return;
    const now = this.o.now();
    const waiting = [...this.work.entries()].filter(([token]) => !this.inflight.has(token)).sort((a, b) => a[1].priority - b[1].priority || a[1].due - b[1].due || a[1].seq - b[1].seq);
    let earliest = Number.POSITIVE_INFINITY;
    for (const [token, work] of waiting) {
      if (work.due > now) {
        earliest = Math.min(earliest, work.due);
        continue;
      }
      if (this.inflight.size >= this.o.concurrency) break;
      this.work.delete(token);
      this.launch(token, work.kind);
    }
    if (Number.isFinite(earliest)) this.pumpTimer = setTimeout(() => this.pump(), Math.max(0, earliest - now));
  }

  private launch(token: string, kind: WorkKind): void {
    const controller = new AbortController();
    this.lifecycle?.signal.addEventListener('abort', () => controller.abort(), { once: true });
    const done = (async () => {
      try {
        if (kind === 'copy') await this.copy(token, controller.signal);
        else if (kind === 'remove') await this.removeCopy(token, controller.signal);
        else await this.backfillThumbnail(token, controller.signal);
      } catch {
        await this.failTask(token, kind, 'unexpected', controller.signal, 'transient').catch(() => undefined);
      } finally {
        this.inflight.delete(token);
        const record = this.records.get(token);
        if (record && this.running) {
          if (this.deleted.has(token)) {
            this.deleted.delete(token);
            await this.beginRemoval(record).catch(() => undefined);
          } else if (!this.work.has(token)) this.schedule(record);
        }
        this.pump();
        void this.finishImportIfDone().catch(() => undefined);
      }
    })();
    this.inflight.set(token, { controller, done });
  }

  // ---- the copy ------------------------------------------------------------------------

  private async copy(token: string, signal: AbortSignal): Promise<void> {
    const store = this.store;
    if (!store) return;
    // The attempt is counted, and the next one scheduled, before anything is downloaded, so
    // nothing that keeps failing can fetch the same file again without waiting its turn.
    const before = this.records.get(token);
    if (!before) return;
    const attempt = before.attempts + 1;
    await this.patch(token, { attempts: attempt, nextAttemptAt: this.o.now() + this.retryDelay(attempt) });
    const hint = this.hints.get(token);
    this.hints.delete(token);
    let file = hint;
    if (!file) {
      const got = await this.o.hosted.getMediaFile(token, signal);
      if (!got.ok) {
        if (got.kind === 'not-found') return this.skip(token, 'hosted-deleted');
        return this.failTask(token, 'copy', 'hosted-unavailable', signal, 'transient');
      }
      file = got.value;
    }
    const verdict = classify(file, { isIntermediate: this.o.isIntermediate });
    if (!verdict.copy) return this.skip(token, verdict.reason);

    let prompt: HostedPrompt | undefined;
    if (file.maybe_prompt_token) {
      const got = await this.o.hosted.getPrompt(file.maybe_prompt_token, signal);
      if (got.ok) prompt = got.value;
      else if (got.kind === 'unavailable') return this.failTask(token, 'copy', 'hosted-unavailable', signal, 'transient');
    }
    const referencedAssets: string[] = [];
    for (const reference of referenceTokens(prompt)) {
      const known = await this.o.journal.get(this.o.account, reference);
      if (known?.state === 'saved' && known.descriptionUrl) referencedAssets.push(`${known.descriptionUrl}#it`);
    }

    let bytes: Blob;
    try {
      bytes = await this.o.fetchPublicBytes(file.media_links.cdn_url, { maxBytes: this.o.maxBytes, signal });
    } catch (error) {
      const kind = error instanceof BytesError ? error.kind : 'unavailable';
      if (kind === 'too-large') return this.skip(token, 'too-large');
      if (kind === 'bad-url' || kind === 'gone') return this.failTask(token, 'copy', 'bytes-unavailable', signal, 'terminal');
      // A refused request cannot be told from a CORS block: after a few tries it is reported as one.
      // Never terminal for the item: whether the media host is reachable at all is judged once,
      // across every item (`mediaHostBlocked`), not by one item's failures.
      this.noteByteFailure(signal);
      if (kind === 'network') return this.failTask(token, 'copy', 'cdn-blocked', signal, 'transient');
      return this.failTask(token, 'copy', 'bytes-unavailable', signal, 'transient');
    }
    this.noteByteSuccess();
    const sniffed = this.o.sniff(await blobHead(bytes), { extension: declaredExtension(file) });
    if (!sniffed) return this.skip(token, 'unsupported-type');
    if (sniffed.contentType.startsWith('audio/')) return this.skip(token, 'audio-unsupported');
    const kind = kindOf(sniffed.contentType, sniffed.extension);
    if (!kind || !agrees(verdict.expects, kind)) return this.skip(token, 'unsupported-type');

    const template = file.media_links.thumbnail_template;
    let thumb: { bytes: Blob; contentType: string } | undefined;
    if (kind !== 'model3d') thumb = await this.fetchThumbnail(template, signal);

    const description: AssetInput = {
      ...toAssetInput(file, prompt, { kind, referencedAssets }),
      ...(thumb ? { thumbnailEncodingFormat: thumb.contentType } : {}),
    };
    const put = await store.put({
      bytes,
      contentType: sniffed.contentType,
      extension: sniffed.extension,
      createdAt: parseDate(file.created_at) ?? new Date(this.o.now()),
      description,
      ...(thumb ? { thumbnail: { bytes: thumb.bytes } } : {}),
      signal,
    });
    if (!put.ok) return this.storeFailure(token, 'copy', put.error, signal);
    this.refusedItems.clear();

    let thumbnail: 'attached' | 'waiting' | 'none' = kind === 'model3d' || !thumbnailUrl(template) ? 'none' : 'waiting';
    if (put.value.thumbnailUrl !== undefined) thumbnail = 'attached';
    else if (thumb && put.value.thumbnailMissing) {
      const attached = await store.attachThumbnail(put.value.descriptionUrl, {
        bytes: thumb.bytes,
        mutate: thumbnailMutation(thumb.contentType),
        signal,
      });
      if (attached.ok) thumbnail = 'attached';
    }
    await this.patch(token, {
      state: 'saved',
      descriptionUrl: put.value.descriptionUrl,
      sha256: put.value.sha256,
      thumbnail,
      thumbnailTemplate: thumbnail === 'waiting' ? template : undefined,
      thumbnailAttempts: 0,
      thumbnailNextAt: thumbnail === 'waiting' ? this.o.now() + (this.o.thumbnailDelaysMs[0] ?? 0) : undefined,
      lastError: undefined,
      attempts: 0,
      repeats: undefined,
      nextAttemptAt: undefined,
    });
  }

  private async fetchThumbnail(template: string | null | undefined, signal: AbortSignal): Promise<{ bytes: Blob; contentType: string } | undefined> {
    const url = thumbnailUrl(template);
    if (!url) return undefined;
    try {
      const bytes = await this.o.fetchPublicBytes(url, { maxBytes: this.o.maxThumbnailBytes, signal });
      const sniffed = this.o.sniff(await blobHead(bytes));
      return sniffed?.contentType.startsWith('image/') ? { bytes, contentType: sniffed.contentType } : undefined;
    } catch {
      return undefined;
    }
  }

  private async backfillThumbnail(token: string, signal: AbortSignal): Promise<void> {
    const store = this.store;
    const record = this.records.get(token);
    if (!store || !record?.descriptionUrl || record.thumbnail !== 'waiting') return;
    const thumb = await this.fetchThumbnail(record.thumbnailTemplate, signal);
    if (thumb) {
      const attached = await store.attachThumbnail(record.descriptionUrl, { bytes: thumb.bytes, mutate: thumbnailMutation(thumb.contentType), signal });
      if (attached.ok) return this.patch(token, { thumbnail: 'attached', thumbnailTemplate: undefined, thumbnailNextAt: undefined });
      if (attached.error.kind === 'exposed') return this.storeFailure(token, 'thumb', attached.error, signal);
      if (attached.error.kind === 'not-found') return this.patch(token, { thumbnail: 'none', thumbnailTemplate: undefined, thumbnailNextAt: undefined });
    }
    if (signal.aborted) return;
    const attempts = (record.thumbnailAttempts ?? 0) + 1;
    const delay = this.o.thumbnailDelaysMs[attempts];
    if (delay === undefined) return this.patch(token, { thumbnail: 'none', thumbnailTemplate: undefined, thumbnailNextAt: undefined, thumbnailAttempts: attempts });
    await this.patch(token, { thumbnailAttempts: attempts, thumbnailNextAt: this.o.now() + delay });
  }

  // ---- removal -------------------------------------------------------------------------

  private async removeCopy(token: string, signal: AbortSignal): Promise<void> {
    const store = this.store;
    const record = this.records.get(token);
    if (!store || !record) return;
    if (!record.descriptionUrl) return this.dropRecord(token);
    // Several hosted items can share one copy. It goes only with the last of them.
    const others = [...(this.pairings.get(record.descriptionUrl) ?? [])].filter((other) => other !== token && this.records.get(other)?.state === 'saved');
    if (others.length > 0) return this.dropRecord(token);
    const removed = await store.remove(record.descriptionUrl, signal);
    if (removed.ok || removed.error.kind === 'not-found') return this.dropRecord(token);
    return this.storeFailure(token, 'remove', removed.error, signal);
  }

  private async dropRecord(token: string): Promise<void> {
    await this.o.journal.remove(this.o.account, token);
    const record = this.records.get(token);
    if (record) this.unindex(record);
    this.records.delete(token);
    this.states.delete(token);
    this.work.delete(token);
    this.hints.delete(token);
    this.changed();
  }

  private index(record: JournalRecord): void {
    if (!record.descriptionUrl) return;
    const tokens = this.pairings.get(record.descriptionUrl) ?? new Set<string>();
    tokens.add(record.token);
    this.pairings.set(record.descriptionUrl, tokens);
  }

  private unindex(record: JournalRecord): void {
    if (!record.descriptionUrl) return;
    const tokens = this.pairings.get(record.descriptionUrl);
    tokens?.delete(record.token);
    if (tokens?.size === 0) this.pairings.delete(record.descriptionUrl);
  }

  // ---- failures ------------------------------------------------------------------------

  private async skip(token: string, reason: SkipReason): Promise<void> {
    await this.patch(token, { state: 'skipped', lastError: reason, nextAttemptAt: undefined });
  }

  private async retryOne(token: string): Promise<boolean> {
    const record = this.records.get(token);
    if (!record) return false;
    if (record.state === 'failed') await this.patch(token, { state: 'pending', attempts: 0, repeats: undefined, nextAttemptAt: undefined, lastError: undefined });
    else if (record.state === 'skipped' && record.lastError === 'bad-date') await this.patch(token, { state: 'pending', attempts: 0, repeats: undefined, nextAttemptAt: undefined, lastError: undefined });
    else if (record.state === 'remove-failed') await this.patch(token, { state: 'removing', attempts: 0, repeats: undefined, nextAttemptAt: undefined, lastError: undefined });
    else if (record.state === 'pending' || record.state === 'removing') await this.patch(token, { nextAttemptAt: undefined });
    else if (record.state === 'saved' && record.thumbnail === 'waiting') await this.patch(token, { thumbnailNextAt: undefined, thumbnailAttempts: 0 });
    else return false;
    return true;
  }

  private recheck(): void {
    this.blocked = null;
    this.exposureOk = false;
    this.changed();
    void this.prepare();
  }

  private async storeFailure(token: string, kind: WorkKind, error: MediaStoreError, signal: AbortSignal): Promise<void> {
    if (error.kind === 'exposed') {
      this.blocked = error.reason === 'library-exposed' ? 'exposed' : 'exposure-unknown';
      this.target = this.store?.exposureTarget() ?? this.target;
      this.exposureOk = false;
      this.changed();
      // Not the item's fault and not counted against it: the pause holds the queue until the person acts.
      return this.uncount(token, kind);
    }
    if (kind === 'copy') {
      const refusal = podRefusal(error);
      if (refusal === 'no-space') return this.quotaHit(token, signal);
      if (refusal === 'item') return this.refusedByPod(token);
      if (refusal === 'unclear') return this.refusedUnclear(token, signal);
      if (error.kind === 'too-large') return this.skip(token, 'too-large');
    }
    // A repeated failure of the same deterministic kind is final until the person retries.
    const { reason, policy } = this.classifyStoreError(error);
    // A 401 and a 403 both read as "forbidden". While the session refreshes the first is
    // transient, so the store is opened again with the fresh fetch before giving up.
    if (reason === 'forbidden' && !signal.aborted) {
      this.store = null;
      this.exposureOk = false;
      void this.prepare();
    }
    return this.failTask(token, kind, reason, signal, policy);
  }

  private classifyStoreError(error: MediaStoreError): { reason: FailureReason; policy: Policy } {
    switch (error.kind) {
      case 'conflict':
        return { reason: 'conflict', policy: DETERMINISTIC_REPEATS };
      case 'forbidden':
        return { reason: 'forbidden', policy: this.o.blockedAttempts };
      case 'unsupported':
        return { reason: 'unsupported', policy: DETERMINISTIC_REPEATS };
      case 'too-large':
        return { reason: 'invalid-description', policy: 'terminal' };
      case 'offline':
        return { reason: 'offline', policy: 'transient' };
      case 'not-found':
        return { reason: 'store', policy: 'transient' };
      default:
        if (DETERMINISTIC_REASONS.has(error.reason)) return { reason: 'invalid-description', policy: DETERMINISTIC_REPEATS };
        return { reason: error.reason === 'unexpected' ? 'unexpected' : 'store', policy: 'transient' };
    }
  }

  /**
   * Records a failed attempt. A transient failure (outage, timeout, server error, expired
   * session) never ends an item: it backs off, up to a ceiling, and goes on. A terminal one, or
   * one that kept repeating past its own limit, becomes `failed` and waits for the person.
   */
  private async failTask(token: string, kind: WorkKind, reason: FailureReason, signal: AbortSignal, policy: Policy): Promise<void> {
    const record = this.records.get(token);
    if (!record) return;
    // Stopped, disconnected or deleted: nothing was learned, so the attempt does not count.
    if (signal.aborted || (this.o.network && !this.o.network.isOnline()) || !this.o.session.isConnected()) return this.uncount(token, kind);
    if (kind === 'thumb') return; // a thumbnail miss never fails the saved item
    // A copy was counted when it began; the other kinds are counted here.
    const attempts = kind === 'copy' ? record.attempts : record.attempts + 1;
    const repeats = (record.lastError === reason ? record.repeats ?? 0 : 0) + 1;
    const removing = kind === 'remove';
    if (policy === 'terminal' || (typeof policy === 'number' && repeats >= policy)) {
      await this.patch(token, { state: removing ? 'remove-failed' : 'failed', attempts, repeats, lastError: reason, nextAttemptAt: undefined });
      return;
    }
    await this.patch(token, { attempts, repeats, lastError: reason, nextAttemptAt: this.o.now() + this.retryDelay(attempts, reason) });
  }

  private async uncount(token: string, kind: WorkKind): Promise<void> {
    const record = this.records.get(token);
    if (kind !== 'copy' || !record || record.state !== 'pending') return;
    await this.patch(token, { attempts: Math.max(0, record.attempts - 1), nextAttemptAt: undefined });
  }

  /** Backoff, capped at a quarter of an hour; an item that has failed many times waits a day. */
  private retryDelay(attempts: number, reason?: FailureReason): number {
    // An outage can be long and is waited out at the usual pace; an item that keeps failing for
    // some other reason is not worth a download every quarter of an hour.
    if (attempts > LONG_WAIT_AFTER && (reason === 'store' || reason === 'unexpected' || reason === 'invalid-description')) return LONG_WAIT_MS;
    return backoffDelay(attempts, this.o.baseDelayMs, this.o.maxDelayMs, this.o.random);
  }

  private noteByteFailure(signal: AbortSignal): void {
    if (signal.aborted) return;
    this.byteFailures++;
    this.changed();
  }

  private noteByteSuccess(): void {
    const first = !this.bytesEverOk;
    this.byteFailures = 0;
    this.bytesEverOk = true;
    if (first) void this.o.journal.updateAccountState(this.o.account, { bytesEverOk: true }).catch(() => undefined);
    this.changed();
  }

  // ---- store and session -----------------------------------------------------------------

  private prepare(): Promise<void> {
    this.preparing ??= this.prepareOnce().finally(() => {
      this.preparing = null;
      this.changed();
      this.pump();
    });
    return this.preparing;
  }

  private async prepareOnce(): Promise<void> {
    if (!this.running || !this.o.session.isConnected() || !(this.o.network?.isOnline() ?? true)) return;
    const signal = this.lifecycle?.signal;
    if (!signal) return;
    const generation = this.generation;
    if (!this.store) {
      const opened = await this.o.openStore(signal, { allowUnknownExposureFor: (url) => this.isConfirmed(url) }).catch(() => ({ ok: false as const, reason: 'failed' as const }));
      // A session change while this was opening: the store it built used the previous fetch.
      if (generation !== this.generation || !this.running) return;
      if (!opened.ok) return this.retryPrepareLater(opened.reason);
      this.store = opened.store;
      this.storeAttempts = 0;
    }
    if (!this.exposureOk && this.blocked === null) {
      const ensured = await this.store.ensureLibrary(signal).catch(() => undefined);
      if (generation !== this.generation || !this.store) return;
      this.target = this.store.exposureTarget();
      if (!ensured || !ensured.ok) return this.retryPrepareLater(ensured && !ensured.ok && ensured.error.kind === 'offline' ? 'offline' : 'failed');
      const report = ensured.value;
      this.libraryUrl = report.url;
      this.target = report.url ?? report.probed;
      if (report.url === null) {
        // No library, and the storage root is exposed or could not be checked: nothing was created
        // and the root is never offered for confirmation.
        this.blocked = 'storage-unsafe';
      } else if (report.exposure === 'private') this.exposureOk = true;
      else if (report.exposure === 'exposed') this.blocked = 'exposed';
      else if (this.isConfirmed(report.url)) this.exposureOk = true;
      else this.blocked = 'exposure-unknown';
    }
    if (this.exposureOk && !this.resumed) {
      this.resumed = true;
      await this.store.resumePending(signal).catch(() => undefined);
    }
  }

  /** Bumped whenever the session or network changes what an in-flight store open would mean. */
  private generation = 0;

  private isConfirmed(target: string): boolean {
    for (const url of this.confirmed) {
      if (target === url || target.startsWith(url.endsWith('/') ? url : `${url}/`)) return true;
    }
    return false;
  }

  private retryPrepareLater(_reason: 'offline' | 'failed'): void {
    this.storeAttempts++;
    if (!this.running) return;
    const delay = backoffDelay(this.storeAttempts, this.o.baseDelayMs, this.o.maxDelayMs, this.o.random);
    if (this.prepareTimer) clearTimeout(this.prepareTimer);
    this.prepareTimer = setTimeout(() => {
      this.prepareTimer = null;
      void this.prepare();
    }, delay);
  }

  private onSessionChange(): void {
    if (!this.running) return;
    this.generation++;
    if (this.o.session.isConnected()) {
      this.store = null;
      this.exposureOk = false;
      this.blocked = null;
      this.resumed = false;
      void this.prepare().then(() => this.reconcile().catch(() => undefined));
    } else {
      for (const { controller } of this.inflight.values()) controller.abort();
      this.store = null;
      this.exposureOk = false;
    }
    this.changed();
  }

  private onNetworkChange(): void {
    if (!this.running) return;
    if (this.o.network?.isOnline()) {
      void this.prepare().then(() => this.reconcile().catch(() => undefined));
    } else {
      for (const { controller } of this.inflight.values()) controller.abort();
    }
    this.changed();
  }

  // ---- journal and notifications ---------------------------------------------------------------

  private async patch(token: string, patch: RecordPatch): Promise<void> {
    const now = this.o.now();
    const current = this.records.get(token);
    if (!current) return;
    const next: JournalRecord = { ...current, ...patch, updatedAt: now };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete (next as unknown as Record<string, unknown>)[key];
    this.unindex(current);
    this.records.set(token, next);
    this.index(next);
    this.states.set(token, stateFromRecord(next));
    this.work.delete(token);
    this.schedule(next);
    this.changed();
    await this.o.journal.update(this.o.account, token, patch, now).catch(() => undefined);
  }

  private changed(): void {
    this.version++;
    for (const wake of this.importWaiters.splice(0)) wake();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // a faulty subscriber must not stop the mirror
      }
    }
  }
}

function stateFromRecord(record: JournalRecord): ItemState {
  switch (record.state) {
    case 'saved':
      return { kind: 'saved', descriptionUrl: record.descriptionUrl ?? '', thumbnail: record.thumbnail ?? 'none' };
    case 'failed':
      return { kind: 'failed', reason: (record.lastError as FailureReason) ?? 'unexpected', attempts: record.attempts };
    case 'skipped':
      return { kind: 'skipped', reason: (record.lastError as SkipReason) ?? 'unsupported-type' };
    case 'removing':
      return { kind: 'removing', attempts: record.attempts };
    case 'remove-failed':
      return { kind: 'remove-failed', reason: (record.lastError as FailureReason) ?? 'unexpected', attempts: record.attempts };
    default:
      return { kind: 'pending', attempts: record.attempts, ...(record.lastError ? { lastError: record.lastError as FailureReason } : {}) };
  }
}

/** What the store's sniffer reports for splats: a generic type, told apart by its extension. */
const SPLAT_EXTENSIONS = new Set(['.ply', '.spz']);

function kindOf(contentType: string, extension: string): AssetKind | undefined {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('model/')) return 'model3d';
  if (contentType === 'application/octet-stream' && SPLAT_EXTENSIONS.has(extension)) return 'model3d';
  return undefined;
}

/**
 * The extension the hosted record declares, which the sniffer needs only to accept SPZ (a
 * format with no signature). It narrows and never decides: the bytes still have to be an SPZ.
 */
function declaredExtension(file: HostedMediaFile): string | undefined {
  if (file.media_type.toLowerCase() === 'spz') return '.spz';
  const name = file.maybe_original_filename?.toLowerCase();
  const dot = name?.lastIndexOf('.') ?? -1;
  return name && dot >= 0 ? name.slice(dot) : undefined;
}

/** A 3D record whose bytes are an image is a cover screenshot, not the model. */
function agrees(expects: Expected, kind: AssetKind): boolean {
  return expects !== 'model' || kind === 'model3d';
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
