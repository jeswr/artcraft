import { PodGalleryProvider, PodLibraryOpenError, createPodLibraryController, type PodGalleryAccess, type PodGallerySignedOut } from "@storyteller/pod-gallery";
import { ERROR_TEXT, usePodSessionState, type PodSession, type PodSessionState } from "@storyteller/pod-session";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

const DECLINED_TEXT = "You declined in ArtCraft's dialog. Choose Sign in again to be asked again.";

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

  // Set by a press of "Sign in again" here: from then on "My pod" stays while the app asks and after
  // its answer, which the gallery shows, instead of switching to the ArtCraft library.
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    if (webId !== null) setPressed(false);
  }, [webId]);
  // Re-read on every state change: whether the window can sign in again follows the session's state.
  const canSignInAgain = webId === null && session.canSignInAgain();
  const followUp = pressed && webId === null ? afterPress(state) : null;
  const offered = canSignInAgain || followUp !== null;
  const asking = followUp?.asking ?? false;
  const problem = followUp?.problem ?? null;
  const signedOut = useMemo<PodGallerySignedOut | null>(
    () =>
      offered
        ? {
            signInAgain: () => {
              setPressed(true);
              void session.signInAgain();
            },
            asking,
            problem,
            canPress: canSignInAgain,
          }
        : null,
    [session, offered, asking, problem, canSignInAgain],
  );

  return (
    <PodGalleryProvider access={access} signedOut={signedOut}>
      {children}
    </PodGalleryProvider>
  );
}

/**
 * What the gallery says after a press of "Sign in again": asking while the app's dialog is open, and
 * the answer when it did not lead to a sign-in. Null for a state that is not an answer to the press.
 */
function afterPress(state: PodSessionState): { asking: boolean; problem: string | null } | null {
  if (state.kind === "connecting") return { asking: true, problem: null };
  if (state.kind === "disconnected") return { asking: false, problem: state.outcome === "declined" ? DECLINED_TEXT : null };
  if (state.kind === "error") return { asking: false, problem: ERROR_TEXT[state.error] };
  return null;
}
