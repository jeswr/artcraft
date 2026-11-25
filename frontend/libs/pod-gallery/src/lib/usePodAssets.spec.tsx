// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PodGalleryAccess } from './context.js';
import { PodLibraryOpenError } from './library.js';
import { podAssetDescriptionUrl } from './ref.js';
import { asset, fakeLibrary, fakeSource, page } from './testing.js';
import { usePodAssets, type PodAssets } from './usePodAssets.js';

afterEach(cleanup);

function harness(access: PodGalleryAccess) {
  const latest: { current: PodAssets | null } = { current: null };
  function Probe() {
    latest.current = usePodAssets(access);
    return <p data-testid="status">{latest.current.state.status}</p>;
  }
  render(<Probe />);
  return latest as { current: PodAssets };
}

function accessFor(library: ReturnType<typeof fakeLibrary>): PodGalleryAccess & { open: ReturnType<typeof vi.fn> } {
  return { sessionKey: 'https://alice.example/profile/card#me', open: vi.fn(async () => library) };
}

describe('listing the pod library', () => {
  it('shows loading, then the first page in the order listed', async () => {
    const library = fakeLibrary(fakeSource([page([asset(2), asset(1)], 'c2')]));
    const view = harness(accessFor(library));
    expect(screen.getByTestId('status').textContent).toBe('loading');
    await waitFor(() => expect(view.current.state.status).toBe('ready'));
    const state = view.current.state;
    if (state.status !== 'ready') throw new Error('not ready');
    expect(state.items.map((item) => item.name)).toEqual(['Item 2', 'Item 1']);
    expect(state.hasMore).toBe(true);
  });

  it('pages on request, shows an item that appears twice once, and stops at the end', async () => {
    const source = fakeSource([page([asset(2), asset(1)], 'c2'), page([asset(1), asset(0)], null, 2)]);
    const view = harness(accessFor(fakeLibrary(source)));
    await waitFor(() => expect(view.current.state.status).toBe('ready'));
    act(() => view.current.loadMore());
    await waitFor(() => {
      const state = view.current.state;
      expect(state.status === 'ready' && state.items.length).toBe(3);
    });
    const state = view.current.state;
    if (state.status !== 'ready') throw new Error('not ready');
    expect(state.items.map((item) => podAssetDescriptionUrl(item.ref).slice(-2))).toEqual(['d2', 'd1', 'd0']);
    expect(state.hasMore).toBe(false);
    expect(state.unreadable).toBe(2);
    expect(source.list.mock.calls[1]?.[0]).toMatchObject({ cursor: 'c2' });
    act(() => view.current.loadMore());
    expect(source.list).toHaveBeenCalledTimes(2);
  });

  it('keeps what is shown when a later page fails, and can try again', async () => {
    const source = fakeSource([page([asset(1)], 'c2'), { ok: false, error: 'offline' }, page([asset(0)])]);
    const view = harness(accessFor(fakeLibrary(source)));
    await waitFor(() => expect(view.current.state.status).toBe('ready'));
    act(() => view.current.loadMore());
    await waitFor(() => expect(view.current.state.status === 'ready' && view.current.state.loadMoreFailed).toBe(true));
    expect(view.current.state.status === 'ready' && view.current.state.items.length).toBe(1);
    act(() => view.current.loadMore());
    await waitFor(() => expect(view.current.state.status === 'ready' && view.current.state.items.length).toBe(2));
  });

  it('reads an empty library as ready with nothing in it', async () => {
    const view = harness(accessFor(fakeLibrary(fakeSource([page([])]))));
    await waitFor(() => expect(view.current.state.status).toBe('ready'));
    expect(view.current.state.status === 'ready' && view.current.state.items).toEqual([]);
  });

  it('skips pages with nothing showable in them', async () => {
    const source = fakeSource([page([], 'c2', 3), page([], 'c3', 1), page([asset(1)], null)]);
    const view = harness(accessFor(fakeLibrary(source)));
    await waitFor(() => expect(view.current.state.status).toBe('ready'));
    expect(view.current.state.status === 'ready' && view.current.state.items.length).toBe(1);
    expect(view.current.state.status === 'ready' && view.current.state.unreadable).toBe(4);
  });

  it('reports a failed first page as a closed error and refreshes on request', async () => {
    const source = fakeSource([{ ok: false, error: 'forbidden' }, page([asset(1)])]);
    const view = harness(accessFor(fakeLibrary(source)));
    await waitFor(() => expect(view.current.state).toEqual({ status: 'error', error: 'forbidden' }));
    act(() => view.current.refresh());
    await waitFor(() => expect(view.current.state.status).toBe('ready'));
  });

  it('reports a pod that could not be opened, without its reason', async () => {
    const access: PodGalleryAccess = { sessionKey: 'k', open: async () => Promise.reject(new PodLibraryOpenError('offline')) };
    const view = harness(access);
    await waitFor(() => expect(view.current.state).toEqual({ status: 'error', error: 'offline' }));
  });

  it('tries again by itself when the network returns after an offline failure', async () => {
    const source = fakeSource([{ ok: false, error: 'offline' }, page([asset(1)])]);
    const view = harness(accessFor(fakeLibrary(source)));
    await waitFor(() => expect(view.current.state).toEqual({ status: 'error', error: 'offline' }));
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(view.current.state.status).toBe('ready'));
  });

  it('starts over for a different account', async () => {
    const alice = accessFor(fakeLibrary(fakeSource([page([asset(1)])])));
    const bob: PodGalleryAccess = { sessionKey: 'https://bob.example/profile/card#me', open: vi.fn(async () => fakeLibrary(fakeSource([page([asset(7)])]))) };
    const latest: { current: PodAssets | null } = { current: null };
    function Probe({ access }: { access: PodGalleryAccess }) {
      latest.current = usePodAssets(access);
      return null;
    }
    const { rerender } = render(<Probe access={alice} />);
    await waitFor(() => expect(latest.current?.state.status).toBe('ready'));
    rerender(<Probe access={bob} />);
    await waitFor(() => {
      const state = latest.current?.state;
      expect(state?.status === 'ready' && state.items[0]?.name).toBe('Item 7');
    });
  });
});
