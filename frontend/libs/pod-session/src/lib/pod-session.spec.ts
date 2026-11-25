import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PodSessionConfig } from './config.js';
import { createPodSession, localStorageMarker, type PodSessionDeps } from './pod-session.js';
import { StorageOriginRefused } from './storage-origins.js';
import type { PodSessionState } from './state.js';
import type { PendingSignIn } from './pending.js';
import { fakeAuth, fakePodMode, memoryMarker, memoryPending } from './testing.js';
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
  shell?: 'ok' | 'not-pod-window' | 'window-not-clean' | 'policy-not-applied';
  flagged?: boolean;
  fresh?: string | null;
  consumeFails?: boolean;
  answer?: 'requested' | 'declined' | 'throws';
  leaveFails?: boolean;
  auth?: ReturnType<typeof fakeAuth>;
  config?: PodSessionConfig;
  selfTest?: PodSessionDeps['selfTest'];
  wipe?: (call: number) => Promise<WipeOutcome> | WipeOutcome;
  createAuth?: () => ReturnType<typeof fakeAuth>;
  /** What the typed sign-in left in page storage; by default a typed issuer matching `fresh`. */
  pending?: PendingSignIn | null;
  listed?: string[];
  addAnswer?: Parameters<typeof fakePodMode>[0]['addAnswer'];
} = {}) {
  const podMode = fakePodMode({
    podWindow: options.podWindow ?? false,
    shell: options.shell ?? 'ok',
    flagged: options.flagged ?? false,
    issuer: options.issuer ?? null,
    fresh: options.fresh ?? null,
    consumeFails: options.consumeFails ?? false,
    answer: options.answer ?? 'requested',
    leaveFails: options.leaveFails ?? false,
    ...(options.listed || options.addAnswer ? { listed: options.listed ?? [], addAnswer: options.addAnswer ?? 'requested' } : {}),
  });
  const pending = memoryPending(options.pending !== undefined ? options.pending : options.fresh ? { hint: { kind: 'issuer', issuer: options.fresh } } : null);
  const marker = memoryMarker(options.marker ?? null);
  const auth = options.auth ?? fakeAuth();
  const order: string[] = [];
  const createAuth = vi.fn((_options?: { fetch?: typeof fetch }) => {
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
    pending,
    selfTest: options.selfTest ?? (async () => ({ ok: true })),
  });
  const states: PodSessionState[] = [];
  session.subscribe((s) => states.push(s));
  return { session, podMode, marker, pending, auth, createAuth, wipeStores, order, states };
}

