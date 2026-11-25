// @vitest-environment node
import 'fake-indexeddb/auto';
import { createMockOp } from '@jeswr/pod-auth/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultAuth } from './default-auth.js';
import { createPodSession } from './pod-session.js';
import { deletePodAuthDatabases, podAuthDatabaseNames } from './wipe.js';
import { fakePodMode, memoryMarker, memoryPending } from './testing.js';
import type { PodSessionConfig } from './config.js';

const config: PodSessionConfig = {
  clientId: 'https://artcraft.example/solid-client-id.jsonld',
  redirectUri: 'ai.artcraft.app:/oauth/callback',
  allowLoopbackHttp: false,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * Real pod-auth and desktop-auth against pod-auth's in-memory identity provider. The shell is
 * a fake with the shape of the Tauri plugins: `openUrl` receives the authorization URL, and the
 * "operating system" later delivers the provider's callback to the deep-link listener.
 */
function world(cfg: PodSessionConfig = config) {
  const op = createMockOp({ requireInteraction: true, refreshTokens: true });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === cfg.clientId) {
      const document = await (await op.fetch(op.clientId)).json();
      return Response.json({ ...document, client_id: cfg.clientId, application_type: 'native', redirect_uris: [cfg.redirectUri] });
    }
    return op.fetch(request);
  });
  let listener: ((urls: string[]) => void) | null = null;
  const callbacks: string[] = [];
  const opened: string[] = [];
  const host = {
    async onOpenUrl(handler: (urls: string[]) => void) {
      listener = handler;
      return () => {
        listener = null;
      };
    },
    async openUrl(url: string) {
      opened.push(url);
      const callback = await op.getCode(new URL(url), new AbortController().signal);
      callbacks.push(callback);
      queueMicrotask(() => listener?.([callback]));
    },
  };
  return { op, host, callbacks, opened };
}

/** The click that starts a sign-in, then the click that opens the browser at the provider. */
async function signInThroughTheBrowserClick(session: ReturnType<typeof createPodSession>, provider?: string): Promise<void> {
  const started = session.beginSignIn();
  await vi.waitFor(() => expect(session.getState().kind).toBe('confirm-provider'));
  if (provider) expect(session.getState()).toMatchObject({ provider });
  session.openBrowser();
  await started;
}

describe('sign-in through pod-auth and desktop-auth', () => {
  it('connects, gives a credentialed fetch, and never logs the callback', async () => {
    const { op, host, callbacks, opened } = world();
    const logged: unknown[][] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => void logged.push(args));
    }
    const podMode = fakePodMode({ podWindow: true, issuer: new URL(op.issuer).origin, fresh: new URL(op.issuer).origin });
    const session = createPodSession({
      config,
      createAuth: (options) => createDefaultAuth(config, host, options),
      wipeStores: async () => 'wiped',
      podMode,
      marker: memoryMarker(),
      pending: memoryPending({ hint: { kind: 'issuer', issuer: op.issuer } }),
      selfTest: async () => ({ ok: true }),
    });

    await session.start();
    const started = session.beginSignIn();
    await vi.waitFor(() => expect(session.getState().kind).toBe('confirm-provider'));
    // Nothing has opened yet: the person sees the provider the address names, then clicks.
    expect(opened).toEqual([]);
    expect(session.getState()).toMatchObject({ provider: new URL(op.issuer).origin });
    session.openBrowser();
    await started;

    expect(session.getState()).toEqual({ kind: 'connected', webId: op.webId });
    const podFetch = session.getFetch();
    expect(podFetch).not.toBeNull();
    expect(await (await podFetch!(`${op.root}private`)).text()).toBe('protected Solid');

    // The shell saw the authorization URL and the callback, and no credential material.
    expect(opened).toHaveLength(1);
    expect(new URL(opened[0]!).searchParams.has('code_verifier')).toBe(false);
    const secrets = callbacks.flatMap((c) => [c, new URL(c).searchParams.get('code') ?? '', new URL(c).searchParams.get('state') ?? '']);
    const text = JSON.stringify(logged);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(JSON.stringify(session.getState())).not.toContain(callbacks[0]!);
  });

  it('ends in a closed error kind when the callback comes from the wrong issuer', async () => {
    const { op } = world();
    let listener: ((urls: string[]) => void) | null = null;
    const forging = {
      async onOpenUrl(handler: (urls: string[]) => void) {
        listener = handler;
        return () => undefined;
      },
      async openUrl(url: string) {
        const callback = new URL(await op.getCode(new URL(url), new AbortController().signal));
        callback.searchParams.set('iss', 'https://attacker.example/');
        queueMicrotask(() => listener?.([callback.href]));
      },
    };
    const session = createPodSession({
      config,
      createAuth: (options) => createDefaultAuth(config, forging, options),
      wipeStores: async () => 'wiped',
      podMode: fakePodMode({ podWindow: true, issuer: new URL(op.issuer).origin, fresh: new URL(op.issuer).origin }),
      marker: memoryMarker(),
      pending: memoryPending({ hint: { kind: 'issuer', issuer: op.issuer } }),
      selfTest: async () => ({ ok: true }),
    });
    await session.start();
    await signInThroughTheBrowserClick(session);
    expect(session.getState()).toEqual({ kind: 'error', error: 'sign-in-failed' });
    expect(session.getFetch()).toBeNull();
    expect(op.stats.tokens).toBe(0);
  });
});

