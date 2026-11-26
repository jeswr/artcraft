import { PodGalleryProvider, PodLibraryOpenError, createPodLibraryController, type PodGalleryAccess, type PodGallerySignedOut } from "@storyteller/pod-gallery";
import { usePodSessionState, type PodSession } from "@storyteller/pod-session";
import { type ReactNode, useCallback, useEffect, useMemo } from "react";

/**
 * Offers the pod library to the gallery while a pod is connected. When the session has ended in a
 * pod window that can sign in again, the gallery keeps "My pod" and offers that instead. Otherwise
 * it provides nothing, and nothing is loaded: the code that opens the pod is one dynamic import,
 * made only when the person opens "My pod". Both media loaders are purged when the pod is disconnected,
 * when the signed-in WebID changes and when this host unmounts.
 */
export function PodGalleryHost({ session, children }: { session: PodSession; children: ReactNode }) {
  const state = usePodSessionState(session);
  const webId = state.kind === "connected" ? state.webId : null;

  const currentKey = useCallback(() => {
    const current = session.getState();
    return current.kind === "connected" ? current.webId : "";
  }, [session]);
  const controller = useMemo(
    () =>
      createPodLibraryController({
        // The key is the signed-in WebID: a different one is a different account.
        getSessionKey: () => {
          const current = session.getState();
          return current.kind === "connected" ? current.webId : null;
        },
        build: async (key, signal) => {
          if (!session.getFetch()) throw new PodLibraryOpenError("not-connected");
          const { buildPodLibrary } = await import("./gallery-runtime");
          // The fetch is read per request, so an ended session stops reads instead of reusing it.
          return buildPodLibrary({ getFetch: () => session.getFetch(), getSessionKey: currentKey, webId: key, signal });
        },
      }),
    [session, currentKey],
  );

  useEffect(() => {
    controller.sync();
  }, [controller, webId]);
  useEffect(() => () => controller.dispose(), [controller]);

  const access = useMemo<PodGalleryAccess | null>(() => (webId ? { sessionKey: webId, open: () => controller.open() } : null), [controller, webId]);

  // Re-read on every state change: whether the window can sign in again follows the session's state.
  const canSignInAgain = webId === null && session.canSignInAgain();
  const signedOut = useMemo<PodGallerySignedOut | null>(
    () => (canSignInAgain ? { signInAgain: () => void session.signInAgain() } : null),
    [session, canSignInAgain],
  );

  return (
    <PodGalleryProvider access={access} signedOut={signedOut}>
      {children}
    </PodGalleryProvider>
  );
}
