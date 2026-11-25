import type { ListPage, MediaItem, MediaStoreErrorKind, Result } from '@jeswr/pod-media-store';
import type { AssetDescription } from '@jeswr/solid-creative-assets';
import { mintPodAssetRef, podAssetDescriptionUrl } from './ref.js';
import type { PodAsset, PodLibrarySource, PodSourceErrorKind, PodSourceResult } from './types.js';

/** Items per request. The store reads one description document per item, so this is also the cost. */
export const PAGE_SIZE = 50;

/** Pod text is untrusted: bound what reaches the DOM. */
export const MAX_NAME_LENGTH = 200;
export const MAX_TEXT_LENGTH = 2000;

/**
 * The part of an opened `@jeswr/pod-media-store` store this view uses: `list` and `get`. The
 * store's write methods are not in this type, so nothing built on it can write to the pod.
 */
export interface ReadOnlyAssetStore {
  list(options?: { cursor?: string; limit?: number; signal?: AbortSignal }): Promise<Result<ListPage<AssetDescription>>>;
  get(descriptionUrl: string, signal?: AbortSignal): Promise<Result<MediaItem<AssetDescription>>>;
}

/**
 * Turns an opened store into the gallery's source. Nothing is read from the pod here beyond what
 * the store parsed (the SDK's asset model builds the values; no RDF is touched), and no URL is
 * made up: the content and thumbnail URLs are the ones the store returns.
 */
export function createPodLibrarySource(store: ReadOnlyAssetStore): PodLibrarySource {
  return {
    async list({ cursor, limit, signal }) {
      const page = await store.list({
        ...(cursor ? { cursor } : {}),
        limit: limit ?? PAGE_SIZE,
        ...(signal ? { signal } : {}),
      });
      if (!page.ok) return failure(page.error.kind);
      const { items, next, skipped } = page.value;
      return {
        ok: true,
        value: {
          items: items.map(toPodAsset),
          next,
          unreadable: skipped.unparseable + skipped.outOfScope,
        },
      };
    },
    async get(ref, signal) {
      const found = await store.get(podAssetDescriptionUrl(ref), signal);
      return found.ok ? { ok: true, value: toPodAsset(found.value) } : failure(found.error.kind);
    },
  };
}

export function toPodAsset(item: MediaItem<AssetDescription>): PodAsset {
  const { value } = item;
  const asset = value.asset;
  const created = asset.dateCreated ?? item.modified;
  return {
    ref: mintPodAssetRef(item.descriptionUrl),
    kind: value.kind,
    name: clip(asset.name, MAX_NAME_LENGTH),
    description: clip(asset.description, MAX_TEXT_LENGTH),
    prompt: clip(value.generation?.prompt, MAX_TEXT_LENGTH),
    createdAt: created && !Number.isNaN(created.getTime()) ? created.toISOString() : null,
    declaredType: clip(asset.encodingFormat, 100),
    contentUrl: item.binaryUrl,
    thumbnailUrl: item.thumbnailUrl ?? null,
  };
}

function clip(text: string | undefined, max: number): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

function failure(kind: MediaStoreErrorKind): PodSourceResult<never> {
  return { ok: false, error: errorKindOf(kind) };
}

function errorKindOf(kind: MediaStoreErrorKind): PodSourceErrorKind {
  if (kind === 'offline' || kind === 'forbidden' || kind === 'not-found') return kind;
  return 'failed';
}

