import type { ItemState, MirrorSummary } from '@storyteller/pod-mirror';
import { createContext, type ReactNode, useContext, useSyncExternalStore } from 'react';

/** Controls for "copy my existing library to my pod". */
export interface PodImportControls {
  /** How many items the hosted library holds, when that is cheaply known. */
  estimate(): Promise<{ total: number | null }>;
  start(total: number | null): Promise<boolean>;
  pause(): Promise<void>;
  resume(): Promise<boolean>;
  cancel(): Promise<void>;
}

/** What the gallery and settings need from a mirror. `PodMirror` satisfies it. */
export interface PodMirrorView {
  stateOf(token: string): ItemState | undefined;
  summary(): MirrorSummary;
  subscribe(listener: () => void): () => void;
  retry(token: string): Promise<void>;
  /** Puts every failed item back in the queue; resolves with how many. */
  retryAllFailed(): Promise<number>;
  /** Removes the pod copies of items ArtCraft no longer lists, after the person confirmed; resolves with how many. */
  removeGoneFromPod(): Promise<number>;
  /** Lifts an exposure pause and asks the pod again. */
  recheckExposure(): void;
  /** The person says the container is private, for a pod that cannot say; resolves false if nothing was waiting. */
  confirmPrivate(): Promise<boolean>;
  /** Present when the mirror can copy the existing library. */
  import?: PodImportControls;
  /** True when copying cannot run here (the local record could not be opened). */
  unavailable?: boolean;
  /** Purges this account's journal after the person confirms. */
  forgetAccount(): Promise<void>;
}

const PodMirrorViewContext = createContext<PodMirrorView | null>(null);

/** Makes a mirror's item states available below it. Without one, nothing pod-related renders. */
export function PodMirrorViewProvider({ view, children }: { view: PodMirrorView | null; children: ReactNode }) {
  return <PodMirrorViewContext.Provider value={view}>{children}</PodMirrorViewContext.Provider>;
}

export function usePodMirrorView(): PodMirrorView | null {
  return useContext(PodMirrorViewContext);
}

const none = () => () => undefined;
const nothing = () => undefined;

/** The state of one hosted item, or undefined when no pod is connected or it is not journalled. */
export function usePodItemState(token: string | undefined): ItemState | undefined {
  const view = usePodMirrorView();
  return useSyncExternalStore(
    view ? view.subscribe : none,
    () => (view && token ? view.stateOf(token) : undefined),
    nothing,
  );
}

/** Counts and pause reason, or null when no pod is connected. */
export function usePodMirrorSummary(): MirrorSummary | null {
  const view = usePodMirrorView();
  return useSyncExternalStore(
    view ? view.subscribe : none,
    () => (view ? view.summary() : null),
    () => null,
  );
}
