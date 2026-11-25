// @vitest-environment node
import 'fake-indexeddb/auto';
import { createMockOp } from '@jeswr/pod-auth/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultAuth } from './default-auth.js';
import { createPodSession } from './pod-session.js';
import { deletePodAuthDatabases, podAuthDatabaseNames } from './wipe.js';
import { fakePodMode, memoryMarker } from './testing.js';
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

describe('sign-in through pod-auth and desktop-auth', () => {
  it('connects, gives a credentialed fetch, and never logs the callback', async () => {
    const { op, host, callbacks, opened } = world();
    const logged: unknown[][] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => void logged.push(args));
    }
    const podMode = fakePodMode({ podWindow: true, issuer: op.issuer, fresh: op.issuer });
    const session = createPodSession({
      config,
      createAuth: () => createDefaultAuth(config, host),
      wipeStores: async () => 'wiped',
      podMode,
      marker: memoryMarker(),
      selfTest: async () => ({ ok: true }),
    });

    await session.start();
    await session.beginSignIn();

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
      createAuth: () => createDefaultAuth(config, forging),
      wipeStores: async () => 'wiped',
      podMode: fakePodMode({ podWindow: true, issuer: op.issuer, fresh: op.issuer }),
      marker: memoryMarker(),
      selfTest: async () => ({ ok: true }),
    });
    await session.start();
    await session.beginSignIn();
    expect(session.getState()).toEqual({ kind: 'error', error: 'sign-in-failed' });
    expect(session.getFetch()).toBeNull();
    expect(op.stats.tokens).toBe(0);
  });
});

describe('the wipe against the databases pod-auth really creates', () => {
  it('finds them by their real names, and reports a delete behind an open connection as deferred', async () => {
    const own: PodSessionConfig = { ...config, clientId: 'https://wipe.example/solid-client-id.jsonld' };
    const { op, host } = world(own);
    const names = async () => (await indexedDB.databases()).flatMap((d) => (d.name ? [d.name] : []));
    const before = podAuthDatabaseNames(await names()).length;
    const session = createPodSession({
      config: own,
      createAuth: () => createDefaultAuth(own, host),
      wipeStores: async () => 'wiped',
      podMode: fakePodMode({ podWindow: true, issuer: op.issuer, fresh: op.issuer }),
      marker: memoryMarker(),
      selfTest: async () => ({ ok: true }),
    });
    await session.start();
    await session.beginSignIn();
    expect(session.getState().kind).toBe('connected');

    // Not hand-built names: these exist because pod-auth created them.
    expect(podAuthDatabaseNames(await names()).length).toBeGreaterThan(before);

    // pod-auth still holds its connections, so the delete can only be queued; it must not
    // be reported as done.
    expect(await deletePodAuthDatabases()).toBe('deferred');
  });
});
