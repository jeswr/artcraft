import { PodGalleryProvider, PodLibraryOpenError, createPodLibraryController, type PodGalleryAccess, type PodGallerySignedOut, type PodGallerySignInStep } from "@storyteller/pod-gallery";
import { ERROR_TEXT, usePodSessionState, type PodSession, type PodSessionState } from "@storyteller/pod-session";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

const DECLINED_TEXT = "You declined in ArtCraft's dialog. Choose Sign in again to be asked again.";

/**
 * Offers the pod library to the gallery while a pod is connected. When the session has ended in a
 * pod window that can sign in again, the gallery keeps "My pod" and offers that instead; while a pod
 * window is part-way through signing in (after "Sign in again" reloaded it), "My pod" shows the step
 * and its next click, so the person can finish there instead of in Settings. Otherwise
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
  const step = useMemo(() => (webId === null ? signInStep(state, session) : null), [state, session, webId]);
  const offered = canSignInAgain || followUp !== null || step !== null;
  const asking = followUp?.asking ?? false;
  // Without a press in this page (a reloaded pod window whose sign-in step failed), still say what
  // failed, so "Sign in again" is not offered under the generic "session ended" text alone.
  const problem = followUp?.problem ?? (webId === null ? unpressedProblem(state) : null);
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
            step,
          }
        : null,
    [session, offered, asking, problem, canSignInAgain, step],
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

/**
 * What the gallery says about an error this page did not cause with a press. An ended session needs
 * no line of its own: the signed-out text already says so.
 */
function unpressedProblem(state: PodSessionState): string | null {
  return state.kind === "error" && state.error !== "session-ended" ? ERROR_TEXT[state.error] : null;
}

/**
 * A sign-in in progress in a pod window, as "My pod" shows it: what is happening, and the next step
 * when it is the person's click (the same click Settings offers). Allowing a new address is left to
 * Settings, which explains it in full. Null in any other state.
 */
function signInStep(state: PodSessionState, session: PodSession): PodGallerySignInStep | null {
  switch (state.kind) {
    case "ready-to-sign-in":
    case "needs-approval":
    case "confirm-provider":
    case "signing-in":
      break;
    default:
      return null;
  }
  if (!session.inPodMode()) return null;
  switch (state.kind) {
    case "ready-to-sign-in":
      return {
        status: `${state.approved ? `You allowed ${state.approved}` : `You confirmed ${state.issuer}`} in ArtCraft's dialog. Nothing has started yet; your browser opens only after you continue and then choose to sign in.`,
        action: { label: "Continue sign-in", press: () => void session.beginSignIn() },
      };
    case "needs-approval":
      // Whether to allow an address needs the full explanation, which only Settings gives.
      return {
        status: `Going on needs ArtCraft to be allowed to contact ${state.origin}. Settings, under Solid pod, says what it is for and lets you allow it.`,
        action: null,
      };
    case "confirm-provider":
      return {
        status: `You sign in at ${state.provider}. Your browser opens there when you choose to; Settings, under Solid pod, can cancel.`,
        action: { label: `Sign in at ${state.provider}`, press: () => session.openBrowser() },
      };
    case "signing-in":
      return {
        status: state.provider
          ? `Waiting for your browser to finish signing in at ${state.provider}. Your pod shows here once you are back.`
          : "Preparing your sign-in. Your browser has not opened yet.",
        action: null,
      };
  }
}
