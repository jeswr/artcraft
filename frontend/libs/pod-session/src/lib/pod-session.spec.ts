import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PodSessionConfig } from './config.js';
import { createPodSession, localStorageMarker, type PodSessionDeps } from './pod-session.js';
import { StorageOriginRefused } from './storage-origins.js';
import type { PodSessionState } from './state.js';
import type { PendingSignIn, SignInHint } from './pending.js';
import { fakeAuth, fakePodMode, memoryHint, memoryMarker, memoryPending } from './testing.js';
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
  answer?: 'requested' | 'declined' | 'too-fast' | 'throws';
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
  /** What the last successful sign-in typed. */
  signedIn?: SignInHint | null;
  againAnswer?: NonNullable<Parameters<typeof fakePodMode>[0]>['againAnswer'];
  againAvailable?: boolean;
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
    againAnswer: options.againAnswer ?? 'requested',
    againAvailable: options.againAvailable ?? true,
    ...(options.listed || options.addAnswer ? { listed: options.listed ?? [], addAnswer: options.addAnswer ?? 'requested' } : {}),
  });
  const pending = memoryPending(options.pending !== undefined ? options.pending : options.fresh ? { hint: { kind: 'issuer', issuer: options.fresh } } : null);
  const marker = memoryMarker(options.marker ?? null);
  const signedIn = memoryHint(options.signedIn ?? null);
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
    signedIn,
    selfTest: options.selfTest ?? (async () => ({ ok: true })),
  });
  const states: PodSessionState[] = [];
  session.subscribe((s) => states.push(s));
  return { session, podMode, marker, pending, signedIn, auth, createAuth, wipeStores, order, states };
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

  it('passes no fetch where there is no gate (only the hold on the browser)', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, fresh: ISSUER });
    await t.session.start();
    const started = t.session.beginSignIn();
    await vi.waitFor(() => expect(t.auth.calls).toContain('login'));
    expect(t.createAuth.mock.calls[0]?.[0]?.fetch).toBeUndefined();
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
    // The profile is on pod.example; the address pod-auth needs next is a different one, so the
    // dialog is for a sign-in provider the profile named.
    expect(t.session.getState()).toEqual({ kind: 'needs-approval', origin: 'https://id.example', phase: 'sign-in', purpose: 'sign-in', webId: PROFILE });
    expect(t.pending.value).toEqual({ hint: { kind: 'webid', webId: PROFILE }, origin: 'https://id.example', purpose: 'sign-in' });
    expect(t.podMode.requested).toEqual([]);
    expect(t.auth.calls).toContain('logout');
    expect(t.session.getFetch()).toBeNull();
  });

  it('asks the app when the person allows, and leaves the sign-in to the rebuilt window', async () => {
    const t = await waiting();
    await t.session.approveOrigin();
    expect(t.podMode.requested).toEqual(['https://id.example']);
    expect(t.podMode.purposes).toEqual(['sign-in']);
    // The app rebuilds the window; a surviving one stays in a closed failure rather than guessing.
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'request-failed' });
  });

  it('the rebuilt window shows the recorded origin and the allowed one apart, and signs in with what was typed', async () => {
    const t = setup({
      podWindow: true,
      issuer: OTHER, // the profile's own origin: what pod mode was entered for
      fresh: 'https://id.example', // the provider the profile named, which the person then allowed
      listed: [OTHER, 'https://id.example'],
      pending: { hint: { kind: 'webid', webId: PROFILE }, origin: 'https://id.example', purpose: 'sign-in' },
    });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'ready-to-sign-in', issuer: OTHER, webId: PROFILE, approved: 'https://id.example', purpose: 'sign-in' });
    const started = t.session.beginSignIn();
    await vi.waitFor(() => expect(t.auth.calls).toContain('login'));
    expect(t.auth.loginHints).toEqual([{ webId: PROFILE }]);
    expect(t.session.getState()).toEqual({ kind: 'signing-in', issuer: OTHER });
    t.auth.finish(PROFILE);
    await started;
    expect(t.session.getState().kind).toBe('connected');
  });

  it('a grant for an origin the window does not list, or that is not the pending one, starts nothing', async () => {
    const unlisted = setup({
      podWindow: true,
      issuer: OTHER,
      fresh: 'https://id.example',
      listed: [OTHER],
      pending: { hint: { kind: 'webid', webId: PROFILE }, origin: 'https://id.example', purpose: 'sign-in' },
      auth: fakeAuth({ restored: WEBID }),
    });
    await unlisted.session.start();
    expect(unlisted.session.getState().kind).toBe('connected');
    expect(unlisted.pending.value).toBeNull();
    const wrong = setup({
      podWindow: true,
      issuer: OTHER,
      fresh: OTHER,
      listed: [OTHER, 'https://id.example'],
      pending: { hint: { kind: 'webid', webId: PROFILE }, origin: 'https://id.example', purpose: 'sign-in' },
      auth: fakeAuth({ restored: WEBID }),
    });
    await wrong.session.start();
    expect(wrong.session.getState().kind).toBe('connected');
  });

  it('signs in with the hint it showed, not what page storage says at the click', async () => {
    const t = setup({ podWindow: true, issuer: OTHER, fresh: OTHER, listed: [OTHER], pending: { hint: { kind: 'webid', webId: PROFILE } } });
    await t.session.start();
    t.pending.value = { hint: { kind: 'issuer', issuer: 'https://login-example.net' } };
    const started = t.session.beginSignIn();
    await vi.waitFor(() => expect(t.auth.calls).toContain('login'));
    expect(t.auth.loginHints).toEqual([{ webId: PROFILE }]);
    t.auth.finish(PROFILE);
    await started;
  });

  it('a declined answer ends in origin-declined and forgets what was typed', async () => {
    const t = await waiting({ addAnswer: 'declined' });
    await t.session.approveOrigin();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'origin-declined' });
    expect(t.pending.value).toBeNull();
  });

  it.each([
    ['too-fast', 'too-fast'],
    ['busy', 'busy'],
    ['cooling_down', 'busy'],
  ] as const)('%s changes nothing: Allow is offered again with the same address and the hint is kept', async (word, wait) => {
    const t = await waiting({ addAnswer: word === 'too-fast' ? 'too-fast' : new Error(word) });
    const before = t.pending.value;
    await t.session.approveOrigin();
    expect(t.session.getState()).toEqual({ kind: 'needs-approval', origin: 'https://id.example', phase: 'sign-in', purpose: 'sign-in', webId: PROFILE, wait });
    expect(t.pending.value).toEqual(before);
    // The next press goes through once the app is ready.
    t.podMode.addAnswer = 'requested';
    await t.session.approveOrigin();
    expect(t.podMode.requested).toEqual(['https://id.example', 'https://id.example']);
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'request-failed' }); // the surviving window; a rebuilt one resumes
  });

  it('a restore that needs an origin can also be retried after a too-fast answer', async () => {
    const auth = fakeAuth({ restoreError: refusal('needs-approval', OTHER) });
    const t = setup({ podWindow: true, issuer: ISSUER, listed: [ISSUER], addAnswer: 'too-fast', auth });
    await t.session.start();
    await t.session.approveOrigin();
    expect(t.session.getState()).toEqual({ kind: 'needs-approval', origin: OTHER, phase: 'restore', purpose: 'storage', wait: 'too-fast' });
    expect(t.wipeStores).not.toHaveBeenCalled();
  });

  it.each([
    ['refused_origin', 'origin-declined'],
    ['too_many_prompts', 'origin-limit'],
    ['too_many_origins', 'origin-limit'],
    ['unexpected_word', 'request-failed'],
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
    expect(t.session.getState()).toEqual({ kind: 'needs-approval', origin: OTHER, phase: 'restore', purpose: 'storage' });
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

describe('the purpose the page names', () => {
  async function refused(origin: string, hint: PendingSignIn['hint'], recorded = OTHER) {
    const t = setup({ podWindow: true, issuer: recorded, fresh: recorded, listed: [recorded], pending: { hint } });
    await t.session.start();
    const started = t.session.beginSignIn();
    await vi.waitFor(() => expect(t.auth.calls).toContain('login'));
    t.auth.fail(refusal('needs-approval', origin));
    await started;
    return t.session.getState();
  }

  it('is app-identity for the host of the Client Identifier Document, whatever was typed', async () => {
    const host = new URL(CONFIG.clientId).origin;
    expect(await refused(host, { kind: 'webid', webId: PROFILE })).toMatchObject({ purpose: 'app-identity' });
    expect(await refused(host, { kind: 'issuer', issuer: ISSUER }, ISSUER)).toMatchObject({ purpose: 'app-identity' });
  });

  it('is sign-in for another address while a WebID is signed in with, profile for another address while a provider is', async () => {
    expect(await refused('https://id.example', { kind: 'webid', webId: PROFILE })).toMatchObject({ purpose: 'sign-in' });
    expect(await refused(OTHER, { kind: 'issuer', issuer: ISSUER }, ISSUER)).toMatchObject({ purpose: 'profile' });
  });
});

describe('the click that opens the browser', () => {
  async function atTheBrowser(url: string) {
    const t = setup({ podWindow: true, issuer: OTHER, fresh: OTHER, listed: [OTHER], pending: { hint: { kind: 'webid', webId: PROFILE } } });
    await t.session.start();
    const started = t.session.beginSignIn();
    await vi.waitFor(() => expect(t.auth.calls).toContain('login'));
    const options = t.createAuth.mock.calls[0]![0]!;
    let opened = false;
    const gate = options.confirmOpen!(url).then(() => void (opened = true));
    return { t, started, gate, opened: () => opened };
  }

  it('shows the provider the address is at, apart from the profile, and opens nothing until the click', async () => {
    const { t, started, gate, opened } = await atTheBrowser('https://login-example.net/authorize?client_id=x&state=secret');
    expect(t.session.getState()).toEqual({ kind: 'confirm-provider', provider: 'https://login-example.net', webId: PROFILE });
    expect(JSON.stringify(t.session.getState())).not.toContain('secret');
    await Promise.resolve();
    expect(opened()).toBe(false);
    t.session.openBrowser();
    await gate;
    expect(opened()).toBe(true);
    expect(t.session.getState()).toEqual({ kind: 'signing-in', issuer: OTHER, provider: 'https://login-example.net' });
    t.auth.finish(PROFILE);
    await started;
    expect(t.session.getState().kind).toBe('connected');
  });

  it('cancel before the click stops the sign-in without opening anything', async () => {
    const { t, started, gate, opened } = await atTheBrowser('https://login.example/authorize');
    t.session.cancel();
    await expect(gate).rejects.toBeDefined();
    t.auth.fail(new Error('aborted'));
    await started;
    expect(opened()).toBe(false);
    expect(t.session.getState()).toEqual({ kind: 'disconnected' });
    expect(t.pending.value).toBeNull();
  });

  it.each(['not a url', 'http://login.example/authorize', 'https://foo.local/x', 'https://login.example:0/x'])('refuses to open %j: no origin the app would allow', async (url) => {
    const { t, started, gate } = await atTheBrowser(url);
    await expect(gate).rejects.toBeDefined();
    expect(t.session.getState().kind).not.toBe('confirm-provider');
    t.auth.fail(new Error('refused'));
    await started;
  });

  it('openBrowser does nothing outside confirm-provider', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, fresh: ISSUER });
    await t.session.start();
    t.session.openBrowser();
    expect(t.session.getState().kind).toBe('ready-to-sign-in');
  });
});

