import type { Marker, MarkerValue, PodAuthPort, PodModePort } from './pod-session.js';

export type FakeAuth = PodAuthPort & {
  calls: string[];
  loginHints: { issuer: string }[];
  /** Resolves a pending login. */
  finish(webId: string | null): void;
  /** Rejects a pending login. */
  fail(error: unknown): void;
};

/** A pod-auth stand-in. `login` stays pending until `finish`, `fail` or the signal aborts. */
export function fakeAuth(options: { restored?: string | null; restoreError?: unknown; logoutError?: unknown } = {}): FakeAuth {
  const calls: string[] = [];
  const loginHints: { issuer: string }[] = [];
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
  restoreAllowed: boolean;
  policy: boolean;
  issuer: string | null;
  /** What the shell's native dialog answers. */
  answer: 'requested' | 'declined' | 'throws';
  /** Make the shell's leave request fail. */
  leaveFails: boolean;
  log: string[];
  entered: string[];
};

export function fakePodMode(
  initial: Partial<Pick<FakePodMode, 'podWindow' | 'restoreAllowed' | 'policy' | 'issuer' | 'answer' | 'leaveFails'>> = {},
): FakePodMode {
  const mode: FakePodMode = {
    podWindow: false,
    restoreAllowed: true,
    policy: true,
    issuer: null,
    answer: 'requested',
    leaveFails: false,
    log: [],
    entered: [],
    ...initial,
    isPodMode: () => mode.podWindow,
    sessionRestoreAllowed: () => mode.podWindow && mode.restoreAllowed,
    policyApplied: () => mode.podWindow && mode.policy,
    recordedIssuer: () => mode.issuer,
    async requestEnter(issuer) {
      mode.entered.push(issuer);
      mode.log.push('enter');
      if (mode.answer === 'throws') throw new Error('shell refused');
      return mode.answer;
    },
    async requestReload() {
      mode.log.push('reload');
    },
    async leave(wipe) {
      mode.log.push('leave-wipe-start');
      await wipe();
      if (mode.leaveFails) throw new Error('shell refused');
      mode.log.push('left');
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
