import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PodSessionConfig } from './config.js';
import { createPodSession, localStorageMarker, type PodSessionDeps } from './pod-session.js';
import type { PodSessionState } from './state.js';
import { fakeAuth, fakePodMode, memoryMarker } from './testing.js';
import type { WipeOutcome } from './wipe.js';

const ISSUER = 'https://login.example';
const WEBID = 'https://pod.example/alice/profile/card#me';
const CONFIG: PodSessionConfig = {
  clientId: 'https://artcraft.example/solid-client-id.jsonld',
  redirectUri: 'ai.artcraft.app:/oauth/callback',
  allowLoopbackHttp: false,
};

afterEach(() => vi.restoreAllMocks());

function setup(options: {
  podWindow?: boolean;
  marker?: Parameters<typeof memoryMarker>[0];
  issuer?: string | null;
  restoreAllowed?: boolean;
  policy?: boolean;
  answer?: 'requested' | 'declined' | 'throws';
  leaveFails?: boolean;
  auth?: ReturnType<typeof fakeAuth>;
  config?: PodSessionConfig;
  selfTest?: PodSessionDeps['selfTest'];
  wipe?: (call: number) => Promise<WipeOutcome> | WipeOutcome;
  createAuth?: () => ReturnType<typeof fakeAuth>;
} = {}) {
  const podMode = fakePodMode({
    podWindow: options.podWindow ?? false,
    restoreAllowed: options.restoreAllowed ?? true,
    policy: options.policy ?? true,
    issuer: options.issuer ?? null,
    answer: options.answer ?? 'requested',
    leaveFails: options.leaveFails ?? false,
  });
  const marker = memoryMarker(options.marker ?? null);
  const auth = options.auth ?? fakeAuth();
  const order: string[] = [];
  const createAuth = vi.fn(() => {
    order.push('createAuth');
    return options.createAuth ? options.createAuth() : auth;
  });
  let wipes = 0;
  const wipeStores = vi.fn(async (): Promise<WipeOutcome> => {
    order.push('wipe');
    return (await options.wipe?.(wipes++)) ?? 'wiped';
  });
  const session = createPodSession({
    config: options.config ?? CONFIG,
    createAuth,
    wipeStores,
    podMode,
    marker,
    selfTest: options.selfTest ?? (async () => ({ ok: true })),
  });
  const states: PodSessionState[] = [];
  session.subscribe((s) => states.push(s));
  return { session, podMode, marker, auth, createAuth, wipeStores, order, states };
}

describe('connect', () => {
  it('validates the issuer, asks the app, and leaves the sign-in to the rebuilt window', async () => {
    const t = setup();
    await t.session.connect(`  ${ISSUER}/ `);
    expect(t.podMode.entered).toEqual([ISSUER]);
    expect(t.marker.value).toBe('connect');
    expect(t.session.getState()).toEqual({ kind: 'connecting', issuer: ISSUER });
    // Nothing that could hold credentials is created in this window.
    expect(t.createAuth).not.toHaveBeenCalled();
    expect(t.wipeStores).not.toHaveBeenCalled();
  });

  it.each(['', 'login.example', 'javascript:alert(1)', 'https://u:p@login.example', 'http://login.example', 'http://localhost:3000'])(
    'refuses %j without asking the app',
    async (input) => {
      const t = setup();
      await t.session.connect(input);
      expect(t.session.getState()).toEqual({ kind: 'error', error: 'invalid-issuer' });
      expect(t.podMode.entered).toEqual([]);
      expect(t.marker.value).toBeNull();
    },
  );

  it('accepts http://localhost only when the config allows it', async () => {
    const t = setup({ config: { ...CONFIG, allowLoopbackHttp: true } });
    await t.session.connect('http://localhost:3000');
    expect(t.podMode.entered).toEqual(['http://localhost:3000']);
  });

  it('records that the person declined and clears the marker', async () => {
    const t = setup({ answer: 'declined' });
    await t.session.connect(ISSUER);
    expect(t.session.getState()).toEqual({ kind: 'disconnected', outcome: 'declined' });
    expect(t.marker.value).toBeNull();
  });

  it('reports request-failed and clears the marker when the app refuses', async () => {
    const t = setup({ answer: 'throws' });
    await t.session.connect(ISSUER);
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'request-failed' });
    expect(t.marker.value).toBeNull();
  });

  it.each([
    ['the placeholder client', { ...CONFIG, clientId: 'https://client-id.placeholder.invalid/artcraft/solid-client-id.jsonld' }, 'not-configured'],
    ['a client that is not a URL', { ...CONFIG, clientId: 'nope' }, 'invalid-config'],
    ['a redirect without a reverse-domain scheme', { ...CONFIG, redirectUri: 'artcraft:/oauth/callback' }, 'invalid-config'],
  ] as const)('refuses %s before asking the app', async (_name, config, error) => {
    const t = setup({ config });
    await t.session.connect(ISSUER);
    expect(t.session.getState()).toEqual({ kind: 'error', error });
    expect(t.podMode.entered).toEqual([]);
  });

  it('does nothing in a pod window', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER });
    await t.session.start();
    t.states.length = 0;
    await t.session.connect('https://other.example');
    expect(t.podMode.entered).toEqual([]);
    expect(t.states).toEqual([]);
  });

  it('is refused when the window is unsupported', async () => {
    const t = setup({ selfTest: async () => ({ ok: false, reason: 'web-locks-missing' }) });
    await t.session.connect(ISSUER);
    expect(t.session.getState()).toEqual({ kind: 'unsupported', reason: 'web-locks-missing' });
    expect(t.podMode.entered).toEqual([]);
  });
});

