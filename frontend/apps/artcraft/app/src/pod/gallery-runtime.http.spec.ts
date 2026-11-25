// @vitest-environment node
import { createTypeIndex } from "@jeswr/pod-type-index";
import { createMemoryJournal, type ExposureCheck } from "@jeswr/pod-media-store";
import { createMemoryStorage } from "@jeswr/storage-client/memory";
import { openCreativeAssetStore } from "@storyteller/pod-mirror";
import { describe, expect, it } from "vitest";
import { HTTP_POD_ROOT, httpPod } from "./__fixtures__/http-pod";
import { PAGE_SIZE } from "@storyteller/pod-gallery";
import { buildPodLibrary } from "./gallery-runtime";

/** A PNG header with a real IHDR (16x16), enough for the store's type check. */
function png(seed: number): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 16, 0, 0, 0, 16, 8, 2, 0, 0, 0]);
  for (let i = 29; i < 40; i++) bytes[i] = (seed * 31 + i) & 0xff;
  return bytes;
}

const WEB_ID = `${HTTP_POD_ROOT}profile/card#me`;

async function seedProfile(storage: ReturnType<typeof createMemoryStorage>, typeIndex: string | null) {
  const links = typeIndex ? `<${WEB_ID}> <http://www.w3.org/ns/solid/terms#publicTypeIndex> <${typeIndex}>.` : "";
  await storage.write(`${HTTP_POD_ROOT}profile/card`, `<${WEB_ID}> a <http://xmlns.com/foaf/0.1/Person>. ${links}`, { contentType: "text/turtle", ifMatch: "*" });
}

async function scenario(kind: "empty" | "index-only" | "populated", count = 3) {
  const data = createMemoryStorage({ protocol: "solid", root: HTTP_POD_ROOT });
  const indexUrl = `${HTTP_POD_ROOT}settings/publicTypeIndex.ttl`;
  await seedProfile(data, kind === "index-only" ? indexUrl : null);
  if (kind === "index-only") {
    await data.write(indexUrl, `<> a <http://www.w3.org/ns/solid/terms#TypeIndex>, <http://www.w3.org/ns/solid/terms#ListedDocument>.`, { contentType: "text/turtle", ifMatch: "*" });
  }
  if (kind === "populated") {
    const typeIndex = createTypeIndex({ storage: data, features: data.features, profile: WEB_ID });
    {
      const exposure: ExposureCheck = async () => "private";
      const writer = await openCreativeAssetStore({ storage: data, features: data.features, typeIndex, exposure, journal: createMemoryJournal() });
      if (!writer.ok) throw new Error(`seed store did not open: ${writer.error.kind}`);
      for (let n = 1; n <= count; n++) {
        const put = await writer.value.put({
          bytes: new Blob([png(n)]),
          contentType: "image/png",
          extension: ".png",
          createdAt: new Date(Date.UTC(2026, 5, 1, 10, 0, n)),
          description: { kind: "image", name: `Item ${n}`, dateCreated: new Date(Date.UTC(2026, 5, 1, 10, 0, n)) },
        });
        if (!put.ok) throw new Error(`seed put failed: ${put.error.kind}`);
      }
    }
  }
  return httpPod(data);
}

async function readEverything(pod: Awaited<ReturnType<typeof scenario>>) {
  const library = await buildPodLibrary({ getFetch: () => pod.fetch, getSessionKey: () => WEB_ID, webId: WEB_ID, signal: new AbortController().signal });
  const page = await library.source.list({});
  return { library, page };
}

const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);

describe("opening and listing the pod library sends only reads", () => {
  for (const kind of ["empty", "index-only", "populated"] as const) {
    it(`on ${kind === "empty" ? "an empty pod" : kind === "index-only" ? "a pod with a type index but no library" : "a populated pod"}: GET, HEAD and OPTIONS only`, async () => {
      const pod = await scenario(kind);
      const before = pod.requests.length;
      const { page } = await readEverything(pod);
      expect(page.ok).toBe(true);
      const methods = pod.requests.slice(before).map((request) => request.method);
      expect(methods.length).toBeGreaterThan(0);
      expect(methods.filter((method) => !READ_ONLY.has(method))).toEqual([]);
      if (kind === "populated") expect(page.ok && page.value.items.map((item) => item.name)).toEqual(["Item 3", "Item 2", "Item 1"]);
      else expect(page.ok && page.value.items).toEqual([]);
    });
  }
});

