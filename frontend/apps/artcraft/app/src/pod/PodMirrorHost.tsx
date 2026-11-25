import { useSignals } from "@preact/signals-react/runtime";
import { createPublicBytesFetcher, openMirrorJournal, PodMirror } from "@storyteller/pod-mirror";
import { PodMirrorViewProvider, type PodMirrorView } from "@storyteller/pod-mirror-ui";
import { usePodSessionState, type PodSession } from "@storyteller/pod-session";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { authentication } from "~/signals";
import { createHostedClient } from "./mirror-hosted";
import { createCdnBytesFetcher } from "./mirror-bytes";
import { createTauriMirrorEvents } from "./mirror-events";
import { browserNetworkPort, sessionPortFor } from "./mirror-ports";
import { createStoreOpener } from "./mirror-store";

/**
 * Copies the hosted library to the pod while a pod is connected. Everything under it can read
 * item states through `@storyteller/pod-mirror-ui`; without a connected pod, and without a
 * hosted username, nothing is built and nothing renders.
 */
export function PodMirrorHost({ session, children }: { session: PodSession; children: ReactNode }) {
  useSignals();
  const state = usePodSessionState(session);
  const webId = state.kind === "connected" ? state.webId : null;
  const username = authentication.userInfo.value?.username ?? null;
  const [mirror, setMirror] = useState<PodMirror | null>(null);
  // Bumped after "forget this account" so a fresh mirror (with a new watermark) takes over.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!webId || !username) return;
    let cancelled = false;
    let built: PodMirror | null = null;
    let closeJournal: (() => void) | null = null;
    void (async () => {
      let journal;
      try {
        journal = await openMirrorJournal();
      } catch {
        return; // no durable journal, no mirror: a copy that cannot be remembered is not started
      }
      if (cancelled) {
        journal.close();
        return;
      }
      closeJournal = () => journal.close();
      built = new PodMirror({
        account: { webId, username },
        journal,
        hosted: createHostedClient(username),
        openStore: createStoreOpener({ podFetch: () => session.getFetch(), webId, journal }),
        fetchPublicBytes: createCdnBytesFetcher(createPublicBytesFetcher()),
        session: sessionPortFor(session, webId),
        network: browserNetworkPort(),
        events: createTauriMirrorEvents(),
        reconcileIntervalMs: 10 * 60_000,
      });
      setMirror(built);
      await built.start();
    })();
    return () => {
      cancelled = true;
      setMirror(null);
      const stopping = built?.stop();
      void Promise.resolve(stopping).finally(() => closeJournal?.());
    };
  }, [session, webId, username, generation]);

  const forgetAccount = useCallback(async () => {
    await mirror?.forgetAccount();
    setGeneration((value) => value + 1);
  }, [mirror]);

  const view = useMemo<PodMirrorView | null>(
    () =>
      mirror && {
        stateOf: (token) => mirror.stateOf(token),
        summary: () => mirror.summary(),
        subscribe: (listener) => mirror.subscribe(listener),
        retry: (token) => mirror.retry(token),
        forgetAccount,
      },
    [mirror, forgetAccount],
  );

  return <PodMirrorViewProvider view={view}>{children}</PodMirrorViewProvider>;
}