describe('start in a pod window', () => {
  it('continues a confirmed sign-in against the issuer the app recorded', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, marker: 'connect' });
    const started = t.session.start();
    await vi.waitFor(() => expect(t.auth.calls).toContain('login'));
    expect(t.order).toEqual(['wipe', 'createAuth']);
    expect(t.auth.loginHints).toEqual([{ issuer: ISSUER }]);
    expect(t.marker.value).toBeNull();
    expect(t.session.getState()).toEqual({ kind: 'signing-in', issuer: ISSUER });
    t.auth.finish(WEBID);
    await started;
    expect(t.session.getState()).toEqual({ kind: 'connected', webId: WEBID });
    expect(t.session.getFetch()).toBe(t.auth.fetch);
  });

  it('restores a remembered session when no sign-in was asked for', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, auth: fakeAuth({ restored: WEBID }) });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'connected', webId: WEBID });
    expect(t.wipeStores).not.toHaveBeenCalled();
  });

  it('stays disconnected when there is nothing to restore', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'disconnected' });
    expect(t.auth.calls).toEqual(['restore', 'dispose']);
  });

  it('reports a closed error when restore fails', async () => {
    const t = setup({ podWindow: true, auth: fakeAuth({ restoreError: new Error('https://x/?code=SECRET') }) });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'restore-failed' });
    expect(JSON.stringify(t.states)).not.toContain('SECRET');
  });

  it('never builds pod-auth when analytics already ran in this window', async () => {
    const t = setup({ podWindow: true, restoreAllowed: false, marker: 'connect', issuer: ISSUER });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'window-not-clean' });
    expect(t.createAuth).not.toHaveBeenCalled();
    expect(t.wipeStores).not.toHaveBeenCalled();
  });

  it('never builds pod-auth when no narrowing policy is confirmed', async () => {
    const t = setup({ podWindow: true, policy: false, marker: 'connect', issuer: ISSUER });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'policy-not-applied' });
    expect(t.createAuth).not.toHaveBeenCalled();
    const restoring = setup({ podWindow: true, policy: false });
    await restoring.session.start();
    expect(restoring.session.getState()).toEqual({ kind: 'error', error: 'policy-not-applied' });
    expect(restoring.createAuth).not.toHaveBeenCalled();
  });

  it('refuses a bad config inside the pod window too, without building pod-auth', async () => {
    const t = setup({ podWindow: true, config: { ...CONFIG, clientId: 'http://client.example/id' } });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'invalid-config' });
    expect(t.createAuth).not.toHaveBeenCalled();
  });

  it('ignores a connect marker without a recorded issuer', async () => {
    const t = setup({ podWindow: true, issuer: null, marker: 'connect' });
    await t.session.start();
    expect(t.auth.calls).not.toContain('login');
    expect(t.marker.value).toBeNull();
  });

  it('clears a stale connect marker in an ordinary window and does nothing else', async () => {
    const t = setup({ marker: 'connect' });
    await t.session.start();
    expect(t.marker.value).toBeNull();
    expect(t.session.getState()).toEqual({ kind: 'disconnected' });
    expect(t.createAuth).not.toHaveBeenCalled();
  });
});

