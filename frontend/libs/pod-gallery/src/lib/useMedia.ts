import type { MediaError, MediaLoader } from '@jeswr/pod-media-loader';
import { useMedia } from '@jeswr/pod-media-loader/react';
import { useCallback, useEffect, useState } from 'react';
import { type PodMediaAddress, unwrapPodMediaAddress } from './address.js';

/**
 * `useMedia` for a pod address: acquires through the loader on mount, releases on unmount, retries
 * `over-budget` by itself a few times and then offers `retry()`. A null address is `idle`.
 */
export function usePodMedia(loader: MediaLoader, address: PodMediaAddress | null) {
  return useMedia(loader, address ? unwrapPodMediaAddress(address) : null);
}

export type PodOriginalStatus = 'loading' | 'ready' | 'error';

export interface PodOriginal {
  status: PodOriginalStatus;
  /** A `blob:` URL while `ready`. */
  url: string | undefined;
  /** The SNIFFED type of the file, never the pod's declared one. */
  contentType: string | undefined;
  error: MediaError | undefined;
  retry(): void;
}

/**
 * The full file of one item, for the viewer. Unlike `useMedia` it reports the sniffed type, so
 * the viewer picks `<img>`, `<video>` or `<audio>` from what the bytes are. One hold at a time,
 * released on unmount, on a new address and on a purge.
 */
export function usePodOriginal(loader: MediaLoader, address: PodMediaAddress | null): PodOriginal {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ status: PodOriginalStatus; url?: string; contentType?: string; error?: MediaError }>({ status: 'loading' });
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  // Keyed on the URL, not the address object: a refreshed description mints a new object for the
  // same file, and that must not abort and restart the read.
  const url = address ? unwrapPodMediaAddress(address) : null;

  useEffect(() => {
    if (url === null) return;
    const abort = new AbortController();
    let release: (() => void) | undefined;
    setResult({ status: 'loading' });
    const unsubscribe = loader.subscribe((event) => {
      if (event !== 'purge') return;
      release = undefined;
      setResult({ status: 'error', error: { code: 'purged', message: 'purged' } });
    });
    void loader.acquire(url, { signal: abort.signal }).then((acquired) => {
      if (abort.signal.aborted) {
        if (acquired.ok) acquired.value.release();
        return;
      }
      if (!acquired.ok) return setResult({ status: 'error', error: acquired.error });
      release = acquired.value.release;
      setResult({ status: 'ready', url: acquired.value.url, contentType: acquired.value.contentType });
    });
    return () => {
      abort.abort();
      unsubscribe();
      release?.();
      setResult({ status: 'loading' });
    };
  }, [loader, url, attempt]);

  return { status: url !== null ? result.status : 'error', url: result.url, contentType: result.contentType, error: result.error, retry };
}
