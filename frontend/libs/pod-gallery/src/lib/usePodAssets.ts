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

/** After a failed "load more", scrolling does not try again for this long, doubling up to the cap. */
export const RETRY_BACKOFF_MS = 2000;
export const RETRY_BACKOFF_CAP_MS = 30_000;

export interface PodAssets {
  state: PodAssetsState;
  /**
   * Fetches the next page: a no-op while one is loading, at the end, or inside the back-off after
   * a failure. `force` (the person pressed Retry) skips the back-off.
   */
  loadMore(options?: { force?: boolean }): void;
  /** Starts again from the newest item, listing the pod afresh. */
  refresh(): void;
}

/**
 * Lists the pod library page by page for the gallery. It reads only: the source it uses has no
 * other operation. A new mount and a refresh list the pod afresh; later pages reuse the
 * container listings the source cached. It starts again when the pod's account changes and when
 * the network comes back after an offline failure. Items are kept in the order the store lists
 * them (newest month first, newest first within a month).
 */
export function usePodAssets(access: PodGalleryAccess): PodAssets {
  const [state, setState] = useState<PodAssetsState>({ status: 'loading' });
  const [generation, setGeneration] = useState(0);
  const cursorRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const libraryRef = useRef<PodLibrary | null>(null);
  const failuresRef = useRef(0);
  const notBeforeRef = useRef(0);

  useEffect(() => {
    const abort = new AbortController();
    abortRef.current = abort;
    cursorRef.current = null;
    libraryRef.current = null;
    failuresRef.current = 0;
    notBeforeRef.current = 0;
    busyRef.current = true;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const library = await access.open();
        library.invalidateListing?.();
        const first = await library.source.list({ cursor: null, signal: abort.signal });
        if (abort.signal.aborted) return;
        if (!first.ok) return setState({ status: 'error', error: first.error });
        cursorRef.current = first.value.next;
        libraryRef.current = library;
        setState({
          status: 'ready',
          library,
          items: first.value.items,
          hasMore: first.value.next !== null,
          loadingMore: false,
          loadMoreFailed: false,
          unreadable: first.value.unreadable,
        });
      } catch (error) {
        if (abort.signal.aborted) return;
        setState({ status: 'error', error: error instanceof PodLibraryOpenError ? error.kind : 'failed' });
      } finally {
        // A run that was replaced must not clear the flag of the run that replaced it.
        if (abortRef.current === abort) busyRef.current = false;
      }
    })();
    return () => abort.abort();
  }, [access, generation]);

  const loadMore = useCallback((options?: { force?: boolean }) => {
    const cursor = cursorRef.current;
    const abort = abortRef.current;
    const library = libraryRef.current;
    if (busyRef.current || cursor === null || !abort || !library || abort.signal.aborted) return;
    if (!options?.force && Date.now() < notBeforeRef.current) return;
    busyRef.current = true;
    setState((current) => (current.status === 'ready' ? { ...current, loadingMore: true, loadMoreFailed: false } : current));
    void (async () => {
      try {
        const page = await library.source.list({ cursor, signal: abort.signal });
        if (abort.signal.aborted) return;
        if (!page.ok) {
          failuresRef.current += 1;
          notBeforeRef.current = Date.now() + Math.min(RETRY_BACKOFF_CAP_MS, RETRY_BACKOFF_MS * 2 ** (failuresRef.current - 1));
          setState((current) => (current.status === 'ready' ? { ...current, loadingMore: false, loadMoreFailed: true } : current));
          return;
        }
        failuresRef.current = 0;
        cursorRef.current = page.value.next;
        setState((current) =>
          current.status === 'ready'
            ? {
                ...current,
                items: mergeById(current.items, page.value.items),
                hasMore: page.value.next !== null,
                loadingMore: false,
                unreadable: current.unreadable + page.value.unreadable,
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

/** A description that appears on two pages (the listing moved while paging) is shown once. */
function mergeById(existing: readonly PodAsset[], added: readonly PodAsset[]): readonly PodAsset[] {
  const seen = new Set(existing.map((item) => podAssetDescriptionUrl(item.ref)));
  return [...existing, ...added.filter((item) => !seen.has(podAssetDescriptionUrl(item.ref)))];
}
