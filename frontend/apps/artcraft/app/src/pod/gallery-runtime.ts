import { createMediaLoader } from "@jeswr/pod-media-loader";
import { createMemoryJournal } from "@jeswr/pod-media-store";
import { createTypeIndex } from "@jeswr/pod-type-index";
import { createPodClient, type StorageClient } from "@jeswr/storage-client";
import { createPodLibrarySource, MAX_MOUNTED_TILES, PodLibraryOpenError, type PodLibrary, type PodLibrarySource } from "@storyteller/pod-gallery";
import { openCreativeAssetStore } from "@storyteller/pod-mirror";
import { profileDocumentOf } from "./mirror-store";

/**
 * Limits for the grid's thumbnails, sized per the loader's "Grids and galleries" guidance. The
 * grid mounts at most `MAX_MOUNTED_TILES` tiles, each holding one entry, and `maxEntries` leaves
 * room for the same number again as released-but-cached entries. Nothing larger than a
 * thumbnail is read for a tile (a bigger file is a "too large to preview" tile), and only
 * images are allowed: the one narrowing of the loader's default type list.
 */
export const TILE_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntries: MAX_MOUNTED_TILES * 2,
  /** Reserved when a response declares no length: a thumbnail, not a full-size original. */
  assumedBytes: 128 * 1024,
  maxPixels: 16_000_000,
  maxConcurrent: 6,
  budgetWaitMs: 20_000,
  allow: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"],
} as const;

/** Limits for the originals the viewer opens: one item at a time, so very few entries and reads. */
export const VIEWER_LIMITS = {
  maxBytes: 25 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntries: 4,
  assumedBytes: 1024 * 1024,
  maxPixels: 64_000_000,
  maxConcurrent: 2,
  budgetWaitMs: 30_000,
} as const;

type ClientParts = Awaited<ReturnType<typeof createPodClient>>;

/** What the session can say about itself, shared by the fetch wrapper and the source wrapper. */
interface SessionProblem {
  /** An authenticated request was refused (401) or the session had ended or changed, since the last listing started. */
  rejected: boolean;
}

export interface OpenLibraryDeps {
  storage: ClientParts["storage"];
  features: ClientParts["features"];
  typeIndex: Parameters<typeof openCreativeAssetStore>[0]["typeIndex"];
  signal: AbortSignal;
  /** The signed-in WebID, or "" while no pod is connected: the loaders purge themselves when it changes. */
  getSessionKey: () => string;
  /** Set by the session's fetch when it saw a refusal or an ended session. */
  problem?: SessionProblem;
}

/**
 * Builds the pod library for viewing: the media store for listing and two media loaders (small
 * thumbnails for the grid, originals for the viewer) over one storage client. Read only by
 * construction: the store is wrapped by a source that has no write method, its delete journal is
 * in memory and never read, and its exposure probe answers "unknown", which makes any write the
 * store might be asked to do refuse. Container listings are cached for the life of the library
 * (until `invalidateListing`), so paging does not list the pod's folders again for every page.
 * Throws a `PodLibraryOpenError` with a closed kind.
 */
export async function openPodLibrary({ storage, features, typeIndex, signal, getSessionKey, problem = { rejected: false } }: OpenLibraryDeps): Promise<PodLibrary> {
  const cached = withListingCache(storage);
  const opened = await openCreativeAssetStore({
    storage: cached.storage,
    features,
    typeIndex,
    exposure: async () => "unknown",
    journal: createMemoryJournal(),
    signal,
  });
  if (!opened.ok) throw new PodLibraryOpenError(problem.rejected ? "sign-in" : opened.error.kind === "offline" || opened.error.kind === "forbidden" ? opened.error.kind : "failed");
  const store = opened.value;
  const scope = (url: string) => store.isInsideLibrary(url);
  const tileLoader = createMediaLoader({ storage: cached.storage, scope, getSessionKey, ...TILE_LIMITS, allow: [...TILE_LIMITS.allow] });
  const viewerLoader = createMediaLoader({ storage: cached.storage, scope, getSessionKey, ...VIEWER_LIMITS });
  return {
    source: sessionAware(createPodLibrarySource(store), problem),
    tileLoader,
    viewerLoader,
    invalidateListing: () => {
      problem.rejected = false; // a new listing starts from what the pod says now
      cached.invalidate();
    },
  };
}

