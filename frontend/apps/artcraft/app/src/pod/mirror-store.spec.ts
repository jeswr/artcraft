import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  createPodClient: vi.fn(),
  createTypeIndex: vi.fn(() => ({ findAll: vi.fn(), register: vi.fn() })),
  openCreativeAssetStore: vi.fn(),
  checkOwnerOnly: vi.fn(),
}));
vi.mock("@jeswr/storage-client", () => ({ createPodClient: sdk.createPodClient }));
vi.mock("@jeswr/pod-type-index", () => ({ createTypeIndex: sdk.createTypeIndex }));
vi.mock("@jeswr/pod-access", () => ({ checkOwnerOnly: sdk.checkOwnerOnly }));
vi.mock("@storyteller/pod-mirror", async (importActual) => ({ ...(await importActual<typeof import("@storyteller/pod-mirror")>()), openCreativeAssetStore: sdk.openCreativeAssetStore }));

import { createMemoryMirrorJournal } from "@storyteller/pod-mirror";
import { createStoreOpener, profileDocumentOf } from "./mirror-store";

const WEB_ID = "https://alice.example/profile/card#me";
const ROOT = "https://alice.example/";
const signal = new AbortController().signal;

beforeEach(() => {
  vi.clearAllMocks();
  sdk.createPodClient.mockResolvedValue({ storage: { root: ROOT }, features: { protocol: "solid" } });
  sdk.openCreativeAssetStore.mockResolvedValue({
    ok: true,
    value: { library: null, put: vi.fn(), attachThumbnail: vi.fn(), remove: vi.fn(), resumePending: vi.fn(), checkExposure: vi.fn() },
  });
});

describe("the profile document", () => {
  it("is the WebID without its fragment", () => {
    expect(profileDocumentOf(WEB_ID)).toBe("https://alice.example/profile/card");
  });
});

describe("opening the pod store", () => {
  it("uses the pod session's own fetch for every pod call and nothing else", async () => {
    const podFetch = vi.fn() as unknown as typeof fetch;
    const open = createStoreOpener({ podFetch: () => podFetch, webId: WEB_ID, journal: createMemoryMirrorJournal() });
    const result = await open(signal, { allowUnknownExposureFor: () => false });
    expect(result.ok).toBe(true);
    expect(sdk.createPodClient).toHaveBeenCalledWith(expect.objectContaining({ fetch: podFetch, storage: "https://alice.example/profile/card" }));
    expect(sdk.createTypeIndex).toHaveBeenCalledWith(expect.objectContaining({ fetch: podFetch, profile: WEB_ID }));
  });

  it("scopes the delete journal to this WebID and this storage", async () => {
    const journal = createMemoryMirrorJournal();
    const spy = vi.spyOn(journal, "deletesFor");
    await createStoreOpener({ podFetch: () => vi.fn() as unknown as typeof fetch, webId: WEB_ID, journal })(signal, { allowUnknownExposureFor: () => false });
    expect(spy).toHaveBeenCalledWith(WEB_ID, ROOT);
  });

  it("passes the 'allow unknown exposure' choice through, and only that", async () => {
    const open = createStoreOpener({ podFetch: () => vi.fn() as unknown as typeof fetch, webId: WEB_ID, journal: createMemoryMirrorJournal() });
    const allow = (url: string) => url.startsWith("https://pod.example/confirmed/");
    await open(signal, { allowUnknownExposureFor: allow });
    expect(sdk.openCreativeAssetStore.mock.calls[0][0].allowUnknownExposureFor).toBe(allow);
  });

  it("reports the exposure target: the library once it exists, the storage root before", async () => {
    const open = createStoreOpener({ podFetch: () => vi.fn() as unknown as typeof fetch, webId: WEB_ID, journal: createMemoryMirrorJournal() });
    const first = await open(signal, { allowUnknownExposureFor: () => false });
    if (!first.ok) throw new Error("expected a store");
    expect(first.store.exposureTarget()).toBe(ROOT);
    sdk.openCreativeAssetStore.mockResolvedValue({ ok: true, value: { library: `${ROOT}creative-assets/`, checkExposure: vi.fn() } });
    const second = await open(signal, { allowUnknownExposureFor: () => false });
    if (!second.ok) throw new Error("expected a store");
    expect(second.store.exposureTarget()).toBe(`${ROOT}creative-assets/`);
  });

  it("does not open anything without a session fetch, and maps failures to a closed reason", async () => {
    const journal = createMemoryMirrorJournal();
    expect(await createStoreOpener({ podFetch: () => null, webId: WEB_ID, journal })(signal, { allowUnknownExposureFor: () => false })).toEqual({ ok: false, reason: "failed" });
    expect(sdk.createPodClient).not.toHaveBeenCalled();
    const open = createStoreOpener({ podFetch: () => vi.fn() as unknown as typeof fetch, webId: WEB_ID, journal });
    sdk.openCreativeAssetStore.mockResolvedValue({ ok: false, error: { kind: "offline" } });
    expect(await open(signal, { allowUnknownExposureFor: () => false })).toEqual({ ok: false, reason: "offline" });
    sdk.openCreativeAssetStore.mockResolvedValue({ ok: false, error: { kind: "failed" } });
    expect(await open(signal, { allowUnknownExposureFor: () => false })).toEqual({ ok: false, reason: "failed" });
    sdk.createPodClient.mockRejectedValue(new Error("secret detail"));
    expect(await open(signal, { allowUnknownExposureFor: () => false })).toEqual({ ok: false, reason: "offline" });
  });
});
