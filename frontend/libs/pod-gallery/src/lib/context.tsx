import { createContext, type ReactNode, useContext } from 'react';
import type { PodLibrary } from './library.js';

/** What the gallery needs to reach the pod library of the connected account. */
export interface PodGalleryAccess {
  /** The signed-in WebID. A different one is a different account: a new access object. */
  readonly sessionKey: string;
  open(): Promise<PodLibrary>;
}

const PodGalleryContext = createContext<PodGalleryAccess | null>(null);

/** Offers "My pod" below it. Without a connected pod the value is null and nothing pod-related renders. */
export function PodGalleryProvider({ access, children }: { access: PodGalleryAccess | null; children: ReactNode }) {
  return <PodGalleryContext.Provider value={access}>{children}</PodGalleryContext.Provider>;
}

export function usePodGalleryAccess(): PodGalleryAccess | null {
  return useContext(PodGalleryContext);
}
