import { createContext, type ReactNode, useContext, useEffect, useSyncExternalStore } from 'react';
import { type Notice, noticeFor } from './messages.js';
import type { PodSession } from './pod-session.js';
import type { PodSessionState } from './state.js';

const PodSessionContext = createContext<PodSession | null>(null);

/**
 * Makes one session available to the tree so later code can call `getFetch()`.
 * `startNow` is true in a pod window (restore or continue a sign-in) and wherever a step of
 * connecting or disconnecting is waiting to be settled; elsewhere the session starts when a
 * component first asks for it.
 */
export function PodSessionProvider({
  session,
  startNow,
  onNotice,
  children,
}: {
  session: PodSession;
  startNow: boolean;
  /** Receives a short notice for each state change worth announcing, wherever the person is. */
  onNotice?: (notice: Notice) => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!onNotice) return;
    let previous: PodSessionState | null = null;
    return session.subscribe((next) => {
      const notice = noticeFor(previous, next);
      previous = next;
      if (notice) onNotice(notice);
    });
  }, [session, onNotice]);
  useEffect(() => {
    if (startNow) void session.start();
  }, [session, startNow]);
  return <PodSessionContext.Provider value={session}>{children}</PodSessionContext.Provider>;
}

/** The session, or null when no provider is mounted. */
export function usePodSessionOrNull(): PodSession | null {
  return useContext(PodSessionContext);
}

/** The current state of a session. */
export function usePodSessionState(session: PodSession): PodSessionState {
  return useSyncExternalStore(session.subscribe, session.getState, session.getState);
}
