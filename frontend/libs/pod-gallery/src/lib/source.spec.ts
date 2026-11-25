import type { MediaItem, Result } from '@jeswr/pod-media-store';
import type { AssetDescription } from '@jeswr/solid-creative-assets';
import { describe, expect, it, vi } from 'vitest';
import { unwrapPodMediaAddress } from './address.js';
import { podAssetDescriptionUrl } from './ref.js';
import { createPodLibrarySource, MAX_NAME_LENGTH, MAX_TEXT_LENGTH, PAGE_SIZE, type ReadOnlyAssetStore } from './source.js';

const LIB = 'https://pod.example/creative-assets/';

function item(n: number, value: Partial<AssetDescription> & { asset?: Record<string, unknown> } = {}, over: Partial<MediaItem<AssetDescription>> = {}): MediaItem<AssetDescription> {
  return {
    descriptionUrl: `${LIB}2026/06/d${n}`,
    value: { kind: 'image', asset: { contentUrl: `${LIB}2026/06/b${n}.png`, name: `Item ${n}` }, ...value } as AssetDescription,
    binaryUrl: `${LIB}2026/06/b${n}.png`,
    thumbnailUrl: undefined,
    etag: null,
    modified: new Date('2026-06-02T00:00:00Z'),
    ...over,
  };
}

function storeWith(result: Result<{ items: MediaItem<AssetDescription>[]; next: string | null; skipped: { foreign: number; unparseable: number; pending: number; outOfScope: number } }>) {
  const store = {
    list: vi.fn(async () => result),
    get: vi.fn(async (): Promise<Result<MediaItem<AssetDescription>>> => ({ ok: true, value: item(9) })),
  };
  return store satisfies ReadOnlyAssetStore;
}

const skipped = { foreign: 1, unparseable: 2, pending: 0, outOfScope: 3 };

describe('the pod library source', () => {
  it('lists in the order the store gives and maps only what the store parsed', async () => {
    const store = storeWith({ ok: true, value: { items: [item(2), item(1)], next: 'c2', skipped } });
    const result = await createPodLibrarySource(store).list({ cursor: 'c1' });
    expect(store.list).toHaveBeenCalledWith({ cursor: 'c1', limit: PAGE_SIZE });
    if (!result.ok) throw new Error('expected a page');
    expect(result.value.items.map((asset) => asset.name)).toEqual(['Item 2', 'Item 1']);
    expect(result.value.next).toBe('c2');
    expect(result.value.unreadable).toBe(5); // unparseable + outside the library; foreign members are not documents
  });

  it('uses the content and thumbnail URLs the store returned and never builds one', async () => {
    const withThumb = item(1, {}, { thumbnailUrl: `${LIB}2026/06/b1-thumb.png`, binaryUrl: `${LIB}2026/06/returned-by-store.png` });
    const store = storeWith({ ok: true, value: { items: [withThumb, item(2)], next: null, skipped } });
    const result = await createPodLibrarySource(store).list({});
    if (!result.ok) throw new Error('expected a page');
    const [first, second] = result.value.items;
    expect(unwrapPodMediaAddress(first!.content)).toBe(`${LIB}2026/06/returned-by-store.png`);
    expect(unwrapPodMediaAddress(first!.thumbnail!)).toBe(`${LIB}2026/06/b1-thumb.png`);
    expect(second?.thumbnail).toBeNull();
    expect(podAssetDescriptionUrl(first!.ref)).toBe(`${LIB}2026/06/d1`);
  });

  it('keeps pod text as plain, bounded strings and drops empty ones', async () => {
    const long = 'x'.repeat(MAX_TEXT_LENGTH + 500);
    const store = storeWith({
      ok: true,
      value: {
        items: [
          item(1, { asset: { contentUrl: 'u', name: `<img src=x onerror=alert(1)>${'n'.repeat(MAX_NAME_LENGTH)}`, description: long }, generation: { prompt: '  a fox  ' } } as never),
          item(2, { asset: { contentUrl: 'u', name: '   ', description: '' } } as never),
        ],
        next: null,
        skipped,
      },
    });
    const result = await createPodLibrarySource(store).list({});
    if (!result.ok) throw new Error('expected a page');
    const [one, two] = result.value.items;
    expect(one?.name?.length).toBe(MAX_NAME_LENGTH);
    expect(one?.name?.startsWith('<img')).toBe(true); // left as text: the view renders it as text
    expect(one?.description?.length).toBe(MAX_TEXT_LENGTH);
    expect(one?.prompt).toBe('a fox');
    expect(two?.name).toBeNull();
    expect(two?.description).toBeNull();
  });

  it('strips bidirectional controls from pod text', async () => {
    const source = createPodLibrarySource(storeWith({ ok: true, value: { items: [item(1, { asset: { contentUrl: 'u', name: 'abc\u202Edef\u2066ghi\u200F' } } as never)], next: null, skipped } }));
    const result = await source.list({});
    expect(result.ok && result.value.items[0]?.name).toBe('abcdefghi');
  });

  it('dates an item by its creation time, then by the description document, otherwise not at all', async () => {
    const created = item(1, { asset: { contentUrl: 'u', dateCreated: new Date('2026-05-01T00:00:00Z') } } as never);
    const modifiedOnly = item(2);
    const undated = item(3, {}, { modified: null });
    const store = storeWith({ ok: true, value: { items: [created, modifiedOnly, undated], next: null, skipped } });
    const result = await createPodLibrarySource(store).list({});
    if (!result.ok) throw new Error('expected a page');
    expect(result.value.items.map((asset) => asset.createdAt)).toEqual(['2026-05-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z', null]);
  });

  it('reports the store errors as a closed word', async () => {
    for (const [kind, expected] of [
      ['offline', 'offline'],
      ['forbidden', 'forbidden'],
      ['not-found', 'not-found'],
      ['conflict', 'failed'],
      ['exposed', 'failed'],
    ] as const) {
      const store = storeWith({ ok: false, error: { kind, reason: 'storage' } as never });
      expect(await createPodLibrarySource(store).list({})).toEqual({ ok: false, error: expected });
    }
  });

  it('gets one item by the address the store returned', async () => {
    const store = storeWith({ ok: true, value: { items: [item(1)], next: null, skipped } });
    const source = createPodLibrarySource(store);
    const listed = await source.list({});
    if (!listed.ok) throw new Error('expected a page');
    const got = await source.get(listed.value.items[0]!.ref);
    expect(store.get).toHaveBeenCalledWith(`${LIB}2026/06/d1`, undefined);
    expect(got.ok).toBe(true);
  });

  it('exposes no way to write, delete or import', () => {
    const source = createPodLibrarySource(storeWith({ ok: true, value: { items: [], next: null, skipped } }));
    expect(Object.keys(source).sort()).toEqual(['get', 'list']);
  });
});
