import type { PodGate } from '@storyteller/pod-mode';
import type { PendingSignIn, PendingStore } from './pending.js';
import type { Marker, MarkerValue, PodAuthPort, PodModePort } from './pod-session.js';
import type { AddOriginResult } from '@storyteller/pod-mode';

export type FakeAuth = PodAuthPort & {
  calls: string[];
  loginHints: ({ issuer: string } | { webId: string })[];
  /** Resolves a pending login. */
  finish(webId: string | null): void;
  /** Rejects a pending login. */
  fail(error: unknown): void;
};

/** A pod-auth stand-in. `login` stays pending until `finish`, `fail` or the signal aborts. */
export function fakeAuth(options: { restored?: string | null; restoredWithoutWebId?: boolean; restoreError?: unknown; logoutError?: unknown } = {}): FakeAuth {
  const calls: string[] = [];
  const loginHints: ({ issuer: string } | { webId: string })[] = [];
  let resolve: (v: { webId: string | null }) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const auth: FakeAuth = {
    calls,
    loginHints,
    fetch: (async () => new Response('ok')) as typeof fetch,
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
    finish: (webId) => resolve({ webId }),
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
  answer: 'requested' | 'declined' | 'throws';
  /** Make the shell's leave request fail. */
  leaveFails: boolean;
  consumeFails: boolean;
  log: string[];
  entered: string[];
  /** Origins the window's policy lists, and what the shell answers to a request to add one. */
  listed: string[];
  addAnswer: AddOriginResult | Error;
  requested: string[];
};

export function fakePodMode(
  initial: Partial<Pick<FakePodMode, 'podWindow' | 'shell' | 'flagged' | 'issuer' | 'fresh' | 'answer' | 'leaveFails' | 'consumeFails' | 'listed' | 'addAnswer'>> = {},
): FakePodMode {
  const mode: FakePodMode = {
    podWindow: false,
    shell: 'ok',
    flagged: false,
    issuer: null,
    fresh: null,
    answer: 'requested',
    leaveFails: false,
    consumeFails: false,
    log: [],
    entered: [],
    listed: [],
    addAnswer: 'requested',
    requested: [],
    ...initial,
    // Present only when a test asks for an origin gate: a plain window has none.
    ...(initial.listed || initial.addAnswer
      ? {
          admission: {
            known: () => mode.listed,
            async request(origin: string) {
              mode.requested.push(origin);
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
