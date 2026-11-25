// @vitest-environment node
import type { ExposureCheck } from "@jeswr/pod-media-store";
import { createTypeIndex } from "@jeswr/pod-type-index";
import type { StorageClient } from "@jeswr/storage-client";
import { createMemoryStorage } from "@jeswr/storage-client/memory";
import { podAssetKey, type PodAsset, type PodLibrary } from "@storyteller/pod-gallery";
import { createMemoryJournal } from "@jeswr/pod-media-store";
import { openCreativeAssetStore } from "@storyteller/pod-mirror";
import { beforeEach, describe, expect, it } from "vitest";
import { openPodLibrary } from "./gallery-runtime";

const ROOT = "https://pod.example/alice/";
const WEB_ID = `${ROOT}profile/card#me`;
const signal = new AbortController().signal;

/** A PNG header with a real IHDR, so the loader's decompression-bomb guard can read its size. */
function png(seed: number, width = 16, height = 16): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  bytes.set([8, 2, 0, 0, 0], 24);
  for (let i = 29; i < 40; i++) bytes[i] = (seed * 31 + i) & 0xff;
  return bytes;
}

let storage: StorageClient;

async function seed() {
  storage = createMemoryStorage({ protocol: "solid", root: ROOT });
  await storage.write(`${ROOT}profile/card`, `<${WEB_ID}> a <http://xmlns.com/foaf/0.1/Person>.`, { contentType: "text/turtle", ifMatch: "*" });
  const typeIndex = createTypeIndex({ storage, features: storage.features, profile: WEB_ID });
  const exposure: ExposureCheck = async () => "private";
  const writer = await openCreativeAssetStore({ storage, features: storage.features, typeIndex, exposure, journal: createMemoryJournal() });
  if (!writer.ok) throw new Error("seed store did not open");
  const put = async (n: number, createdAt: string, name: string, extra: object = {}) => {
    const result = await writer.value.put({
      bytes: new Blob([png(n)]),
      contentType: "image/png",
      extension: ".png",
      createdAt: new Date(createdAt),
      description: { kind: "image", name, dateCreated: new Date(createdAt), ...extra },
      thumbnail: { bytes: new Blob([png(n + 50)]) },
    });
    if (!result.ok) throw new Error(`seed put failed: ${result.error.kind}`);
    return result.value;
  };
  const older = await put(1, "2026-05-10T10:00:00Z", "Older");
  const newer = await put(2, "2026-06-10T10:00:00Z", "<img src=x onerror=alert(1)>", { generation: { prompt: "a fox" } });
  const session = { key: WEB_ID };
  const library = await openPodLibrary({ storage, features: storage.features, typeIndex, signal, getSessionKey: () => session.key });
  return { library, older, newer, typeIndex, session };
}

async function everythingOnThePod(): Promise<string> {
  let text = "";
  const walk = async (container: string): Promise<void> => {
    for await (const entry of storage.listAll(container)) {
      text += `${entry.url}\n`;
      if (entry.url.endsWith("/")) await walk(entry.url);
      else text += `${await (await storage.read(entry.url)).text()}\n`;
    }
  };
  await walk(storage.root);
  return text;
}

async function listAll(library: PodLibrary): Promise<PodAsset[]> {
  const page = await library.source.list({});
  if (!page.ok) throw new Error(`list failed: ${page.error}`);
  return [...page.value.items];
}

let world: Awaited<ReturnType<typeof seed>>;
beforeEach(async () => {
  world = await seed();
});

describe("the pod library opened for viewing, against a real store, loader and memory pod", () => {
  it("lists newest first, with the text exactly as the pod wrote it, and hands out only opaque addresses", async () => {
    const items = await listAll(world.library);
    expect(items.map((item) => item.name)).toEqual(["<img src=x onerror=alert(1)>", "Older"]);
    expect(items[0]?.prompt).toBe("a fox");
    // Nothing of an item is a string that names the pod.
    expect(JSON.stringify(items.map((item) => [item.ref, item.content, item.thumbnail]))).not.toContain("pod.example");
    for (const item of items) for (const value of [item.ref, item.content, item.thumbnail]) expect(typeof value).toBe("object");
    expect(new Set(items.map((item) => podAssetKey(item.ref))).size).toBe(2);
    const again = await world.library.source.get(items[0]!.ref);
    expect(again.ok && again.value.name).toBe("<img src=x onerror=alert(1)>");
  });

  it("reads thumbnails through a small image-only loader and originals through the viewer's, both as blob URLs typed by their bytes", async () => {
    const thumb = await world.library.tileLoader.acquire(world.newer.thumbnailUrl!);
    if (!thumb.ok) throw new Error(`acquire failed: ${thumb.error.code}`);
    expect(thumb.value.url.startsWith("blob:")).toBe(true);
    expect(thumb.value.contentType).toBe("image/png");
    thumb.value.release();
    const original = await world.library.viewerLoader.acquire(world.newer.binaryUrl);
    if (!original.ok) throw new Error(`acquire failed: ${original.error.code}`);
    expect(original.value.contentType).toBe("image/png");
    original.value.release();
  });

  it("purges both loaders when the session key changes, before anything is served", async () => {
    const first = await world.library.viewerLoader.acquire(world.newer.binaryUrl);
    if (!first.ok) throw new Error("acquire failed");
    first.value.release();
    world.session.key = "https://pod.example/bob/profile/card#me";
    const second = await world.library.viewerLoader.acquire(world.newer.binaryUrl);
    if (!second.ok) throw new Error("acquire failed");
    expect(second.value.url).not.toBe(first.value.url);
    second.value.release();
  });

  it("ends every read on a purge", async () => {
    const result = await world.library.tileLoader.acquire(world.newer.thumbnailUrl!);
    if (result.ok) result.value.release();
    world.library.tileLoader.purge();
    world.library.viewerLoader.purge();
    for (const loader of [world.library.tileLoader, world.library.viewerLoader]) {
      const after = await loader.acquire(world.newer.binaryUrl);
      expect(after.ok ? "ok" : after.error.code).toBe("purged");
    }
  });

  it("refuses a file whose bytes are not passive media, whatever its name says", async () => {
    await storage.write(world.newer.binaryUrl, new Blob(["<html><script>alert(1)</script></html>"]), { contentType: "image/png", ifMatch: "*" });
    const result = await world.library.viewerLoader.acquire(world.newer.binaryUrl);
    expect(result.ok ? "ok" : result.error.code).toBe("unsupported-type");
  });

  it("refuses an address outside the library without reading it", async () => {
    for (const loader of [world.library.tileLoader, world.library.viewerLoader]) {
      const result = await loader.acquire(`${ROOT}profile/card`);
      expect(result.ok ? "ok" : result.error.code).toBe("out-of-scope");
    }
  });

  it("does not change anything on the pod: not by listing, not by showing, not by opening an item", async () => {
    const before = await everythingOnThePod();
    const items = await listAll(world.library);
    for (const [url, loader] of [
      [world.newer.thumbnailUrl, world.library.tileLoader],
      [world.newer.binaryUrl, world.library.viewerLoader],
      [world.older.binaryUrl, world.library.viewerLoader],
    ] as const) {
      const result = await loader.acquire(url!);
      if (result.ok) result.value.release();
    }
    for (const item of items) await world.library.source.get(item.ref);
    expect(await everythingOnThePod()).toBe(before);
  });
});
