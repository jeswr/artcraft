import { createContext, type ReactNode, useContext } from 'react';
import type { PodLibrary } from './library.js';

/** What the gallery needs to reach the pod library of the connected account. */
export interface PodGalleryAccess {
  /** The signed-in WebID. A different one is a different account: a new access object. */
  readonly sessionKey: string;
  open(): Promise<PodLibrary>;
}

/**
 * A pod window whose session has ended: the pod cannot be read, but the person can sign in again.
 * The gallery keeps "My pod" and says so there, instead of quietly showing the ArtCraft library.
 */
export interface PodGallerySignedOut {
  /** The person's click on "Sign in again". Never called by anything else. */
  signInAgain(): void;
  /** True while the app is asking the person in its dialog: the button waits. */
  readonly asking?: boolean;
  /** What came of the last press, in words, when it did not lead to a sign-in. */
  readonly problem?: string | null;
  /** False when pressing again cannot help (the app's limit for this run is reached). Default true. */
  readonly canPress?: boolean;
  /**
   * Set while a pod window is part-way through signing in (after "Sign in again" reloaded it, for
   * example). "My pod" then shows this step instead of "Sign in again".
   */
  readonly step?: PodGallerySignInStep | null;
}

/** One step of a sign-in in progress, as "My pod" shows it. */
export interface PodGallerySignInStep {
  /** What is happening, in words. */
  readonly status: string;
  /** The next step when it is the person's: called only from their click. */
  readonly action?: { readonly label: string; press(): void } | null;
}

const PodGalleryContext = createContext<PodGalleryAccess | null>(null);
const PodGallerySignedOutContext = createContext<PodGallerySignedOut | null>(null);

/**
 * Offers "My pod" below it. Without a connected pod `access` is null; `signedOut` is set when the
 * session ended and can be signed in to again. With neither, nothing pod-related renders.
 */
export function PodGalleryProvider({
  access,
  signedOut = null,
  children,
}: {
  access: PodGalleryAccess | null;
  signedOut?: PodGallerySignedOut | null;
  children: ReactNode;
}) {
  return (
    <PodGalleryContext.Provider value={access}>
      <PodGallerySignedOutContext.Provider value={access ? null : signedOut}>{children}</PodGallerySignedOutContext.Provider>
    </PodGalleryContext.Provider>
  );
}

export function usePodGalleryAccess(): PodGalleryAccess | null {
  return useContext(PodGalleryContext);
}

/** Set only while no pod is connected and the session can be signed in to again. */
export function usePodGallerySignedOut(): PodGallerySignedOut | null {
  return useContext(PodGallerySignedOutContext);
}
