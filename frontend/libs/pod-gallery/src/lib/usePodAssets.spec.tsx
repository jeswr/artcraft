// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PodGalleryAccess } from './context.js';
import { PodLibraryOpenError } from './library.js';
import { podAssetDescriptionUrl } from './ref.js';
import { asset, fakeLibrary, fakeSource, page } from './testing.js';
import { RETRY_BACKOFF_MS, usePodAssets, type PodAssets } from './usePodAssets.js';

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
    act(() => view.current.loadMore({ force: true }));
    await waitFor(() => expect(view.current.state.status === 'ready' && view.current.state.items.length).toBe(2));
  });

  it('reads an empty library as ready with nothing in it', async () => {
    const view = harness(accessFor(fakeLibrary(fakeSource([page([])]))));
    await waitFor(() => expect(view.current.state.status).toBe('ready'));
    expect(view.current.state.status === 'ready' && view.current.state.items).toEqual([]);
  });

  it('lists the pod afresh on mount and on refresh, and says so to the library', async () => {
    const library = Object.assign(fakeLibrary(fakeSource([page([asset(1)])])), { invalidateListing: vi.fn() });
    const view = harness(accessFor(library));
    await waitFor(() => expect(view.current.state.status).toBe('ready'));
    expect(library.invalidateListing).toHaveBeenCalledTimes(1);
    act(() => view.current.refresh());
    await waitFor(() => expect(library.invalidateListing).toHaveBeenCalledTimes(2));
  });

  it('does not retry a failed "load more" on every scroll event: it backs off, then doubles, and a click skips it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const source = fakeSource([page([asset(3)], 'c2'), { ok: false, error: 'offline' }, { ok: false, error: 'offline' }, page([asset(2)], 'c3'), page([asset(1)])]);
      const view = harness(accessFor(fakeLibrary(source)));
      await waitFor(() => expect(view.current.state.status).toBe('ready'));
      const failed = () => view.current.state.status === 'ready' && view.current.state.loadMoreFailed;
      act(() => view.current.loadMore());
      await waitFor(() => expect(failed()).toBe(true));
      expect(source.list).toHaveBeenCalledTimes(2);
      // A burst of scroll events inside the back-off asks nothing.
      for (let i = 0; i < 20; i++) act(() => view.current.loadMore());
      expect(source.list).toHaveBeenCalledTimes(2);
      vi.setSystemTime(Date.now() + RETRY_BACKOFF_MS + 1);
      act(() => view.current.loadMore());
      await waitFor(() => expect(source.list).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(failed()).toBe(true));
      // The second failure doubles the wait.
      vi.setSystemTime(Date.now() + RETRY_BACKOFF_MS + 1);
      act(() => view.current.loadMore());
      expect(source.list).toHaveBeenCalledTimes(3);
      vi.setSystemTime(Date.now() + RETRY_BACKOFF_MS * 2);
      act(() => view.current.loadMore());
      await waitFor(() => expect(source.list).toHaveBeenCalledTimes(4));
      await waitFor(() => expect(view.current.state.status === 'ready' && view.current.state.items.length).toBe(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('a click on Retry skips the back-off', async () => {
    const source = fakeSource([page([asset(2)], 'c2'), { ok: false, error: 'offline' }, page([asset(1)])]);
    const view = harness(accessFor(fakeLibrary(source)));
    await waitFor(() => expect(view.current.state.status).toBe('ready'));
    act(() => view.current.loadMore());
    await waitFor(() => expect(view.current.state.status === 'ready' && view.current.state.loadMoreFailed).toBe(true));
    act(() => view.current.loadMore({ force: true }));
    await waitFor(() => expect(view.current.state.status === 'ready' && view.current.state.items.length).toBe(2));
  });

  it('asks the library for each page once: a page is one list call', async () => {
    const source = fakeSource([page([asset(2)], 'c2'), page([asset(1)])]);
    const view = harness(accessFor(fakeLibrary(source)));
    await waitFor(() => expect(view.current.state.status).toBe('ready'));
    act(() => view.current.loadMore());
    await waitFor(() => expect(source.list).toHaveBeenCalledTimes(2));
  });

  it('keeps why a "load more" failed: an ended session is not shown as a plain failure', async () => {
    const source = fakeSource([page([asset(2)], 'c2'), { ok: false, error: 'sign-in' }]);
    const view = harness(accessFor(fakeLibrary(source)));
    await waitFor(() => expect(view.current.state.status).toBe('ready'));
    act(() => view.current.loadMore());
    await waitFor(() => expect(view.current.state.status === 'ready' && view.current.state.loadMoreError).toBe('sign-in'));
  });

  it('survives a source that throws while paging', async () => {
    const source = fakeSource([page([asset(2)], 'c2')]);
    const view = harness(accessFor(fakeLibrary(source)));
    await waitFor(() => expect(view.current.state.status).toBe('ready'));
    source.list.mockRejectedValueOnce(new Error('boom'));
    act(() => view.current.loadMore());
    await waitFor(() => expect(view.current.state.status === 'ready' && view.current.state.loadMoreFailed).toBe(true));
    expect(view.current.state.status === 'ready' && view.current.state.loadingMore).toBe(false);
  });

  it('reports a session that has ended as its own state', async () => {
    const source = fakeSource([{ ok: false, error: 'sign-in' }]);
    const view = harness(accessFor(fakeLibrary(source)));
    await waitFor(() => expect(view.current.state).toEqual({ status: 'error', error: 'sign-in' }));
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