describe('connect', () => {
  it('validates the issuer, asks the app, and leaves the sign-in to the rebuilt window', async () => {
    const t = setup();
    await t.session.connect(`  ${ISSUER}/ `);
    expect(t.podMode.entered).toEqual([ISSUER]);
    expect(t.marker.value).toBeNull(); // the approval lives in the app, not in page storage
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
  it('waits for a click after an approved connect, then wipes and signs in against the approved issuer', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, fresh: ISSUER });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'ready-to-sign-in', issuer: ISSUER });
    // Nothing leaves the window and nothing is built before the click.
    expect(t.createAuth).not.toHaveBeenCalled();
    expect(t.wipeStores).not.toHaveBeenCalled();
    expect(t.podMode.log).not.toContain('consume');
    const started = t.session.beginSignIn();
    await vi.waitFor(() => expect(t.auth.calls).toContain('login'));
    expect(t.order).toEqual(['wipe', 'createAuth']);
    expect(t.auth.loginHints).toEqual([{ issuer: ISSUER }]);
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

  it('does not call a restored session connected when it has no WebID', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, auth: fakeAuth({ restoredWithoutWebId: true }) });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'disconnected' });
    expect(t.auth.calls).toEqual(['restore', 'dispose']);
  });

  it('never builds pod-auth when the shell says this is not a pod window', async () => {
    const t = setup({ podWindow: true, shell: 'not-pod-window', issuer: ISSUER, fresh: ISSUER });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'window-not-clean' });
    expect(t.createAuth).not.toHaveBeenCalled();
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
    const t = setup({ podWindow: true, shell: 'window-not-clean', issuer: ISSUER, fresh: ISSUER });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'window-not-clean' });
    expect(t.createAuth).not.toHaveBeenCalled();
    expect(t.wipeStores).not.toHaveBeenCalled();
  });

  it('never builds pod-auth when no narrowing policy is confirmed, for a sign-in, a restore or a leave', async () => {
    const t = setup({ podWindow: true, shell: 'policy-not-applied', issuer: ISSUER, fresh: ISSUER });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'policy-not-applied' });
    expect(t.createAuth).not.toHaveBeenCalled();
    await t.session.leave();
    expect(t.createAuth).not.toHaveBeenCalled();
    expect(t.session.getState()).toEqual({ kind: 'signed-out-locally' });
    const restoring = setup({ podWindow: true, shell: 'policy-not-applied' });
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

  it('lets a record loaded from disk restore a session but never start a fresh sign-in', async () => {
    // No approval in this process (fresh is null): even a page-written marker changes nothing.
    const t = setup({ podWindow: true, issuer: ISSUER, marker: 'done', auth: fakeAuth({ restored: WEBID }) });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'connected', webId: WEBID });
    expect(t.wipeStores).not.toHaveBeenCalled();
    expect(t.auth.calls).not.toContain('login');
    await t.session.beginSignIn();
    expect(t.auth.calls).not.toContain('login');
    expect(t.podMode.log).not.toContain('consume');
  });

  it('ignores an approval for any issuer other than the recorded one', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, fresh: 'https://attacker.example' });
    await t.session.start();
    expect(t.session.getState().kind).not.toBe('ready-to-sign-in');
    expect(t.auth.calls).not.toContain('login');
  });

  it('refuses a click whose consumed approval is not the one shown, or is gone', async () => {
    const gone = setup({ podWindow: true, issuer: ISSUER, fresh: ISSUER, consumeFails: true });
    await gone.session.start();
    await gone.session.beginSignIn();
    expect(gone.session.getState()).toEqual({ kind: 'error', error: 'request-failed' });
    expect(gone.createAuth).not.toHaveBeenCalled();
    const other = setup({ podWindow: true, issuer: ISSUER, fresh: ISSUER });
    await other.session.start();
    other.podMode.consumeFresh = async () => 'https://other.example';
    await other.session.beginSignIn();
    expect(other.session.getState()).toEqual({ kind: 'error', error: 'request-failed' });
    expect(other.wipeStores).not.toHaveBeenCalled();
  });

  it('ignores a page-written connect word: only an approved dialog counts', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, marker: 'connect' as never, auth: fakeAuth() });
    await t.session.start();
    expect(t.auth.calls).not.toContain('login');
    expect(t.marker.value).toBeNull();
  });

  it('clears a stale marker in an ordinary window and does nothing else', async () => {
    const t = setup({ marker: 'leave' });
    await t.session.start();
    expect(t.marker.value).toBeNull();
    expect(t.session.getState()).toEqual({ kind: 'disconnected' });
    expect(t.createAuth).not.toHaveBeenCalled();
  });

  it('finishes a wipe left pending before pod-auth opens anything, then goes on', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, marker: 'wipe' });
    await t.session.start();
    expect(t.order.slice(0, 2)).toEqual(['wipe', 'createAuth']);
    expect(t.marker.value).toBeNull();
  });

  it('reports wipe-failed and builds nothing when a pending wipe still cannot finish', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, marker: 'wipe', wipe: () => 'deferred' });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'wipe-failed' });
    expect(t.createAuth).not.toHaveBeenCalled();
    expect(t.marker.value).toBe('wipe');
  });
});

