import {
  addStorageOrigin,
  consumeFreshConnect,
  credentialsCleared,
  enterPodMode,
  gatePodMode,
  isPodMode,
  leavePodMode,
  type PodGate,
  type PodModeRequests,
  readHostPodMode,
  reloadPodWindow,
} from '@storyteller/pod-mode';
import { checkConfig, type ConfigCheck, type PodSessionConfig } from './config.js';
import { parseIssuerInput } from './issuer.js';
import { runSelfTest, type SelfTestResult } from './self-test.js';
import type { PodSessionErrorKind, PodSessionState } from './state.js';
import { createOriginGate, gateFetch, type OriginAdmission } from './storage-origins.js';
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
  /** This window was built in pod mode (latched). */
  isPodMode(): boolean;
  /**
   * Whether pod-auth may be built here. Read afresh from the shell's frozen answer on every
   * call; in production a meta policy or the page's own latch never satisfies it.
   */
  gate(): PodGate;
  /** An ordinary window the shell says may still hold pod credentials: only disconnecting. */
  finishing(): boolean;
  /** The issuer the shell recorded for this pod window, if any. */
  recordedIssuer(): string | null;
  /** The issuer of a connect approved in the shell's dialog in this process, if any. */
  freshIssuer(): string | null;
  /** Asks the shell to enter pod mode for `issuer` (native dialog). */
  requestEnter(issuer: string): Promise<'requested' | 'declined'>;
  /** The click that starts a fresh sign-in: the shell hands out the approved issuer, once. */
  consumeFresh(): Promise<string>;
  /** Asks the shell to rebuild the window, staying in the current mode. */
  requestReload(): Promise<void>;
  /** Asks the shell to leave pod mode (the wipe has already succeeded). */
  leave(): Promise<void>;
  /** Tells the shell a wipe succeeded in a window that is not in pod mode. */
  credentialsCleared(): Promise<void>;
  /**
   * How a request to an origin the policy does not list asks the shell to admit it. Absent where
   * there is no shell (a plain browser), in which case `getFetch()` is pod-auth's fetch as is.
   */
  admission?: OriginAdmission;
}

/**
 * What survives the window rebuilds between steps: where this flow was. Only a closed set of
 * words, never an origin, token or URL.
 */
export type MarkerValue =
  /** The stored data must be deleted before any connection to it opens; then carry on. */
  | 'wipe'
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
  /**
   * The click that starts a sign-in, in a pod window that has a freshly approved connect. Wipes
   * stale stores, then opens the system browser. Never called by anything but a click.
   */
  beginSignIn(): Promise<void>;
  /** An ordinary window that may still hold pod credentials shows only the finish flow. */
  finishing(): boolean;
  /** Abandons a sign-in that is waiting for the browser. */
  cancel(): void;
  /**
   * Leaves pod mode from any state: revokes if it can, always wipes the local data, then asks
   * the app to leave. Revocation failing does not stop the wipe; a wipe that cannot finish is
   * reported and the window stays in pod mode.
   */
  leave(): Promise<void>;
  /**
   * The credentialed fetch, or null unless connected. In the desktop app a request to an origin
   * the window's policy does not list first asks the app to admit it (native dialog); a
   * refusal rejects the request with `StorageOriginRefused`.
   */
  getFetch(): typeof fetch | null;
  /** Whether this window is a pod window, as the app recorded it. */
  inPodMode(): boolean;
  /** Whether this build can sign in at all; Connect stays disabled unless this is `ok`. */
  configCheck(): ConfigCheck;
}

