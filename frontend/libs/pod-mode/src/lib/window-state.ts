export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const POD_MODE_FLAG_KEY = 'artcraft.podMode';
export const POD_MODE_ORIGINS_KEY = 'artcraft.podMode.origins';
export const FLAG_ON = '1';

/**
 * What the Tauri shell says about this window, set by an initialization script that runs before
 * any page script and cannot be reassigned. The shell owns pod mode: it persists the record,
 * confirms origins in a native dialog, and (in a bundled build) adds the narrowing policy as
 * a response header. When it is present, the localStorage flag below is not consulted.
 */
export type HostPodMode = {
  enabled: boolean;
  issuer?: string;
  storageOrigins: readonly string[];
  /** The shell sends the pod policy as the response header of this window's documents. */
  headerPolicy: boolean;
  /**
   * Pod mode, or credentials that were never confirmed wiped. While true no analytics load,
   * even in a window that is not in pod mode.
   */
  credentialsMayExist: boolean;
  /**
   * The issuer of a connect the person approved in the shell's dialog in this process. A
   * record merely loaded from disk never carries it, so only an approval can start a fresh
   * sign-in. The shell hands it out once, to a click.
   */
  freshConnect?: string;
};

export const HOST_POD_MODE_KEY = '__ARTCRAFT_POD_MODE__';

export type PodModeDeps = {
  /** Dev-server fallback only: the flag and origins used when there is no shell. */
  storage?: StorageLike;
  reload?: () => void;
  /** Reads the shell's answer; defaults to the initialization script's global. */
  readHost?: () => HostPodMode | null;
  /** Calls into the shell. Absent in a plain browser, where the localStorage fallback is used. */
  requests?: PodModeRequests;
  /** Overrides `import.meta.env.DEV`: a development run may rely on the meta policy alone. */
  dev?: boolean;
};

/** `too-fast`: Allow was pressed sooner than a considered answer; nothing changed, ask again later. */
export type EnterResult = 'requested' | 'declined' | 'too-fast';

export type AddOriginResult = EnterResult;

/**
 * Why the page says it wants an origin added. A closed set the app cannot check: it only changes
 * what the app's dialog says. `sign-in`: the place the person will be asked to sign in, which
 * their profile named. `profile`: where their WebID profile is read from. `storage`: where their
 * pod's files are. `app-identity`: ArtCraft's own published identity document.
 */
export type OriginPurpose = 'profile' | 'storage' | 'sign-in' | 'app-identity';

/** The shell's commands. None of them carries a credential. */
export type PodModeRequests = {
  /** Asks to enter pod mode for `issuer`. The shell shows a native confirmation. */
  requestEnter(origins: { issuer: string }): Promise<EnterResult>;
  /** Asks to admit one more storage origin. The shell shows a native confirmation. */
  requestAddStorageOrigin(origin: string, purpose: OriginPurpose): Promise<AddOriginResult>;
  /** Leaves pod mode. The caller has already wiped the credentials. */
  requestLeave(): Promise<void>;
  /** Rebuilds the window, staying in the current mode. */
  requestReload(): Promise<void>;
  /** A wipe succeeded in a window that is not in pod mode: the shell clears its flag. */
  requestCredentialsCleared(): Promise<void>;
  /** The click that starts a fresh sign-in: the issuer the person approved, once. */
  requestConsumeFresh(): Promise<string>;
};

type WindowState = {
  podMode: boolean;
  analyticsLoaded: boolean;
  metaPolicy: boolean;
  host: HostPodMode | null;
};

// Shared through a global symbol because the bootstrap script and the app bundle are
// separate module instances in the same window.
const KEY = Symbol.for('artcraft.podWindowState');

function holder(): { [KEY]?: WindowState } {
  return globalThis as unknown as { [KEY]?: WindowState };
}

function defaultStorage(): StorageLike | undefined {
  return globalThis.localStorage;
}

/**
 * Raw read of the flag. FAIL CLOSED: if storage is absent or any read throws (blocked site
 * data, sandboxed frame, ...) this returns true, so analytics stay off rather than risk
 * loading third-party scripts into a window that may hold pod credentials. The cost is that
 * an ordinary user with unreadable storage gets the pod policy.
 */
export function readPodModeFlag(deps: PodModeDeps = {}): boolean {
  try {
    const storage = deps.storage ?? defaultStorage();
    if (!storage) return true;
    return storage.getItem(POD_MODE_FLAG_KEY) === FLAG_ON;
  } catch {
    return true;
  }
}

/**
 * The shell's answer, or null when there is none (plain browser). A present but malformed value
 * fails closed: pod mode, no origins, no header policy.
 */
