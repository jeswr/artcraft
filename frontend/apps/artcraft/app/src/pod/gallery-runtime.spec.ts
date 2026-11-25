import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  createPodClient: vi.fn(),
  createTypeIndex: vi.fn(() => ({ findAll: vi.fn(), register: vi.fn() })),
  openCreativeAssetStore: vi.fn(),
  createMediaLoader: vi.fn(() => ({ acquire: vi.fn(), purge: vi.fn(), subscribe: vi.fn() })),
}));
vi.mock("@jeswr/storage-client", () => ({ createPodClient: sdk.createPodClient }));
vi.mock("@jeswr/pod-type-index", () => ({ createTypeIndex: sdk.createTypeIndex }));
vi.mock("@jeswr/pod-media-loader", () => ({ createMediaLoader: sdk.createMediaLoader }));
vi.mock("@storyteller/pod-mirror", () => ({ openCreativeAssetStore: sdk.openCreativeAssetStore }));

import { MAX_MOUNTED_TILES } from "@storyteller/pod-gallery";
import { buildPodLibrary, TILE_LIMITS, VIEWER_LIMITS } from "./gallery-runtime";

const WEB_ID = "https://alice.example/profile/card#me";
const ROOT = "https://alice.example/";
const signal = new AbortController().signal;
const build = (getFetch: () => typeof fetch | null, abort: AbortSignal = signal) => buildPodLibrary({ getFetch, getSessionKey: () => WEB_ID, webId: WEB_ID, signal: abort });
const someFetch = () => vi.fn() as unknown as typeof fetch;

function fakeStore(library: string | null = `${ROOT}creative-assets/`) {
  return { library, isInsideLibrary: (url: string) => library !== null && url.startsWith(library), list: vi.fn(), get: vi.fn(), put: vi.fn(), remove: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  sdk.createPodClient.mockResolvedValue({ storage: { root: ROOT }, features: { protocol: "solid" } });
});