describe('sign-in failures', () => {
  async function connectThen(act: (t: ReturnType<typeof setup>) => void | Promise<void>, options: Parameters<typeof setup>[0] = {}) {
    const t = setup({ podWindow: true, issuer: ISSUER, marker: 'connect', ...options });
    const started = t.session.start();
    await vi.waitFor(() => expect(t.auth.calls).toContain('login'));
    await act(t);
    await started;
    return t;
  }

  it('maps pod-auth codes to closed kinds and scrubs the stores', async () => {
    for (const [code, kind] of [['timed-out', 'sign-in-timed-out'], ['host-failed', 'browser-open-failed'], ['other', 'sign-in-failed']] as const) {
      const t = await connectThen((x) => x.auth.fail(Object.assign(new Error('https://x/?code=SECRET'), { code })));
      expect(t.session.getState()).toEqual({ kind: 'error', error: kind });
      expect(t.auth.calls).toContain('logout');
      expect(t.wipeStores).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(t.states)).not.toContain('SECRET');
    }
  });

  it('logs out and wipes when login resolves without a WebID', async () => {
    const t = await connectThen((x) => x.auth.finish(null));
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'sign-in-failed' });
    expect(t.auth.calls).toEqual(['login', 'logout', 'dispose']);
    expect(t.wipeStores).toHaveBeenCalledTimes(2);
    expect(t.session.getFetch()).toBeNull();
  });

  it('logs out and wipes when login finishes after the person cancelled', async () => {
    const auth = fakeAuth();
    // A pod-auth whose login does not honour the signal and still resolves with a session.
    auth.login = async (_hint, { signal }) => {
      auth.calls.push('login');
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      return { webId: WEBID };
    };
    const t = await connectThen((x) => x.session.cancel(), { auth });
    expect(t.session.getState()).toEqual({ kind: 'disconnected' });
    expect(t.auth.calls).toEqual(['login', 'logout', 'dispose']);
    expect(t.wipeStores).toHaveBeenCalledTimes(2);
    expect(t.session.getFetch()).toBeNull();
  });

  it('logs out and wipes when the person cancels', async () => {
    const t = await connectThen((x) => x.session.cancel());
    expect(t.session.getState()).toEqual({ kind: 'disconnected' });
    expect(t.auth.calls).toEqual(['login', 'logout', 'dispose']);
    expect(t.wipeStores).toHaveBeenCalledTimes(2);
  });

  it('does not build pod-auth when the person cancels while the starting wipe runs', async () => {
    let release: () => void = () => undefined;
    const t = setup({
      podWindow: true,
      issuer: ISSUER,
      marker: 'connect',
      wipe: (call) => (call === 0 ? new Promise<WipeOutcome>((resolve) => (release = () => resolve('wiped'))) : 'wiped'),
    });
    const started = t.session.start();
    await vi.waitFor(() => expect(t.session.getState().kind).toBe('signing-in'));
    t.session.cancel();
    release();
    await started;
    expect(t.createAuth).not.toHaveBeenCalled();
    expect(t.session.getState()).toEqual({ kind: 'disconnected' });
  });

  it('does not begin when the starting wipe is only queued', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, marker: 'connect', wipe: () => 'deferred' });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'wipe-failed' });
    expect(t.createAuth).not.toHaveBeenCalled();
  });

  it('builds pod-auth inside the guarded section: a throwing factory is a closed error', async () => {
    const t = setup({
      podWindow: true,
      issuer: ISSUER,
      marker: 'connect',
      createAuth: () => {
        throw new Error('https://x/?code=SECRET');
      },
    });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'sign-in-failed' });
    expect(JSON.stringify(t.states)).not.toContain('SECRET');
  });

  it('scrubs even when the scrub itself fails, and reports the first failure', async () => {
    const t = await connectThen((x) => x.auth.fail(Object.assign(new Error('x'), { code: 'timed-out' })), {
      auth: fakeAuth({ logoutError: new Error('down') }),
      wipe: (call) => {
        if (call > 0) throw new Error('blocked');
        return 'wiped';
      },
    });
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'sign-in-timed-out' });
  });
});

