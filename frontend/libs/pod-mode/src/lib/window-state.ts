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
  /** The shell added the narrowing policy to this document's response headers. */
  headerPolicy: boolean;
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
};

export type EnterResult = 'requested' | 'declined';

/** The shell's commands. None of them carries a credential. */
export type PodModeRequests = {
  /** Asks to enter pod mode for `issuer`. The shell shows a native confirmation. */
  requestEnter(origins: { issuer: string }): Promise<EnterResult>;
  /** Asks to admit one more storage origin. The shell shows a native confirmation. */
  requestAddStorageOrigin(origin: string): Promise<EnterResult>;
  /** Leaves pod mode. The caller has already wiped the credentials. */
  requestLeave(): Promise<void>;
  /** Rebuilds the window, staying in the current mode. */
  requestReload(): Promise<void>;
};

type WindowState = {
  podMode: boolean;
  analyticsLoaded: boolean;
  headerPolicy: boolean;
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
  const closed: HostPodMode = { enabled: true, storageOrigins: [], headerPolicy: false };
  if (typeof raw !== 'object' || raw === null) return closed;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== 'boolean' || typeof r.headerPolicy !== 'boolean' || !Array.isArray(r.storageOrigins)) return closed;
  if (!r.storageOrigins.every((o) => typeof o === 'string')) return closed;
  if (r.issuer !== undefined && typeof r.issuer !== 'string') return closed;
  return {
    enabled: r.enabled,
    ...(r.issuer === undefined ? {} : { issuer: r.issuer as string }),
    storageOrigins: [...(r.storageOrigins as string[])],
    headerPolicy: r.headerPolicy,
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
  return (h[KEY] = { podMode, analyticsLoaded: false, headerPolicy: host?.headerPolicy === true && host.enabled, metaPolicy: false, host });
}

/** The shell's record as latched at load, or null when there is no shell. */
export function latchedHostPodMode(deps: PodModeDeps = {}): HostPodMode | null {
  return state(deps).host;
}

/** A narrowing policy is in force: the shell's response header or an inserted meta element. */
export function podPolicyApplied(deps: PodModeDeps = {}): boolean {
  const s = state(deps);
  return s.podMode && (s.headerPolicy || s.metaPolicy);
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

export function analyticsAllowed(deps: PodModeDeps = {}): boolean {
  return !isPodMode(deps);
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
