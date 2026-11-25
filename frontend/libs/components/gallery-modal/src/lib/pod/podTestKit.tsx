import { createMediaLoader, type MediaLoader } from "@jeswr/pod-media-loader";
import { mintPodAssetRef, type PodAsset, type PodLibrary, type PodListPage, type PodSourceResult } from "@storyteller/pod-gallery";
import { mintPodMediaAddress } from "@storyteller/pod-gallery/media";
import { vi } from "vitest";

/** A pod for tests: files by URL, the real media loader over them, and a count of every read. */
export const POD = "https://alice.example/creative-assets/2026/06/";

/** A PNG header with a real IHDR, so the loader's decompression-bomb guard can read its size. */
export function png(seed = 1, width = 16, height = 16): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  bytes.set([8, 2, 0, 0, 0], 24);
  for (let i = 29; i < 40; i++) bytes[i] = (seed * 31 + i) & 0xff;
  return bytes;
}

/** The decompression-bomb GIF from the review: a 1x1 logical screen whose one frame claims 65535x65535. */
export function gifBomb(): Uint8Array {
  return Uint8Array.from([
    ...Array.from("GIF89a", (c) => c.charCodeAt(0)),
    1, 0, 1, 0, 0, 0, 0, // logical screen 1x1, no colour table
    0x2c, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0, // image descriptor 65535x65535
    2, 1, 0, // LZW minimum code size, one empty block, terminator
    0x3b,
  ]);
}

/** The smallest bytes the loader recognises as MP4 video. */
export function mp4(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32]);
  return bytes;
}

export function asset(n: number, over: Partial<PodAsset> = {}): PodAsset {
  return {
    ref: mintPodAssetRef(`${POD}d${n}`),
    kind: "image",
    name: `Item ${n}`,
    description: null,
    prompt: null,
    createdAt: "2026-06-01T10:00:00.000Z",
    declaredType: "image/png",
    content: mintPodMediaAddress(`${POD}b${n}.png`),
    thumbnail: mintPodMediaAddress(`${POD}b${n}-thumb.png`),
    ...over,
  };
}

export const thumbUrl = (n: number) => `${POD}b${n}-thumb.png`;
export const contentUrl = (n: number, ext = "png") => `${POD}b${n}.${ext}`;

export interface FakeFile {
  bytes: Uint8Array;
  /** The Content-Length the pod declares (default: the real size). */
  declared?: number | null;
}

export interface TestPodOptions {
  files?: Map<string, FakeFile>;
  tile?: Partial<Parameters<typeof createMediaLoader>[0]>;
  viewer?: Partial<Parameters<typeof createMediaLoader>[0]>;
  getSessionKey?: () => string;
}

/** Counts, per loader, the holds taken and given back, so a test can say "everything was released". */
export function counted(loader: MediaLoader) {
  const counts = { acquired: 0, released: 0 };
  const acquire = loader.acquire.bind(loader);
  loader.acquire = async (url, options) => {
    const result = await acquire(url, options);
    if (!result.ok) return result;
    counts.acquired++;
    let once = false;
    const release = result.value.release;
    return {
      ok: true,
      value: {
        ...result.value,
        release: () => {
          if (!once) counts.released++;
          once = true;
          release();
        },
      },
    };
  };
  return counts;
}

export function testPod(pages: PodSourceResult<PodListPage>[], options: TestPodOptions = {}) {
  const files = options.files ?? new Map<string, FakeFile>();
  const reads: string[] = [];
  const storage = {
    root: POD,
    isWithinStorage: (url: string) => url.startsWith("https://alice.example/"),
    read: vi.fn(async (url: string) => {
      reads.push(url);
      const file = files.get(url);
      if (!file) throw Object.assign(new Error("not found"), { code: "not-found", status: 404 });
      return {
        url,
        status: 200 as const,
        etag: null,
        contentLength: file.declared === undefined ? file.bytes.byteLength : file.declared,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(file.bytes);
            controller.close();
          },
        }),
      };
    }),
  };
  let created = 0;
  const objectUrls = { createObjectURL: vi.fn(() => `blob:test/${++created}`), revokeObjectURL: vi.fn() };
  const common = { storage: storage as never, scope: (url: string) => url.startsWith(POD), objectUrls, ...(options.getSessionKey ? { getSessionKey: options.getSessionKey } : {}) };
  const tileLoader = createMediaLoader({ ...common, maxBytes: 2 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, maxEntries: 320, assumedBytes: 128 * 1024, ...options.tile });
  const viewerLoader = createMediaLoader({ ...common, maxBytes: 25 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, maxEntries: 4, maxConcurrent: 2, ...options.viewer });
  const tileCounts = counted(tileLoader);
  const viewerCounts = counted(viewerLoader);
  let index = 0;
  const source = {
    list: vi.fn(async () => pages[Math.min(index++, pages.length - 1)]!),
    get: vi.fn(async () => ({ ok: false as const, error: "not-found" as const })),
  };
  const library: PodLibrary = { source, tileLoader, viewerLoader, invalidateListing: vi.fn() };
  return { library, source, storage, reads, objectUrls, tileLoader, viewerLoader, tileCounts, viewerCounts, files };
}

export function page(items: PodAsset[], next: string | null = null, unreadable = 0): PodSourceResult<PodListPage> {
  return { ok: true, value: { items, next, unreadable } };
}

/** Every thumbnail (and optionally every original) for items 1..n, as small PNGs. */
export function pngFiles(count: number, originals = true): Map<string, FakeFile> {
  const files = new Map<string, FakeFile>();
  for (let n = 1; n <= count; n++) {
    files.set(thumbUrl(n), { bytes: png(n + 100) });
    if (originals) files.set(contentUrl(n), { bytes: png(n) });
  }
  return files;
}
