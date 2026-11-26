import { useSignals } from "@preact/signals-react/runtime";
import type { PodMirror } from "@storyteller/pod-mirror";
import { PodMirrorViewProvider, type PodMirrorView } from "@storyteller/pod-mirror-ui";
import { usePodSessionState, type PodSession } from "@storyteller/pod-session";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authentication } from "~/signals";

/**
 * Copies the hosted library to the pod while a pod is connected and its storage is known. Everything under it can read
 * item states through `@storyteller/pod-mirror-ui`. Without a connected pod, or without a
 * hosted username, nothing is built, nothing is loaded and nothing renders: the mirror's code
 * is one dynamic import made only when both exist.
 */
export function PodMirrorHost({ session, children }: { session: PodSession; children: ReactNode }) {
  useSignals();
  const state = usePodSessionState(session);
  // While pod-auth knows no storage for the WebID, every pod request would go out anonymous and be
  // refused, so the mirror does not start; Settings says why. Reopening ArtCraft after the profile
  // is fixed connects with storage known, and the mirror starts then.
  const webId = state.kind === "connected" && !state.storageUnknown ? state.webId : null;
  const username = authentication.userInfo.value?.username ?? null;
  const [mirror, setMirror] = useState<PodMirror | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // Bumped after "forget this account" so a fresh mirror (with a new baseline) takes over.
  const [generation, setGeneration] = useState(0);
  // Settles once the mirror of the previous effect run has stopped. The next one starts only
  // then, so two mirrors never run over the same journal at once.
  const stopped = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (!webId || !username) return;
    let cancelled = false;
    let running: { dispose(): Promise<void> } | null = null;
    setUnavailable(false);
    const previous = stopped.current;
    const run = (async () => {
      await previous;
      if (cancelled) return;
      const { startPodMirror } = await import("./mirror-runtime");
      const started = await startPodMirror({ session, webId, username, currentUsername: () => authentication.userInfo.peek()?.username ?? null });
      if (cancelled) {
        await started.dispose();
        return;
      }
      running = started;
      setMirror(started.mirror);
    })().catch(() => {
      if (!cancelled) setUnavailable(true);
    });
    return () => {
      cancelled = true;
      setMirror(null);
      // A start still in flight disposes its own mirror when it finishes (above); either way this
      // run counts as stopped only after its mirror's dispose has settled.
      stopped.current = run.then(() => running?.dispose()).catch(() => undefined);
    };
  }, [session, webId, username, generation]);

  const forgetAccount = useCallback(async () => {
    await mirror?.forgetAccount();
    setGeneration((value) => value + 1);
  }, [mirror]);

  const view = useMemo<PodMirrorView | null>(() => {
    if (mirror) {
      return {
        stateOf: (token) => mirror.stateOf(token),
        summary: () => mirror.summary(),
        subscribe: (listener) => mirror.subscribe(listener),
        retry: (token) => mirror.retry(token),
        retryAllFailed: () => mirror.retryAllFailed(),
        recheckExposure: () => mirror.recheckExposure(),
        removeGoneFromPod: () => mirror.removeGoneFromPod(),
        copyAgain: () => mirror.copyAgain(),
        confirmPrivate: () => mirror.confirmPrivate(),
        import: {
          estimate: () => mirror.estimateImport(),
          start: (total) => mirror.startImport(total),
          pause: () => mirror.pauseImport(),
          resume: () => mirror.resumeImport(),
          cancel: () => mirror.cancelImport(),
        },
        forgetAccount,
      };
    }
    return unavailable ? UNAVAILABLE_VIEW : null;
  }, [mirror, unavailable, forgetAccount]);

  return <PodMirrorViewProvider view={view}>{children}</PodMirrorViewProvider>;
}

const NOTHING = () => undefined;
const UNAVAILABLE_SUMMARY = {
  version: 0,
  running: false,
  paused: "stopped",
  exposureTarget: null,
  counts: { saved: 0, pending: 0, failed: 0, skipped: 0, removing: 0 },
  goneFromArtcraft: 0,
  mediaHostBlocked: false,
  import: { state: "idle", pausedBy: null, walked: 0, total: null, saved: 0, skipped: 0, failed: 0, pending: 0, startedAt: null, finishedAt: null },
} as const;

/** What the person sees when the local record could not be opened: no mirror, and a line saying so. */
const UNAVAILABLE_VIEW: PodMirrorView = {
  stateOf: () => undefined,
  summary: () => UNAVAILABLE_SUMMARY,
  subscribe: () => NOTHING,
  retry: async () => undefined,
  retryAllFailed: async () => 0,
  recheckExposure: NOTHING,
  removeGoneFromPod: async () => 0,
  confirmPrivate: async () => false,
  forgetAccount: async () => undefined,
  unavailable: true,
};