describe('an ordinary window that may still hold pod credentials', () => {
  it('shows only the finish flow: deletes first, never opens pod-auth, then asks the shell to clear the flag', async () => {
    const t = setup({ flagged: true });
    await t.session.start();
    expect(t.session.finishing()).toBe(true);
    expect(t.order).toEqual(['wipe']);
    expect(t.createAuth).not.toHaveBeenCalled();
    expect(t.podMode.log).toEqual(['cleared']);
    expect(t.session.getState()).toEqual({ kind: 'disconnected', outcome: 'disconnected' });
  });

  it('does not clear the flag when the delete cannot finish, and says so', async () => {
    const t = setup({ flagged: true, wipe: () => 'deferred' });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'wipe-failed' });
    expect(t.podMode.log).not.toContain('cleared');
  });

  it('finishes a disconnect that the pod window handed over: wipes again, then clears the flag, and keeps the answer', async () => {
    // The pod window asked the shell to leave and left its answer; the shell keeps the flag set.
    const t = setup({ flagged: true, marker: 'done' });
    await t.session.start();
    expect(t.order).toEqual(['wipe']);
    expect(t.podMode.log).toEqual(['cleared']);
    expect(t.session.getState()).toEqual({ kind: 'disconnected', outcome: 'disconnected' });
    const failed = setup({ flagged: true, marker: 'done-revocation-failed' });
    await failed.session.start();
    expect(failed.podMode.log).toEqual(['cleared']);
    expect(failed.session.getState()).toEqual({ kind: 'signed-out-locally' });
  });

  it('an interrupted disconnect (the flag survived a restart) is finished before anything else runs', async () => {
    // No marker at all: the previous window was gone before it could write one.
    const t = setup({ flagged: true });
    await t.session.start();
    expect(t.order).toEqual(['wipe']);
    expect(t.createAuth).not.toHaveBeenCalled();
    expect(t.podMode.log).toEqual(['cleared']);
  });

  it('keeps asking to finish for as long as the wipe cannot be confirmed', async () => {
    const t = setup({ flagged: true, wipe: () => 'deferred' });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'wipe-failed' });
    expect(t.podMode.log).toEqual([]);
    expect(t.session.finishing()).toBe(true);
  });

  it('refuses to connect while credentials may exist', async () => {
    const t = setup({ flagged: true, wipe: () => 'deferred' });
    await t.session.connect(ISSUER);
    expect(t.podMode.entered).toEqual([]);
  });

  it('can be retried with Leave', async () => {
    let call = 0;
    const t = setup({ flagged: true, wipe: () => (call++ === 0 ? 'deferred' : 'wiped') });
    await t.session.start();
    await t.session.leave();
    expect(t.podMode.log).toContain('cleared');
  });
});

describe('sign-in failures', () => {
  async function connectThen(act: (t: ReturnType<typeof setup>) => void | Promise<void>, options: Parameters<typeof setup>[0] = {}) {
    const t = setup({ podWindow: true, issuer: ISSUER, fresh: ISSUER, ...options });
    await t.session.start();
    const started = t.session.beginSignIn();
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
      fresh: ISSUER,
      wipe: (call) => (call === 0 ? new Promise<WipeOutcome>((resolve) => (release = () => resolve('wiped'))) : 'wiped'),
    });
    await t.session.start();
    const started = t.session.beginSignIn();
    await vi.waitFor(() => expect(t.session.getState().kind).toBe('signing-in'));
    t.session.cancel();
    release();
    await started;
    expect(t.createAuth).not.toHaveBeenCalled();
    expect(t.session.getState()).toEqual({ kind: 'disconnected' });
  });

  it('does not begin when the starting wipe is only queued', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, fresh: ISSUER, wipe: () => 'deferred' });
    await t.session.start();
    await t.session.beginSignIn();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'wipe-failed' });
    expect(t.createAuth).not.toHaveBeenCalled();
  });

  it('remembers a delete that could not finish after a failed sign-in, so the next window does it first', async () => {
    const t = await connectThen((x) => x.auth.fail(Object.assign(new Error('x'), { code: 'timed-out' })), {
      wipe: (call) => (call === 0 ? 'wiped' : 'deferred'),
    });
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'sign-in-timed-out' });
    expect(t.marker.value).toBe('wipe');
  });

  it('remembers a failed revocation too when that delete could not finish', async () => {
    const t = await connectThen((x) => x.auth.fail(Object.assign(new Error('x'), { code: 'timed-out' })), {
      auth: fakeAuth({ logoutError: new Error('down') }),
      wipe: (call) => {
        if (call > 0) throw new Error('blocked');
        return 'wiped';
      },
    });
    expect(t.marker.value).toBe('leave-revocation-failed');
  });

  it('builds pod-auth inside the guarded section: a throwing factory is a closed error', async () => {
    const t = setup({
      podWindow: true,
      issuer: ISSUER,
      fresh: ISSUER,
      createAuth: () => {
        throw new Error('https://x/?code=SECRET');
      },
    });
    await t.session.start();
    await t.session.beginSignIn();
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
    expect(t.podMode.log).toEqual(['wipe', 'left']);
    expect(t.session.getState()).toEqual({ kind: 'disconnected', outcome: 'disconnected' });
    expect(t.session.getFetch()).toBeNull();
    expect(t.marker.value).toBeNull();
  });

  it('leaves the marker for the rebuilt window to show the answer', async () => {
    const t = await connected();
    let markerAtLeave: unknown = 'unset';
    const original = t.podMode.leave;
    t.podMode.leave = async () => {
      markerAtLeave = t.marker.value;
      return original();
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
    t.podMode.leave = async () => {
      markerAtLeave = t.marker.value;
      return original();
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
    expect(t.podMode.log).toEqual(['left']);
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
    // Kept until the delete is confirmed, so a quit in between does not lose it.
    expect(t.marker.value).toBe('leave');
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
    ['a window that failed the policy check', () => setup({ podWindow: true, shell: 'policy-not-applied' })],
  ])('works from %s: wipes locally and leaves', async (_name, make) => {
    const t = make();
    await t.session.start();
    await t.session.leave();
    expect(t.wipeStores).toHaveBeenCalled();
    expect(t.podMode.log).toContain('left');
  });

  it('works while a sign-in is running: aborts it, then wipes and leaves', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, fresh: ISSUER });
    await t.session.start();
    const started = t.session.beginSignIn();
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
    expect(() => marker.set('wipe')).not.toThrow();
    expect(() => marker.set(null)).not.toThrow();
  });
});

