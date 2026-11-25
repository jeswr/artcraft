import { useCallback, useEffect, useRef, useState } from 'react';
import type { PodGalleryAccess } from './context.js';
import { PodLibraryOpenError, type PodLibrary } from './library.js';
import { podAssetDescriptionUrl } from './ref.js';
import type { PodAsset, PodSourceErrorKind } from './types.js';

export type PodAssetsErrorKind = PodSourceErrorKind | 'not-connected';

export type PodAssetsState =
  | { status: 'loading' }
  | { status: 'error'; error: PodAssetsErrorKind }
  | {
      status: 'ready';
      library: PodLibrary;
      items: readonly PodAsset[];
      hasMore: boolean;
      loadingMore: boolean;
      /** The last "load more" failed; the items already shown stay. */
      loadMoreFailed: boolean;
      /** Descriptions in the library that cannot be shown (other apps' documents, unreadable ones). */
      unreadable: number;
    };

/** Pages with nothing showable in them are skipped, up to this many in a row. */
const MAX_EMPTY_PAGES = 20;

export interface PodAssets {
  state: PodAssetsState;
  /** Fetches the next page (a no-op while one is loading or at the end). */
  loadMore(): void;
  /** Starts again from the newest item. */
  refresh(): void;
}

/**
 * Lists the pod library page by page for the gallery. It reads only: the source it uses has no
 * other operation. It starts again when the pod's account changes, when the person refreshes and
 * when the network comes back after an offline failure. Items are kept in the order the store
 * lists them (newest month first, newest first within a month).
 */
export function usePodAssets(access: PodGalleryAccess): PodAssets {
  const [state, setState] = useState<PodAssetsState>({ status: 'loading' });
  const [generation, setGeneration] = useState(0);
  const cursorRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const libraryRef = useRef<PodLibrary | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    abortRef.current = abort;
    cursorRef.current = null;
    libraryRef.current = null;
    busyRef.current = true;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const library = await access.open();
        const first = await fetchPages(library, null, abort.signal);
        if (abort.signal.aborted) return;
        if (!first.ok) return setState({ status: 'error', error: first.error });
        cursorRef.current = first.next;
        libraryRef.current = library;
        setState({
          status: 'ready',
          library,
          items: first.items,
          hasMore: first.next !== null,
          loadingMore: false,
          loadMoreFailed: false,
          unreadable: first.unreadable,
        });
      } catch (error) {
        if (abort.signal.aborted) return;
        const kind = error instanceof PodLibraryOpenError ? error.kind : 'failed';
        setState({ status: 'error', error: kind });
      } finally {
        // A run that was replaced must not clear the flag of the run that replaced it.
        if (abortRef.current === abort) busyRef.current = false;
      }
    })();
    return () => abort.abort();
  }, [access, generation]);

  const loadMore = useCallback(() => {
    const cursor = cursorRef.current;
    const abort = abortRef.current;
    if (busyRef.current || cursor === null || !abort || abort.signal.aborted) return;
    busyRef.current = true;
    setState((current) => (current.status === 'ready' ? { ...current, loadingMore: true, loadMoreFailed: false } : current));
    void (async () => {
      try {
        const library = libraryRef.current;
        if (!library) return;
        const page = await fetchPages(library, cursor, abort.signal);
        if (abort.signal.aborted) return;
        if (!page.ok) {
          setState((current) => (current.status === 'ready' ? { ...current, loadingMore: false, loadMoreFailed: true } : current));
          return;
        }
        cursorRef.current = page.next;
        setState((current) =>
          current.status === 'ready'
            ? {
                ...current,
                items: mergeById(current.items, page.items),
                hasMore: page.next !== null,
                loadingMore: false,
                unreadable: current.unreadable + page.unreadable,
              }
            : current,
        );
      } finally {
        if (abortRef.current === abort) busyRef.current = false;
      }
    })();
  }, []);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  // Back online after an offline failure: try again once, without a click.
  const offline = state.status === 'error' && state.error === 'offline';
  useEffect(() => {
    if (!offline) return;
    window.addEventListener('online', refresh);
    return () => window.removeEventListener('online', refresh);
  }, [offline, refresh]);

  return { state, loadMore, refresh };
}

type Fetched = { ok: true; items: PodAsset[]; next: string | null; unreadable: number } | { ok: false; error: PodSourceErrorKind };

async function fetchPages(library: PodLibrary, cursor: string | null, signal: AbortSignal): Promise<Fetched> {
  const items: PodAsset[] = [];
  let unreadable = 0;
  let next = cursor;
  for (let pages = 0; pages < MAX_EMPTY_PAGES; pages++) {
    const result = await library.source.list({ cursor: next, signal });
    if (!result.ok) return { ok: false, error: result.error };
    items.push(...result.value.items);
    unreadable += result.value.unreadable;
    next = result.value.next;
    if (items.length > 0 || next === null) break;
  }
  return { ok: true, items, next, unreadable };
}

/** A description that appears on two pages (the listing moved while paging) is shown once. */
function mergeById(existing: readonly PodAsset[], added: readonly PodAsset[]): readonly PodAsset[] {
  const seen = new Set(existing.map((item) => podAssetDescriptionUrl(item.ref)));
  return [...existing, ...added.filter((item) => !seen.has(podAssetDescriptionUrl(item.ref)))];
}
