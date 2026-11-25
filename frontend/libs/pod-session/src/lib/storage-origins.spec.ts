import { describe, expect, it, vi } from 'vitest';
import type { PodSessionConfig } from './config.js';
import { createPodSession, realPodModePort } from './pod-session.js';
import { createOriginGate, gateFetch, MAX_ORIGIN_REQUESTS_PER_WINDOW, type OriginAdmission, StorageOriginRefused } from './storage-origins.js';
import { fakeAuth, fakePodMode, memoryMarker } from './testing.js';

const ISSUER = 'https://login.example';
const POD = 'https://pod.example';
const WEBID = `${POD}/alice/profile/card#me`;
const CONFIG: PodSessionConfig = {
  clientId: 'https://artcraft.example/solid-client-id.jsonld',
  redirectUri: 'ai.artcraft.app:/oauth/callback',
  allowLoopbackHttp: false,
};

function admission(answer: 'requested' | 'declined' | 'throws' = 'requested', known: string[] = [ISSUER]) {
  const requested: string[] = [];
  const port: OriginAdmission = {
    known: () => known,
    async request(origin: string) {
      requested.push(origin);
      if (answer === 'throws') throw new Error('too_many_origins');
      return answer;
    },
  };
  return { port, requested, known };
}

describe('the origin gate', () => {
  it('lets the sign-in server and already approved origins through without asking', async () => {
    const a = admission('requested', [ISSUER, POD]);
    const gate = createOriginGate(a.port);
    await gate.allow(ISSUER);
    await gate.allow(POD);
    expect(a.requested).toEqual([]);
  });

  it('asks once for a new origin and remembers the approval', async () => {
    const a = admission();
    const gate = createOriginGate(a.port);
    await gate.allow(POD);
    await gate.allow(POD);
    expect(a.requested).toEqual([POD]);
  });

  it('shares one request between concurrent callers', async () => {
    const a = admission();
    const gate = createOriginGate(a.port);
    await Promise.all([gate.allow(POD), gate.allow(POD), gate.allow(POD)]);
    expect(a.requested).toEqual([POD]);
  });

  it('only ever sends a bare origin, never a path, query or credentials', async () => {
    const a = admission();
    const gate = createOriginGate(a.port);
    for (const hostile of [`${POD}/a/b?token=x`, `https://u:p@evil.example`, 'https://*.example', 'http://pod.example', 'javascript:alert(1)', '', 'not a url']) {
      await expect(gate.allow(hostile)).rejects.toBeInstanceOf(StorageOriginRefused);
    }
    expect(a.requested).toEqual([]);
  });

  it('a refusal is remembered: no second dialog for another origin in the same window', async () => {
    const a = admission('declined');
    const gate = createOriginGate(a.port);
    await expect(gate.allow(POD)).rejects.toBeInstanceOf(StorageOriginRefused);
    await expect(gate.allow('https://other.example')).rejects.toBeInstanceOf(StorageOriginRefused);
    expect(a.requested).toEqual([POD]);
  });

  it('an error from the app (cap, cool-down, invalid) counts as a refusal and carries no detail', async () => {
    const a = admission('throws');
    const gate = createOriginGate(a.port);
    const error = await gate.allow(POD).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageOriginRefused);
    expect(String((error as Error).message)).not.toContain('example');
    await expect(gate.allow('https://other.example')).rejects.toBeInstanceOf(StorageOriginRefused);
    expect(a.requested).toEqual([POD]);
  });

  it('a hostile profile cannot open more than a few dialogs in one window', async () => {
    const a = admission();
    const gate = createOriginGate(a.port);
    for (let i = 0; i < MAX_ORIGIN_REQUESTS_PER_WINDOW; i++) await gate.allow(`https://pod${i}.example`);
    await expect(gate.allow('https://one-more.example')).rejects.toBeInstanceOf(StorageOriginRefused);
    expect(a.requested).toHaveLength(MAX_ORIGIN_REQUESTS_PER_WINDOW);
  });
});

describe('gateFetch', () => {
  it('asks before the first request to a new origin, for strings, URLs and Requests, and never before', async () => {
    const a = admission();
    const order: string[] = [];
    const inner = vi.fn(async () => {
      order.push('fetch');
      return new Response('ok');
    }) as unknown as typeof fetch;
    const original = a.port.request;
    a.port.request = async (origin: string) => {
      order.push('ask');
      return original(origin);
    };
    const fetchGated = gateFetch(inner, createOriginGate(a.port));
    await fetchGated(`${POD}/alice/profile/card`);
    await fetchGated(new URL(`${POD}/alice/`));
    await fetchGated(new Request(`${POD}/alice/x`));
    await fetchGated(`${ISSUER}/.well-known/openid-configuration`);
    expect(order).toEqual(['ask', 'fetch', 'fetch', 'fetch', 'fetch']);
    expect(a.requested).toEqual([POD]);
  });

  it('does not send a request to an origin that was refused', async () => {
    const a = admission('declined');
    const inner = vi.fn(async () => new Response('ok')) as unknown as typeof fetch;
    const fetchGated = gateFetch(inner, createOriginGate(a.port));
    await expect(fetchGated(`${POD}/alice/`)).rejects.toBeInstanceOf(StorageOriginRefused);
    expect(inner).not.toHaveBeenCalled();
  });
});

describe('the session fetch', () => {
  async function connected(withAdmission: OriginAdmission | undefined) {
    const auth = fakeAuth({ restored: WEBID });
    const podMode = { ...fakePodMode({ podWindow: true, issuer: ISSUER }), ...(withAdmission ? { admission: withAdmission } : {}) };
    const session = createPodSession({
      config: CONFIG,
      createAuth: () => auth,
      wipeStores: async () => 'wiped',
      podMode,
      marker: memoryMarker(),
      selfTest: async () => ({ ok: true }),
    });
    await session.start();
    expect(session.getState()).toEqual({ kind: 'connected', webId: WEBID });
    return { session, auth };
  }

  it('is pod-auth’s own fetch where there is no shell to ask', async () => {
    const { session, auth } = await connected(undefined);
    expect(session.getFetch()).toBe(auth.fetch);
  });

  it('asks the shell for a storage origin that is not the issuer’s before the first pod request, and reuses one wrapper', async () => {
    const a = admission();
    const { session, auth } = await connected(a.port);
    const podFetch = session.getFetch() as typeof fetch;
    expect(podFetch).not.toBe(auth.fetch);
    expect(session.getFetch()).toBe(podFetch);
    expect(a.requested).toEqual([]);
    const response = await podFetch(`${POD}/alice/profile/card`);
    expect(await response.text()).toBe('ok');
    expect(a.requested).toEqual([POD]);
  });

  it('is null again once the session is no longer connected', async () => {
    const a = admission();
    const { session } = await connected(a.port);
    await session.leave();
    expect(session.getFetch()).toBeNull();
  });
});

describe('the app port', () => {
  it('forwards only the origin to the shell’s add-storage-origin request and lists the window’s approved origins', async () => {
    const calls: string[] = [];
    const requests = {
      requestEnter: async () => 'requested' as const,
      requestAddStorageOrigin: async (origin: string) => {
        calls.push(origin);
        return 'requested' as const;
      },
      requestLeave: async () => undefined,
      requestReload: async () => undefined,
      requestCredentialsCleared: async () => undefined,
      requestConsumeFresh: async () => ISSUER,
    };
    const port = realPodModePort(requests);
    await port.admission?.request(POD);
    expect(calls).toEqual([POD]);
    expect(port.admission?.known()).toEqual([]); // no shell record in this test window
    expect(realPodModePort().admission).toBeUndefined();
  });
});
