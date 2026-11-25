import {
  enterPodMode,
  isPodMode,
  leavePodMode,
  podPolicyApplied,
  type PodModeRequests,
  readPodModeOrigins,
  reloadPodWindow,
  sessionRestoreAllowed,
} from '@storyteller/pod-mode';
import { checkConfig, type ConfigCheck, type PodSessionConfig } from './config.js';
import { parseIssuerInput } from './issuer.js';
import { runSelfTest, type SelfTestResult } from './self-test.js';
import type { PodSessionErrorKind, PodSessionState } from './state.js';
import type { WipeOutcome } from './wipe.js';

/** The part of `@jeswr/pod-auth`'s `PodAuth` this machine uses. */
export interface PodAuthPort {
  login(hint: { issuer: string }, options: { signal: AbortSignal }): Promise<{ webId: string | null }>;
  restore(): Promise<{ webId: string | null } | null>;
  logout(): Promise<void>;
  dispose?(): void;
  /** The only fetch that may carry pod credentials. */
  fetch: typeof fetch;
}

/** What the machine needs from the window and the shell, replaceable in tests. */
export interface PodModePort {
  isPodMode(): boolean;
  sessionRestoreAllowed(): boolean;
  /** A narrowing policy (shell header or meta element) is confirmed for this window. */
  policyApplied(): boolean;
  /** The issuer the shell recorded for this pod window, if any. */
  recordedIssuer(): string | null;
  /** Asks the shell to enter pod mode for `issuer` (native dialog). */
  requestEnter(issuer: string): Promise<'requested' | 'declined'>;
  /** Asks the shell to rebuild the window, staying in the current mode. */
  requestReload(): Promise<void>;
  /** Wipes through `wipeCredentials`, then asks the shell to leave pod mode. */
  leave(wipeCredentials: () => Promise<void>): Promise<void>;
}

/**
 * What survives the window rebuilds between steps: where this flow was. Only a closed set of
 * words, never an origin, token or URL.
 */
export type MarkerValue =
  /** Connect was confirmed; start the sign-in in the pod window. */
  | 'connect'
  /** A disconnect needs the stored data deleted before any connection to it opens. */
  | 'leave'
  | 'leave-revocation-failed'
  /** The disconnect finished; show the answer once. */
  | 'done'
  | 'done-revocation-failed';

export interface Marker {
  get(): MarkerValue | null;
  set(value: MarkerValue | null): void;
}

export interface PodSessionDeps {
  config: PodSessionConfig;
  /** Builds a fresh pod-auth. Called only where credentials may be read or created. */
  createAuth(): PodAuthPort;
  /** Deletes every locally stored pod credential. Rejects when it cannot; `deferred` is not done. */
  wipeStores(): Promise<WipeOutcome>;
  selfTest?: () => Promise<SelfTestResult>;
  podMode?: PodModePort;
  marker?: Marker;
}

export interface PodSession {
  getState(): PodSessionState;
  subscribe(listener: (state: PodSessionState) => void): () => void;
  /** Settles any step left by a window rebuild, then self-test and restore. Idempotent. */
  start(): Promise<PodSessionState>;
  /** Asks the app to enter pod mode for the typed issuer. The app confirms in its own dialog. */
  connect(issuerInput: string): Promise<void>;
  /** Abandons a sign-in that is waiting for the browser. */
  cancel(): void;
  /**
   * Leaves pod mode from any state: revokes if it can, always wipes the local data, then asks
   * the app to leave. Revocation failing does not stop the wipe; a wipe that cannot finish is
   * reported and the window stays in pod mode.
   */
  leave(): Promise<void>;
  /** The credentialed fetch, or null unless connected. */
  getFetch(): typeof fetch | null;
  /** Whether this window is a pod window, as the app recorded it. */
  inPodMode(): boolean;
  /** Whether this build can sign in at all; Connect stays disabled unless this is `ok`. */
  configCheck(): ConfigCheck;
}

const MARKER_KEY = 'artcraft.podSession.marker';
const MARKER_VALUES: readonly MarkerValue[] = ['connect', 'leave', 'leave-revocation-failed', 'done', 'done-revocation-failed'];

