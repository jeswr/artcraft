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
  getMediaFile(token: string, signal?: AbortSignal): Promise<HostedResult<HostedMediaFile>>;
  getPrompt(token: string, signal?: AbortSignal): Promise<HostedResult<HostedPrompt>>;
  /** The signed-in user's library, newest first; `pageIndex` starts at 0. */
  listUserMediaFiles(pageIndex: number, pageSize: number, signal?: AbortSignal): Promise<HostedResult<HostedPage>>;
}

/** The hosted account a mirror copies for. Records are keyed by it. */
export interface MirrorAccount {
  webId: string;
  /** The hosted username. */
  username: string;
}

/** Why an item was not saved and will not be unless the person asks again. */
export type FailureReason =
  | 'conflict'
  | 'forbidden'
  | 'too-large'
  | 'unsupported'
  | 'exposed'
  | 'invalid-description'
  | 'bytes-unavailable'
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
  | 'hosted-deleted';

/**
 * Where one item stands. Every journalled item is in exactly one of these; the gallery shows
 * it and nothing is dropped without one.
 */
export type ItemState =
  | { kind: 'pending'; attempts: number }
  | { kind: 'saved'; descriptionUrl: string; thumbnail: 'attached' | 'waiting' | 'none' }
  | { kind: 'failed'; reason: FailureReason; attempts: number }
  | { kind: 'skipped'; reason: SkipReason }
  /** The hosted copy is deleted and the pod copy is being removed. */
  | { kind: 'removing'; attempts: number }
  /** The hosted copy is deleted but the pod copy could not be removed yet. */
  | { kind: 'remove-failed'; reason: FailureReason; attempts: number };

export type PauseReason = 'offline' | 'session' | 'exposed' | 'exposure-unknown' | 'store-unavailable' | 'stopped';

export interface MirrorStatus {
  running: boolean;
  /** Why no copying happens right now, when it does not. */
  paused: PauseReason | null;
}

export interface MirrorCounts {
  saved: number;
  pending: number;
  failed: number;
  skipped: number;
  removing: number;
}

export interface MirrorSummary extends MirrorStatus {
  /** Changes whenever anything visible changes. */
  version: number;
  counts: MirrorCounts;
}

export interface ReconcileResult {
  enqueued: number;
  pages: number;
  stoppedBy: 'journalled' | 'watermark' | 'end' | 'page-cap' | 'hosted-unavailable' | 'not-running';
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
