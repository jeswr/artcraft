import type { MediaLoader } from '@jeswr/pod-media-loader';
import type { PodLibrarySource } from './types.js';

/** What the gallery panel needs once a pod is open: the read-only source and the media loader. */
export interface PodLibrary {
  readonly source: PodLibrarySource;
  /** The one way pod bytes reach the screen (a `blob:` URL typed by the sniffed type). */
  readonly loader: MediaLoader;
  /** Anything else to release with the library (the loader is purged by the controller). */
  close?(): void;
}

export type PodLibraryOpenErrorKind = 'not-connected' | 'offline' | 'failed';

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
 * Owns the one open pod library and ties its life to the session: the media loader is purged
 * (every object URL revoked, reads aborted, later acquires refused) when the pod is
 * disconnected, when the WebID changes, and on `dispose`. The loader has no session-key option
 * of its own, so this is where "a change of account purges everything" is enforced: the key is
 * the WebID, compared on every `open` and every `sync`.
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
    library.loader.purge();
  } finally {
    library.close?.();
  }
}