export function createPodSession(deps: PodSessionDeps): PodSession {
  const podMode = deps.podMode ?? realPodModePort();
  const marker = deps.marker ?? localStorageMarker();
  const selfTest = deps.selfTest ?? (() => runSelfTest());

  let state: PodSessionState = { kind: 'disconnected' };
  const listeners = new Set<(state: PodSessionState) => void>();
  let auth: PodAuthPort | null = null;
  let abort: AbortController | null = null;
  let started: Promise<PodSessionState> | null = null;
  let leaving: Promise<void> | null = null;

  const set = (next: PodSessionState): void => {
    state = next;
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        // a faulty subscriber must not break the machine
      }
    }
  };
  const fail = (error: PodSessionErrorKind): void => set({ kind: 'error', error });
  const releaseAuth = (): void => {
    const current = auth;
    auth = null;
    try {
      current?.dispose?.();
    } catch {
      // nothing more to do
    }
  };

  /** Why pod-auth may not be built in this window, or null when it may. */
  function gate(): PodSessionErrorKind | null {
    const config = checkConfig(deps.config);
    if (config === 'not-configured') return 'not-configured';
    if (config === 'invalid') return 'invalid-config';
    if (!podMode.isPodMode()) return 'window-not-clean';
    if (!podMode.sessionRestoreAllowed()) return 'window-not-clean';
    if (!podMode.policyApplied()) return 'policy-not-applied';
    return null;
  }

  /** Revoke at the provider and purge pod-auth's stored sessions. True when that worked. */
  async function revoke(): Promise<boolean> {
    try {
      if (auth === null) {
        // An ordinary window, or a build with no client yet, has never held a session.
        if (!podMode.isPodMode() || checkConfig(deps.config) === 'not-configured') return true;
        if (gate() !== null) return false;
        auth = deps.createAuth();
      }
      await auth.logout();
      return true;
    } catch {
      return false;
    } finally {
      releaseAuth();
    }
  }

  /** After any failure once credentials may exist: revoke and wipe, both best effort. */
  async function scrub(): Promise<void> {
    await revoke();
    try {
      await deps.wipeStores();
    } catch {
      // the caller already reports the failure; leave still wipes
    }
  }

  async function signIn(issuer: string): Promise<void> {
    const blocked = gate();
    if (blocked !== null) return fail(blocked);
    const controller = new AbortController();
    abort = controller;
    set({ kind: 'signing-in', issuer });
    try {
      // A fresh sign-in starts from empty stores: anything already there was not written by
      // this window's own sign-in. A delete that is only pending is not empty.
      if ((await deps.wipeStores()) !== 'wiped') return fail('wipe-failed');
      if (controller.signal.aborted) return settleCancelled();
      const created = deps.createAuth();
      auth = created;
      const identity = await created.login({ issuer }, { signal: controller.signal });
      if (controller.signal.aborted) {
        await scrub();
        return settleCancelled();
      }
      if (identity.webId === null) {
        await scrub();
        return fail('sign-in-failed');
      }
      set({ kind: 'connected', webId: identity.webId });
    } catch (error) {
      // Tokens may already be stored when the failure came after the exchange.
      await scrub();
      if (controller.signal.aborted) return settleCancelled();
      fail(classify(error));
    } finally {
      if (abort === controller) abort = null;
    }
  }

  async function restore(): Promise<void> {
    const blocked = gate();
    if (blocked !== null) return fail(blocked);
    try {
      const created = deps.createAuth();
      auth = created;
      const identity = await created.restore();
      if (identity?.webId) set({ kind: 'connected', webId: identity.webId });
      else releaseAuth();
    } catch {
      releaseAuth();
      fail('restore-failed');
    }
  }

  function settleCancelled(): void {
    releaseAuth();
    set({ kind: 'disconnected' });
  }

  /** The final step of a disconnect, after the stored data is gone. */
  async function finishLeave(revoked: boolean): Promise<void> {
    marker.set(revoked ? 'done' : 'done-revocation-failed');
    try {
      if (podMode.isPodMode()) await podMode.leave(async () => undefined);
    } catch {
      marker.set(null);
      return fail('request-failed');
    }
    // Normally the window is rebuilt here and the marker shows the answer; without a rebuild
    // (a plain browser) this shows it directly.
    marker.set(null);
    set(revoked ? { kind: 'disconnected', outcome: 'disconnected' } : { kind: 'signed-out-locally' });
  }

  async function settleLeaveMarker(value: 'leave' | 'leave-revocation-failed'): Promise<void> {
    // No pod-auth exists in this window yet, so nothing holds the stored data open.
    marker.set(null);
    set({ kind: 'leaving', step: 'clearing' });
    let outcome: WipeOutcome;
    try {
      outcome = await deps.wipeStores();
    } catch {
      return fail('wipe-failed');
    }
    if (outcome !== 'wiped') return fail('wipe-failed');
    await finishLeave(value === 'leave');
  }

  async function runLeave(): Promise<void> {
    abort?.abort();
    set({ kind: 'leaving', step: 'revoking' });
    const revoked = await revoke();
    set({ kind: 'leaving', step: 'clearing' });
    let outcome: WipeOutcome;
    try {
      outcome = await deps.wipeStores();
    } catch {
      return fail('wipe-failed');
    }
    if (outcome === 'deferred') {
      // A connection from this window still holds the data open, so the delete is only queued.
      // Rebuild the window (closing the connection) and finish there, before anything reopens it.
      marker.set(revoked ? 'leave' : 'leave-revocation-failed');
      set({ kind: 'leaving', step: 'reloading' });
      try {
        await podMode.requestReload();
      } catch {
        marker.set(null);
        fail('request-failed');
      }
      return;
    }
    await finishLeave(revoked);
  }

  const session: PodSession = {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start() {
      started ??= (async () => {
        const pending = marker.get();
        if (podMode.isPodMode() && (pending === 'leave' || pending === 'leave-revocation-failed')) {
          await settleLeaveMarker(pending);
          return state;
        }
        marker.set(null);
        const result = await selfTest().catch((): SelfTestResult => ({ ok: false, reason: 'key-not-persistable' }));
        if (!result.ok) {
          set({ kind: 'unsupported', reason: result.reason });
          return state;
        }
        if (pending === 'done') set({ kind: 'disconnected', outcome: 'disconnected' });
        else if (pending === 'done-revocation-failed') set({ kind: 'signed-out-locally' });
        if (!podMode.isPodMode()) return state;
        const issuer = podMode.recordedIssuer();
        if (pending === 'connect' && issuer !== null) await signIn(issuer);
        else await restore();
        return state;
      })();
      return started;
    },

    async connect(issuerInput) {
      await session.start();
      const k = state.kind;
      if (k !== 'disconnected' && k !== 'error' && k !== 'signed-out-locally') return;
      if (podMode.isPodMode()) return;
      const config = checkConfig(deps.config);
      if (config !== 'ok') return fail(config === 'invalid' ? 'invalid-config' : 'not-configured');
      const issuer = parseIssuerInput(issuerInput, deps.config.allowLoopbackHttp);
      if (issuer === null) return fail('invalid-issuer');
      set({ kind: 'connecting', issuer });
      marker.set('connect');
      try {
        const answer = await podMode.requestEnter(issuer);
        if (answer === 'declined') {
          marker.set(null);
          set({ kind: 'disconnected', outcome: 'declined' });
        }
        // 'requested': the app rebuilds this window; the sign-in continues in the new one.
      } catch {
        marker.set(null);
        fail('request-failed');
      }
    },

    cancel() {
      if (state.kind === 'signing-in') abort?.abort();
    },

    leave() {
      leaving ??= runLeave().finally(() => {
        leaving = null;
      });
      return leaving;
    },

    getFetch: () => (state.kind === 'connected' && auth ? auth.fetch : null),
    inPodMode: () => podMode.isPodMode(),
    configCheck: () => checkConfig(deps.config),
  };

  return session;
}