describe('leave', () => {
  async function connected(options: Parameters<typeof setup>[0] = {}) {
    const t = setup({ podWindow: true, issuer: ISSUER, auth: fakeAuth({ restored: WEBID }), ...options });
    await t.session.start();
    expect(t.session.getState().kind).toBe('connected');
    return t;
  }

  it('revokes before it wipes', async () => {
    const t = await connected();
    const logout = t.auth.logout.bind(t.auth);
    t.auth.logout = async () => {
      t.order.push('logout');
      await logout();
    };
    await t.session.leave();
    expect(t.order.slice(-2)).toEqual(['logout', 'wipe']);
  });

  it('revokes, wipes, and only then asks the app to leave', async () => {
    const t = await connected();
    t.wipeStores.mockImplementation(async () => {
      t.podMode.log.push('wipe');
      return 'wiped';
    });
    await t.session.leave();
    expect(t.auth.calls).toEqual(['restore', 'logout', 'dispose']);
    expect(t.podMode.log).toEqual(['wipe', 'leave-wipe-start', 'left']);
    expect(t.session.getState()).toEqual({ kind: 'disconnected', outcome: 'disconnected' });
    expect(t.session.getFetch()).toBeNull();
    expect(t.marker.value).toBeNull();
  });

  it('leaves the marker for the rebuilt window to show the answer', async () => {
    const t = await connected();
    let markerAtLeave: unknown = 'unset';
    const original = t.podMode.leave;
    t.podMode.leave = async (wipe) => {
      markerAtLeave = t.marker.value;
      return original(wipe);
    };
    await t.session.leave();
    expect(markerAtLeave).toBe('done');
  });

  it('still wipes and leaves when revocation fails, and says so as its own state', async () => {
    const t = await connected({ auth: fakeAuth({ restored: WEBID, logoutError: new Error('network') }) });
    await t.session.leave();
    expect(t.wipeStores).toHaveBeenCalledTimes(1);
    expect(t.podMode.log).toContain('left');
    expect(t.session.getState()).toEqual({ kind: 'signed-out-locally' });
  });

  it('records a failed revocation for the rebuilt window', async () => {
    const t = await connected({ auth: fakeAuth({ restored: WEBID, logoutError: new Error('network') }) });
    let markerAtLeave: unknown = 'unset';
    const original = t.podMode.leave;
    t.podMode.leave = async (wipe) => {
      markerAtLeave = t.marker.value;
      return original(wipe);
    };
    await t.session.leave();
    expect(markerAtLeave).toBe('done-revocation-failed');
  });

  it('does not leave pod mode when the wipe fails, and says so', async () => {
    const t = await connected({
      wipe: () => {
        throw new Error('disk');
      },
    });
    await t.session.leave();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'wipe-failed' });
    expect(t.podMode.log).not.toContain('left');
    expect(t.session.getFetch()).toBeNull();
  });

  it('treats a blocked delete as unfinished: rebuilds the window and finishes there', async () => {
    const t = await connected({ wipe: (call) => (call === 0 ? 'deferred' : 'wiped') });
    await t.session.leave();
    expect(t.podMode.log).toEqual(['reload']);
    expect(t.marker.value).toBe('leave');
    expect(t.session.getState()).toEqual({ kind: 'leaving', step: 'reloading' });
    expect(t.podMode.log).not.toContain('left');
  });

  it('remembers a failed revocation across the rebuild', async () => {
    const t = await connected({
      auth: fakeAuth({ restored: WEBID, logoutError: new Error('x') }),
      wipe: () => 'deferred',
    });
    await t.session.leave();
    expect(t.marker.value).toBe('leave-revocation-failed');
  });

  it('reports request-failed when the window cannot be rebuilt', async () => {
    const t = await connected({ wipe: () => 'deferred' });
    t.podMode.requestReload = async () => {
      throw new Error('x');
    };
    await t.session.leave();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'request-failed' });
    expect(t.marker.value).toBeNull();
  });

  it('finishes a disconnect in the rebuilt window before pod-auth opens anything', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, marker: 'leave' });
    await t.session.start();
    expect(t.order).toEqual(['wipe']);
    expect(t.createAuth).not.toHaveBeenCalled();
    expect(t.podMode.log).toEqual(['leave-wipe-start', 'left']);
    expect(t.session.getState()).toEqual({ kind: 'disconnected', outcome: 'disconnected' });
  });

  it('finishes with the revocation-failed answer when that is what was recorded', async () => {
    const t = setup({ podWindow: true, marker: 'leave-revocation-failed' });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'signed-out-locally' });
  });

  it('finishes a recorded disconnect even when the browser cannot run pod-auth', async () => {
    const t = setup({ podWindow: true, marker: 'leave', selfTest: async () => ({ ok: false, reason: 'web-locks-missing' }) });
    await t.session.start();
    expect(t.podMode.log).toContain('left');
  });

  it('reports wipe-failed in the rebuilt window when the delete is still not done', async () => {
    const t = setup({ podWindow: true, marker: 'leave', wipe: () => 'deferred' });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'wipe-failed' });
    expect(t.podMode.log).not.toContain('left');
    expect(t.marker.value).toBeNull();
  });

  it('reports request-failed when the app will not leave, and keeps nothing recorded', async () => {
    const t = await connected({ leaveFails: true });
    await t.session.leave();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'request-failed' });
    expect(t.marker.value).toBeNull();
  });

  it.each([
    ['an error', () => setup({ podWindow: true, auth: fakeAuth({ restoreError: new Error('x') }) })],
    ['a disconnected pod window', () => setup({ podWindow: true })],
    ['an unsupported pod window', () => setup({ podWindow: true, selfTest: async () => ({ ok: false, reason: 'web-locks-missing' }) })],
    ['a window that failed the policy check', () => setup({ podWindow: true, policy: false })],
  ])('works from %s: wipes locally and leaves', async (_name, make) => {
    const t = make();
    await t.session.start();
    await t.session.leave();
    expect(t.wipeStores).toHaveBeenCalled();
    expect(t.podMode.log).toContain('left');
  });

  it('works while a sign-in is running: aborts it, then wipes and leaves', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, marker: 'connect' });
    const started = t.session.start();
    await vi.waitFor(() => expect(t.auth.calls).toContain('login'));
    await t.session.leave();
    await started;
    expect(t.podMode.log).toContain('left');
    expect(t.session.getFetch()).toBeNull();
  });

  it('wipes even in an ordinary window, without asking the app to leave', async () => {
    const t = setup();
    await t.session.leave();
    expect(t.wipeStores).toHaveBeenCalled();
    expect(t.podMode.log).toEqual([]);
    expect(t.session.getState()).toEqual({ kind: 'disconnected', outcome: 'disconnected' });
  });

  it('runs one disconnect at a time', async () => {
    const t = await connected();
    await Promise.all([t.session.leave(), t.session.leave()]);
    expect(t.wipeStores).toHaveBeenCalledTimes(1);
  });
});