const MARKER_KEY = 'artcraft.podSession.marker';
const MARKER_VALUES: readonly MarkerValue[] = ['wipe', 'leave', 'leave-revocation-failed', 'done', 'done-revocation-failed'];

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
  const originGate = podMode.admission ? createOriginGate(podMode.admission) : null;
  let gated: { source: typeof fetch; fetch: typeof fetch } | null = null;

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
    const shell = podMode.gate();
    if (shell === 'policy-not-applied') return 'policy-not-applied';
    return shell === 'ok' ? null : 'window-not-clean';
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

  /**
   * After any failure once credentials may exist: revoke and wipe, both best effort. A delete
   * that is only queued, or one that failed, is remembered, so the next window deletes before
   * anything opens the stores.
   */
  async function scrub(): Promise<void> {
    const revoked = await revoke();
    let wiped = false;
    try {
      wiped = (await deps.wipeStores()) === 'wiped';
    } catch {
      wiped = false;
    }
    if (!wiped) marker.set(revoked ? 'wipe' : 'leave-revocation-failed');
  }

  async function signIn(issuer: string): Promise<void> {
    const blocked = gate();
    if (blocked !== null) return fail(blocked);
    const controller = new AbortController();
    abort = controller;
    set({ kind: 'signing-in', issuer });
    try {
      // A fresh sign-in starts from empty stores: anything already there was not written by
      // this window's own sign-in. A delete that is only queued is not empty.
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
      if (podMode.isPodMode()) await podMode.leave();
      else if (podMode.finishing()) await podMode.credentialsCleared();
    } catch {
      marker.set(null);
      return fail('request-failed');
    }
    // Normally the window is rebuilt here and the marker shows the answer; without a rebuild
    // (a plain browser) this shows it directly.
    marker.set(null);
    set(revoked ? { kind: 'disconnected', outcome: 'disconnected' } : { kind: 'signed-out-locally' });
  }

  /** Delete first, in a window where nothing holds the stored data open. True when it is gone. */
  async function wipeNow(): Promise<boolean> {
    try {
      return (await deps.wipeStores()) === 'wiped';
    } catch {
      return false;
    }
  }

  async function settleLeaveMarker(value: 'leave' | 'leave-revocation-failed'): Promise<void> {
    set({ kind: 'leaving', step: 'clearing' });
    // The marker stays until the delete is confirmed: a quit in between leaves it for the next start.
    if (!(await wipeNow())) return fail('wipe-failed');
    marker.set(null);
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
        const inPod = podMode.isPodMode();
        if (inPod && (pending === 'leave' || pending === 'leave-revocation-failed')) {
          await settleLeaveMarker(pending);
          return state;
        }
        if (inPod && pending === 'wipe') {
          set({ kind: 'leaving', step: 'clearing' });
          if (!(await wipeNow())) {
            fail('wipe-failed');
            return state;
          }
          marker.set(null);
          set({ kind: 'disconnected' });
        } else if (!inPod && podMode.finishing()) {
          // Credentials may still be in web storage and the window loaded no analytics. The
          // only thing to do is delete them; nothing here opens pod-auth.
          marker.set(null);
          set({ kind: 'leaving', step: 'clearing' });
          if (await wipeNow()) await finishLeave(pending !== 'leave-revocation-failed' && pending !== 'done-revocation-failed');
          else fail('wipe-failed');
          return state;
        } else if (pending !== 'done' && pending !== 'done-revocation-failed') {
          marker.set(null);
        }
        const result = await selfTest().catch((): SelfTestResult => ({ ok: false, reason: 'key-not-persistable' }));
        if (!result.ok) {
          set({ kind: 'unsupported', reason: result.reason });
          return state;
        }
        if (pending === 'done') {
          marker.set(null);
          set({ kind: 'disconnected', outcome: 'disconnected' });
        } else if (pending === 'done-revocation-failed') {
          marker.set(null);
          set({ kind: 'signed-out-locally' });
        }
        if (!inPod) return state;
        // A connect the person approved in the dialog in this process waits for a click. Nothing
        // starts a sign-in on its own, and a record merely loaded from disk only restores.
        const fresh = podMode.freshIssuer();
        if (fresh !== null && fresh === podMode.recordedIssuer() && gate() === null) {
          set({ kind: 'ready-to-sign-in', issuer: fresh });
          return state;
        }
        if (state.kind !== 'error') await restore();
        return state;
      })();
      return started;
    },

    async connect(issuerInput) {
      await session.start();
      const k = state.kind;
      if (k !== 'disconnected' && k !== 'error' && k !== 'signed-out-locally') return;
      if (podMode.isPodMode() || podMode.finishing()) return;
      const config = checkConfig(deps.config);
      if (config !== 'ok') return fail(config === 'invalid' ? 'invalid-config' : 'not-configured');
      const issuer = parseIssuerInput(issuerInput, deps.config.allowLoopbackHttp);
      if (issuer === null) return fail('invalid-issuer');
      set({ kind: 'connecting', issuer });
      try {
        const answer = await podMode.requestEnter(issuer);
        if (answer === 'declined') set({ kind: 'disconnected', outcome: 'declined' });
        // 'requested': the app rebuilds this window; the person clicks Continue in the new one.
      } catch {
        fail('request-failed');
      }
    },

    async beginSignIn() {
      if (state.kind !== 'ready-to-sign-in') return;
      const shown = state.issuer;
      let issuer: string;
      try {
        issuer = await podMode.consumeFresh();
      } catch {
        return fail('request-failed');
      }
      if (issuer !== shown) return fail('request-failed');
      await signIn(issuer);
    },

    finishing: () => podMode.finishing(),

    cancel() {
      if (state.kind === 'signing-in') abort?.abort();
      else if (state.kind === 'ready-to-sign-in') set({ kind: 'disconnected' });
    },

    leave() {
      leaving ??= runLeave().finally(() => {
        leaving = null;
      });
      return leaving;
    },

    getFetch() {
      if (state.kind !== 'connected' || !auth) return null;
      if (!originGate) return auth.fetch;
      if (gated?.source !== auth.fetch) gated = { source: auth.fetch, fetch: gateFetch(auth.fetch, originGate) };
      return gated.fetch;
    },
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
    gate: () => gatePodMode(),
    finishing: () => {
      const host = readHostPodMode();
      return host !== null && !host.enabled && host.credentialsMayExist;
    },
    recordedIssuer: () => readHostPodMode()?.issuer ?? null,
    freshIssuer: () => readHostPodMode()?.freshConnect ?? null,
    requestEnter: (issuer) => enterPodMode({ issuer }, deps),
    consumeFresh: () => consumeFreshConnect(deps),
    requestReload: () => reloadPodWindow(deps),
    leave: () => leavePodMode(async () => undefined, deps),
    credentialsCleared: () => credentialsCleared(deps),
    ...(requests
      ? {
          admission: {
            known: () => {
              const host = readHostPodMode();
              return host === null ? [] : [...(host.issuer === undefined ? [] : [host.issuer]), ...host.storageOrigins];
            },
            request: (origin: string) => addStorageOrigin(origin, deps),
          },
        }
      : {}),
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