/** Maps a failure to a closed kind. Reads only `code`; never the message or any URL. */
function classify(error: unknown): PodSessionErrorKind {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'timed-out') return 'sign-in-timed-out';
  if (code === 'host-failed') return 'browser-open-failed';
  return 'sign-in-failed';
}

/** The window state and the app's requests. `requests` is absent only in a plain browser. */
export function realPodModePort(requests?: PodModeRequests): PodModePort {
  const deps = requests ? { requests } : {};
  return {
    isPodMode: () => isPodMode(),
    sessionRestoreAllowed: () => sessionRestoreAllowed(),
    policyApplied: () => podPolicyApplied(),
    recordedIssuer: () => readPodModeOrigins()?.issuer ?? null,
    requestEnter: (issuer) => enterPodMode({ issuer }, deps),
    requestReload: () => reloadPodWindow(deps),
    leave: (wipe) => leavePodMode(wipe, deps),
  };
}

/** True when a step of connecting or disconnecting is waiting for the next window to settle it. */
export function hasPendingStep(marker: Marker = localStorageMarker()): boolean {
  return marker.get() !== null;
}

export function localStorageMarker(storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): Marker {
  const pick = () => storage ?? globalThis.localStorage;
  return {
    get() {
      try {
        const value = pick().getItem(MARKER_KEY);
        return (MARKER_VALUES as readonly (string | null)[]).includes(value) ? (value as MarkerValue) : null;
      } catch {
        return null;
      }
    },
    set(value) {
      try {
        if (value === null) pick().removeItem(MARKER_KEY);
        else pick().setItem(MARKER_KEY, value);
      } catch {
        // without it the person simply presses the button again
      }
    },
  };
}
