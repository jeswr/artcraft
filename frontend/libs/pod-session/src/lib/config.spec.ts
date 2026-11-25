import { describe, expect, it } from 'vitest';
import {
  checkConfig,
  isPlaceholderClient,
  PLACEHOLDER_CLIENT_ID,
  readConfig,
  redirectUriFor,
  type PodSessionConfig,
} from './config.js';

const ok: PodSessionConfig = {
  clientId: 'https://artcraft.example/solid-client-id.jsonld',
  redirectUri: 'ai.artcraft.app:/oauth/callback',
  allowLoopbackHttp: false,
};

describe('readConfig', () => {
  it('derives the redirect from the app identifier, so dev and release differ', () => {
    expect(readConfig('ai.artcraft.app', {}).redirectUri).toBe('ai.artcraft.app:/oauth/callback');
    expect(readConfig('ai.artcraft.app.dev', {}).redirectUri).toBe('ai.artcraft.app.dev:/oauth/callback');
    expect(redirectUriFor('a.b')).toBe('a.b:/oauth/callback');
  });

  it('falls back to the placeholder client, which stays disabled', () => {
    const config = readConfig('ai.artcraft.app', {});
    expect(config.clientId).toBe(PLACEHOLDER_CLIENT_ID);
    expect(isPlaceholderClient(config)).toBe(true);
    expect(checkConfig(config)).toBe('not-configured');
  });

  it('takes the client identifier from the build environment', () => {
    const config = readConfig('ai.artcraft.app', { VITE_SOLID_CLIENT_ID: ok.clientId });
    expect(config.clientId).toBe(ok.clientId);
    expect(isPlaceholderClient(config)).toBe(false);
    expect(readConfig('ai.artcraft.app', { VITE_SOLID_CLIENT_ID: '' }).clientId).toBe(PLACEHOLDER_CLIENT_ID);
    expect(readConfig('ai.artcraft.app', { VITE_SOLID_CLIENT_ID: 5 }).clientId).toBe(PLACEHOLDER_CLIENT_ID);
  });

  it('allows loopback http only in a dev build that also sets the flag', () => {
    expect(readConfig('x.y', { VITE_SOLID_ALLOW_LOOPBACK: 'true', DEV: true }).allowLoopbackHttp).toBe(true);
    expect(readConfig('x.y', { VITE_SOLID_ALLOW_LOOPBACK: 'true', DEV: false }).allowLoopbackHttp).toBe(false);
    expect(readConfig('x.y', { VITE_SOLID_ALLOW_LOOPBACK: 'yes', DEV: true }).allowLoopbackHttp).toBe(false);
    expect(readConfig('x.y', { DEV: true }).allowLoopbackHttp).toBe(false);
  });
});

describe('checkConfig', () => {
  it('accepts a good config', () => expect(checkConfig(ok)).toBe('ok'));

  it.each([
    ['a client that is not a URL', { clientId: 'client' }],
    ['an http client', { clientId: 'http://artcraft.example/id' }],
    ['a loopback http client without the flag', { clientId: 'http://localhost:3000/id' }],
    ['a client with credentials', { clientId: 'https://u:p@artcraft.example/id' }],
    ['a client with a fragment', { clientId: 'https://artcraft.example/id#x' }],
    ['a redirect without the callback path', { redirectUri: 'ai.artcraft.app:/other' }],
    ['a redirect scheme without a dot', { redirectUri: 'artcraft:/oauth/callback' }],
    ['an https redirect', { redirectUri: 'https://artcraft.example/oauth/callback' }],
    ['an empty scheme', { redirectUri: ':/oauth/callback' }],
    ['an upper-case scheme', { redirectUri: 'AI.ArtCraft:/oauth/callback' }],
  ])('rejects %s', (_name, patch) => {
    expect(checkConfig({ ...ok, ...patch })).toBe('invalid');
  });

  it('accepts a loopback http client only when the dev flag is set', () => {
    const local = { ...ok, clientId: 'http://localhost:3000/id' };
    expect(checkConfig({ ...local, allowLoopbackHttp: true })).toBe('ok');
    expect(checkConfig({ ...local, clientId: 'http://example.com/id', allowLoopbackHttp: true })).toBe('invalid');
  });
});
