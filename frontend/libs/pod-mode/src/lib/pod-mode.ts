import { buildAllowsLoopback, type PodOrigins, parseOrigin, validatePodOrigins } from './origins.js';
import {
  type AddOriginResult,
  type EnterResult,
  type OriginPurpose,
  FLAG_ON,
  latchedHostPodMode,
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

/** The origins this window runs under: `issuer` and every admitted storage origin. */
export type PodModeOrigins = { issuer?: string; storageOrigins: string[] };

/**
 * Origins for the window's narrowing policy. With a shell they are its persisted, natively
 * confirmed record (re-validated here); without one they are the dev fallback's remembered
 * hints. Null when absent, unreadable or corrupt.
 */
export function readPodModeOrigins(deps: PodModeDeps = {}): PodModeOrigins | null {
  const host = latchedHostPodMode(deps);
  if (host !== null) {
    if (!host.enabled) return null;
    const storageOrigins = host.storageOrigins.map((o) => parseOrigin(o, buildAllowsLoopback()));
    if (storageOrigins.some((o) => o === null)) return null;
    if (host.issuer === undefined) return { storageOrigins: storageOrigins as string[] };
    const issuer = parseOrigin(host.issuer, buildAllowsLoopback());
    return issuer === null ? null : { issuer, storageOrigins: storageOrigins as string[] };
  }
  const hint = readPodOrigins(deps);
  if (hint === null) return null;
  return { issuer: hint.issuer, storageOrigins: hint.storage === undefined ? [] : [hint.storage] };
}

/** Dev fallback only: remembered, re-validated origins from localStorage. Untrusted hints. */
export function readPodOrigins(deps: PodModeDeps = {}): PodOrigins | null {
  try {
    const raw = storageOf(deps).getItem(POD_MODE_ORIGINS_KEY);
    if (raw === null) return null;
    return validatePodOrigins(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Ask to enter pod mode. With a shell this is a request: the shell shows a native dialog that
 * names the issuer, persists the record on approval and rebuilds the window, so the page can
 * never choose its own origins. Resolves `declined` when the user said no. Without a shell
 * (plain browser, dev server) it writes the localStorage fallback and reloads.
 */
export async function enterPodMode(origins: PodOrigins, deps: PodModeDeps = {}): Promise<EnterResult> {
  const valid = validatePodOrigins(origins);
  if (valid === null) {
    throw new Error('enterPodMode: origins must be https origins (http only for localhost or 127.0.0.1)');
  }
  if (deps.requests) return deps.requests.requestEnter({ issuer: valid.issuer });
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
  return 'requested';
}

/** Ask to admit one more storage origin, after a native confirmation. Requires a shell. */
export async function addStorageOrigin(origin: string, purpose: OriginPurpose, deps: PodModeDeps = {}): Promise<AddOriginResult> {
  const valid = parseOrigin(origin, buildAllowsLoopback());
  if (valid === null) throw new Error('addStorageOrigin: not an origin');
  if (!deps.requests) throw new Error('addStorageOrigin: needs the desktop shell');
  return deps.requests.requestAddStorageOrigin(valid, purpose);
}

/**
 * Leave pod mode. `wipeCredentials` must delete every stored pod credential (tokens, keys,
 * registrations). The shell is asked to leave, and the window to reload, only after it
 * resolves; if it rejects, the window stays in pod mode and the error is rethrown. The shell
 * cannot verify that the wipe happened, so this order is the control.
 */
export async function leavePodMode(wipeCredentials: () => Promise<void>, deps: PodModeDeps = {}): Promise<void> {
  await wipeCredentials();
  if (deps.requests) return deps.requests.requestLeave();
  const storage = storageOf(deps);
  storage.removeItem(POD_MODE_FLAG_KEY);
  storage.removeItem(POD_MODE_ORIGINS_KEY);
  reloadOf(deps)();
}

/** Rebuild this window without changing the mode (the shell, or a plain reload as fallback). */
export async function reloadPodWindow(deps: PodModeDeps = {}): Promise<void> {
  if (deps.requests) return deps.requests.requestReload();
  reloadOf(deps)();
}

/** A wipe succeeded in a window that is not in pod mode. Requires a shell. */
export async function credentialsCleared(deps: PodModeDeps = {}): Promise<void> {
  if (!deps.requests) return reloadOf(deps)();
  return deps.requests.requestCredentialsCleared();
}

/** The click that starts a fresh sign-in: the issuer the person approved, once. Requires a shell. */
export async function consumeFreshConnect(deps: PodModeDeps = {}): Promise<string> {
  if (!deps.requests) throw new Error('consumeFreshConnect: needs the desktop shell');
  return deps.requests.requestConsumeFresh();
}