/**
 * A listing that failed because the session ended or was refused is "sign in again", not
 * "offline" or "failed": the fetch wrapper recorded what it saw, and this says so.
 */
function sessionAware(source: PodLibrarySource, problem: SessionProblem): PodLibrarySource {
  return {
    async list(options) {
      const result = await source.list(options);
      return !result.ok && problem.rejected ? { ok: false, error: "sign-in" } : result;
    },
    async get(ref, signal) {
      const result = await source.get(ref, signal);
      return !result.ok && problem.rejected ? { ok: false, error: "sign-in" } : result;
    },
  };
}

type Entries = Awaited<ReturnType<StorageClient["list"]>>;
type Entry = Entries["items"][number];

/**
 * Caches what the pod says about its containers: `list` pages and `listAll` walks, keyed by the
 * container, page and listing options. Nothing else is cached (descriptions and media bytes are
 * read afresh), and a listing that failed or was cut short by an abort is never remembered.
 */
function withListingCache(storage: StorageClient): { storage: StorageClient; invalidate: () => void } {
  const pages = new Map<string, Entries>();
  const walks = new Map<string, Entry[]>();
  const keyOf = (container: string, opts?: { cursor?: unknown; maxBytes?: number; revalidate?: boolean }) =>
    JSON.stringify([container, opts?.cursor ?? null, opts?.maxBytes ?? null, opts?.revalidate ?? false]);

  const wrapped = new Proxy(storage, {
    get(target, property) {
      if (property === "list") {
        return async (container: string, opts?: Parameters<StorageClient["list"]>[1]) => {
          const key = keyOf(container, opts);
          const hit = pages.get(key);
          if (hit) return hit;
          const page = await target.list(container, opts);
          pages.set(key, page);
          return page;
        };
      }
      if (property === "listAll") {
        return async function* (container: string, opts?: Parameters<StorageClient["listAll"]>[1]) {
          const key = keyOf(container, opts);
          const hit = walks.get(key);
          if (hit) {
            yield* hit;
            return;
          }
          const seen: Entry[] = [];
          for await (const entry of target.listAll(container, opts)) {
            seen.push(entry);
            yield entry;
          }
          walks.set(key, seen);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    storage: wrapped,
    invalidate: () => {
      pages.clear();
      walks.clear();
    },
  };
}

export interface BuildLibraryDeps {
  /** The session's current authenticated `fetch`, or null once it has ended. Read on every request. */
  getFetch: () => typeof fetch | null;
  getSessionKey: () => string;
  webId: string;
  signal: AbortSignal;
}

const isEndedSession = (error: unknown) => error instanceof Error && /^Session (expired|changed)/.test(error.message);

/**
 * Opens the pod library from the session's authenticated `fetch` and nothing else. The `fetch`
 * is looked up per request, never captured: after the session ends, requests fail as a session
 * problem instead of using a stale credential, and a refusal (401) or an expired or changed
 * session is remembered so the gallery can say "sign in again" rather than "offline".
 *
 * Everything the pod gallery needs is imported here and nowhere on the app's start-up path, so a
 * window that never opens "My pod" never loads any of it.
 */
export async function buildPodLibrary({ getFetch, getSessionKey, webId, signal }: BuildLibraryDeps): Promise<PodLibrary> {
  const problem: SessionProblem = { rejected: false };
  const podFetch: typeof fetch = async (input, init) => {
    const current = getFetch();
    if (!current) {
      problem.rejected = true;
      throw new TypeError("Session ended");
    }
    try {
      const response = await current(input, init);
      if (response.status === 401) problem.rejected = true;
      return response;
    } catch (error) {
      if (isEndedSession(error)) problem.rejected = true;
      throw error;
    }
  };
  try {
    const { storage, features } = await createPodClient({ fetch: podFetch, storage: profileDocumentOf(webId), signal });
    return await openPodLibrary({ storage, features, typeIndex: createTypeIndex({ storage, features, profile: webId, fetch: podFetch }), signal, getSessionKey, problem });
  } catch (error) {
    if (error instanceof PodLibraryOpenError) throw error;
    if (problem.rejected) throw new PodLibraryOpenError("sign-in");
    throw new PodLibraryOpenError(!signal.aborted && typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "failed");
  }
}
