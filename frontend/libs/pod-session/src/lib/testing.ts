import type { PodGate } from '@storyteller/pod-mode';
import type { HintStore, PendingSignIn, PendingStore, SignInHint } from './pending.js';
import type { Marker, MarkerValue, PodAuthPort, PodModePort, SignedInIdentity } from './pod-session.js';
import type { AddOriginResult } from '@storyteller/pod-mode';

export type FakeAuth = PodAuthPort & {
  calls: string[];
  loginHints: ({ issuer: string } | { webId: string })[];
  /** Resolves a pending login, optionally with pod-auth's storage discovery. */
  finish(webId: string | null, storageDiscovery?: SignedInIdentity['storageDiscovery']): void;
  /** Emits pod-auth's `expired` event. */
  expire(): void;
  /** Rejects a pending login. */
  fail(error: unknown): void;
};

/** A pod-auth stand-in. `login` stays pending until `finish`, `fail` or the signal aborts. */
export function fakeAuth(options: { restored?: string | null; restoredWithoutWebId?: boolean; restoreError?: unknown; logoutError?: unknown } = {}): FakeAuth {
  const calls: string[] = [];
  const loginHints: ({ issuer: string } | { webId: string })[] = [];
  let resolve: (v: SignedInIdentity) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const expired = new Set<() => void>();
  const auth: FakeAuth = {
    calls,
    on(_event, handler) {
      expired.add(handler);
      return () => expired.delete(handler);
    },
    expire: () => {
      for (const handler of [...expired]) handler();
    },
    loginHints,
    fetch: (async () => new Response('ok')) as typeof fetch,
    nonInteractiveFetch: (async () => new Response('ok')) as typeof fetch,
    login(hint, { signal }) {
      calls.push('login');
      loginHints.push(hint);
      return new Promise((res, rej) => {
        resolve = res;
        reject = rej;
        signal.addEventListener('abort', () => rej(signal.reason ?? new Error('aborted')));
      });
    },
    async restore() {
      calls.push('restore');
      if (options.restoreError) throw options.restoreError;
      if (options.restoredWithoutWebId) return { webId: null };
      return options.restored ? { webId: options.restored } : null;
    },
    async logout() {
      calls.push('logout');
      if (options.logoutError) throw options.logoutError;
    },
    dispose() {
      calls.push('dispose');
    },
    finish: (webId, storageDiscovery) => resolve(storageDiscovery ? { webId, storageDiscovery } : { webId }),
    fail: (error) => reject(error),
  };
  return auth;
}

export type FakePodMode = PodModePort & {
  podWindow: boolean;
  /** The shell's answer to `gate()`. */
  shell: PodGate;
  /** An ordinary window the shell says may still hold pod credentials. */
  flagged: boolean;
  issuer: string | null;
  /** The issuer of a connect approved in a dialog in this process. */
  fresh: string | null;
  /** What the shell's native dialog answers. */
  answer: 'requested' | 'declined' | 'too-fast' | 'throws';
  /** What the shell answers to "sign in again": an answer, or the word it rejects with. */
  againAnswer: 'requested' | 'declined' | 'too-fast' | 'busy' | 'cooling_down' | 'too_many_prompts';
  /** Whether the window has a shell that can be asked to sign in again. */
  againAvailable: boolean;
  /** Make the shell's leave request fail. */
  leaveFails: boolean;
  consumeFails: boolean;
  log: string[];
  entered: string[];
  /** Origins the window's policy lists, and what the shell answers to a request to add one. */
  listed: string[];
  addAnswer: AddOriginResult | Error;
  requested: string[];
  purposes: string[];
};

export function fakePodMode(
  initial: Partial<
    Pick<FakePodMode, 'podWindow' | 'shell' | 'flagged' | 'issuer' | 'fresh' | 'answer' | 'leaveFails' | 'consumeFails' | 'listed' | 'addAnswer' | 'againAnswer' | 'againAvailable'>
  > = {},
): FakePodMode {
  const mode: FakePodMode = {
    podWindow: false,
    shell: 'ok',
    flagged: false,
    issuer: null,
    fresh: null,
    answer: 'requested',
    againAnswer: 'requested',
    againAvailable: true,
    leaveFails: false,
    consumeFails: false,
    log: [],
    entered: [],
    listed: [],
    addAnswer: 'requested',
    requested: [],
    purposes: [],
    ...initial,
    // Present only when a test asks for an origin gate: a plain window has none.
    ...(initial.listed || initial.addAnswer
      ? {
          admission: {
            known: () => mode.listed,
            async request(origin: string, purpose: string) {
              mode.requested.push(origin);
              mode.purposes.push(purpose);
              mode.log.push('add-origin');
              if (mode.addAnswer instanceof Error) throw mode.addAnswer;
              return mode.addAnswer;
            },
          },
        }
      : {}),
    isPodMode: () => mode.podWindow,
    gate: () => (mode.podWindow ? mode.shell : 'not-pod-window'),
    finishing: () => !mode.podWindow && mode.flagged,
    recordedIssuer: () => mode.issuer,
    freshIssuer: () => mode.fresh,
    async requestEnter(issuer) {
      mode.entered.push(issuer);
      mode.log.push('enter');
      if (mode.answer === 'throws') throw new Error('shell refused');
      return mode.answer;
    },
    async consumeFresh() {
      mode.log.push('consume');
      if (mode.consumeFails || mode.fresh === null) throw new Error('not fresh');
      const issuer = mode.fresh;
      mode.fresh = null;
      return issuer;
    },
    async requestReload() {
      mode.log.push('reload');
    },
    get requestSignInAgain() {
      if (!mode.againAvailable) return undefined;
      return async () => {
        mode.log.push('sign-in-again');
        const answer = mode.againAnswer;
        if (answer === 'busy' || answer === 'cooling_down' || answer === 'too_many_prompts') throw answer;
        return answer;
      };
    },
    async leave() {
      if (mode.leaveFails) throw new Error('shell refused');
      mode.log.push('left');
    },
    async credentialsCleared() {
      if (mode.leaveFails) throw new Error('shell refused');
      mode.log.push('cleared');
    },
  };
  return mode;
}

export function memoryMarker(initial: MarkerValue | null = null): Marker & { value: MarkerValue | null } {
  const marker = {
    value: initial,
    get: () => marker.value,
    set: (v: MarkerValue | null) => {
      marker.value = v;
    },
  };
  return marker;
}

export function memoryPending(initial: PendingSignIn | null = null): PendingStore & { value: PendingSignIn | null } {
  const store = {
    value: initial,
    get: () => store.value,
    set: (v: PendingSignIn | null) => {
      store.value = v;
    },
  };
  return store;
}

export function memoryHint(initial: SignInHint | null = null): HintStore & { value: SignInHint | null } {
  const store = {
    value: initial,
    get: () => store.value,
    set: (v: SignInHint | null) => {
      store.value = v;
    },
  };
  return store;
}