describe('an origin the window has not approved, through real pod-auth', () => {
  function gated(op: ReturnType<typeof createMockOp>, host: ReturnType<typeof world>['host'], hint: { kind: 'issuer'; issuer: string } | { kind: 'webid'; webId: string }, answer: 'requested' | 'declined', listed: string[] = []) {
    const requested: string[] = [];
    const origin = new URL(hint.kind === 'webid' ? hint.webId : hint.issuer).origin;
    const podMode = {
      ...fakePodMode({ podWindow: true, issuer: origin, fresh: origin }),
      // Only what the window lists is readable; every other origin needs approval first.
      admission: {
        known: () => listed,
        async request(origin: string) {
          requested.push(origin);
          return answer;
        },
      },
    };
    const pending = memoryPending({ hint });
    const session = createPodSession({
      config,
      createAuth: (options) => createDefaultAuth(config, host, options),
      wipeStores: async () => 'wiped',
      podMode,
      marker: memoryMarker(),
      pending,
      selfTest: async () => ({ ok: true }),
    });
    return { session, pending, requested, podMode };
  }

  it('explains first when pod-auth reads a WebID profile from an origin that is not listed, and sends nothing to it', async () => {
    const { op, host, opened } = world();
    const seen: string[] = [];
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init).url);
      return inner(input, init);
    });
    // As the real port does: the window lists the origin it was entered for (here the profile's).
    const t = gated(op, host, { kind: 'webid', webId: op.webId }, 'requested', [new URL(op.webId).origin]);
    await t.session.start();
    expect(t.session.getState().kind).toBe('ready-to-sign-in');
    await t.session.beginSignIn();
    // The profile is readable; the first address pod-auth then needs is not listed, so the page
    // explains before anything is sent there and before any browser opens.
    expect(t.session.getState()).toMatchObject({ kind: 'needs-approval', phase: 'sign-in', webId: op.webId });
    expect(seen.every((url) => new URL(url).origin === new URL(op.webId).origin)).toBe(true);
    expect(opened).toEqual([]);
    expect(t.pending.value).toMatchObject({ hint: { kind: 'webid', webId: op.webId } });
    expect(t.requested).toEqual([]);
    expect(t.session.getFetch()).toBeNull();
  });

  it('asks about the first unlisted origin pod-auth reads (here the Client Identifier Document host); a decline ends in origin-declined and forgets what was typed', async () => {
    const { op, host } = world();
    const t = gated(op, host, { kind: 'issuer', issuer: op.issuer }, 'declined');
    await t.session.start();
    await t.session.beginSignIn();
    expect(t.session.getState()).toMatchObject({ kind: 'needs-approval', purpose: 'app-identity' });
    await t.session.approveOrigin();
    expect(t.requested).toEqual([new URL(config.clientId).origin]);
    expect(t.session.getState()).toEqual({ kind: 'error', error: 'origin-declined' });
    expect(t.pending.value).toBeNull();
  });
});

