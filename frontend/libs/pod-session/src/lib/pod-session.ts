import {
  addStorageOrigin,
  consumeFreshConnect,
  credentialsCleared,
  enterPodMode,
  gatePodMode,
  isPodMode,
  leavePodMode,
  type OriginPurpose,
  parseOrigin,
  type PodGate,
  type PodModeRequests,
  readHostPodMode,
  reloadPodWindow,
} from '@storyteller/pod-mode';
import { checkConfig, type ConfigCheck, type PodSessionConfig } from './config.js';
import { parseSignInInput } from './issuer.js';
import { localStoragePending, originOfHint, type PendingStore, type SignInHint } from './pending.js';
import { runSelfTest, type SelfTestResult } from './self-test.js';
import { type SignInGate, SignInNotInProgressError } from './sign-in-gate.js';
import type { PodSessionErrorKind, PodSessionState } from './state.js';
import { createOriginGate, gateFetch, isInvalidInjectedResponse, type OriginAdmission, refusalOf } from './storage-origins.js';
import type { WipeOutcome } from './wipe.js';

/** What the session hands pod-auth when it builds one. */
export type AuthOptions = {
  /** pod-auth's transport for its own unauthenticated reads: the origin gate in explain-first mode. */
  fetch?: typeof fetch;
  /**
   * Called with the address pod-auth is about to open in the system browser; the browser opens
   * only after it resolves. The session uses it to show the person the provider's origin and wait
   * for their click.
   */
  confirmOpen?: (url: string) => Promise<void>;
  /**
   * Asked before pod-auth may open the system browser. It returns only while the sign-in the
   * person started with `beginSignIn` is in progress, and only once for that attempt; otherwise
   * it throws `SignInNotInProgressError` and the session ends (see `getFetch`).
   */
  authorizeSignIn?: SignInGate;
};

/** The part of `@jeswr/pod-auth`'s `PodAuth` this machine uses. */
export interface PodAuthPort {
  login(hint: { issuer: string } | { webId: string }, options: { signal: AbortSignal }): Promise<{ webId: string | null }>;
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
  requestEnter(issuer: string): Promise<'requested' | 'declined' | 'too-fast'>;
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
  /**
   * Builds a fresh pod-auth. Called only where credentials may be read or created.
   * `options.fetch` is pod-auth's transport for its own unauthenticated reads: the origin gate in
   * its explain-first mode. Absent where there is no shell (a plain browser). `options.confirmOpen`
   * holds the system browser until the person has seen the provider's origin and clicked.
   */
  createAuth(options?: AuthOptions): PodAuthPort;
  /** Deletes every locally stored pod credential. Rejects when it cannot; `deferred` is not done. */
  wipeStores(): Promise<WipeOutcome>;
  selfTest?: () => Promise<SelfTestResult>;
  podMode?: PodModePort;
  marker?: Marker;
  /** The hint typed and the origin approved while a sign-in waits for a window rebuild. */
  pending?: PendingStore;
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
  /**
   * From `confirm-provider`: the person clicked "Sign in at <provider>", so the system browser
   * opens. Never called by anything but that click.
   */
  openBrowser(): void;
  /** Abandons a sign-in that is waiting for the browser, or for the click that opens it. */
  cancel(): void;
  /**
   * From `needs-approval`: asks the app to let this window contact the address pod-auth needs
   * (native dialog; the window reloads when it is allowed). A sign-in is then offered again; a
   * restore simply runs again. A decline ends in `error('origin-declined')`.
   */
  approveOrigin(): Promise<void>;
  /** From an error that left the stored session alone (a declined address): tries the restore again. */
  retry(): Promise<void>;
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
  const pending = deps.pending ?? localStoragePending(undefined, deps.config.allowLoopbackHttp);

  let state: PodSessionState = { kind: 'disconnected' };
  const listeners = new Set<(state: PodSessionState) => void>();
  let auth: PodAuthPort | null = null;
  let abort: AbortController | null = null;
  /**
   * The one sign-in the person started and is still waiting for. It is the only thing that may
   * open the system browser, and it may do so once. An attempt that finished, failed or was
   * aborted is gone from here, so what it built can no longer authorise anything.
   */
  type Attempt = { controller: AbortController; browserOpened: boolean };
  let attempt: Attempt | null = null;
  let started: Promise<PodSessionState> | null = null;
  let leaving: Promise<void> | null = null;
  const originGate = podMode.admission ? createOriginGate(podMode.admission, deps.config.allowLoopbackHttp) : null;
  let gated: { source: typeof fetch; fetch: typeof fetch } | null = null;
  // pod-auth's own reads: an unlisted origin is refused at once so the page can explain first.
  const authFetch: typeof fetch | undefined = originGate ? gateFetch((input, init) => globalThis.fetch(input, init), originGate, { prompt: false }) : undefined;
  // What the displayed `ready-to-sign-in` offered: used by the click, never re-read from storage.
  let offered: { hint: SignInHint; fresh: string } | null = null;
  let signingFor: { hint: SignInHint; issuer: string } | null = null;
  let confirming: { resolve: () => void; reject: (reason: unknown) => void } | null = null;

