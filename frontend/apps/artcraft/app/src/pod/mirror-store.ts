import { checkOwnerOnly } from "@jeswr/pod-access";
import { exposureFromOwnerOnly } from "@jeswr/pod-media-store";
import { createTypeIndex } from "@jeswr/pod-type-index";
import { createPodClient } from "@jeswr/storage-client";
import { asPodStorePort, type MirrorJournal, type OpenStore, openCreativeAssetStore } from "@storyteller/pod-mirror";

/** The WebID's profile document: any URL inside the storage will do for discovery. */
export function profileDocumentOf(webId: string): string {
  const url = new URL(webId);
  url.hash = "";
  return url.href;
}

/**
 * Builds the mirror's store from the session's authenticated `fetch` and nothing else: pod
 * client, Type Index, the media store with the creative-assets model, the durable delete
 * journal (this WebID's and this storage's entries only), and the read-only owner-only probe
 * for the exposure check. Writes into a container whose exposure cannot be determined happen
 * only when the caller says the person confirmed it.
 */
export function createStoreOpener(deps: { podFetch: () => typeof fetch | null; webId: string; journal: MirrorJournal }): OpenStore {
  return async (signal, { allowUnknownExposure }) => {
    const podFetch = deps.podFetch();
    if (!podFetch) return { ok: false, reason: "failed" };
    try {
      const { storage, features } = await createPodClient({ fetch: podFetch, storage: profileDocumentOf(deps.webId), signal });
      const opened = await openCreativeAssetStore({
        storage,
        features,
        typeIndex: createTypeIndex({ storage, features, profile: deps.webId, fetch: podFetch }),
        exposure: exposureFromOwnerOnly((url) => checkOwnerOnly({ storage, url, ownerWebId: deps.webId })),
        journal: deps.journal.deletesFor(deps.webId, storage.root),
        allowUnknownExposure,
        signal,
      });
      if (opened.ok) return { ok: true, store: asPodStorePort(opened.value, storage.root) };
      return { ok: false, reason: opened.error.kind === "offline" ? "offline" : "failed" };
    } catch {
      return { ok: false, reason: signal.aborted ? "failed" : "offline" };
    }
  };
}
