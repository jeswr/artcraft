import { useSignals } from "@preact/signals-react/runtime";
import type { PodMirror } from "@storyteller/pod-mirror";
import { PodMirrorViewProvider, type PodMirrorView } from "@storyteller/pod-mirror-ui";
import { usePodSessionState, type PodSession } from "@storyteller/pod-session";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { authentication } from "~/signals";

/**
 * Copies the hosted library to the pod while a pod is connected. Everything under it can read
 * item states through `@storyteller/pod-mirror-ui`. Without a connected pod, or without a
 * hosted username, nothing is built, nothing is loaded and nothing renders: the mirror's code
 * is one dynamic import made only when both exist.
 */
export function PodMirrorHost({ session, children }: { session: PodSession; children: ReactNode }) {
  useSignals();
  const state = usePodSessionState(session);
  const webId = state.kind === "connected" ? state.webId : null;
  const username = authentication.userInfo.value?.username ?? null;
  const [mirror, setMirror] = useState<PodMirror | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // Bumped after "forget this account" so a fresh mirror (with a new baseline) takes over.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!webId || !username) return;
    let cancelled = false;
    let running: { dispose(): Promise<void> } | null = null;
    setUnavailable(false);
    void (async () => {
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
      void running?.dispose();
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
        confirmPrivate: () => mirror.confirmPrivate(),
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
