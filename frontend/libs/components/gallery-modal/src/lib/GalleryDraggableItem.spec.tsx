import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ItemState } from '@storyteller/pod-mirror';
import { PodMirrorViewProvider, type PodMirrorView } from '@storyteller/pod-mirror-ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GalleryDraggableItem } from './GalleryDraggableItem';
import type { GalleryItem } from './gallery-modal';

afterEach(cleanup);

const item: GalleryItem = { id: 'm_1', label: 'Fox', thumbnail: 'https://cdn.example/t.png', createdAt: '2026-06-01T00:00:00Z', mediaClass: 'image' };

function renderTile(state: ItemState | undefined, tile: GalleryItem = item) {
  const retry = vi.fn(async () => undefined);
  const view: PodMirrorView = {
    stateOf: (token) => (token === tile.id ? state : undefined),
    summary: () => ({ version: 1, running: true, paused: null, counts: { saved: 0, pending: 0, failed: 0, skipped: 0, removing: 0 } }),
    subscribe: () => () => undefined,
    retry,
    forgetAccount: async () => undefined,
  };
  const tree = (
    <GalleryDraggableItem item={tile} mode="view" activeFilter="all" selected={false} onClick={() => undefined} onImageError={() => undefined} />
  );
  render(<PodMirrorViewProvider view={view}>{tree}</PodMirrorViewProvider>);
  return { retry };
}

describe('the pod state on a gallery tile', () => {
  it('shows nothing when no pod is connected', () => {
    render(<GalleryDraggableItem item={item} mode="view" activeFilter="all" selected={false} onClick={() => undefined} onImageError={() => undefined} />);
    expect(screen.queryByLabelText(/pod/i)).toBeNull();
  });

  it('names the state of an item and keeps the tile itself unchanged', () => {
    renderTile({ kind: 'saved', descriptionUrl: 'https://pod/d', thumbnail: 'none' });
    expect(screen.getByRole('img', { name: 'Saved to pod' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fox' })).toBeTruthy();
  });

  it('retries a failed item from the tile without opening it', () => {
    const onClick = vi.fn();
    const { retry } = renderTile({ kind: 'failed', reason: 'bytes-unavailable', attempts: 6 });
    const button = screen.getByRole('button', { name: /Not saved to pod: the file could not be downloaded\. Retry/ });
    fireEvent.click(button);
    expect(retry).toHaveBeenCalledWith('m_1');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('says why audio is not saved', () => {
    renderTile({ kind: 'skipped', reason: 'audio-unsupported' }, { ...item, mediaClass: 'audio' });
    expect(screen.getByRole('img', { name: 'Not saved to pod: audio is not supported yet' })).toBeTruthy();
  });
});
