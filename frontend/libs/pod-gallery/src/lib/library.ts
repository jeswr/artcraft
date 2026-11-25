import type { MediaLoader } from '@jeswr/pod-media-loader';
import type { PodLibrarySource } from './types.js';

/** What the gallery panel needs once a pod is open: the read-only source and two media loaders. */
export interface PodLibrary {
  readonly source: PodLibrarySource;
  /**
   * Small, image-only reads for the grid's thumbnails: a low per-file limit and a budget sized for
   * a screenful, so a grid cannot pull originals into memory.
   */
  readonly tileLoader: MediaLoader;
  /** Originals, for the one item the viewer shows: a larger per-file limit, very few at once. */
  readonly viewerLoader: MediaLoader;
  /** Forget the container listings the source cached, so the next page lists the pod again. */
  invalidateListing?(): void;
  /** Anything else to release with the library (both loaders are purged by the controller). */
  close?(): void;
}

/**
 * The most tiles the grid mounts at once. The app sizes the tile loader from it (`maxEntries` is a
 * multiple of it) and the grid never mounts more, whatever the window size.
 */
export const MAX_MOUNTED_TILES = 160;

/** `sign-in`: the session has ended or was refused. `forbidden`: the pod refused this account. */
export type PodLibraryOpenErrorKind = 'not-connected' | 'offline' | 'sign-in' | 'forbidden' | 'failed';

export class PodLibraryOpenError extends Error {
  readonly kind: PodLibraryOpenErrorKind;
  constructor(kind: PodLibraryOpenErrorKind) {
    super(kind); // a closed word: no URL, host or server text
    this.name = 'PodLibraryOpenError';
    this.kind = kind;
  }
}

export interface PodLibraryDeps {
  /** The signed-in WebID, or null when no pod is connected. */
  getSessionKey(): string | null;
  /** Builds the library for that WebID. Called at most once per WebID until it is torn down. */
  build(sessionKey: string, signal: AbortSignal): Promise<PodLibrary>;
}

export interface PodLibraryController {
  /** The library for the current WebID, built on first use. Rejects with a `PodLibraryOpenError`. */
  open(): Promise<PodLibrary>;
  /** Call when the session may have changed: a different WebID, or none, tears the library down. */
  sync(): void;
  /** Tears down whatever is open. */
  dispose(): void;
}

interface Entry {
  readonly key: string;
  readonly abort: AbortController;
  readonly ready: Promise<PodLibrary>;
  library?: PodLibrary;
}

/**
 * Owns the one open pod library and ties its life to the session: both media loaders are purged
 * (every object URL revoked, reads aborted, later acquires refused) when the pod is
 * disconnected, when the WebID changes, and on `dispose`. The loaders also take a
 * `getSessionKey` (the WebID) and purge themselves when it changes; this controller does not
 * rely on that alone: the key is compared on every `open` and every `sync`, and the library is
 * rebuilt for the new account.
 */
export function createPodLibraryController(deps: PodLibraryDeps): PodLibraryController {
  let entry: Entry | null = null;

  const teardown = () => {
    const old = entry;
    entry = null;
    if (!old) return;
    old.abort.abort();
    if (old.library) release(old.library);
  };

  return {
    open() {
      const key = deps.getSessionKey();
      if (key === null) {
        teardown();
        return Promise.reject(new PodLibraryOpenError('not-connected'));
      }
      if (entry && entry.key !== key) teardown();
      if (entry) return entry.ready;
      const abort = new AbortController();
      const mine: Entry = {
        key,
        abort,
        ready: deps.build(key, abort.signal).then(
          (library) => {
            if (entry !== mine) {
              // Torn down or switched while it was being built: nothing may keep it.
              release(library);
              throw new PodLibraryOpenError('not-connected');
            }
            mine.library = library;
            return library;
          },
          (error: unknown) => {
            if (entry === mine) entry = null; // a failure is not remembered: the next open tries again
            throw error instanceof PodLibraryOpenError ? error : new PodLibraryOpenError('failed');
          },
        ),
      };
      entry = mine;
      return mine.ready;
    },
    sync() {
      if (entry && entry.key !== deps.getSessionKey()) teardown();
    },
    dispose: teardown,
  };
}

function release(library: PodLibrary): void {
  try {
    library.tileLoader.purge();
    library.viewerLoader.purge();
  } finally {
    library.close?.();
  }
}