describe('a typed address the app answers too fast', () => {
  it('is a too-fast error, not a decline, and forgets what was typed', async () => {
    const t = setup({ answer: 'too-fast' });
    await t.session.connect(PROFILE);
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'approval-too-fast' });
    expect(t.pending.value).toBeNull();
  });
});

describe('signing in again in a pod window', () => {
  /** A pod window whose restored session the gate has just ended (a background read's refresh failed). */
  async function ended(options: Parameters<typeof setup>[0] = {}) {
    const t = setup({ podWindow: true, issuer: ISSUER, auth: fakeAuth({ restored: WEBID }), ...options });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'connected', webId: WEBID });
    const options_ = t.createAuth.mock.calls.at(-1)![0] as { authorizeSignIn?: () => void };
    expect(() => options_.authorizeSignIn!()).toThrow();
    return t;
  }

  it('is offered once the gate has ended the session, and asks the app only on the click', async () => {
    const t = await ended();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'session-ended' });
    expect(t.session.canSignInAgain()).toBe(true);
    expect(t.podMode.log).not.toContain('sign-in-again');
    await t.session.signInAgain();
    expect(t.podMode.log).toContain('sign-in-again');
    // The rebuilt window offers "Continue sign-in" from this hint, for the recorded issuer only.
    expect(t.pending.value).toEqual({ hint: { kind: 'issuer', issuer: ISSUER } });
    expect(t.session.getState()).toEqual({ kind: 'connecting', issuer: ISSUER });
    // Nothing is built, wiped or opened by the request itself.
    expect(t.auth.calls).not.toContain('login');
    expect(t.wipeStores).not.toHaveBeenCalled();
  });

  it('is offered in the last state a subscriber is told about when the start settles, without a later change', async () => {
    for (const auth of [fakeAuth(), fakeAuth({ restoreError: new Error('boom') })]) {
      const t = setup({ podWindow: true, issuer: ISSUER, auth });
      // What a view rendering on each notification would read, as the app's views do.
      const seen: boolean[] = [];
      t.session.subscribe(() => seen.push(t.session.canSignInAgain()));
      await t.session.start();
      expect(seen.at(-1)).toBe(true);
    }
  });

  it('is offered in a pod window with nothing to restore, and Try again leads back to it', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, auth: fakeAuth({ restoreError: new Error('boom') }) });
    await t.session.start();
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'restore-failed' });
    expect(t.session.canSignInAgain()).toBe(true);
    const nothing = setup({ podWindow: true, issuer: ISSUER });
    await nothing.session.start();
    expect(nothing.session.getState()).toEqual({ kind: 'disconnected' });
    expect(nothing.session.canSignInAgain()).toBe(true);
  });

  it('the allowed request leads, in the rebuilt window, to a sign-in that waits for the click', async () => {
    const t = await ended();
    await t.session.signInAgain();
    // The rebuilt window: the shell's one-shot grant for the recorded issuer, the same page storage.
    const podMode = fakePodMode({ podWindow: true, issuer: ISSUER, fresh: ISSUER });
    const auth = fakeAuth();
    const next = createPodSession({ config: CONFIG, createAuth: () => auth, wipeStores: async () => 'wiped', podMode, marker: memoryMarker(), pending: t.pending, signedIn: t.signedIn, selfTest: async () => ({ ok: true }) });
    await next.start();
    expect(next.getState()).toEqual({ kind: 'ready-to-sign-in', issuer: ISSUER });
    expect(auth.calls).toEqual([]);
    const done = next.beginSignIn();
    await vi.waitFor(() => expect(auth.calls).toContain('login'));
    expect(auth.loginHints).toEqual([{ issuer: ISSUER }]);
    auth.finish(WEBID);
    await done;
    expect(next.getState()).toEqual({ kind: 'connected', webId: WEBID });
  });

  it('asks pod-auth the way the person signed in last time when that was for this address', async () => {
    const t = await ended({ issuer: 'https://pod.example', signedIn: { kind: 'webid', webId: WEBID } });
    await t.session.signInAgain();
    expect(t.pending.value).toEqual({ hint: { kind: 'webid', webId: WEBID } });
    // A remembered hint for another address is not used: the grant can only be for the recorded issuer.
    const other = await ended({ signedIn: { kind: 'webid', webId: WEBID } });
    await other.session.signInAgain();
    expect(other.pending.value).toEqual({ hint: { kind: 'issuer', issuer: ISSUER } });
  });

  it.each([
    ['declined', { kind: 'disconnected', outcome: 'declined' }],
    ['too-fast', { kind: 'error', error: 'approval-too-fast' }],
    ['busy', { kind: 'error', error: 'sign-in-again-wait' }],
    ['cooling_down', { kind: 'error', error: 'sign-in-again-wait' }],
    ['too_many_prompts', { kind: 'error', error: 'sign-in-again-limit' }],
  ] as const)('an app answer of %s leaves no hint behind and says so', async (againAnswer, expected) => {
    const t = await ended({ againAnswer });
    await t.session.signInAgain();
    expect(t.session.getState()).toEqual(expected);
    expect(t.pending.value).toBeNull();
    expect(t.session.canSignInAgain()).toBe(againAnswer !== 'too_many_prompts');
  });

  it('is not offered without a shell, without a recorded issuer, outside pod mode, while connected or after a refused address', async () => {
    const noShell = await ended({ againAvailable: false });
    expect(noShell.session.canSignInAgain()).toBe(false);
    await noShell.session.signInAgain();
    expect(noShell.session.getState()).toEqual({ kind: 'error', error: 'session-ended' });
    const noIssuer = setup({ podWindow: true, issuer: null });
    await noIssuer.session.start();
    expect(noIssuer.session.canSignInAgain()).toBe(false);
    const ordinary = setup();
    await ordinary.session.start();
    expect(ordinary.session.canSignInAgain()).toBe(false);
    const connected = setup({ podWindow: true, issuer: ISSUER, auth: fakeAuth({ restored: WEBID }) });
    await connected.session.start();
    expect(connected.session.canSignInAgain()).toBe(false);
    await connected.session.signInAgain();
    expect(connected.podMode.log).not.toContain('sign-in-again');
    const refused = setup({ podWindow: true, issuer: ISSUER, listed: [ISSUER], auth: fakeAuth({ restoreError: refusal('declined') }) });
    await refused.session.start();
    expect(refused.session.getState()).toEqual({ kind: 'error', error: 'origin-declined' });
    expect(refused.session.canSignInAgain()).toBe(false);
  });

  it('is not offered before the window has finished starting', () => {
    const t = setup({ podWindow: true, issuer: ISSUER });
    expect(t.session.getState()).toEqual({ kind: 'disconnected' });
    expect(t.session.canSignInAgain()).toBe(false);
  });

  it('remembers what the person typed for a successful sign-in, and forgets it on leaving', async () => {
    const t = setup({ podWindow: true, issuer: ISSUER, fresh: ISSUER });
    await t.session.start();
    const done = t.session.beginSignIn();
    await vi.waitFor(() => expect(t.auth.calls).toContain('login'));
    t.auth.finish(WEBID);
    await done;
    expect(t.signedIn.value).toEqual({ kind: 'issuer', issuer: ISSUER });
    await t.session.leave();
    expect(t.signedIn.value).toBeNull();
  });
});
