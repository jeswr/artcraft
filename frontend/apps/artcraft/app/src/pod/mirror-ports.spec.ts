import { describe, expect, it, vi } from "vitest";
import type { PodSession, PodSessionState } from "@storyteller/pod-session";
import { browserNetworkPort, sessionPortFor } from "./mirror-ports";

function fakePodSession(initial: PodSessionState) {
  let state = initial;
  const listeners = new Set<() => void>();
  const session = {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as PodSession;
  return { session, set: (next: PodSessionState) => { state = next; for (const l of listeners) l(); }, listeners };
}

const ALICE = "https://alice.example/profile/card#me";

describe("the session as the mirror sees it", () => {
  it("is connected only as the WebID the mirror was built for", () => {
    const pod = fakePodSession({ kind: "connected", webId: ALICE } as PodSessionState);
    const port = sessionPortFor(pod.session, ALICE);
    expect(port.isConnected()).toBe(true);
    pod.set({ kind: "connected", webId: "https://bob.example/profile/card#me" } as PodSessionState);
    expect(port.isConnected()).toBe(false);
    pod.set({ kind: "disconnected" } as PodSessionState);
    expect(port.isConnected()).toBe(false);
  });

  it("tells the mirror about every session change, until unsubscribed", () => {
    const pod = fakePodSession({ kind: "disconnected" } as PodSessionState);
    const listener = vi.fn();
    const off = sessionPortFor(pod.session, ALICE).subscribe(listener);
    pod.set({ kind: "connected", webId: ALICE } as PodSessionState);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    pod.set({ kind: "disconnected" } as PodSessionState);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(pod.listeners.size).toBe(0);
  });
});

describe("the network as the mirror sees it", () => {
  it("reports the browser's state and its online and offline events, until unsubscribed", () => {
    const target = new EventTarget() as unknown as Window;
    const nav = { onLine: true };
    const port = browserNetworkPort(target, nav);
    const listener = vi.fn();
    const off = port.subscribe(listener);
    expect(port.isOnline()).toBe(true);
    nav.onLine = false;
    target.dispatchEvent(new Event("offline"));
    expect(port.isOnline()).toBe(false);
    nav.onLine = true;
    target.dispatchEvent(new Event("online"));
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    target.dispatchEvent(new Event("online"));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
