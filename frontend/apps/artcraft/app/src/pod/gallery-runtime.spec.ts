import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  createPodClient: vi.fn(),
  createTypeIndex: vi.fn(() => ({ findAll: vi.fn(), register: vi.fn() })),
  openCreativeAssetStore: vi.fn(),
  createMediaLoader: vi.fn(() => ({ acquire: vi.fn(), purge: vi.fn() })),
}));
vi.mock("@jeswr/storage-client", () => ({ createPodClient: sdk.createPodClient }));
vi.mock("@jeswr/pod-type-index", () => ({ createTypeIndex: sdk.createTypeIndex }));
vi.mock("@jeswr/pod-media-loader", () => ({ createMediaLoader: sdk.createMediaLoader }));
vi.mock("@storyteller/pod-mirror", () => ({ openCreativeAssetStore: sdk.openCreativeAssetStore }));

import { buildPodLibrary, MEDIA_LIMITS } from "./gallery-runtime";

const WEB_ID = "https://alice.example/profile/card#me";
const ROOT = "https://alice.example/";
const signal = new AbortController().signal;

function fakeStore(library: string | null = `${ROOT}creative-assets/`) {
  return { library, isInsideLibrary: (url: string) => library !== null && url.startsWith(library), list: vi.fn(), get: vi.fn(), put: vi.fn(), remove: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  sdk.createPodClient.mockResolvedValue({ storage: { root: ROOT }, features: { protocol: "solid" } });
});

describe("opening the pod library for viewing", () => {
  it("uses the session's fetch for the pod client and the type index, and nothing else", async () => {
    const podFetch = vi.fn() as unknown as typeof fetch;
    sdk.openCreativeAssetStore.mockResolvedValue({ ok: true, value: fakeStore() });
    await buildPodLibrary(podFetch, WEB_ID, signal);
    expect(sdk.createPodClient).toHaveBeenCalledWith(expect.objectContaining({ fetch: podFetch, storage: "https://alice.example/profile/card" }));
    expect(sdk.createTypeIndex).toHaveBeenCalledWith(expect.objectContaining({ fetch: podFetch, profile: WEB_ID }));
  });

  it("cannot write: the exposure probe says unknown and the library offers only list and get", async () => {
    const store = fakeStore();
    sdk.openCreativeAssetStore.mockResolvedValue({ ok: true, value: store });
    const library = await buildPodLibrary(vi.fn() as unknown as typeof fetch, WEB_ID, signal);
    const deps = sdk.openCreativeAssetStore.mock.calls[0]?.[0] as { exposure: (url: string) => Promise<string>; allowUnknownExposureFor?: unknown };
    await expect(deps.exposure(`${ROOT}creative-assets/`)).resolves.toBe("unknown");
    expect(deps.allowUnknownExposureFor).toBeUndefined();
    expect(Object.keys(library.source).sort()).toEqual(["get", "list"]);
  });

  it("keeps the loader's default type list and limits, scoped to the library the store found", async () => {
    sdk.openCreativeAssetStore.mockResolvedValue({ ok: true, value: fakeStore() });
    await buildPodLibrary(vi.fn() as unknown as typeof fetch, WEB_ID, signal);
    const options = (sdk.createMediaLoader.mock.calls as unknown as [Record<string, unknown>][])[0]![0];
    expect(options).not.toHaveProperty("allow");
    expect(options).not.toHaveProperty("sniff");
    expect(options).toMatchObject(MEDIA_LIMITS);
    const scope = options.scope as (url: string) => boolean;
    expect(scope(`${ROOT}creative-assets/2026/06/a.png`)).toBe(true);
    expect(scope(`${ROOT}profile/card`)).toBe(false);
  });

  it("reports a store that would not open as a closed word", async () => {
    sdk.openCreativeAssetStore.mockResolvedValue({ ok: false, error: { kind: "offline", reason: "storage" } });
    await expect(buildPodLibrary(vi.fn() as unknown as typeof fetch, WEB_ID, signal)).rejects.toMatchObject({ kind: "offline" });
    sdk.openCreativeAssetStore.mockResolvedValue({ ok: false, error: { kind: "forbidden", reason: "storage" } });
    await expect(buildPodLibrary(vi.fn() as unknown as typeof fetch, WEB_ID, signal)).rejects.toMatchObject({ kind: "failed" });
  });

  it("does not let an error's text out", async () => {
    sdk.createPodClient.mockRejectedValue(new Error("https://alice.example/secret?token=abc"));
    const error = await buildPodLibrary(vi.fn() as unknown as typeof fetch, WEB_ID, signal).catch((caught: unknown) => caught);
    expect((error as Error).message).toMatch(/^(failed|offline)$/);
  });
});