export function readHostPodMode(): HostPodMode | null {
  const raw = (globalThis as Record<string, unknown>)[HOST_POD_MODE_KEY];
  if (raw === undefined) return null;
  const closed: HostPodMode = { enabled: true, storageOrigins: [], headerPolicy: false, credentialsMayExist: true };
  if (typeof raw !== 'object' || raw === null) return closed;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== 'boolean' || typeof r.headerPolicy !== 'boolean' || !Array.isArray(r.storageOrigins)) return closed;
  if (typeof r.credentialsMayExist !== 'boolean') return closed;
  if (r.freshConnect !== undefined && typeof r.freshConnect !== 'string') return closed;
  if (!r.storageOrigins.every((o) => typeof o === 'string')) return closed;
  if (r.issuer !== undefined && typeof r.issuer !== 'string') return closed;
  return {
    enabled: r.enabled,
    ...(r.issuer === undefined ? {} : { issuer: r.issuer as string }),
    storageOrigins: [...(r.storageOrigins as string[])],
    headerPolicy: r.headerPolicy,
    credentialsMayExist: r.credentialsMayExist,
    ...(r.freshConnect === undefined ? {} : { freshConnect: r.freshConnect as string }),
  };
}

function hostOf(deps: PodModeDeps): HostPodMode | null {
  return (deps.readHost ?? readHostPodMode)();
}

function state(deps: PodModeDeps = {}): WindowState {
  const h = holder();
  if (h[KEY]) return h[KEY];
  const host = hostOf(deps);
  // With a shell, its answer is the authority and localStorage is not read at all.
  const podMode = host === null ? readPodModeFlag(deps) : host.enabled;
  return (h[KEY] = { podMode, analyticsLoaded: false, metaPolicy: false, host });
}

/** The shell's record as latched at load, or null when there is no shell. */
export function latchedHostPodMode(deps: PodModeDeps = {}): HostPodMode | null {
  return state(deps).host;
}

/** A narrowing policy is in force: the shell's response header or an inserted meta element. */
export function podPolicyApplied(deps: PodModeDeps = {}): boolean {
  return gatePodMode(deps) === 'ok';
}

/** Called after the narrowing meta policy was inserted into <head>. */
export function markMetaPolicyApplied(): void {
  state().metaPolicy = true;
}

/** Decide pod mode once for this window (first call wins) and return the latched value. */
export function latchPodWindow(deps: PodModeDeps = {}): boolean {
  return state(deps).podMode;
}

/**
 * True when this window was latched into pod mode. The decision is made once, by the
 * bootstrap, and never changes for the life of the window: writing the flag later (for
 * example in enterPodMode, before the reload) does not turn this window into a pod window.
 */
export function isPodMode(deps: PodModeDeps = {}): boolean {
  return state(deps).podMode;
}

/**
 * No analytics in a pod window, and none in an ordinary window the shell says may still hold
 * pod credentials (until a wipe is confirmed).
 */
export function analyticsAllowed(deps: PodModeDeps = {}): boolean {
  return !isPodMode(deps) && latchedHostPodMode(deps)?.credentialsMayExist !== true;
}

export type PodGate = 'ok' | 'not-pod-window' | 'window-not-clean' | 'policy-not-applied';

/**
 * Whether pod-auth may be built in this window. In a production build only the shell's frozen
 * global counts, read afresh each time: pod mode on, and its header policy in force. The
 * writable latch is consulted only for "did an analytics loader ever run". A meta policy alone
 * is accepted only in a development run, where the dev server serves the page and the shell
 * cannot add a header.
 */
export function gatePodMode(deps: PodModeDeps = {}): PodGate {
  const dev = deps.dev ?? import.meta.env?.DEV === true;
  const s = state(deps);
  const host = hostOf(deps);
  if (host !== null) {
    if (!host.enabled) return 'not-pod-window';
    if (s.analyticsLoaded) return 'window-not-clean';
    if (host.headerPolicy) return 'ok';
    return dev && s.metaPolicy ? 'ok' : 'policy-not-applied';
  }
  // No shell: a plain browser. Only a development run may go on, with the meta policy.
  if (!dev) return 'policy-not-applied';
  if (!s.podMode) return 'not-pod-window';
  if (s.analyticsLoaded) return 'window-not-clean';
  return s.metaPolicy ? 'ok' : 'policy-not-applied';
}

/** Called by the analytics loaders: a third-party script may now be running in this window. */
export function markAnalyticsLoaded(): void {
  state().analyticsLoaded = true;
}

/**
 * Session restore (reading stored pod credentials) is allowed only in a pod window in which no
 * analytics loader ever ran.
 */
export function sessionRestoreAllowed(): boolean {
  const s = state();
  return s.podMode && !s.analyticsLoaded;
}

/** Test helper: forget the latch. */
export function resetPodWindowForTests(): void {
  delete holder()[KEY];
}