  /** Holds the system browser until the person has seen the provider's origin and clicked. */
  const confirmOpen = (url: string): Promise<void> => {
    let provider: string | null = null;
    try {
      provider = parseOrigin(new URL(url).origin, deps.config.allowLoopbackHttp);
    } catch {
      provider = null;
    }
    if (provider === null || signingFor === null) return Promise.reject(new Error('not an origin'));
    const signal = abort?.signal;
    const shown = provider;
    const typed = signingFor.hint;
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
      const entry = { resolve, reject };
      confirming = entry;
      signal?.addEventListener(
        'abort',
        () => {
          if (confirming === entry) confirming = null;
          reject(signal.reason ?? new Error('aborted'));
        },
        { once: true },
      );
      set({ kind: 'confirm-provider', provider: shown, ...(typed.kind === 'webid' ? { webId: typed.webId } : {}) });
    });
  };
  /**
   * A pod-auth that may open the browser only for `owner`, the attempt it is built for. One built
   * with `null` (a restore, a revoke) never may, and neither may the one a finished attempt left
   * behind to serve reads: a read whose token cannot be renewed ends the session instead.
   */
  const buildAuth = (owner: Attempt | null): PodAuthPort =>
    deps.createAuth({
      ...(authFetch ? { fetch: authFetch } : {}),
      confirmOpen,
      authorizeSignIn: () => {
        if (owner !== null && attempt === owner && !owner.controller.signal.aborted && !owner.browserOpened) {
          owner.browserOpened = true;
          return;
        }
        // Nothing the person is waiting for asked for this: a background read, or a second ask.
        if (state.kind === 'connected') sessionEnded();
        throw new SignInNotInProgressError();
      },
    });

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

  /**
   * The connected session can no longer renew its token without the person: nothing may use its
   * fetch, so the mirror pauses and the gallery asks to sign in again. The stored sign-in is kept
   * so "Try again" can restore it; leaving pod mode removes it.
   */
  function sessionEnded(): void {
    releaseAuth();
    fail('restore-failed');
  }

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
        auth = buildAuth(null);
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

  /** The pod-auth login hint for what the person typed. */
  const loginHint = (hint: SignInHint) => (hint.kind === 'webid' ? { webId: hint.webId } : { issuer: hint.issuer });

  async function signIn(hint: SignInHint, origin: string): Promise<void> {
    const blocked = gate();
    if (blocked !== null) return fail(blocked);
    const controller = new AbortController();
    abort = controller;
    const mine: Attempt = { controller, browserOpened: false };
    attempt = mine;
    signingFor = { hint, issuer: origin };
    set({ kind: 'signing-in', issuer: origin });
    try {
      // A fresh sign-in starts from empty stores: anything already there was not written by
      // this window's own sign-in. A delete that is only queued is not empty.
      if ((await deps.wipeStores()) !== 'wiped') return fail('wipe-failed');
      if (controller.signal.aborted) return settleCancelled();
      const created = buildAuth(mine);
      auth = created;
      const identity = await created.login(loginHint(hint), { signal: controller.signal });
      if (controller.signal.aborted) {
        await scrub();
        return settleCancelled();
      }
      if (identity.webId === null) {
        await scrub();
        pending.set(null);
        return fail('sign-in-failed');
      }
      pending.set(null);
      set({ kind: 'connected', webId: identity.webId });
    } catch (error) {
      // Tokens may already be stored when the failure came after the exchange.
      await scrub();
      if (controller.signal.aborted) return settleCancelled();
      settleFailure(error, 'sign-in', hint);
    } finally {
      if (abort === controller) abort = null;
      if (attempt === mine) attempt = null;
      confirming = null;
      signingFor = null;
    }
  }

  /**
   * A failure that may be the origin gate speaking: an address that is not allowed yet is
   * explained first (`needs-approval`; what the person typed is kept so the sign-in can be
   * offered again after the window reloads), a final refusal is reported as such, and a
   * document pod-auth could not accept is a plain failure. Anything else is classified as before.
   */
  function settleFailure(error: unknown, phase: 'sign-in' | 'restore', hint?: SignInHint): void {
    const refusal = refusalOf(error);
    if (refusal?.reason === 'needs-approval') {
      const purpose = purposeOf(refusal.origin, phase, hint);
      if (phase === 'sign-in' && hint) pending.set({ hint, origin: refusal.origin, purpose });
      return set({ kind: 'needs-approval', origin: refusal.origin, phase, purpose, ...(hint?.kind === 'webid' ? { webId: hint.webId } : {}) });
    }
    if (phase === 'sign-in') pending.set(null);
    if (refusal) return fail(refusal.reason === 'limit' ? 'origin-limit' : refusal.reason === 'declined' ? 'origin-declined' : phase === 'restore' ? 'restore-failed' : 'sign-in-failed');
    if (isInvalidInjectedResponse(error)) return fail('invalid-response');
    fail(phase === 'restore' ? 'restore-failed' : classify(error));
  }

  /**
   * What the page tells the app an address is for. It is the page's best reading of which read
   * pod-auth was making (the app cannot check it, and says so): a stored session needs a pod;
   * ArtCraft's own identity document has its own host; with a typed WebID, any other address is
   * the provider the profile named; with a typed provider, it is where the profile is.
   */
  function purposeOf(origin: string, phase: 'sign-in' | 'restore', hint?: SignInHint): OriginPurpose {
    if (phase === 'restore') return 'storage';
    let clientOrigin: string | null = null;
    try {
      clientOrigin = new URL(deps.config.clientId).origin;
    } catch {
      clientOrigin = null;
    }
    if (origin === clientOrigin) return 'app-identity';
    if (hint?.kind === 'webid' && origin !== originOfHint(hint, deps.config.allowLoopbackHttp)) return 'sign-in';
    return 'profile';
  }

  async function restore(): Promise<void> {
    const blocked = gate();
    if (blocked !== null) return fail(blocked);
    try {
      const created = buildAuth(null);
      auth = created;
      const identity = await created.restore();
      if (identity?.webId) set({ kind: 'connected', webId: identity.webId });
      else releaseAuth();
    } catch (error) {
      // A refusal is never a reason to drop the stored session: nothing is wiped, so approving
      // the address (or declining) leaves the sign-in data as it was.
      releaseAuth();
      settleFailure(error, 'restore');
    }
  }

  function settleCancelled(): void {
    pending.set(null);
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
    pending.set(null);
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
        const markerPending = marker.get();
        const inPod = podMode.isPodMode();
        if (inPod && (markerPending === 'leave' || markerPending === 'leave-revocation-failed')) {
          await settleLeaveMarker(markerPending);
          return state;
        }
        if (inPod && markerPending === 'wipe') {
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
          if (await wipeNow()) await finishLeave(markerPending !== 'leave-revocation-failed' && markerPending !== 'done-revocation-failed');
          else fail('wipe-failed');
          return state;
        } else if (markerPending !== 'done' && markerPending !== 'done-revocation-failed') {
          marker.set(null);
        }
        const result = await selfTest().catch((): SelfTestResult => ({ ok: false, reason: 'key-not-persistable' }));
        if (!result.ok) {
          set({ kind: 'unsupported', reason: result.reason });
          return state;
        }
        if (markerPending === 'done') {
          marker.set(null);
          set({ kind: 'disconnected', outcome: 'disconnected' });
        } else if (markerPending === 'done-revocation-failed') {
          marker.set(null);
          set({ kind: 'signed-out-locally' });
        }
        if (!inPod) return state;
        // A connect the person approved in the dialog in this process waits for a click. Nothing
        // starts a sign-in on its own, and a record merely loaded from disk only restores.
        // The pending hint is what makes an approval a sign-in rather than a restore: a window
        // rebuilt after an approval for a connected session has none and just restores.
        const fresh = podMode.freshIssuer();
        const waiting = pending.get();
        const recorded = podMode.recordedIssuer();
        // What the approval was for: the address the person was asked about, which is the entered
        // issuer, or the address they then allowed. It must be one the window's policy lists.
        const target = waiting === null ? null : (waiting.origin ?? originOfHint(waiting.hint, deps.config.allowLoopbackHttp));
        const listed = fresh !== null && (fresh === recorded || (podMode.admission?.known().includes(fresh) ?? false));
        if (fresh !== null && recorded !== null && target === fresh && listed && waiting !== null && gate() === null) {
          offered = { hint: waiting.hint, fresh };
          set({
            kind: 'ready-to-sign-in',
            issuer: recorded,
            ...(waiting.hint.kind === 'webid' ? { webId: waiting.hint.webId } : {}),
            ...(waiting.origin ? { approved: waiting.origin } : {}),
            ...(waiting.origin && waiting.purpose ? { purpose: waiting.purpose } : {}),
          });
          return state;
        }
        if (waiting !== null) pending.set(null);
        if (state.kind !== 'error') await restore();
        return state;
      })();
      return started;
    },

    async connect(input) {
      await session.start();
      const k = state.kind;
      if (k !== 'disconnected' && k !== 'error' && k !== 'signed-out-locally') return;
      if (podMode.isPodMode() || podMode.finishing()) return;
      const config = checkConfig(deps.config);
      if (config !== 'ok') return fail(config === 'invalid' ? 'invalid-config' : 'not-configured');
      const typed = parseSignInInput(input, deps.config.allowLoopbackHttp);
      if (typed === null) return fail('invalid-issuer');
      // For a WebID the app is asked about the profile's own origin: the window must be able to
      // reach it before pod-auth can read the profile and find the provider.
      pending.set({ hint: typed.kind === 'webid' ? { kind: 'webid', webId: typed.webId } : { kind: 'issuer', issuer: typed.issuer } });
      set({ kind: 'connecting', issuer: typed.origin });
      try {
        const answer = await podMode.requestEnter(typed.origin);
        if (answer === 'declined') {
          pending.set(null);
          set({ kind: 'disconnected', outcome: 'declined' });
        } else if (answer === 'too-fast') {
          pending.set(null);
          fail('approval-too-fast');
        }
        // 'requested': the app rebuilds this window; the person clicks Continue in the new one.
      } catch {
        pending.set(null);
        fail('request-failed');
      }
    },

    async beginSignIn() {
      if (state.kind !== 'ready-to-sign-in' || offered === null) return;
      // What the click was offered for: the hint and address the page showed, not a re-read.
      const { hint, fresh } = offered;
      const issuer = state.issuer;
      let approved: string;
      try {
        approved = await podMode.consumeFresh();
      } catch {
        return fail('request-failed');
      }
      if (approved !== fresh) return fail('request-failed');
      offered = null;
      await signIn(hint, issuer);
    },

    async approveOrigin() {
      if (state.kind !== 'needs-approval' || !podMode.admission) return;
      const waiting = state;
      const { origin, phase, purpose } = waiting;
      let answer: Awaited<ReturnType<OriginAdmission['request']>>;
      try {
        answer = await podMode.admission.request(origin, purpose);
      } catch (error) {
        const word = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
        // The app is showing another dialog or still waiting after a refusal: nothing changed, so
        // the person can press Allow again in a moment and what they typed is kept.
        if (word === 'busy' || word === 'cooling_down') return set({ ...waiting, wait: 'busy' });
        pending.set(null);
        if (word === 'refused_origin') return fail('origin-declined');
        if (word === 'too_many_prompts' || word === 'too_many_origins') return fail('origin-limit');
        return fail('request-failed');
      }
      if (answer === 'declined') {
        pending.set(null);
        return fail('origin-declined');
      }
      // Allow came back too fast to be a considered answer: nothing changed, ask again.
      if (answer === 'too-fast') return set({ ...waiting, wait: 'too-fast' });
      // 'requested': the app rebuilds this window and the new one picks up from the pending hint.
      // A window that is still here already had the address listed, so there is nothing to wait for.
      if (phase === 'restore') await restore();
      else {
        pending.set(null);
        fail('request-failed');
      }
    },

    async retry() {
      if (state.kind !== 'error' || !podMode.isPodMode()) return;
      if (state.error !== 'origin-declined' && state.error !== 'restore-failed') return;
      set({ kind: 'disconnected' });
      await restore();
    },

    finishing: () => podMode.finishing(),

    openBrowser() {
      if (state.kind !== 'confirm-provider' || confirming === null || signingFor === null) return;
      const open = confirming;
      confirming = null;
      set({ kind: 'signing-in', issuer: signingFor.issuer, provider: state.provider });
      open.resolve();
    },

    cancel() {
      if (state.kind === 'signing-in' || state.kind === 'confirm-provider') abort?.abort();
      else if (state.kind === 'ready-to-sign-in') {
        pending.set(null);
        set({ kind: 'disconnected' });
      }
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
            request: (origin: string, purpose: OriginPurpose) => addStorageOrigin(origin, purpose, deps),
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
