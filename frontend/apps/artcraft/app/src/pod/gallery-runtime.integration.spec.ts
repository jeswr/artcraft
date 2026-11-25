// @vitest-environment node
import type { ExposureCheck } from "@jeswr/pod-media-store";
import { createTypeIndex } from "@jeswr/pod-type-index";
import type { StorageClient } from "@jeswr/storage-client";
import { createMemoryStorage } from "@jeswr/storage-client/memory";
import { podAssetDescriptionUrl, type PodAsset, type PodLibrary } from "@storyteller/pod-gallery";
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
  const library = await openPodLibrary({ storage, features: storage.features, typeIndex, signal });
  return { library, older, newer, typeIndex };
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
  it("lists newest first, with the text exactly as the pod wrote it", async () => {
    const items = await listAll(world.library);
    expect(items.map((item) => item.name)).toEqual(["<img src=x onerror=alert(1)>", "Older"]);
    expect(items[0]?.prompt).toBe("a fox");
    expect(items.every((item) => item.contentUrl.startsWith(`${ROOT}creative-assets/`))).toBe(true);
    expect(items.every((item) => item.thumbnailUrl?.startsWith(`${ROOT}creative-assets/`))).toBe(true);
    expect(podAssetDescriptionUrl(items[0]!.ref)).toBe(world.newer.descriptionUrl);
  });

  it("loads a file as a blob URL typed by its bytes, and a purge ends it", async () => {
    const [item] = await listAll(world.library);
    const result = await world.library.loader.acquire(item!.contentUrl);
    if (!result.ok) throw new Error(`acquire failed: ${result.error.code}`);
    expect(result.value.url.startsWith("blob:")).toBe(true);
    expect(result.value.contentType).toBe("image/png");
    result.value.release();
    world.library.loader.purge();
    const after = await world.library.loader.acquire(item!.contentUrl);
    expect(after.ok ? "ok" : after.error.code).toBe("purged");
  });

  it("refuses a file whose bytes are not passive media, whatever its name says", async () => {
    const [item] = await listAll(world.library);
    await storage.write(item!.contentUrl, new Blob(["<html><script>alert(1)</script></html>"]), { contentType: "image/png", ifMatch: "*" });
    const result = await world.library.loader.acquire(item!.contentUrl);
    expect(result.ok ? "ok" : result.error.code).toBe("unsupported-type");
  });

  it("refuses an address outside the library without reading it", async () => {
    const result = await world.library.loader.acquire(`${ROOT}profile/card`);
    expect(result.ok ? "ok" : result.error.code).toBe("out-of-scope");
  });

  it("does not change anything on the pod: not by listing, not by showing, not by opening an item", async () => {
    const before = await everythingOnThePod();
    const items = await listAll(world.library);
    for (const item of items) {
      for (const url of [item.thumbnailUrl, item.contentUrl]) {
        const result = await world.library.loader.acquire(url!);
        if (result.ok) result.value.release();
      }
      await world.library.source.get(item.ref);
    }
    expect(await everythingOnThePod()).toBe(before);
  });
});
