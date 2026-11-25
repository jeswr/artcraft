import { type PodOrigins, validatePodOrigins } from './origins.js';
import {
  FLAG_ON,
  POD_MODE_FLAG_KEY,
  POD_MODE_ORIGINS_KEY,
  type PodModeDeps,
  type StorageLike,
} from './window-state.js';

function storageOf(deps: PodModeDeps): StorageLike {
  return deps.storage ?? globalThis.localStorage;
}

function reloadOf(deps: PodModeDeps): () => void {
  return deps.reload ?? (() => location.reload());
}

/** Remembered, re-validated origins; null when absent, unreadable or corrupt. Untrusted hints. */
export function readPodOrigins(deps: PodModeDeps = {}): PodOrigins | null {
  try {
    const raw = storageOf(deps).getItem(POD_MODE_ORIGINS_KEY);
    if (raw === null) return null;
    return validatePodOrigins(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Validate, persist origins then flag, then reload so sign-in runs in a clean window. */
export function enterPodMode(origins: PodOrigins, deps: PodModeDeps = {}): void {
  const valid = validatePodOrigins(origins);
  if (valid === null) {
    throw new Error('enterPodMode: origins must be https origins (http only for localhost or 127.0.0.1)');
  }
  const storage = storageOf(deps);
  try {
    storage.setItem(POD_MODE_ORIGINS_KEY, JSON.stringify(valid));
    storage.setItem(POD_MODE_FLAG_KEY, FLAG_ON);
  } catch (e) {
    try {
      storage.removeItem(POD_MODE_FLAG_KEY);
      storage.removeItem(POD_MODE_ORIGINS_KEY);
    } catch {
      // nothing more to do
    }
    throw e;
  }
  reloadOf(deps)();
}

/**
 * Leave pod mode. `wipeCredentials` must delete every stored pod credential (tokens, keys,
 * registrations). The flag is cleared and the window reloaded only after it resolves; if it
 * rejects, the window stays in pod mode and the error is rethrown.
 */
export async function leavePodMode(
  wipeCredentials: () => Promise<void>,
  deps: PodModeDeps = {},
): Promise<void> {
  await wipeCredentials();
  const storage = storageOf(deps);
  storage.removeItem(POD_MODE_FLAG_KEY);
  storage.removeItem(POD_MODE_ORIGINS_KEY);
  reloadOf(deps)();
}
