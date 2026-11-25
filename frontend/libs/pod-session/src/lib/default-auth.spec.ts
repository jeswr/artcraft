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
import { SignInNotInProgressError } from './sign-in-gate.js';

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
    // getCode is the code driver behind the sign-in gate, not the bare driver.
    expect(created.options?.['ui'].getCode).toBeTypeOf('function');
  });

  it('refuses to open the browser unless the supplied gate lets it, and never asks the driver then', async () => {
    const driver = vi.fn(async () => 'code');
    codeDriver.mockReturnValue(driver as never);
    const authorize = vi.fn(() => {
      throw new SignInNotInProgressError();
    });
    createDefaultAuth(config, host, { authorizeSignIn: authorize });
    const url = new URL('https://login.example/authorize');
    const signal = new AbortController().signal;
    await expect(created.options?.['ui'].getCode(url, signal)).rejects.toBeInstanceOf(SignInNotInProgressError);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(driver).not.toHaveBeenCalled();

    authorize.mockImplementation(() => undefined as never);
    await expect(created.options?.['ui'].getCode(url, signal)).resolves.toBe('code');
    expect(driver).toHaveBeenCalledWith(url, signal);
  });

  it('refuses when no gate is supplied at all', async () => {
    const driver = vi.fn(async () => 'code');
    codeDriver.mockReturnValue(driver as never);
    createDefaultAuth(config, host);
    await expect(created.options?.['ui'].getCode(new URL('https://login.example/authorize'), new AbortController().signal)).rejects.toBeInstanceOf(SignInNotInProgressError);
    expect(driver).not.toHaveBeenCalled();
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
