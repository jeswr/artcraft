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
import { BytesError, type FetchPublicBytes } from './bytes.js';
import type { JournalRecord, MirrorJournal, RecordPatch } from './journal.js';
import { type AssetInput, type AssetKind, classify, parseDate, referenceTokens, thumbnailUrl, toAssetInput } from './mapping.js';
import type {
  FailureReason,
  HostedClient,
  HostedMediaFile,
  HostedPrompt,
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
} from './types.js';

/** The part of `@jeswr/pod-media-store`'s store the mirror uses. */
export interface PodStorePort {
  put(input: PutInput<AssetInput>): Promise<Result<PutOutcome>>;
  attachThumbnail(descriptionUrl: string, input: AttachThumbnailInput): Promise<Result<unknown>>;
  remove(descriptionUrl: string, signal?: AbortSignal): Promise<Result<void>>;
  resumePending(signal?: AbortSignal): Promise<Result<ResumeSummary>>;
  checkExposure(signal?: AbortSignal): Promise<Result<ExposureState>>;
}

export type OpenStoreResult = { ok: true; store: PodStorePort } | { ok: false; reason: 'offline' | 'failed' };
/** Builds the store from the session's fetch. Called again after every reconnect. */
export type OpenStore = (signal: AbortSignal) => Promise<OpenStoreResult>;

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
  /** Automatic attempts before an item is `failed`. */
  maxAttempts?: number;
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
}

const DEFAULTS = {
  concurrency: 2,
  maxBytes: 50 * 1024 * 1024,
  maxThumbnailBytes: 5 * 1024 * 1024,
  maxAttempts: 6,
  baseDelayMs: 5_000,
  maxDelayMs: 15 * 60_000,
  thumbnailDelaysMs: [30_000, 120_000, 600_000, 3_600_000, 21_600_000] as readonly number[],
  pageSize: 100,
  maxReconcilePages: 100,
  reconcileIntervalMs: 0,
  changedDebounceMs: 1_500,
};

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TERMINAL: ReadonlySet<FailureReason> = new Set(['conflict', 'forbidden', 'too-large', 'unsupported', 'invalid-description']);

export function backoffDelay(attempts: number, baseMs: number, maxMs: number, random: () => number): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempts - 1));
  return Math.round(exponential * (0.8 + 0.4 * random()));
}

/** Copies the hosted library to the pod, one item at a time, and remembers how each went. */
export class PodMirror {
  private readonly o: Required<Omit<PodMirrorOptions, 'network' | 'events' | 'isIntermediate' | 'sniff'>> &
    Pick<PodMirrorOptions, 'network' | 'events' | 'isIntermediate'> & { sniff: Sniffer };
  private readonly records = new Map<string, JournalRecord>();
  private readonly states = new Map<string, ItemState>();
  private readonly work = new Map<string, Work>();
  private readonly inflight = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly hints = new Map<string, HostedMediaFile>();
  private readonly deleted = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribers: (() => void)[] = [];

