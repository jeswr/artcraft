// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Notice } from './messages.js';
import { createPodSession } from './pod-session.js';
import { PodSessionProvider, usePodSessionOrNull, usePodSessionState } from './react.js';
import { fakeAuth, fakePodMode, memoryMarker } from './testing.js';

afterEach(cleanup);

const config = { clientId: 'https://artcraft.example/id.jsonld', redirectUri: 'ai.artcraft.app:/oauth/callback', allowLoopbackHttp: false };

function make(options: { podWindow: boolean; auth?: ReturnType<typeof fakeAuth>; marker?: Parameters<typeof memoryMarker>[0] }) {
  return createPodSession({
    config,
    createAuth: () => options.auth ?? fakeAuth(),
    wipeStores: async () => 'wiped',
    podMode: fakePodMode({ podWindow: options.podWindow, issuer: 'https://login.example' }),
    marker: memoryMarker(options.marker ?? null),
    selfTest: async () => ({ ok: true }),
  });
}

function Kind({ session }: { session: NonNullable<ReturnType<typeof usePodSessionOrNull>> }) {
  return <span data-testid="probe">{usePodSessionState(session).kind}</span>;
}
function Probe() {
  const session = usePodSessionOrNull();
  return session ? <Kind session={session} /> : <span data-testid="probe">none</span>;
}

describe('PodSessionProvider', () => {
  it('provides the session and starts it when asked to', async () => {
    const session = make({ podWindow: true, auth: fakeAuth({ restored: 'https://pod.example/me#i' }) });
    render(
      <PodSessionProvider session={session} startNow>
        <Probe />
      </PodSessionProvider>,
    );
    await vi.waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('connected'));
  });

  it('does not start the session when not asked to', async () => {
    const session = make({ podWindow: true, auth: fakeAuth({ restored: 'https://pod.example/me#i' }) });
    const start = vi.spyOn(session, 'start');
    render(
      <PodSessionProvider session={session} startNow={false}>
        <Probe />
      </PodSessionProvider>,
    );
    await act(async () => undefined);
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByTestId('probe').textContent).toBe('disconnected');
  });

  it('gives no session outside a provider', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('none');
  });

  it('passes announcements to onNotice, including one shown after a rebuild', async () => {
    const notices: Notice[] = [];
    const session = make({ podWindow: false, marker: 'done-revocation-failed' });
    render(
      <PodSessionProvider session={session} startNow onNotice={(n) => notices.push(n)}>
        <Probe />
      </PodSessionProvider>,
    );
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    expect(notices[0]).toMatchObject({ level: 'error' });
    expect(notices[0]?.message).toMatch(/could not be told/);
  });

  it('stops announcing after unmount', async () => {
    const notices: Notice[] = [];
    const session = make({ podWindow: false });
    const view = render(
      <PodSessionProvider session={session} startNow={false} onNotice={(n) => notices.push(n)}>
        <Probe />
      </PodSessionProvider>,
    );
    view.unmount();
    await session.leave();
    expect(notices).toEqual([]);
  });
});