describe("opening the pod library for viewing", () => {
  it("uses the session's fetch for the pod client and the type index, and nothing else", async () => {
    const podFetch = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    sdk.openCreativeAssetStore.mockResolvedValue({ ok: true, value: fakeStore() });
    await build(() => podFetch);
    const clientFetch = (sdk.createPodClient.mock.calls[0]![0] as { fetch: typeof fetch; storage: string });
    expect(clientFetch.storage).toBe("https://alice.example/profile/card");
    expect(sdk.createTypeIndex).toHaveBeenCalledWith(expect.objectContaining({ profile: WEB_ID }));
    // The same wrapper serves both, and it passes requests to the session's fetch (looked up per request).
    expect(((sdk.createTypeIndex.mock.calls as unknown as [{ fetch: unknown }][])[0]![0]).fetch).toBe(clientFetch.fetch);
    await clientFetch.fetch("https://alice.example/x");
    expect(podFetch).toHaveBeenCalledTimes(1);
  });

  it("cannot write: the exposure probe says unknown and the library offers only list and get", async () => {
    const store = fakeStore();
    sdk.openCreativeAssetStore.mockResolvedValue({ ok: true, value: store });
    const library = await build(() => someFetch());
    const deps = sdk.openCreativeAssetStore.mock.calls[0]?.[0] as { exposure: (url: string) => Promise<string>; allowUnknownExposureFor?: unknown };
    await expect(deps.exposure(`${ROOT}creative-assets/`)).resolves.toBe("unknown");
    expect(deps.allowUnknownExposureFor).toBeUndefined();
    expect(Object.keys(library.source).sort()).toEqual(["get", "list"]);
  });

  it("builds a tile loader for thumbnails and a viewer loader for originals, scoped to the library the store found", async () => {
    sdk.openCreativeAssetStore.mockResolvedValue({ ok: true, value: fakeStore() });
    const library = await build(() => someFetch());
    const calls = sdk.createMediaLoader.mock.calls as unknown as [Record<string, unknown>][];
    expect(calls).toHaveLength(2);
    const [tile, viewer] = [calls[0]![0], calls[1]![0]];
    expect(library.tileLoader).toBeDefined();
    expect(library.viewerLoader).not.toBe(library.tileLoader);
    // The grid: image types only, thumbnail-sized reads, entries bounded by the mounted-tile cap.
    expect(tile).toMatchObject({ ...TILE_LIMITS, allow: [...TILE_LIMITS.allow] });
    expect(TILE_LIMITS.maxEntries).toBe(MAX_MOUNTED_TILES * 2);
    expect(TILE_LIMITS.maxBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    // The viewer: the loader's default type list (no allow, no sniffer), a handful of entries.
    expect(viewer).toMatchObject(VIEWER_LIMITS);
    expect(viewer).not.toHaveProperty("allow");
    expect(viewer).not.toHaveProperty("sniff");
    expect(VIEWER_LIMITS.maxEntries).toBeLessThanOrEqual(4);
    for (const options of [tile, viewer]) {
      expect(options).not.toHaveProperty("sniff");
      const scope = options!.scope as (url: string) => boolean;
      expect(scope(`${ROOT}creative-assets/2026/06/a.png`)).toBe(true);
      expect(scope(`${ROOT}profile/card`)).toBe(false);
      expect((options!.getSessionKey as () => string)()).toBe(WEB_ID);
    }
  });

  it("reports a store that would not open as a closed word", async () => {
    sdk.openCreativeAssetStore.mockResolvedValue({ ok: false, error: { kind: "offline", reason: "storage" } });
    await expect(build(() => someFetch())).rejects.toMatchObject({ kind: "offline" });
    sdk.openCreativeAssetStore.mockResolvedValue({ ok: false, error: { kind: "forbidden", reason: "storage" } });
    await expect(build(() => someFetch())).rejects.toMatchObject({ kind: "forbidden" });
    sdk.openCreativeAssetStore.mockResolvedValue({ ok: false, error: { kind: "failed", reason: "storage" } });
    await expect(build(() => someFetch())).rejects.toMatchObject({ kind: "failed" });
  });

  it("does not let an error's text out", async () => {
    sdk.createPodClient.mockRejectedValue(new Error("https://alice.example/secret?token=abc"));
    const error = await build(() => someFetch()).catch((caught: unknown) => caught);
    expect((error as Error).message).toMatch(/^(failed|offline)$/);
  });
});

describe("a session that has ended is 'sign in again', never 'offline'", () => {
  /** The pod client asks for the profile, then fails with a message that carries a secret URL. */
  const failsAfterRequest = () =>
    sdk.createPodClient.mockImplementation(async (options: { fetch: typeof fetch }) => {
      await options.fetch("https://alice.example/profile/card").catch(() => undefined);
      throw new Error("https://alice.example/secret?token=abc");
    });

  it("when the pod answers 401", async () => {
    failsAfterRequest();
    const getFetch = () => (async () => new Response(null, { status: 401 })) as typeof fetch;
    await expect(build(getFetch)).rejects.toMatchObject({ kind: "sign-in" });
  });

  it("when the session's fetch says the session expired or changed", async () => {
    failsAfterRequest();
    for (const message of ["Session expired", "Session changed during authentication"]) {
      const getFetch = () => (async () => Promise.reject(new Error(message))) as typeof fetch;
      await expect(build(getFetch)).rejects.toMatchObject({ kind: "sign-in" });
    }
  });

  it("when the session has gone by the time a request is made", async () => {
    failsAfterRequest();
    await expect(build(() => null)).rejects.toMatchObject({ kind: "sign-in" });
  });

  it("but not when the network is merely down", async () => {
    failsAfterRequest();
    const getFetch = () => (async () => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    await expect(build(getFetch)).rejects.toMatchObject({ kind: "failed" });
  });

  it("maps a listing that fails after a refusal to sign-in, and clears it when the listing starts again", async () => {
    sdk.createPodClient.mockResolvedValue({ storage: { root: ROOT }, features: { protocol: "solid" } });
    const store = { ...fakeStore(), list: vi.fn(async () => ({ ok: false, error: { kind: "failed" } })) };
    sdk.openCreativeAssetStore.mockResolvedValue({ ok: true, value: store });
    let status = 401;
    const library = await build(() => (async () => new Response(null, { status })) as typeof fetch);
    const podFetch = (sdk.createPodClient.mock.calls[0]![0] as { fetch: typeof fetch }).fetch;
    await podFetch("https://alice.example/x");
    await expect(library.source.list({})).resolves.toEqual({ ok: false, error: "sign-in" });
    library.invalidateListing?.();
    status = 200;
    await expect(library.source.list({})).resolves.toEqual({ ok: false, error: "failed" });
  });
});
