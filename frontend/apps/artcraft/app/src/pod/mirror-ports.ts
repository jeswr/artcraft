import type { NetworkPort, SessionPort } from "@storyteller/pod-mirror";
import type { PodSession } from "@storyteller/pod-session";

/** Connected to the pod as this web id, and no other. */
export function sessionPortFor(session: PodSession, webId: string): SessionPort {
  const connected = () => {
    const state = session.getState();
    return state.kind === "connected" && state.webId === webId;
  };
  return { isConnected: connected, subscribe: (listener) => session.subscribe(() => listener()) };
}

export function browserNetworkPort(target: Pick<Window, "addEventListener" | "removeEventListener"> = window, nav: Pick<Navigator, "onLine"> = navigator): NetworkPort {
  return {
    isOnline: () => nav.onLine,
    subscribe(listener) {
      target.addEventListener("online", listener);
      target.addEventListener("offline", listener);
      return () => {
        target.removeEventListener("online", listener);
        target.removeEventListener("offline", listener);
      };
    },
  };
}