const OTHER = 'https://pod.example';
const PROFILE = 'https://pod.example/alice/profile/card#me';
const refusal = (reason: ConstructorParameters<typeof StorageOriginRefused>[0], origin = OTHER) =>
  Object.assign(new Error('pod-auth could not read it'), { name: 'InjectedFetchError', cause: new StorageOriginRefused(reason, origin) });

describe('a WebID or a provider address', () => {
  it('asks the app about the origin of a typed WebID and remembers only what was typed', async () => {
    const t = setup();
    await t.session.connect(` ${PROFILE} `);
    expect(t.podMode.entered).toEqual([OTHER]);
    expect(t.pending.value).toEqual({ hint: { kind: 'webid', webId: PROFILE } });
    expect(t.session.getState()).toEqual({ kind: 'connecting', issuer: OTHER });
    expect(t.createAuth).not.toHaveBeenCalled();
  });

  it.each(['https://pod.example/card?x=1', 'https://u:p@pod.example/card#me', 'http://pod.example/card#me', 'ftp://pod.example/card'])('refuses %j', async (input) => {
    const t = setup();
    await t.session.connect(input);
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'invalid-issuer' });
    expect(t.podMode.entered).toEqual([]);
    expect(t.pending.value).toBeNull();
  });

  it('forgets what was typed when the person declines or the app fails', async () => {
    for (const answer of ['declined', 'throws'] as const) {
      const t = setup({ answer });
      await t.session.connect(PROFILE);
      expect(t.pending.value).toBeNull();
    }
  });

  it('after the rebuild shows the WebID and signs in with it as the hint', async () => {
    const t = setup({ podWindow: true, issuer: OTHER, fresh: OTHER, pending: { hint: { kind: 'webid', webId: PROFILE } } });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'ready-to-sign-in', issuer: OTHER, webId: PROFILE });
    const started = t.session.beginSignIn();
    await vi.waitFor(() => expect(t.auth.calls).toContain('login'));
    expect(t.auth.loginHints).toEqual([{ webId: PROFILE }]);
    t.auth.finish('https://pod.example/alice/profile/card#me');
    await started;
    expect(t.session.getState().kind).toBe('connected');
    expect(t.pending.value).toBeNull();
  });

  it('hands pod-auth the gate in explain-first mode and nothing else changes for it', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, fresh: ISSUER, listed: [ISSUER] });
    await t.session.start();
    const started = t.session.beginSignIn();
    await vi.waitFor(() => expect(t.auth.calls).toContain('login'));
    const options = t.createAuth.mock.calls[0]?.[0];
    expect(typeof options?.fetch).toBe('function');
    // An unlisted origin is refused at once, without opening the dialog.
    await expect(options!.fetch!(`${OTHER}/profile`)).rejects.toMatchObject({ reason: 'needs-approval', origin: OTHER });
    expect(t.podMode.requested).toEqual([]);
    t.auth.finish(WEBID);
    await started;
  });

  it('passes no fetch where there is no gate', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, fresh: ISSUER });
    await t.session.start();
    const started = t.session.beginSignIn();
    await vi.waitFor(() => expect(t.auth.calls).toContain('login'));
    expect(t.createAuth.mock.calls[0]?.[0]).toBeUndefined();
    t.auth.finish(WEBID);
    await started;
  });

  it('ignores a pending hint that names another origin, or a record that was not approved now', async () => {
    const other = setup({ podWindow: true, issuer: ISSUER, fresh: ISSUER, pending: { hint: { kind: 'webid', webId: PROFILE } }, auth: fakeAuth({ restored: WEBID }) });
    await other.session.start();
    expect(other.session.getState()).toEqual({ kind: 'connected', webId: WEBID });
    expect(other.pending.value).toBeNull();
    const stale = setup({ podWindow: true, issuer: ISSUER, pending: { hint: { kind: 'issuer', issuer: ISSUER } }, auth: fakeAuth({ restored: WEBID }) });
    await stale.session.start();
    expect(stale.session.getState().kind).toBe('connected');
    expect(stale.pending.value).toBeNull();
  });

  it('clears the pending hint on cancel from ready-to-sign-in and on leave', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, fresh: ISSUER });
    await t.session.start();
    t.session.cancel();
    expect(t.pending.value).toBeNull();
    expect(t.session.getState()).toEqual({ kind: 'disconnected' });
    const u = setup({ podWindow: true, issuer: ISSUER, fresh: ISSUER });
    await u.session.start();
    await u.session.leave();
    expect(u.pending.value).toBeNull();
  });
});