const isContainer = (request: { url: string }) => request.url.endsWith("/");

describe("requests per page", () => {
  it("lists the pod's folders once for the whole gallery session, and pages after that read only descriptions", async () => {
    const pod = await scenario("populated", 120);
    const library = await buildPodLibrary({ getFetch: () => pod.fetch, getSessionKey: () => WEB_ID, webId: WEB_ID, signal: new AbortController().signal });
    library.invalidateListing?.();
    const counts: { page: number; gets: number; containerGets: number; heads: number }[] = [];
    let cursor: string | null = null;
    let pageNumber = 0;
    do {
      const before = pod.requests.length;
      const result = await library.source.list({ cursor });
      if (!result.ok) throw new Error(`list failed: ${result.error}`);
      const sent = pod.requests.slice(before);
      counts.push({ page: ++pageNumber, gets: sent.filter((r) => r.method === "GET").length, containerGets: sent.filter((r) => r.method === "GET" && isContainer(r)).length, heads: sent.filter((r) => r.method === "HEAD").length });
      cursor = result.value.next;
    } while (cursor !== null);
    expect(counts.length).toBe(3);
    // Page one walks the library, year and month folders and the month's listing.
    expect(counts[0]!.containerGets).toBeGreaterThan(0);
    // Later pages list nothing again: every container listing came from the cache.
    for (const later of counts.slice(1)) expect(later.containerGets).toBe(0);
    // Each page reads one description per item it returns (the store reads a few more than the page
    // needs, in its last batch), and nothing else: no media file is read to list.
    for (const entry of counts) expect(entry.gets - entry.containerGets).toBeLessThanOrEqual(PAGE_SIZE + 8);
    expect(counts[0]!.containerGets).toBe(3);
    expect(counts.reduce((sum, entry) => sum + entry.heads, 0)).toBe(0);
  });
});

describe("the loaders and the session's state", () => {
  const SOMEWHERE = `${HTTP_POD_ROOT}creative-assets/2026/06/x.png`;
  const open = async (pod: Awaited<ReturnType<typeof scenario>>, wrap: (inner: typeof fetch) => typeof fetch) =>
    buildPodLibrary({ getFetch: () => wrap(pod.fetch), getSessionKey: () => WEB_ID, webId: WEB_ID, signal: new AbortController().signal });

  it("a session that expires after opening makes tile and viewer reads fail as offline AND marks the session ended", async () => {
    const pod = await scenario("populated", 3);
    let expired = false;
    const library = await open(pod, (inner) => (async (input, init) => (expired ? Promise.reject(new Error("Session expired")) : inner(input, init))) as typeof fetch);
    expect(library.sessionEnded?.()).toBe(false);
    expired = true;
    for (const loader of [library.tileLoader, library.viewerLoader]) {
      const result = await loader.acquire(SOMEWHERE);
      expect(result.ok ? "ok" : result.error.code).toBe("offline");
    }
    // The tiles and the viewer turn that into "sign in again" by asking this.
    expect(library.sessionEnded?.()).toBe(true);
  });

  it("a 401 reaches the loaders as 'forbidden' and marks the session ended; a good answer later clears it", async () => {
    const pod = await scenario("populated", 3);
    let refuse = false;
    const library = await open(pod, (inner) => (async (input, init) => (refuse ? new Response(null, { status: 401 }) : inner(input, init))) as typeof fetch);
    refuse = true;
    const result = await library.tileLoader.acquire(SOMEWHERE);
    expect(result.ok ? "ok" : result.error.code).toBe("forbidden");
    expect(library.sessionEnded?.()).toBe(true);
    refuse = false;
    await library.source.list({});
    expect(library.sessionEnded?.()).toBe(false);
  });

  it("a plain network failure is not an ended session", async () => {
    const pod = await scenario("populated", 3);
    let down = false;
    const library = await open(pod, (inner) => (async (input, init) => (down ? Promise.reject(new TypeError("Failed to fetch")) : inner(input, init))) as typeof fetch);
    down = true;
    await library.tileLoader.acquire(SOMEWHERE);
    expect(library.sessionEnded?.()).toBe(false);
  });
});
