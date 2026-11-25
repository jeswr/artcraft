export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const POD_MODE_FLAG_KEY = 'artcraft.podMode';
export const POD_MODE_ORIGINS_KEY = 'artcraft.podMode.origins';
export const FLAG_ON = '1';

export type PodModeDeps = {
  storage?: StorageLike;
  reload?: () => void;
};

type WindowState = { podMode: boolean; analyticsLoaded: boolean };

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

function state(deps: PodModeDeps = {}): WindowState {
  const h = holder();
  return (h[KEY] ??= { podMode: readPodModeFlag(deps), analyticsLoaded: false });
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
