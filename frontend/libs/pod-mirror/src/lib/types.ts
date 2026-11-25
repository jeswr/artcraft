/**
 * The pieces of ArtCraft's hosted API that the mirror reads, as structural types. They are
 * subsets of `MediaFile` and `Prompts` in `@storyteller/api`; the app layer assigns the real
 * models to these, so a change to the hosted models fails to compile there.
 */
export interface HostedMediaFile {
  token: string;
  media_type: string;
  media_class: string | null;
  maybe_prompt_token: string | null;
  maybe_original_filename: string | null;
  maybe_duration_millis: number | null;
  maybe_title: string | null;
  maybe_origin_model_type: string | null;
  origin: { maybe_model: { title: string } | null };
  media_links: { cdn_url: string; thumbnail_template: string };
  created_at: string;
}

export interface HostedPrompt {
  token: string;
  created_at: string;
  maybe_positive_prompt: string | null;
  maybe_negative_prompt: string | null;
  maybe_model_type: string | null;
  maybe_model_class: string | null;
  maybe_generation_provider: string | null;
  maybe_generation_mode: string | null;
  maybe_aspect_ratio: string | null;
  maybe_resolution: string | null;
  maybe_duration_seconds: number | null;
  maybe_strength: number | null;
  maybe_batch_count: number | null;
  maybe_generate_audio: boolean | null;
  maybe_style_name: string | null;
  maybe_frame_skip: number | null;
  /** Reference images the generation used (only their tokens are read). */
  maybe_context_images: { media_token: string; semantic: string }[] | null;
}

/** A hosted call's outcome. `not-found` is the hosted side saying the item is gone. */
export type HostedResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'not-found' | 'unavailable' };

export interface HostedPage {
  items: readonly HostedMediaFile[];
  /** Total number of pages, when the hosted side says; the walk also stops on an empty page. */
  totalPages: number | null;
}

/** The hosted calls the mirror makes. The app wires the existing hosted clients to these. */
export interface HostedClient {
  /** The hosted username signed in right now, or null. Deletions are only verified for this account. */
  currentUsername(): string | null;
  /** The hosted API origin in use right now. A journal is only ever used with the origin it was made for. */
  currentHost(): string;
  getMediaFile(token: string, signal?: AbortSignal): Promise<HostedResult<HostedMediaFile>>;
  getPrompt(token: string, signal?: AbortSignal): Promise<HostedResult<HostedPrompt>>;
  /**
   * Looks several items up at once. An item that is missing from a successful answer is only a
   * hint that it is gone; the mirror confirms with `getMediaFile` before acting on it.
   */
  getMediaFiles(tokens: readonly string[], signal?: AbortSignal): Promise<HostedResult<readonly HostedMediaFile[]>>;
  /** The signed-in user's library, newest first; `pageIndex` starts at 0. */
  listUserMediaFiles(pageIndex: number, pageSize: number, signal?: AbortSignal): Promise<HostedResult<HostedPage>>;
}

/** The hosted account a mirror copies for. Records are keyed by it. */
export interface MirrorAccount {
  webId: string;
  /** The hosted username. */
  username: string;
}

/**
 * Why an item was not saved. Only some of these end in `failed` (they wait for the person);
 * the rest (`hosted-unavailable`, `offline`, `store`, `unexpected`, and a transient
 * `bytes-unavailable`) are shown on a `pending` item that is backing off and trying again.
 */
export type FailureReason =
  | 'conflict'
  | 'forbidden'
  | 'unsupported'
  | 'exposed'
  | 'invalid-description'
  | 'bytes-unavailable'
  | 'cdn-blocked'
  | 'hosted-unavailable'
  | 'offline'
  | 'store'
  | 'unexpected';

/** Why an item is deliberately not copied. */
export type SkipReason =
  | 'audio-unsupported'
  | 'scene'
  | 'intermediate'
  | 'unsupported-type'
  | 'too-large'
  /** The pod refused this one item for its size (HTTP 413); nothing else is affected. */
  | 'too-large-for-pod'
  | 'bad-date'
  | 'hosted-deleted';

