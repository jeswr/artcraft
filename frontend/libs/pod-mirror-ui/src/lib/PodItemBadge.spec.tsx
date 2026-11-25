// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ItemState, MirrorSummary } from '@storyteller/pod-mirror';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describePodState } from './messages.js';
import { PodItemBadge, PodItemStatusRow } from './PodItemBadge.js';
import { type PodMirrorView, PodMirrorViewProvider } from './view.js';

afterEach(cleanup);

function fakeView(states: Record<string, ItemState>) {
  const listeners = new Set<() => void>();
  const retry = vi.fn(async () => undefined);
  const summary: MirrorSummary = { version: 1, running: true, paused: null, counts: { saved: 0, pending: 0, failed: 0, skipped: 0, removing: 0 } };
  const view: PodMirrorView = {
    stateOf: (token) => states[token],
    summary: () => summary,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    retry,
    forgetAccount: async () => undefined,
  };
  return { view, retry, set: (token: string, state: ItemState) => { states[token] = state; for (const l of listeners) l(); } };
}

describe('PodItemBadge', () => {
  it('renders nothing without a pod, or for an item the mirror does not know', () => {
    const { container } = render(<PodItemBadge token="m_1" />);
    expect(container.innerHTML).toBe('');
    const { view } = fakeView({});
    const second = render(
      <PodMirrorViewProvider view={view}>
        <PodItemBadge token="m_1" />
      </PodMirrorViewProvider>,
    );
    expect(second.container.innerHTML).toBe('');
  });

  it('names each state, in words, and follows changes', () => {
    const fake = fakeView({ m_1: { kind: 'pending', attempts: 0 } });
    render(
      <PodMirrorViewProvider view={fake.view}>
        <PodItemBadge token="m_1" />
      </PodMirrorViewProvider>,
    );
    expect(screen.getByRole('img', { name: 'Saving to pod' })).toBeTruthy();
    act(() => fake.set('m_1', { kind: 'saved', descriptionUrl: 'https://pod/d', thumbnail: 'none' }));
    expect(screen.getByRole('img', { name: 'Saved to pod' })).toBeTruthy();
    act(() => fake.set('m_1', { kind: 'skipped', reason: 'audio-unsupported' }));
    expect(screen.getByRole('img', { name: 'Not saved to pod: audio is not supported yet' })).toBeTruthy();
  });

  it('offers a retry button for a failed item, and only for those', () => {
    const fake = fakeView({ m_1: { kind: 'failed', reason: 'offline', attempts: 3 }, m_2: { kind: 'saved', descriptionUrl: 'x', thumbnail: 'none' } });
    render(
      <PodMirrorViewProvider view={fake.view}>
        <PodItemBadge token="m_1" />
        <PodItemBadge token="m_2" />
      </PodMirrorViewProvider>,
    );
    const button = screen.getByRole('button', { name: 'Not saved to pod: you are offline. Retry' });
    fireEvent.click(button);
    expect(fake.retry).toHaveBeenCalledWith('m_1');
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('shows the status row with a visible retry', () => {
    const fake = fakeView({ m_1: { kind: 'failed', reason: 'conflict', attempts: 1 } });
    render(
      <PodMirrorViewProvider view={fake.view}>
        <PodItemStatusRow token="m_1" />
      </PodMirrorViewProvider>,
    );
    expect(screen.getByText(/Not saved to pod: a different file/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(fake.retry).toHaveBeenCalledWith('m_1');
  });

  it('every text starts with what it says and never leaks internals', () => {
    for (const reason of ['conflict', 'forbidden', 'too-large', 'unsupported', 'exposed', 'invalid-description', 'bytes-unavailable', 'hosted-unavailable', 'offline', 'store', 'unexpected'] as const) {
      const { label } = describePodState({ kind: 'failed', reason, attempts: 1 });
      expect(label.startsWith('Not saved to pod: ')).toBe(true);
      expect(label).not.toMatch(/https?:|m_/);
    }
  });
});
