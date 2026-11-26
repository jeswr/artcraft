import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  createPodClient: vi.fn(),
  createTypeIndex: vi.fn(() => ({ findAll: vi.fn(), register: vi.fn() })),
  openCreativeAssetStore: vi.fn(),
  checkOwnerOnly: vi.fn(),
  accessModel: vi.fn(),
}));
vi.mock("@jeswr/storage-client", () => ({ createPodClient: sdk.createPodClient }));
vi.mock("@jeswr/pod-type-index", () => ({ createTypeIndex: sdk.createTypeIndex }));
vi.mock("@jeswr/pod-access", () => ({ checkOwnerOnly: sdk.checkOwnerOnly }));
vi.mock("@jeswr/pod-access/requests-solid", () => ({ accessModel: sdk.accessModel }));
vi.mock("@storyteller/pod-mirror", async (importActual) => ({ ...(await importActual<typeof import("@storyteller/pod-mirror")>()), openCreativeAssetStore: sdk.openCreativeAssetStore }));

import { createMemoryMirrorJournal } from "@storyteller/pod-mirror";
import { createStoreOpener, profileDocumentOf } from "./mirror-store";

const WEB_ID = "https://alice.example/profile/card#me";
const ROOT = "https://alice.example/";
const signal = new AbortController().signal;
const UNADVERTISED = { accessControl: { state: "unknown", evidence: "header:none", detail: { model: "none" } } };

beforeEach(() => {
  vi.clearAllMocks();
  sdk.createPodClient.mockResolvedValue({ storage: { root: ROOT, features: UNADVERTISED }, features: { protocol: "solid" } });
  sdk.checkOwnerOnly.mockResolvedValue({ private: true, reasons: [] });
  sdk.accessModel.mockResolvedValue("wac");
  sdk.openCreativeAssetStore.mockResolvedValue({
    ok: true,
    value: { library: null, put: vi.fn(), attachThumbnail: vi.fn(), remove: vi.fn(), resumePending: vi.fn(), ensureLibrary: vi.fn() },
  });
});

describe("the profile document", () => {
  it("is the WebID without its fragment", () => {
    expect(profileDocumentOf(WEB_ID)).toBe("https://alice.example/profile/card");
  });
});

