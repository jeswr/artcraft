import type { MediaLoader } from '@jeswr/pod-media-loader';
import { vi } from 'vitest';
import type { PodLibrary } from './library.js';
import { mintPodMediaAddress } from './address.js';
import { mintPodAssetRef } from './ref.js';
import type { PodAsset, PodLibrarySource, PodListPage, PodSourceResult } from './types.js';

export function fakeLoader() {
  const loader = {
    acquire: vi.fn(async (url: string) => ({
      ok: true as const,
      value: { url: `blob:${url}`, contentType: 'image/png', bytes: 1, release: vi.fn() },
    })),
    purge: vi.fn(),
    resume: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    invalidate: vi.fn(),
    revalidate: vi.fn(),
    stats: vi.fn(() => ({ entries: 0, bytes: 0, inFlight: 0, purged: false })),
  };
  return loader as typeof loader & MediaLoader;
}

export function asset(n: number, over: Partial<PodAsset> = {}): PodAsset {
  return {
    ref: mintPodAssetRef(`https://pod.example/lib/2026/06/d${n}`),
    kind: 'image',
    name: `Item ${n}`,
    description: null,
    prompt: null,
    createdAt: '2026-06-01T10:00:00.000Z',
    declaredType: 'image/png',
    content: mintPodMediaAddress(`https://pod.example/lib/2026/06/b${n}.png`),
    thumbnail: null,
    ...over,
  };
}

export function fakeSource(pages: PodSourceResult<PodListPage>[]): PodLibrarySource & { list: ReturnType<typeof vi.fn> } {
  let index = 0;
  return {
    list: vi.fn(async () => pages[Math.min(index++, pages.length - 1)]),
    get: vi.fn(async () => ({ ok: false as const, error: 'not-found' as const })),
  };
}

export function page(items: PodAsset[], next: string | null = null, unreadable = 0): PodSourceResult<PodListPage> {
  return { ok: true, value: { items, next, unreadable } };
}

export function fakeLibrary(source: PodLibrarySource = fakeSource([page([])])): PodLibrary & { tileLoader: ReturnType<typeof fakeLoader>; viewerLoader: ReturnType<typeof fakeLoader>; close: ReturnType<typeof vi.fn> } {
  return { source, tileLoader: fakeLoader(), viewerLoader: fakeLoader(), close: vi.fn() };
}
