import type { PodMediaAddress } from './address.js';
import type { PodAssetRef } from './ref.js';

export type PodAssetKind = 'image' | 'video' | 'model3d';

/**
 * One item of the pod library as the gallery shows it. Every string that came from the pod
 * (`name`, `description`, `prompt`, `declaredType`) is untrusted text: render it as text, never
 * as markup, and never follow a URL found in it. `content` and `thumbnail` are the addresses the
 * store returned (always inside the library), wrapped so that only the media hooks can use them.
 */
export interface PodAsset {
  readonly ref: PodAssetRef;
  readonly kind: PodAssetKind;
  readonly name: string | null;
  readonly description: string | null;
  readonly prompt: string | null;
  /** Creation time (ISO 8601), or the description's modification time, or null. */
  readonly createdAt: string | null;
  /** The type the description declares. Display only: the loader's sniffed type decides what is shown. */
  readonly declaredType: string | null;
  readonly content: PodMediaAddress;
  readonly thumbnail: PodMediaAddress | null;
}

export interface PodListPage {
  readonly items: readonly PodAsset[];
  /** Pass back as `cursor`, or null at the end. */
  readonly next: string | null;
  /** Descriptions in the library that this view cannot show (not ours, unreadable, outside it). */
  readonly unreadable: number;
}

/** A closed set: no message, URL or server text. */
/** `sign-in`: the pod session has ended or was refused; the person has to sign in again. */
export type PodSourceErrorKind = 'offline' | 'sign-in' | 'forbidden' | 'not-found' | 'failed';

export type PodSourceResult<T> = { ok: true; value: T } | { ok: false; error: PodSourceErrorKind };

/** The read-only view of the pod library: there is no write, delete or import method. */
export interface PodLibrarySource {
  list(options: { cursor?: string | null; limit?: number; signal?: AbortSignal }): Promise<PodSourceResult<PodListPage>>;
  get(ref: PodAssetRef, signal?: AbortSignal): Promise<PodSourceResult<PodAsset>>;
}
