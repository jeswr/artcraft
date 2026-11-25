import { createPublicBytesFetcher, openMirrorJournal, PodMirror } from "@storyteller/pod-mirror";
import type { PodSession } from "@storyteller/pod-session";
import { createHostedClient } from "./mirror-hosted";
import { createTauriMirrorEvents } from "./mirror-events";
import { browserNetworkPort, sessionPortFor } from "./mirror-ports";
import { createStoreOpener } from "./mirror-store";

/** Wait between two pod lookups when the pod copies are checked, so a large library is asked gently. */
export const POD_CHECK_PACE_MS = 25;

/** How often the library is walked again while the app runs (new items also trigger a walk). */
export const RECONCILE_INTERVAL_MS = 10 * 60_000;

export interface MirrorDeps {
  session: PodSession;
  webId: string;
  /** The hosted username the mirror copies for. */
  username: string;
  /** The hosted username signed in right now; deletions are only checked while it matches. */
  currentUsername: () => string | null;
  /** The hosted API origin in use right now (it can be changed while the app runs). */
  currentHost?: () => string;
}

export interface RunningMirror {
  mirror: PodMirror;
  /** Stops the mirror, waits for what is in flight, then closes the journal. */
  dispose(): Promise<void>;
}

/**
 * Builds and starts the mirror. Everything the mirror needs is imported here and nowhere on
 * the app's start-up path, so a window that never connects a pod never loads any of it. Throws
 * when the durable journal cannot be opened: a copy that cannot be remembered is not started.
 */
export async function startPodMirror({ session, webId, username, currentUsername, currentHost }: MirrorDeps): Promise<RunningMirror> {
  const journal = await openMirrorJournal();
  const mirror = new PodMirror({
    account: { webId, username },
    journal,
    hosted: createHostedClient(username, currentUsername, currentHost),
    openStore: createStoreOpener({ podFetch: () => session.getFetch(), webId, journal }),
    fetchPublicBytes: createPublicBytesFetcher(),
    session: sessionPortFor(session, webId),
    network: browserNetworkPort(),
    events: createTauriMirrorEvents(),
    reconcileIntervalMs: RECONCILE_INTERVAL_MS,
    podCheckPaceMs: POD_CHECK_PACE_MS,
  });
  try {
    await mirror.start();
  } catch (error) {
    journal.close();
    throw error;
  }
  return {
    mirror,
    async dispose() {
      await mirror.stop().catch(() => undefined);
      journal.close();
    },
  };
}