describe('approve, rebuild, resume, with a profile on another origin than the provider', () => {
  it('runs the whole flow with real pod-auth and ends connected, showing the provider apart from the profile', async () => {
    const { op, host, opened } = world();
    const profileOrigin = new URL(op.webId).origin; // https://id.example
    const providerOrigin = new URL(op.issuer).origin; // https://op.example
    const clientOrigin = new URL(config.clientId).origin;
    const pending = memoryPending();
    const marker = memoryMarker();
    const listed: string[] = [];
    const approved: { origin: string; purpose: string }[] = [];
    let fresh: string | null = null;

    /** A window the app has just built: the record's issuer, the listed origins and the grant. */
    const window = (podWindow: boolean) => {
      const podMode = {
        ...fakePodMode({ podWindow, issuer: podWindow ? profileOrigin : null, fresh }),
        admission: {
          known: () => (podWindow ? [...listed] : []),
          async request(origin: string, purpose: string) {
            approved.push({ origin, purpose });
            // The app rebuilds the window while this is open: the page that asked never sees an answer.
            return new Promise<never>(() => undefined);
          },
        },
      };
      const session = createPodSession({
        config,
        createAuth: (options) => createDefaultAuth(config, host, options),
        wipeStores: async () => 'wiped',
        podMode,
        marker,
        pending,
        selfTest: async () => ({ ok: true }),
      });
      return session;
    };

    // The ordinary window: the person types their WebID. The app confirms the profile's origin.
    const ordinary = window(false);
    await ordinary.connect(op.webId);
    expect(pending.value).toEqual({ hint: { kind: 'webid', webId: op.webId } });
    listed.push(profileOrigin);
    fresh = profileOrigin;

    // Rebuilt windows, one per approval, until the browser is about to open.
    let provider: string | null = null;
    for (let round = 0; round < 6 && provider === null; round++) {
      const session = window(true);
      await session.start();
      const ready = session.getState();
      expect(ready).toMatchObject({ kind: 'ready-to-sign-in', issuer: profileOrigin, webId: op.webId });
      const started = session.beginSignIn();
      await vi.waitFor(() => expect(['needs-approval', 'confirm-provider']).toContain(session.getState().kind));
      const next = session.getState();
      if (next.kind === 'needs-approval') {
        await started;
        // Explained first, nothing was sent to that address and no browser opened.
        expect(opened).toEqual([]);
        const before = approved.length;
        void session.approveOrigin();
        await vi.waitFor(() => expect(approved).toHaveLength(before + 1));
        const last = approved[approved.length - 1]!;
        listed.push(last.origin);
        fresh = last.origin;
        continue;
      }
      expect(next).toEqual({ kind: 'confirm-provider', provider: providerOrigin, webId: op.webId });
      expect(opened).toEqual([]);
      provider = providerOrigin;
      session.openBrowser();
      await started;
      expect(session.getState()).toEqual({ kind: 'connected', webId: op.webId });
      listed.push(new URL(op.root).origin); // the pod's storage, approved the same way as the others
      expect(await (await session.getFetch()!(`${op.root}private`)).text()).toBe('protected Solid');
    }
    expect(provider).toBe(providerOrigin);
    // The provider was approved as the place to sign in; the identity document's host as ArtCraft's own.
    expect(approved).toEqual(expect.arrayContaining([{ origin: providerOrigin, purpose: 'sign-in' }, { origin: clientOrigin, purpose: 'app-identity' }]));
    expect(approved.every((a) => a.origin !== profileOrigin)).toBe(true);
    expect(opened).toHaveLength(1);
    expect(pending.value).toBeNull();
  });
});

// Last: this block leaves pod-auth's IndexedDB connections open on purpose.
describe('the wipe against the databases pod-auth really creates', () => {
  it('finds them by their real names, and reports a delete behind an open connection as deferred', async () => {
    const own: PodSessionConfig = { ...config, clientId: 'https://wipe.example/solid-client-id.jsonld' };
    const { op, host } = world(own);
    const names = async () => (await indexedDB.databases()).flatMap((d) => (d.name ? [d.name] : []));
    const before = podAuthDatabaseNames(await names()).length;
    const session = createPodSession({
      config: own,
      createAuth: (options) => createDefaultAuth(own, host, options),
      wipeStores: async () => 'wiped',
      podMode: fakePodMode({ podWindow: true, issuer: new URL(op.issuer).origin, fresh: new URL(op.issuer).origin }),
      marker: memoryMarker(),
      pending: memoryPending({ hint: { kind: 'issuer', issuer: op.issuer } }),
      selfTest: async () => ({ ok: true }),
    });
    await session.start();
    await signInThroughTheBrowserClick(session);
    expect(session.getState().kind).toBe('connected');

    // Not hand-built names: these exist because pod-auth created them.
    expect(podAuthDatabaseNames(await names()).length).toBeGreaterThan(before);

    // pod-auth still holds its connections, so the delete can only be queued; it must not
    // be reported as done.
    expect(await deletePodAuthDatabases()).toBe('deferred');
  });
});
