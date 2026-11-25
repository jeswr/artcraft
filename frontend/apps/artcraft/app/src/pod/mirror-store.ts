import { checkOwnerOnly } from "@jeswr/pod-access";
import { accessModel } from "@jeswr/pod-access/requests-solid";
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

type Storage = Parameters<typeof checkOwnerOnly>[0]["storage"];

/**
 * Some servers (Community Solid Server 7.2) advertise no access-control model in their
 * capabilities, and the owner-only check then answers "unsupported-model" for every user. The
 * SDK's own detector (`accessModel`, from the resource's `acl` link and the access document it
 * names) says WAC or ACP; WAC is handed to the check as the storage's model. ACP is not: the
 * check also needs a trusted server dialect, which cannot be detected, so it stays "unknown" and
 * the person's per-container confirmation applies. Nothing is parsed here.
 */
export function withDetectedAccessModel(storage: Storage, podFetch: typeof fetch): (signal?: AbortSignal) => Promise<Storage> {
  const advertised = storage.features.accessControl;
  if (advertised.state === "available" && (advertised.detail.model === "wac" || advertised.detail.model === "acp")) return async () => storage;
  let detected: Promise<Storage> | undefined;
  return (signal) => {
    detected ??= accessModel({ fetch: podFetch, storage: storage.root, ...(signal ? { signal } : {}) }).then(
      (model) => {
        if (model !== "wac") return storage;
        const features = { ...storage.features, accessControl: { ...advertised, state: "available" as const, detail: { model: "wac" as const } } };
        return new Proxy(storage, { get: (target, property, receiver) => (property === "features" ? features : Reflect.get(target, property, target === receiver ? target : receiver)) });
      },
      (error) => {
        detected = undefined; // a failed detection is not remembered
        throw error;
      },
    );
    return detected;
  };
}

/**
 * Builds the mirror's store from the session's authenticated `fetch` and nothing else: pod
 * client, Type Index, the media store with the creative-assets model, the durable delete
 * journal (this WebID's and this storage's entries only), and the read-only owner-only probe
 * for the exposure check. Writes into a container whose exposure cannot be determined happen
 * only for a container the person confirmed (asked per container by the store).
 */
export function createStoreOpener(deps: { podFetch: () => typeof fetch | null; webId: string; journal: MirrorJournal }): OpenStore {
  return async (signal, { allowUnknownExposureFor }) => {
    const podFetch = deps.podFetch();
    if (!podFetch) return { ok: false, reason: "failed" };
    try {
      const { storage, features } = await createPodClient({ fetch: podFetch, storage: profileDocumentOf(deps.webId), signal });
      const modelled = withDetectedAccessModel(storage, podFetch);
      const opened = await openCreativeAssetStore({
        storage,
        features,
        typeIndex: createTypeIndex({ storage, features, profile: deps.webId, fetch: podFetch }),
        exposure: exposureFromOwnerOnly(async (url, probeSignal) =>
          checkOwnerOnly({ storage: await modelled(probeSignal ?? signal), url, ownerWebId: deps.webId }),
        ),
        journal: deps.journal.deletesFor(deps.webId, storage.root),
        allowUnknownExposureFor,
        signal,
      });
      if (opened.ok) return { ok: true, store: asPodStorePort(opened.value, storage.root) };
      return { ok: false, reason: opened.error.kind === "offline" ? "offline" : "failed" };
    } catch {
      return { ok: false, reason: signal.aborted ? "failed" : "offline" };
    }
  };
}
