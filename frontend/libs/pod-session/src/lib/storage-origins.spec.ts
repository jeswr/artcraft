import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PodSessionConfig } from './config.js';
import { createPodSession, realPodModePort } from './pod-session.js';
import type { AddOriginResult } from '@storyteller/pod-mode';
import { createOriginGate, gateFetch, type OriginAdmission, StorageOriginRefused } from './storage-origins.js';
import { fakeAuth, fakePodMode, memoryMarker } from './testing.js';

const ISSUER = 'https://login.example';
const POD = 'https://pod.example';
const WEBID = `${POD}/alice/profile/card#me`;
const CONFIG: PodSessionConfig = {
  clientId: 'https://artcraft.example/solid-client-id.jsonld',
  redirectUri: 'ai.artcraft.app:/oauth/callback',
  allowLoopbackHttp: false,
};

function admission(answer: AddOriginResult | 'throws' = 'requested', known: string[] = [ISSUER]) {
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

/** What the app's `invoke` rejects with: a fixed word. */
function appError(word: string): OriginAdmission {
  return {
    known: () => [ISSUER],
    request: async () => {
      throw word;
    },
  };
}

describe('the origin gate', () => {
  it('lets the sign-in server and already approved origins through without asking', async () => {
    const a = admission('requested', [ISSUER, POD]);
    const gate = createOriginGate(a.port);
    await gate.allow(ISSUER);
    await gate.allow(POD);
    expect(a.requested).toEqual([]);
  });

  it('follows the real flow: the app approves and rebuilds the window, and the rebuilt window finds the origin listed', async () => {
    // In the app an approval rebuilds the window, so the asking page is destroyed and its
    // request never settles; the new window is built from the persisted record.
    const first = admission('requested', [ISSUER]);
    first.port.request = (origin) => {
      first.requested.push(origin);
      return new Promise(() => undefined);
    };
    const oldWindow = createOriginGate(first.port);
    let settled = false;
    void oldWindow.allow(POD).then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    expect(first.requested).toEqual([POD]);
    expect(settled).toBe(false);

    const rebuilt = admission('requested', [ISSUER, POD]);
    await createOriginGate(rebuilt.port).allow(POD);
    expect(rebuilt.requested).toEqual([]);
  });

  it('shares one request between concurrent callers for one origin and asks for different origins in turn', async () => {
    let open = 0;
    let most = 0;
    const requested: string[] = [];
    const port: OriginAdmission = {
      known: () => [ISSUER],
      async request(origin) {
        requested.push(origin);
        most = Math.max(most, ++open);
        await new Promise((resolve) => setTimeout(resolve, 5));
        open--;
        return 'requested';
      },
    };
    const gate = createOriginGate(port);
    await Promise.all([gate.allow(POD), gate.allow(POD), gate.allow('https://other.example'), gate.allow('https://third.example')]);
    expect(requested).toEqual([POD, 'https://other.example', 'https://third.example']);
    expect(most).toBe(1);
  });

  it('only ever sends a bare origin, never a path, query or credentials, and says why it refused', async () => {
    const a = admission();
    const gate = createOriginGate(a.port);
    for (const hostile of [`${POD}/a/b?token=x`, 'https://u:p@evil.example', 'https://*.example', 'http://pod.example', 'javascript:alert(1)', '', 'not a url', 'https://pod.example.']) {
      await expect(gate.allow(hostile)).rejects.toMatchObject({ name: 'StorageOriginRefused', reason: 'invalid' });
    }
    expect(a.requested).toEqual([]);
  });

  it('a decline is remembered for that origin only: another origin is still asked about', async () => {
    const a = admission('declined');
    const gate = createOriginGate(a.port);
    await expect(gate.allow(POD)).rejects.toMatchObject({ reason: 'declined' });
    await expect(gate.allow(POD)).rejects.toMatchObject({ reason: 'declined' });
    await expect(gate.allow('https://other.example')).rejects.toMatchObject({ reason: 'declined' });
    expect(a.requested).toEqual([POD, 'https://other.example']);
  });

  it('an Allow that came too fast is not a refusal and is asked again', async () => {
    const answers: AddOriginResult[] = ['too-fast', 'requested'];
    const port: OriginAdmission = { known: () => [], request: async () => answers.shift() as AddOriginResult };
    const gate = createOriginGate(port);
    await expect(gate.allow(POD)).rejects.toMatchObject({ reason: 'too-fast' });
    await gate.allow(POD);
  });

  it.each([
    ['refused_origin', 'declined', true],
    ['too_many_prompts', 'limit', true],
    ['too_many_origins', 'limit', true],
    ['invalid_origin', 'invalid', true],
    ['busy', 'busy', false],
    ['cooling_down', 'busy', false],
    ['changed', 'unavailable', false],
    ['persist_failed', 'unavailable', false],
  ] as const)('the app answering %s is %s, remembered for later asks: %s', async (word, reason, remembered) => {
    let calls = 0;
    const port: OriginAdmission = {
      known: () => [],
      request: async () => {
        calls++;
        throw word;
      },
    };
    const gate = createOriginGate(port);
    await expect(gate.allow(POD)).rejects.toMatchObject({ reason });
    await expect(gate.allow(POD)).rejects.toMatchObject({ reason });
    expect(calls).toBe(remembered ? 1 : 2);
  });

  it('only a limit from the app stops every later unknown origin; no other app error poisons the gate', async () => {
    const limited = createOriginGate(appError('too_many_prompts'));
    await expect(limited.allow(POD)).rejects.toMatchObject({ reason: 'limit' });
    await expect(limited.allow('https://other.example')).rejects.toMatchObject({ reason: 'limit' });

    const answers: unknown[] = ['invalid_origin', 'busy', 'requested'];
    const port: OriginAdmission = {
      known: () => [],
      request: async () => {
        const next = answers.shift();
        if (next === 'requested') return 'requested';
        throw next;
      },
    };
    const gate = createOriginGate(port);
    await expect(gate.allow('https://a.example')).rejects.toMatchObject({ reason: 'invalid' });
    await expect(gate.allow('https://b.example')).rejects.toMatchObject({ reason: 'busy' });
    await gate.allow('https://c.example');
  });

  it('carries no origin in any refusal message', () => {
    for (const reason of ['declined', 'limit', 'invalid', 'too-fast', 'busy', 'unavailable'] as const) {
      expect(new StorageOriginRefused(reason).message).not.toMatch(/https?:|example/);
    }
  });

  it('stops waiting when the caller aborts, and does not even ask when it already has', async () => {
    const a = admission();
    a.port.request = (origin) => {
      a.requested.push(origin);
      return new Promise(() => undefined);
    };
    const gate = createOriginGate(a.port);
    const controller = new AbortController();
    const waiting = gate.allow(POD, controller.signal);
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    const done = new AbortController();
    done.abort();
    await expect(createOriginGate(admission().port).allow(POD, done.signal)).rejects.toBeDefined();
  });
});

describe('gateFetch', () => {
  it('asks before the first request to a new origin, for strings, URLs and Requests, and never before', async () => {
    const a = admission('requested', [ISSUER]);
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

  it('honours the caller’s AbortSignal while the dialog is open', async () => {
    const a = admission();
    a.port.request = () => new Promise(() => undefined);
    const inner = vi.fn(async () => new Response('ok')) as unknown as typeof fetch;
    const fetchGated = gateFetch(inner, createOriginGate(a.port));
    const first = new AbortController();
    const one = fetchGated(`${POD}/a`, { signal: first.signal });
    first.abort();
    await expect(one).rejects.toBeDefined();
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
  const requests = (calls: string[]) => ({
    requestEnter: async () => 'requested' as const,
    requestAddStorageOrigin: async (origin: string) => {
      calls.push(origin);
      return 'requested' as const;
    },
    requestLeave: async () => undefined,
    requestReload: async () => undefined,
    requestCredentialsCleared: async () => undefined,
    requestConsumeFresh: async () => ISSUER,
  });
  const host = globalThis as Record<string, unknown>;

  afterEach(() => {
    delete host['__ARTCRAFT_POD_MODE__'];
  });

  it('forwards only the origin to the shell’s add-storage-origin request', async () => {
    const calls: string[] = [];
    await realPodModePort(requests(calls)).admission?.request(POD);
    expect(calls).toEqual([POD]);
    expect(realPodModePort().admission).toBeUndefined();
  });

  it('lists the issuer and every approved storage origin of the shell’s record, and nothing without one', () => {
    const port = realPodModePort(requests([]));
    expect(port.admission?.known()).toEqual([]);
    host['__ARTCRAFT_POD_MODE__'] = {
      enabled: true,
      issuer: ISSUER,
      storageOrigins: [POD, 'https://other.example'],
      headerPolicy: true,
      credentialsMayExist: true,
    };
    expect(port.admission?.known()).toEqual([ISSUER, POD, 'https://other.example']);
    host['__ARTCRAFT_POD_MODE__'] = { enabled: false, storageOrigins: [], headerPolicy: true, credentialsMayExist: true };
    expect(port.admission?.known()).toEqual([]);
  });

  it('so a window rebuilt after an approval asks the app nothing for that origin', async () => {
    host['__ARTCRAFT_POD_MODE__'] = { enabled: true, issuer: ISSUER, storageOrigins: [POD], headerPolicy: true, credentialsMayExist: true };
    const calls: string[] = [];
    const gate = createOriginGate(realPodModePort(requests(calls)).admission as OriginAdmission);
    await gate.allow(POD);
    await gate.allow(ISSUER);
    expect(calls).toEqual([]);
  });
});
