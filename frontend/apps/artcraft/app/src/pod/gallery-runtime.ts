import { createMediaLoader } from "@jeswr/pod-media-loader";
import { createMemoryJournal } from "@jeswr/pod-media-store";
import { createTypeIndex } from "@jeswr/pod-type-index";
import { createPodClient } from "@jeswr/storage-client";
import { createPodLibrarySource, PodLibraryOpenError, type PodLibrary } from "@storyteller/pod-gallery";
import { openCreativeAssetStore } from "@storyteller/pod-mirror";
import { profileDocumentOf } from "./mirror-store";

/**
 * Limits for pod media shown in the gallery: the SDK loader's documented example values. The
 * loader's default type allowlist is kept as it is (nothing is passed as `allow`).
 */
export const MEDIA_LIMITS = {
  /** Largest file shown; a larger one is a "too large to preview" tile, not a download. */
  maxBytes: 25 * 1024 * 1024,
  /** Bytes held by object URLs at once (eviction is least-recently-used among released entries). */
  maxTotalBytes: 128 * 1024 * 1024,
  maxEntries: 200,
  /** Refuses decompression bombs before an image is decoded. */
  maxPixels: 64_000_000,
} as const;

type ClientParts = Awaited<ReturnType<typeof createPodClient>>;

export interface OpenLibraryDeps {
  storage: ClientParts["storage"];
  features: ClientParts["features"];
  typeIndex: Parameters<typeof openCreativeAssetStore>[0]["typeIndex"];
  signal: AbortSignal;
}

/**
 * Builds the pod library for viewing: the media store for listing and the media loader for bytes,
 * both over one storage client. Read only by construction: the store is wrapped by a source that
 * has no write method, its delete journal is in memory and never read, and its exposure probe
 * answers "unknown", which makes any write the store might be asked to do refuse. Throws a
 * `PodLibraryOpenError` with a closed kind.
 */
export async function openPodLibrary({ storage, features, typeIndex, signal }: OpenLibraryDeps): Promise<PodLibrary> {
  const opened = await openCreativeAssetStore({
    storage,
    features,
    typeIndex,
    exposure: async () => "unknown",
    journal: createMemoryJournal(),
    signal,
  });
  if (!opened.ok) throw new PodLibraryOpenError(opened.error.kind === "offline" ? "offline" : "failed");
  const store = opened.value;
  const loader = createMediaLoader({ storage, scope: (url) => store.isInsideLibrary(url), ...MEDIA_LIMITS });
  return { source: createPodLibrarySource(store), loader };
}

/**
 * Opens the pod library from the session's authenticated `fetch` and nothing else.
 *
 * Everything the pod gallery needs is imported here and nowhere on the app's start-up path, so a
 * window that never opens "My pod" never loads any of it.
 */
export async function buildPodLibrary(podFetch: typeof fetch, webId: string, signal: AbortSignal): Promise<PodLibrary> {
  try {
    const { storage, features } = await createPodClient({ fetch: podFetch, storage: profileDocumentOf(webId), signal });
    return await openPodLibrary({ storage, features, typeIndex: createTypeIndex({ storage, features, profile: webId, fetch: podFetch }), signal });
  } catch (error) {
    if (error instanceof PodLibraryOpenError) throw error;
    throw new PodLibraryOpenError(!signal.aborted && typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "failed");
  }
}