describe('an origin that needs approval', () => {
  async function waiting(options: Parameters<typeof setup>[0] = {}) {
    const t = setup({ podWindow: true, issuer: OTHER, fresh: OTHER, listed: [OTHER], pending: { hint: { kind: 'webid', webId: PROFILE } }, ...options });
    await t.session.start();
    const started = t.session.beginSignIn();
    await vi.waitFor(() => expect(t.auth.calls).toContain('login'));
    t.auth.fail(refusal('needs-approval', 'https://id.example'));
    await started;
    return t;
  }

  it('explains first during a sign-in, scrubs, and keeps only the hint and the origin', async () => {
    const t = await waiting();
    expect(t.session.getState()).toEqual({ kind: 'needs-approval', origin: 'https://id.example', phase: 'sign-in' });
    expect(t.pending.value).toEqual({ hint: { kind: 'webid', webId: PROFILE }, origin: 'https://id.example' });
    expect(t.podMode.requested).toEqual([]);
    expect(t.auth.calls).toContain('logout');
    expect(t.session.getFetch()).toBeNull();
  });

  it('asks the app when the person allows, and leaves the sign-in to the rebuilt window', async () => {
    const t = await waiting();
    await t.session.approveOrigin();
    expect(t.podMode.requested).toEqual(['https://id.example']);
    // The app rebuilds the window; a surviving one stays in a closed failure rather than guessing.
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'request-failed' });
  });

  it('the rebuilt window offers to continue, with the approved origin, and signs in again', async () => {
    const t = setup({
      podWindow: true,
      issuer: 'https://id.example',
      fresh: 'https://id.example',
      pending: { hint: { kind: 'webid', webId: 'https://id.example/alice#me' }, origin: 'https://id.example' },
    });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'ready-to-sign-in', issuer: 'https://id.example', webId: 'https://id.example/alice#me', approved: 'https://id.example' });
    const started = t.session.beginSignIn();
    await vi.waitFor(() => expect(t.auth.calls).toContain('login'));
    expect(t.auth.loginHints).toEqual([{ webId: 'https://id.example/alice#me' }]);
    t.auth.finish('https://id.example/alice#me');
    await started;
    expect(t.session.getState().kind).toBe('connected');
  });

  it.each([
    ['declined', 'origin-declined'],
    ['too-fast', 'approval-too-fast'],
  ] as const)('a %s answer ends in %s', async (answer, error) => {
    const t = await waiting({ addAnswer: answer });
    await t.session.approveOrigin();
    expect(t.session.getState()).toEqual({ kind: 'error', error });
    expect(t.pending.value).toEqual(answer === 'declined' ? null : expect.anything());
  });

  it.each([
    ['refused_origin', 'origin-declined'],
    ['too_many_prompts', 'origin-limit'],
    ['too_many_origins', 'origin-limit'],
    ['busy', 'request-failed'],
  ] as const)('an app error %s ends in %s', async (word, error) => {
    const t = await waiting({ addAnswer: new Error(word) });
    await t.session.approveOrigin();
    expect(t.session.getState()).toEqual({ kind: 'error', error });
    expect(t.pending.value).toBeNull();
  });

  it('approveOrigin does nothing outside needs-approval', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, listed: [ISSUER], auth: fakeAuth({ restored: WEBID }) });
    await t.session.start();
    await t.session.approveOrigin();
    expect(t.podMode.requested).toEqual([]);
    expect(t.session.getState().kind).toBe('connected');
  });

  it('a restore that needs an origin keeps the stored session: no wipe, no logout, no revocation', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, listed: [ISSUER], auth: fakeAuth({ restoreError: refusal('needs-approval', OTHER) }) });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'needs-approval', origin: OTHER, phase: 'restore' });
    expect(t.wipeStores).not.toHaveBeenCalled();
    expect(t.auth.calls).not.toContain('logout');
    expect(t.pending.value).toBeNull();
  });

  it('allowing a restore origin asks the app, and a window that survives restores again', async () => {
    const auth = fakeAuth({ restoreError: refusal('needs-approval', OTHER) });
    const t = setup({ podWindow: true, issuer: ISSUER, listed: [ISSUER], auth });
    await t.session.start();
    await t.session.approveOrigin();
    expect(t.podMode.requested).toEqual([OTHER]);
    expect(auth.calls.filter((c) => c === 'restore')).toHaveLength(2);
    expect(t.wipeStores).not.toHaveBeenCalled();
  });

  it.each([
    ['declined', 'origin-declined'],
    ['limit', 'origin-limit'],
    ['unavailable', 'restore-failed'],
  ] as const)('a restore refused as %s is %s and wipes nothing', async (reason, error) => {
    const t = setup({ podWindow: true, issuer: ISSUER, listed: [ISSUER], auth: fakeAuth({ restoreError: refusal(reason) }) });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'error', error });
    expect(t.wipeStores).not.toHaveBeenCalled();
  });

  it('a declined restore origin can be retried, or the person can leave', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, listed: [ISSUER], auth: fakeAuth({ restoreError: refusal('declined') }) });
    await t.session.start();
    await t.session.retry();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'origin-declined' });
    expect(t.auth.calls.filter((c) => c === 'restore')).toHaveLength(2);
    await t.session.leave();
    expect(t.podMode.log).toContain('left');
  });

  it('retry only applies to errors that left the stored session alone', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, shell: 'window-not-clean' });
    await t.session.start();
    await t.session.retry();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'window-not-clean' });
  });

  it('a refusal during sign-in that is final is reported as such and forgets the hint', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, fresh: ISSUER });
    await t.session.start();
    const started = t.session.beginSignIn();
    await vi.waitFor(() => expect(t.auth.calls).toContain('login'));
    t.auth.fail(refusal('declined'));
    await started;
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'origin-declined' });
    expect(t.pending.value).toBeNull();
  });
});

describe('a response pod-auth cannot accept', () => {
  const invalid = () => Object.assign(new Error('invalid injected response'), { name: 'InvalidInjectedResponseError' });

  it('is a plain failure during sign-in, however it is wrapped', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, fresh: ISSUER });
    await t.session.start();
    const started = t.session.beginSignIn();
    await vi.waitFor(() => expect(t.auth.calls).toContain('login'));
    t.auth.fail(Object.assign(new Error('wrapped'), { cause: invalid() }));
    await started;
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'invalid-response' });
    expect(t.pending.value).toBeNull();
    expect(t.auth.calls).toContain('logout');
  });

  it('is a plain failure on restore and wipes nothing', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, auth: fakeAuth({ restoreError: invalid() }) });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'invalid-response' });
    expect(t.wipeStores).not.toHaveBeenCalled();
  });
});
