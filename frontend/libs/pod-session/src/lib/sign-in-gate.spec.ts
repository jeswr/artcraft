import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PodSessionConfig } from './config.js';
import { type AuthOptions, createPodSession } from './pod-session.js';
import { refuseSignIn, SignInNotInProgressError } from './sign-in-gate.js';
import { fakeAuth, fakePodMode, memoryMarker, memoryPending } from './testing.js';

const ISSUER = 'https://login.example';
const WEBID = 'https://pod.example/alice/profile/card#me';
const CONFIG: PodSessionConfig = {
  clientId: 'https://artcraft.example/solid-client-id.jsonld',
  redirectUri: 'ai.artcraft.app:/oauth/callback',
  allowLoopbackHttp: false,
};

afterEach(() => vi.restoreAllMocks());

/** A session whose pod-auth stand-ins hand over the options the session built them with. */
function world(options: { restored?: string | null } = {}) {
  const built: { auth: ReturnType<typeof fakeAuth>; options: AuthOptions }[] = [];
  const session = createPodSession({
    config: CONFIG,
    createAuth: (authOptions = {}) => {
      const auth = fakeAuth(options.restored === undefined ? {} : { restored: options.restored });
      built.push({ auth, options: authOptions });
      return auth;
    },
    wipeStores: async () => 'wiped',
    podMode: fakePodMode({ podWindow: true, issuer: ISSUER, fresh: ISSUER }),
    marker: memoryMarker(),
    pending: memoryPending(options.restored ? null : { hint: { kind: 'issuer', issuer: ISSUER } }),
    selfTest: async () => ({ ok: true }),
  });
  return { session, built, last: () => built[built.length - 1]! };
}

/** The person's sign-in, started with the click and left waiting in pod-auth's login. */
async function startSignIn(w: ReturnType<typeof world>) {
  await w.session.start();
  const done = w.session.beginSignIn();
  await vi.waitFor(() => expect(w.last().auth.calls).toContain('login'));
  return { done, gate: w.last().options.authorizeSignIn!, auth: w.last().auth };
}