  private running = false;
  private forgotten = false;
  private seq = 0;
  private version = 0;
  private cachedSummary: MirrorSummary | null = null;
  private watermark = 0;
  private store: PodStorePort | null = null;
  private exposureOk = false;
  private blocked: 'exposed' | 'exposure-unknown' | null = null;
  private storeAttempts = 0;
  private resumed = false;
  private preparing: Promise<void> | null = null;
  private reconciling: Promise<ReconcileResult> | null = null;
  private lifecycle: AbortController | null = null;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private prepareTimer: ReturnType<typeof setTimeout> | null = null;
  private changedTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: PodMirrorOptions) {
    this.o = {
      ...DEFAULTS,
      now: () => Date.now(),
      random: () => Math.random(),
      ...stripUndefined(options),
      sniff: options.sniff ?? defaultSniff,
    } as PodMirror['o'];
  }

  /** Loads the journal, then begins copying whatever is pending. Does not wait for the copies. */
  async start(): Promise<void> {
    if (this.running || this.forgotten) return;
    this.running = true;
    this.lifecycle = new AbortController();
    this.resumed = false;
    const { account, journal } = this.o;
    this.watermark = await journal.ensureWatermark(account, this.o.now());
    this.records.clear();
    this.states.clear();
    for (const record of await journal.list(account)) {
      this.records.set(record.token, record);
      this.states.set(record.token, stateFromRecord(record));
      this.schedule(record);
    }
    if (!this.running) return;
    this.unsubscribers.push(this.o.session.subscribe(() => this.onSessionChange()));
    if (this.o.network) this.unsubscribers.push(this.o.network.subscribe(() => this.onNetworkChange()));
    if (this.o.events) this.unsubscribers.push(this.o.events.subscribe((event) => this.onEvent(event)));
    this.changed();
    void this.prepare().then(() => this.reconcile().catch(() => undefined));
    this.armInterval();
  }

  /** Stops copying and aborts what is in flight. The journal keeps every item's state. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    for (const off of this.unsubscribers.splice(0)) off();
    this.lifecycle?.abort();
    for (const { controller } of this.inflight.values()) controller.abort();
    for (const timer of [this.pumpTimer, this.prepareTimer, this.changedTimer, this.intervalTimer]) if (timer) clearTimeout(timer);
    this.pumpTimer = this.prepareTimer = this.changedTimer = this.intervalTimer = null;
    await Promise.allSettled([...this.inflight.values()].map((entry) => entry.done));
    await Promise.allSettled([this.preparing, this.reconciling]);
    this.store = null;
    this.exposureOk = false;
    this.changed();
  }

  /** Adds one hosted item (by its token) to the queue. Safe to call again for the same item. */
  async enqueue(token: string): Promise<void> {
    await this.admit(token, undefined);
  }

  /** Tries a failed (or backing-off) item again now, and lifts an exposure pause to re-check it. */
  async retry(token: string): Promise<void> {
    const record = this.records.get(token);
    if (!record) return;
    if (record.state === 'failed') await this.patch(token, { state: 'pending', attempts: 0, nextAttemptAt: undefined, lastError: undefined });
    else if (record.state === 'remove-failed') await this.patch(token, { state: 'removing', attempts: 0, nextAttemptAt: undefined, lastError: undefined });
    else if (record.state === 'pending' || record.state === 'removing') await this.patch(token, { nextAttemptAt: undefined });
    else if (record.state === 'saved' && record.thumbnail === 'waiting') await this.patch(token, { thumbnailNextAt: undefined, thumbnailAttempts: 0 });
    else return;
    this.blocked = null;
    this.exposureOk = false;
    void this.prepare();
  }

  /** Walks the hosted listing newest first and queues what is not yet journalled. */
  reconcile(): Promise<ReconcileResult> {
    if (!this.running) return Promise.resolve({ enqueued: 0, pages: 0, stoppedBy: 'not-running', orderUnverified: false });
    this.reconciling ??= this.walk().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
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
    for (const state of this.states.values()) {
      if (state.kind === 'saved') counts.saved++;
      else if (state.kind === 'pending') counts.pending++;
      else if (state.kind === 'failed' || state.kind === 'remove-failed') counts.failed++;
      else if (state.kind === 'skipped') counts.skipped++;
      else counts.removing++;
    }
    this.cachedSummary = { version: this.version, running: this.running, paused: this.pauseReason(), counts };
    return this.cachedSummary;
  }

  /** Stops, and purges this account's journal records, watermark and pending deletes. */
  async forgetAccount(): Promise<void> {
    this.forgotten = true;
    await this.stop();
    await this.o.journal.forgetAccount(this.o.account);
    this.records.clear();
    this.states.clear();
    this.work.clear();
    this.hints.clear();
    this.deleted.clear();
    this.changed();
  }

  /** Resolves when nothing is in flight, preparing or reconciling (work waiting on a timer does not count). */
  async idle(): Promise<void> {
    for (;;) {
      const pending = [...this.inflight.values()].map((entry) => entry.done);
      if (this.preparing) pending.push(this.preparing);
      if (this.reconciling) pending.push(this.reconciling.then(() => undefined, () => undefined));
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  // ---- intake -------------------------------------------------------------------------

  private async admit(token: string, hint: HostedMediaFile | undefined): Promise<boolean> {
    if (this.forgotten || typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false;
    const now = this.o.now();
    const fresh: JournalRecord = { ...this.o.account, token, state: 'pending', attempts: 0, createdAt: now, updatedAt: now };
    const { record, created } = await this.o.journal.create(fresh);
    this.deleted.delete(token);
    if (!created && this.records.has(token)) return false;
    this.records.set(token, record);
    this.states.set(token, stateFromRecord(record));
    if (hint) this.hints.set(token, hint);
    this.schedule(record);
    this.changed();
    this.pump();
    return created;
  }

  private onEvent(event: MirrorSourceEvent): void {
    if (event.type === 'added') for (const token of event.tokens) void this.admit(token, undefined).catch(() => undefined);
    else if (event.type === 'deleted') void this.onHostedDeleted(event.token).catch(() => undefined);
    else {
      if (this.changedTimer) clearTimeout(this.changedTimer);
      this.changedTimer = setTimeout(() => {
        this.changedTimer = null;
        void this.reconcile().catch(() => undefined);
      }, this.o.changedDebounceMs);
    }
  }

  private async walk(): Promise<ReconcileResult> {
    const result: ReconcileResult = { enqueued: 0, pages: 0, stoppedBy: 'end', orderUnverified: false };
    const signal = this.lifecycle?.signal;
    let previous = Number.POSITIVE_INFINITY;
    for (let page = 0; page < this.o.maxReconcilePages; page++) {
      if (!this.running) return { ...result, stoppedBy: 'not-running' };
      if (!this.canTalk()) return { ...result, stoppedBy: 'hosted-unavailable' };
      const listed = await this.o.hosted.listUserMediaFiles(page, this.o.pageSize, signal).catch(() => ({ ok: false as const, kind: 'unavailable' as const }));
      if (!listed.ok) return { ...result, stoppedBy: 'hosted-unavailable' };
      result.pages++;
      const { items, totalPages } = listed.value;
      if (items.length === 0) return { ...result, stoppedBy: 'end' };
      for (const file of items) {
        const created = parseDate(file.created_at)?.getTime();
        if (created !== undefined) {
          if (created > previous) result.orderUnverified = true;
          previous = created;
        }
      }
      for (const file of items) {
        if (!this.running) return { ...result, stoppedBy: 'not-running' };
        if (await this.o.journal.get(this.o.account, file.token)) {
          if (!result.orderUnverified) return { ...result, stoppedBy: 'journalled' };
          continue;
        }
        const created = parseDate(file.created_at)?.getTime();
        if (created !== undefined && created < this.watermark) {
          if (!result.orderUnverified) return { ...result, stoppedBy: 'watermark' };
          continue;
        }
        if (await this.admit(file.token, file)) result.enqueued++;
      }
      if (totalPages !== null && page + 1 >= totalPages) return { ...result, stoppedBy: 'end' };
    }
    return { ...result, stoppedBy: 'page-cap' };
  }

  private armInterval(): void {
    if (!this.running || this.o.reconcileIntervalMs <= 0) return;
    this.intervalTimer = setTimeout(() => {
      void this.reconcile().catch(() => undefined).finally(() => this.armInterval());
    }, this.o.reconcileIntervalMs);
  }

  // ---- delete pairing -------------------------------------------------------------------

  private async onHostedDeleted(token: string): Promise<void> {
    const record = this.records.get(token);
    if (!record) return;
    const running = this.inflight.get(token);
    if (running) {
      this.deleted.add(token);
      running.controller.abort();
      return;
    }
    await this.beginRemoval(record);
  }

  private async beginRemoval(record: JournalRecord): Promise<void> {
    if (record.descriptionUrl && (record.state === 'saved' || record.state === 'removing' || record.state === 'remove-failed' || record.state === 'pending')) {
      await this.patch(record.token, { state: 'removing', attempts: 0, nextAttemptAt: undefined, lastError: undefined });
      this.pump();
      return;
    }
    // Nothing reached the pod: the item has no copy to pair with.
    await this.o.journal.remove(this.o.account, record.token);
    this.records.delete(record.token);
    this.states.delete(record.token);
    this.work.delete(record.token);
    this.hints.delete(record.token);
    this.changed();
  }

  // ---- scheduling ---------------------------------------------------------------------

  private schedule(record: JournalRecord): void {
    this.work.delete(record.token);
    if (record.state === 'pending') this.work.set(record.token, { kind: 'copy', due: record.nextAttemptAt ?? 0, seq: this.seq++ });
    else if (record.state === 'removing') this.work.set(record.token, { kind: 'remove', due: record.nextAttemptAt ?? 0, seq: this.seq++ });
    else if (record.state === 'saved' && record.thumbnail === 'waiting') this.work.set(record.token, { kind: 'thumb', due: record.thumbnailNextAt ?? 0, seq: this.seq++ });
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
    const waiting = [...this.work.entries()].filter(([token]) => !this.inflight.has(token)).sort((a, b) => a[1].due - b[1].due || a[1].seq - b[1].seq);
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
        await this.failTask(token, kind, 'unexpected', controller.signal).catch(() => undefined);
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
      }
    })();
    this.inflight.set(token, { controller, done });
  }

  // ---- the copy ------------------------------------------------------------------------

  private async copy(token: string, signal: AbortSignal): Promise<void> {
    const store = this.store;
    if (!store) return;
    const hint = this.hints.get(token);
    this.hints.delete(token);
    let file = hint;
    if (!file) {
      const got = await this.o.hosted.getMediaFile(token, signal);
      if (!got.ok) {
        if (got.kind === 'not-found') return this.skip(token, 'hosted-deleted');
        return this.failTask(token, 'copy', 'hosted-unavailable', signal);
      }
      file = got.value;
    }
    const verdict = classify(file, { isIntermediate: this.o.isIntermediate });
    if (!verdict.copy) return this.skip(token, verdict.reason);

    let prompt: HostedPrompt | undefined;
    if (file.maybe_prompt_token) {
      const got = await this.o.hosted.getPrompt(file.maybe_prompt_token, signal);
      if (got.ok) prompt = got.value;
      else if (got.kind === 'unavailable') return this.failTask(token, 'copy', 'hosted-unavailable', signal);
    }
    const referencedAssets: string[] = [];
    for (const reference of referenceTokens(prompt)) {
      const known = await this.o.journal.get(this.o.account, reference);
      if (known?.state === 'saved' && known.descriptionUrl) referencedAssets.push(`${known.descriptionUrl}#it`);
    }

    let bytes: Uint8Array;
    try {
      bytes = await this.o.fetchPublicBytes(file.media_links.cdn_url, { maxBytes: this.o.maxBytes, signal });
    } catch (error) {
      if (error instanceof BytesError && error.kind === 'too-large') return this.failTask(token, 'copy', 'too-large', signal, true);
      if (error instanceof BytesError && error.kind === 'bad-url') return this.failTask(token, 'copy', 'bytes-unavailable', signal, true);
      return this.failTask(token, 'copy', 'bytes-unavailable', signal);
    }
    const sniffed = this.o.sniff(bytes);
    if (!sniffed) return this.skip(token, 'unsupported-type');
    if (sniffed.contentType.startsWith('audio/')) return this.skip(token, 'audio-unsupported');
    const kind = kindOf(sniffed.contentType);
    if (!kind) return this.skip(token, 'unsupported-type');

    const template = file.media_links.thumbnail_template;
    let thumb: { bytes: Uint8Array; contentType: string } | undefined;
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
      nextAttemptAt: undefined,
    });
  }

  private async fetchThumbnail(template: string | null | undefined, signal: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
    const url = thumbnailUrl(template);
    if (!url) return undefined;
    try {
      const bytes = await this.o.fetchPublicBytes(url, { maxBytes: this.o.maxThumbnailBytes, signal });
      const sniffed = this.o.sniff(bytes);
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
    const removed = await store.remove(record.descriptionUrl, signal);
    if (removed.ok || removed.error.kind === 'not-found') return this.dropRecord(token);
    return this.storeFailure(token, 'remove', removed.error, signal);
  }

  private async dropRecord(token: string): Promise<void> {
    await this.o.journal.remove(this.o.account, token);
    this.records.delete(token);
    this.states.delete(token);
    this.work.delete(token);
    this.changed();
  }

  // ---- failures ------------------------------------------------------------------------

  private async skip(token: string, reason: SkipReason): Promise<void> {
    await this.patch(token, { state: 'skipped', lastError: reason, nextAttemptAt: undefined });
  }

  private async storeFailure(token: string, kind: WorkKind, error: MediaStoreError, signal: AbortSignal): Promise<void> {
    if (error.kind === 'exposed') {
      this.blocked = error.reason === 'library-exposed' ? 'exposed' : 'exposure-unknown';
      this.exposureOk = false;
      this.changed();
      return this.failTask(token, kind, 'exposed', signal, true);
    }
    const reason = mapStoreError(error);
    return this.failTask(token, kind, reason, signal, TERMINAL.has(reason));
  }

  /**
   * Records a failed attempt. A retryable one backs off and stays `pending` until
   * `maxAttempts`; a terminal one (or the last attempt) becomes `failed` and waits for `retry`.
   */
  private async failTask(token: string, kind: WorkKind, reason: FailureReason, signal: AbortSignal, terminal = false): Promise<void> {
    const record = this.records.get(token);
    if (!record) return;
    if (signal.aborted) return; // stopped, disconnected or deleted: nothing was learned
    if (kind === 'thumb') return; // a thumbnail miss never fails the saved item
    if (this.o.network && !this.o.network.isOnline()) return; // paused, not failed
    const attempts = record.attempts + 1;
    const removing = kind === 'remove';
    if (terminal || attempts >= this.o.maxAttempts) {
      await this.patch(token, { state: removing ? 'remove-failed' : 'failed', attempts, lastError: reason, nextAttemptAt: undefined });
      return;
    }
    const delay = backoffDelay(attempts, this.o.baseDelayMs, this.o.maxDelayMs, this.o.random);
    await this.patch(token, { attempts, lastError: reason, nextAttemptAt: this.o.now() + delay });
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
    if (!this.store) {
      const opened = await this.o.openStore(signal).catch(() => ({ ok: false as const, reason: 'failed' as const }));
      if (!opened.ok) return this.retryPrepareLater(opened.reason);
      this.store = opened.store;
      this.storeAttempts = 0;
    }
    if (!this.exposureOk && this.blocked === null) {
      const checked = await this.store.checkExposure(signal).catch(() => undefined);
      if (checked?.ok && checked.value === 'private') this.exposureOk = true;
      else if (checked?.ok && checked.value === 'exposed') this.blocked = 'exposed';
      else if (checked && !checked.ok && checked.error.kind === 'offline') return this.retryPrepareLater('offline');
      else if (checked && !checked.ok && checked.error.kind === 'exposed') this.blocked = checked.error.reason === 'library-exposed' ? 'exposed' : 'exposure-unknown';
      else this.blocked = 'exposure-unknown';
    }
    if (this.exposureOk && !this.resumed) {
      this.resumed = true;
      await this.store.resumePending(signal).catch(() => undefined);
    }
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
    this.records.set(token, next);
    this.states.set(token, stateFromRecord(next));
    this.work.delete(token);
    this.schedule(next);
    this.changed();
    await this.o.journal.update(this.o.account, token, patch, now).catch(() => undefined);
  }

  private changed(): void {
    this.version++;
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
      return { kind: 'pending', attempts: record.attempts };
  }
}

function kindOf(contentType: string): AssetKind | undefined {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('model/')) return 'model3d';
  return undefined;
}

function mapStoreError(error: MediaStoreError): FailureReason {
  switch (error.kind) {
    case 'conflict':
      return 'conflict';
    case 'forbidden':
      return 'forbidden';
    case 'too-large':
      return 'too-large';
    case 'unsupported':
      return 'unsupported';
    case 'offline':
      return 'offline';
    case 'not-found':
      return 'store';
    default:
      if (error.reason === 'description-too-large' || error.reason === 'invalid-input') return 'invalid-description';
      return error.reason === 'unexpected' ? 'unexpected' : 'store';
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
