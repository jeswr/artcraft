import { isPodMode, readHostPodMode } from "@storyteller/pod-mode";
import {
  createDefaultAuth,
  createPodSession,
  deletePodAuthDatabases,
  hasPendingStep,
  type PodSession,
  type PodSessionConfig,
  readConfig,
  realPodModePort,
} from "@storyteller/pod-session";
import { createTauriPodModeRequests } from "./tauri-requests";
import { tauriDesktopHost } from "./tauri-host";

/** The global the app's initialization script defines (`IDENTIFIER_GLOBAL` in the Rust crate). */
export const APP_IDENTIFIER_KEY = "__ARTCRAFT_APP_IDENTIFIER__";

/**
 * The identifier the app was built with. The redirect scheme comes from it, so a dev overlay
 * (its own identifier) never receives a release build's callback. Empty in a plain browser,
 * which makes the config invalid and keeps sign-in off.
 */
export function readAppIdentifier(scope: object = globalThis): string {
  const value = (scope as Record<string, unknown>)[APP_IDENTIFIER_KEY];
  return typeof value === "string" ? value : "";
}

/** Builds the window's one session. Nothing runs until `start()` is called. */
export function buildPodSession(config: PodSessionConfig, hasShell: boolean): PodSession {
  return createPodSession({
    config,
    createAuth: () => createDefaultAuth(config, tauriDesktopHost),
    wipeStores: () => deletePodAuthDatabases(config),
    podMode: realPodModePort(hasShell ? createTauriPodModeRequests() : undefined),
  });
}

export const podSession = buildPodSession(readConfig(readAppIdentifier()), readHostPodMode() !== null);

/**
 * True in a pod window, which restores or continues a sign-in as soon as it loads, and in any
 * window where a connect or disconnect step is waiting to be settled, so its answer is shown.
 */
export const startPodSessionNow = (): boolean => isPodMode() || hasPendingStep();
