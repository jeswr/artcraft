import { beforeEach, describe, expect, it, vi } from 'vitest';

const created = vi.hoisted(() => ({ options: undefined as undefined | Record<string, any> }));
vi.mock('@jeswr/pod-auth', () => ({
  createPodAuth: (options: Record<string, unknown>) => {
    created.options = options;
    return { fake: true };
  },
}));
const codeDriver = vi.hoisted(() => vi.fn(() => 'driver'));
vi.mock('@jeswr/desktop-auth', () => ({ createDesktopCodeDriver: codeDriver }));

import { createDefaultAuth } from './default-auth.js';

const config = { clientId: 'https://artcraft.example/id.jsonld', redirectUri: 'ai.artcraft.app:/oauth/callback', allowLoopbackHttp: false };
const host = { openUrl: async () => undefined, onOpenUrl: async () => () => undefined };

beforeEach(() => {
  created.options = undefined;
  codeDriver.mockClear();
});

describe('createDefaultAuth', () => {
  it('uses the native redirect for this build and the desktop code driver', () => {
    createDefaultAuth(config, host);
    expect(created.options).toMatchObject({ clientId: config.clientId, redirectUri: config.redirectUri, nativeRedirect: true });
    expect(codeDriver).toHaveBeenCalledWith({ host, redirectUri: config.redirectUri });
    expect(created.options?.['ui'].getCode).toBe('driver');
  });

  it('refuses the WebID prompt: only issuer sign-in is offered', async () => {
    createDefaultAuth(config, host);
    await expect(created.options?.['ui'].getWebId()).rejects.toThrow();
  });

  it('passes the supplied fetch to pod-auth, and none when there is none', () => {
    const injected = (async () => new Response('x')) as typeof fetch;
    createDefaultAuth(config, host, { fetch: injected });
    expect(created.options?.['fetch']).toBe(injected);
    createDefaultAuth(config, host);
    expect(created.options && 'fetch' in created.options).toBe(false);
  });
});