describe("opening the pod store", () => {
  it("uses the pod session's own fetch for every pod call and nothing else", async () => {
    const podFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const open = createStoreOpener({ podFetch: () => podFetch as unknown as typeof fetch, webId: WEB_ID, journal: createMemoryMirrorJournal() });
    const result = await open(signal, { allowUnknownExposureFor: () => false });
    expect(result.ok).toBe(true);
    expect(sdk.createPodClient).toHaveBeenCalledWith(expect.objectContaining({ storage: "https://alice.example/profile/card" }));
    expect(sdk.createTypeIndex).toHaveBeenCalledWith(expect.objectContaining({ profile: WEB_ID }));
    const init = { method: "HEAD" };
    await sdk.createPodClient.mock.calls[0][0].fetch("https://alice.example/a", init);
    await (sdk.createTypeIndex.mock.calls[0] as unknown as [{ fetch: typeof fetch }])[0].fetch("https://alice.example/b", init);
    expect(podFetch.mock.calls).toEqual([
      ["https://alice.example/a", init],
      ["https://alice.example/b", init],
    ]);
  });

  it("tells the mirror when the pod refused a request of the store as the person (401), and only then", async () => {
    let status = 200;
    const podFetch = vi.fn(async () => new Response(null, { status }));
    const open = createStoreOpener({ podFetch: () => podFetch as unknown as typeof fetch, webId: WEB_ID, journal: createMemoryMirrorJournal() });
    const result = await open(signal, { allowUnknownExposureFor: () => false });
    if (!result.ok) throw new Error("expected a store");
    const storeFetch = sdk.createPodClient.mock.calls[0][0].fetch as typeof fetch;
    status = 403;
    await storeFetch("https://alice.example/");
    expect(result.store.refusedSignIn?.()).toBe(false);
    status = 401;
    await storeFetch("https://alice.example/");
    expect(result.store.refusedSignIn?.()).toBe(true);
  });

  it("scopes the delete journal to this WebID and this storage", async () => {
    const journal = createMemoryMirrorJournal();
    const spy = vi.spyOn(journal, "deletesFor");
    await createStoreOpener({ podFetch: () => vi.fn() as unknown as typeof fetch, webId: WEB_ID, journal })(signal, { allowUnknownExposureFor: () => false });
    expect(spy).toHaveBeenCalledWith(WEB_ID, ROOT);
  });

  it("hands the store this scope's delete journal, with every pending delete listed (the mirror's veto decides, not a filter)", async () => {
    const journal = createMemoryMirrorJournal();
    const deletes = journal.deletesFor(WEB_ID, ROOT);
    await deletes.put({ descriptionUrl: `${ROOT}creative-assets/2026/06/paired`, shardUrl: `${ROOT}creative-assets/2026/06/`, phase: "intent" });
    await journal.create({ webId: WEB_ID, username: "alice", token: "m_1", state: "saved", attempts: 0, createdAt: 1, updatedAt: 1, descriptionUrl: `${ROOT}creative-assets/2026/06/paired` });
    await createStoreOpener({ podFetch: () => vi.fn() as unknown as typeof fetch, webId: WEB_ID, journal })(signal, { allowUnknownExposureFor: () => false });
    const handed = sdk.openCreativeAssetStore.mock.calls[0][0].journal;
    expect((await handed.list()).map((entry: { descriptionUrl: string }) => entry.descriptionUrl)).toEqual([`${ROOT}creative-assets/2026/06/paired`]);
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
    sdk.openCreativeAssetStore.mockResolvedValue({ ok: true, value: { library: `${ROOT}creative-assets/`, ensureLibrary: vi.fn() } });
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

describe("the access model of the pod", () => {
  const probe = async (features: unknown = UNADVERTISED) => {
    sdk.createPodClient.mockResolvedValue({ storage: { root: ROOT, features }, features: { protocol: "solid" } });
    await createStoreOpener({ podFetch: () => vi.fn() as unknown as typeof fetch, webId: WEB_ID, journal: createMemoryMirrorJournal() })(signal, { allowUnknownExposureFor: () => false });
    return sdk.openCreativeAssetStore.mock.calls[0][0].exposure as (url: string, signal?: AbortSignal) => Promise<string>;
  };
  const storageSeenByCheck = (call = 0) => sdk.checkOwnerOnly.mock.calls[call][0].storage;

  it("asks the SDK's detector when the server advertises no model, and tells the check WAC", async () => {
    const exposure = await probe();
    expect(await exposure(`${ROOT}creative-assets/`)).toBe("private");
    expect(sdk.accessModel).toHaveBeenCalledWith(expect.objectContaining({ storage: ROOT }));
    const seen = storageSeenByCheck();
    expect(seen.features.accessControl).toMatchObject({ state: "available", detail: { model: "wac" } });
    expect(seen.root).toBe(ROOT);
  });

  it("detects once, and not at all when the server already advertises a model", async () => {
    const exposure = await probe();
    await exposure(`${ROOT}a/`);
    await exposure(`${ROOT}b/`);
    expect(sdk.accessModel).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    sdk.checkOwnerOnly.mockResolvedValue({ private: true, reasons: [] });
    const advertised = { accessControl: { state: "available", evidence: "header:Link", detail: { model: "acp" } } };
    await (await probe(advertised))(`${ROOT}a/`);
    expect(sdk.accessModel).not.toHaveBeenCalled();
    expect(storageSeenByCheck().features).toBe(advertised);
  });

  it("leaves ACP and an undecided model as the server reported them, so the answer stays unknown", async () => {
    for (const model of ["acp", "unknown"]) {
      vi.clearAllMocks();
      sdk.checkOwnerOnly.mockResolvedValue({ private: false, reasons: [{ reason: "unsupported-model" }] });
      sdk.accessModel.mockResolvedValue(model);
      const exposure = await probe();
      expect(await exposure(`${ROOT}a/`)).toBe("unknown");
      expect(storageSeenByCheck().features).toBe(UNADVERTISED);
    }
  });

  it("does not turn a failed detection into an answer, and tries again next time", async () => {
    sdk.accessModel.mockRejectedValueOnce(new Error("503"));
    const exposure = await probe();
    await expect(exposure(`${ROOT}a/`)).rejects.toThrow();
    expect(sdk.checkOwnerOnly).not.toHaveBeenCalled();
    expect(await exposure(`${ROOT}a/`)).toBe("private");
    expect(sdk.accessModel).toHaveBeenCalledTimes(2);
  });
});