describe('after a rebuild the answer is still shown', () => {
  it('shows "disconnected" once from the recorded marker', async () => {
    const t = setup({ marker: 'done' });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'disconnected', outcome: 'disconnected' });
    expect(t.marker.value).toBeNull();
  });

  it('shows "signed out locally" once from the recorded marker', async () => {
    const t = setup({ marker: 'done-revocation-failed' });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'signed-out-locally' });
    expect(t.marker.value).toBeNull();
  });
});

describe('start', () => {
  it('is idempotent', async () => {
    const selfTest = vi.fn(async () => ({ ok: true }) as const);
    const t = setup({ selfTest });
    await Promise.all([t.session.start(), t.session.start()]);
    await t.session.start();
    expect(selfTest).toHaveBeenCalledTimes(1);
  });

  it('is unsupported when the self-test fails or throws, and never touches pod-auth', async () => {
    for (const selfTest of [
      async () => ({ ok: false, reason: 'key-not-persistable' }) as const,
      async () => {
        throw new Error('x');
      },
    ]) {
      const t = setup({ podWindow: true, selfTest });
      await t.session.start();
      expect(t.session.getState()).toEqual({ kind: 'unsupported', reason: 'key-not-persistable' });
      expect(t.createAuth).not.toHaveBeenCalled();
    }
  });

  it('does nothing in an ordinary window', async () => {
    const t = setup();
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'disconnected' });
    expect(t.createAuth).not.toHaveBeenCalled();
  });
});

describe('subscribe', () => {
  it('stops notifying after unsubscribe and survives a throwing subscriber', async () => {
    const t = setup();
    const seen: string[] = [];
    t.session.subscribe(() => {
      throw new Error('bad subscriber');
    });
    const off = t.session.subscribe((s) => seen.push(s.kind));
    await t.session.connect(ISSUER);
    off();
    await t.session.leave();
    expect(seen).toEqual(['connecting']);
  });
});

describe('localStorageMarker', () => {
  function memory() {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
  }

  it('round-trips closed values and clears with null', () => {
    const store = memory();
    const marker = localStorageMarker(store);
    expect(marker.get()).toBeNull();
    marker.set('leave-revocation-failed');
    expect(marker.get()).toBe('leave-revocation-failed');
    marker.set(null);
    expect(marker.get()).toBeNull();
    expect(store.data.size).toBe(0);
  });

  it('ignores any value outside the closed set', () => {
    const store = memory();
    store.data.set('artcraft.podSession.marker', 'https://evil.example');
    expect(localStorageMarker(store).get()).toBeNull();
  });

  it('survives storage that throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const marker = localStorageMarker(throwing);
    expect(marker.get()).toBeNull();
    expect(() => marker.set('connect')).not.toThrow();
    expect(() => marker.set(null)).not.toThrow();
  });
});
