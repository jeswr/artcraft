// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MirrorSummary } from '@storyteller/pod-mirror';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PodLibraryMissingBlock } from './PodLibraryMissingBlock.js';
import { type PodMirrorView, PodMirrorViewProvider } from './view.js';

afterEach(cleanup);

const summary = (libraryMissing: MirrorSummary['libraryMissing']): MirrorSummary => ({
  version: 1, running: true, paused: null, exposureTarget: null, counts: { saved: 40, pending: 0, failed: 0, skipped: 0, removing: 0 },
  goneFromArtcraft: 0, mediaHostBlocked: false, libraryMissing,
  import: { state: 'idle', pausedBy: null, walked: 0, total: null, saved: 0, skipped: 0, failed: 0, pending: 0, startedAt: null, finishedAt: null },
});
const viewOf = (found: MirrorSummary['libraryMissing'], copyAgain = vi.fn(async () => 6)): PodMirrorView => {
  const stable = summary(found);
  return {
  stateOf: () => undefined, summary: () => stable, subscribe: () => () => undefined, retry: async () => undefined, retryAllFailed: async () => 0,
  recheckExposure: () => undefined, confirmPrivate: async () => false, forgetAccount: async () => undefined, removeGoneFromPod: async () => 0, copyAgain,
  };
};

describe('PodLibraryMissingBlock', () => {
  it('renders nothing unless the pod check raised it', () => {
    const { container } = render(<PodMirrorViewProvider view={viewOf(null)}><PodLibraryMissingBlock /></PodMirrorViewProvider>);
    expect(container.innerHTML).toBe('');
  });

  it('says what was found and copies again only when the person presses the button', () => {
    const copyAgain = vi.fn(async () => 6);
    render(<PodMirrorViewProvider view={viewOf({ missing: 6, checked: 6 }, copyAgain)}><PodLibraryMissingBlock /></PodMirrorViewProvider>);
    expect(screen.getByRole('status').textContent).toContain('6 of the 6');
    expect(copyAgain).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy again' }));
    expect(copyAgain).toHaveBeenCalledTimes(1);
  });
});