describe('the gate on opening the system browser', () => {
  it('is handed to every pod-auth the session builds', async () => {
    const w = world({ restored: WEBID });
    await w.session.start();
    expect(w.built.length).toBeGreaterThan(0);
    for (const { options } of w.built) expect(options.authorizeSignIn).toBeTypeOf('function');
  });

  it('refuses outside a sign-in, and ends the connected session as one to sign in to again', async () => {
    const w = world({ restored: WEBID });
    await w.session.start();
    expect(w.session.getState()).toEqual({ kind: 'connected', webId: WEBID });
    const { auth, options } = w.last();
    // A background read whose refresh failed: pod-auth asks for the browser.
    expect(() => options.authorizeSignIn!()).toThrow(SignInNotInProgressError);
    expect(w.session.getState()).toEqual({ kind: 'error', error: 'session-ended' });
    expect(w.session.getFetch()).toBeNull();
    expect(auth.calls).toContain('dispose');
    // Ending the session revokes nothing: the way back is the person's "Sign in again".
    expect(auth.calls).not.toContain('logout');
  });

  it('allows the browser inside the sign-in the person started', async () => {
    const w = world();
    const { gate, done, auth } = await startSignIn(w);
    expect(w.session.getState().kind).toBe('signing-in');
    expect(() => gate()).not.toThrow();
    expect(w.session.getState().kind).toBe('signing-in');
    auth.finish(WEBID);
    await done;
    expect(w.session.getState()).toEqual({ kind: 'connected', webId: WEBID });
  });

  it('allows one browser window per attempt: a second ask during the sign-in is refused and changes nothing', async () => {
    const w = world();
    const { gate, done, auth } = await startSignIn(w);
    gate(); // the sign-in's own ask
    const before = w.session.getState();
    expect(() => gate()).toThrow(SignInNotInProgressError); // a concurrent background 401
    expect(w.session.getState()).toEqual(before);
    auth.finish(WEBID);
    await done;
    expect(w.session.getState().kind).toBe('connected');
  });

  it('refuses after the sign-in was aborted', async () => {
    const w = world();
    const { gate, done } = await startSignIn(w);
    w.session.cancel();
    await done;
    expect(w.session.getState()).toEqual({ kind: 'disconnected' });
    expect(() => gate()).toThrow(SignInNotInProgressError);
    expect(w.session.getState()).toEqual({ kind: 'disconnected' });
  });

  it('refuses a gate that was never used once the sign-in is aborted, even before it settles', async () => {
    const w = world();
    const { gate, done } = await startSignIn(w);
    w.session.cancel();
    expect(() => gate()).toThrow(SignInNotInProgressError);
    await done;
  });

  it('refuses after the sign-in completed, using the auth that attempt left behind', async () => {
    const w = world();
    const { gate, done, auth } = await startSignIn(w);
    auth.finish(WEBID);
    await done;
    expect(w.session.getState()).toEqual({ kind: 'connected', webId: WEBID });
    expect(() => gate()).toThrow(SignInNotInProgressError);
    expect(w.session.getState()).toEqual({ kind: 'error', error: 'session-ended' });
    expect(w.session.getFetch()).toBeNull();
  });

  it('refuses after the sign-in failed', async () => {
    const w = world();
    const { gate, done, auth } = await startSignIn(w);
    auth.fail(Object.assign(new Error('boom'), { code: 'timed-out' }));
    await done;
    expect(w.session.getState().kind).toBe('error');
    expect(() => gate()).toThrow(SignInNotInProgressError);
  });

  it('puts no token material, URL or issuer in the error, the state or any log', async () => {
    const logged: unknown[][] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => void logged.push(args));
    }
    const w = world({ restored: WEBID });
    await w.session.start();
    let caught: unknown;
    try {
      w.last().options.authorizeSignIn!();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SignInNotInProgressError);
    const error = caught as SignInNotInProgressError;
    expect(error.code).toBe('sign-in-not-in-progress');
    const text = JSON.stringify([error.message, error.name, error.code, w.session.getState(), logged]);
    for (const word of ['http', 'token', 'code_verifier', 'dpop', 'access_token', 'refresh_token', 'login.example', 'pod.example']) {
      expect(text.toLowerCase()).not.toContain(word);
    }
    expect(logged).toEqual([]);
  });

  it('a refusal from a pod-auth released earlier does not end the session that replaced it', async () => {
    const built: { auth: ReturnType<typeof fakeAuth>; options: AuthOptions }[] = [];
    const session = createPodSession({
      config: CONFIG,
      createAuth: (authOptions = {}) => {
        // The first restore fails; "Try again" restores with a new pod-auth.
        const auth = fakeAuth(built.length === 0 ? { restoreError: new Error('offline') } : { restored: WEBID });
        built.push({ auth, options: authOptions });
        return auth;
      },
      wipeStores: async () => 'wiped',
      podMode: fakePodMode({ podWindow: true, issuer: ISSUER }),
      marker: memoryMarker(),
      pending: memoryPending(),
      selfTest: async () => ({ ok: true }),
    });
    await session.start();
    expect(session.getState()).toEqual({ kind: 'error', error: 'restore-failed' });
    await session.retry();
    expect(session.getState()).toEqual({ kind: 'connected', webId: WEBID });
    expect(() => built[0]!.options.authorizeSignIn!()).toThrow(SignInNotInProgressError);
    expect(session.getState()).toEqual({ kind: 'connected', webId: WEBID });
    // The current one still ends it.
    expect(() => built[1]!.options.authorizeSignIn!()).toThrow(SignInNotInProgressError);
    expect(session.getState()).toEqual({ kind: 'error', error: 'session-ended' });
  });

  it('refuses by default when no gate is supplied', () => {
    expect(() => refuseSignIn()).toThrow(SignInNotInProgressError);
  });
});