/**
 * Where one item stands. Every journalled item is in exactly one of these; the gallery shows
 * it and nothing is dropped without one.
 */
export type ItemState =
  /** `lastError` is set while the item is backing off after a transient failure. */
  | { kind: 'pending'; attempts: number; lastError?: FailureReason }
  | { kind: 'saved'; descriptionUrl: string; thumbnail: 'attached' | 'waiting' | 'none' }
  | { kind: 'failed'; reason: FailureReason; attempts: number }
  | { kind: 'skipped'; reason: SkipReason }
  /** The hosted copy is deleted and the pod copy is being removed. */
  | { kind: 'removing'; attempts: number }
  /** The hosted copy is deleted but the pod copy could not be removed yet. */
  | { kind: 'remove-failed'; reason: FailureReason; attempts: number };

export type PauseReason = 'offline' | 'session' | 'exposed' | 'exposure-unknown' | 'storage-unsafe' | 'store-unavailable' | 'stopped';

export interface MirrorStatus {
  running: boolean;
  /** Why no copying happens right now, when it does not. */
  paused: PauseReason | null;
  /** The container the exposure check was about, while paused for exposure. */
  exposureTarget: string | null;
}

export interface MirrorCounts {
  saved: number;
  pending: number;
  failed: number;
  skipped: number;
  removing: number;
}

export type ImportState = 'idle' | 'running' | 'paused' | 'cancelled' | 'done';

/** Where "copy my existing library" stands. Counts are of the items this run brought in. */
export interface ImportStatus {
  state: ImportState;
  /** Set while the run is paused by the pod rather than by the person: its storage is full. */
  pausedBy: 'quota' | null;
  /** Hosted items the walk has gone past, whether or not they were already copied. */
  walked: number;
  /** The library's size when it was known cheaply at the start, else null. */
  total: number | null;
  saved: number;
  skipped: number;
  failed: number;
  pending: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface MirrorSummary extends MirrorStatus {
  /** Changes whenever anything visible changes. */
  version: number;
  counts: MirrorCounts;
  import: ImportStatus;
  /** Saved items ArtCraft no longer lists. Their pod copies stay until the person asks to remove them. */
  goneFromArtcraft: number;
  /**
   * The pod check found more of the library missing than it believes on its own (more than
   * max(5, 10%) of the items asked): nothing was requeued. `copyAgain()` is the person's go-ahead.
   */
  /** The local record could not be written: nothing is deleted from the pod until it can, and an item is not called saved. */
  journalUnavailable?: boolean;
  libraryMissing?: { missing: number; checked: number } | null;
  /** Every download from ArtCraft's media host has failed since this install began, while the pod works. */
  mediaHostBlocked: boolean;
}

export interface ReconcileResult {
  enqueued: number;
  pages: number;
  stoppedBy: 'mark' | 'baseline' | 'end' | 'page-cap' | 'hosted-unavailable' | 'not-running';
  /** True when the hosted listing was not newest first, so the walk could not stop early. */
  orderUnverified: boolean;
}

/** What the app tells the mirror happened on the hosted side. */
export type MirrorSourceEvent =
  /** These items were just added to the library. */
  | { type: 'added'; tokens: readonly string[] }
  /** Something was added but the event does not say what: walk the listing. */
  | { type: 'changed' }
  | { type: 'deleted'; token: string };

export interface MirrorEventSource {
  subscribe(handler: (event: MirrorSourceEvent) => void): () => void;
}

export interface SessionPort {
  isConnected(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface NetworkPort {
  isOnline(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface VerifyResult {
  checked: number;
  /** Items the hosted side says it no longer has. Their pod copies are kept and only marked. */
  flagged: number;
  /** Saved items whose pod copy the pod said is gone, queued to be copied again (hosted item still there). */
  requeued: number;
  /** `pod-unavailable`: the hosted side was checked but the pod could not be asked, so the pass is not recorded as done. */
  stoppedBy: 'done' | 'too-soon' | 'hosted-unavailable' | 'pod-unavailable' | 'library-missing' | 'not-running';
}
