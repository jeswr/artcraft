// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { PodLibraryOpenError, usePodGalleryAccess, usePodGallerySignedOut, type PodLibrary } from "@storyteller/pod-gallery";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({
  loads: 0,
  built: [] as { webId: string; getFetch: () => typeof fetch | null; getSessionKey: () => string; library: { tileLoader: { purge: ReturnType<typeof vi.fn> }; viewerLoader: { purge: ReturnType<typeof vi.fn> }; close: ReturnType<typeof vi.fn> } }[],
  fail: false,
}));
vi.mock("./gallery-runtime", () => {
  world.loads++;
  return {
    buildPodLibrary: async ({ getFetch, getSessionKey, webId }: { getFetch: () => typeof fetch | null; getSessionKey: () => string; webId: string }) => {
      if (world.fail) throw new PodLibraryOpenError("offline");
      const library = { source: { list: vi.fn(), get: vi.fn() }, tileLoader: { purge: vi.fn() }, viewerLoader: { purge: vi.fn() }, close: vi.fn() };
      world.built.push({ webId, getFetch, getSessionKey, library });
      return library as unknown as PodLibrary;
    },
  };
});

import { ERROR_TEXT, type PodSession, type PodSessionState } from "@storyteller/pod-session";
import { PodGalleryHost } from "./PodGalleryHost";

const ALICE = "https://alice.example/profile/card#me";
const BOB = "https://bob.example/profile/card#me";
const FETCH = vi.fn() as unknown as typeof fetch;
const INTERACTIVE_FETCH = vi.fn() as unknown as typeof fetch;

function fakePodSession(initial: PodSessionState, options: { canSignInAgain?: (state: PodSessionState) => boolean; podWindow?: boolean } = {}) {
  let state = initial;
  const listeners = new Set<() => void>();
  const signInAgain = vi.fn(async () => undefined);
  const beginSignIn = vi.fn(async () => undefined);
  const openBrowser = vi.fn();
  const session = {
    inPodMode: () => options.podWindow ?? false,
    beginSignIn,
    openBrowser,
    getState: () => state,
    subscribe: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)),
    // The gallery reads in the background: it must get the fetch that never asks for the person.
    getFetch: () => (state.kind === "connected" ? INTERACTIVE_FETCH : null),
    getBackgroundFetch: () => (state.kind === "connected" ? FETCH : null),
    canSignInAgain: () => options.canSignInAgain?.(state) ?? false,
    signInAgain,
  } as unknown as PodSession;
  return {
    session,
    signInAgain,
    beginSignIn,
    openBrowser,
    set: (next: PodSessionState) =>
      act(() => {
        state = next;
        for (const listener of listeners) listener();
      }),
  };
}
const connected = (webId: string) => ({ kind: "connected", webId }) as PodSessionState;
const disconnected = { kind: "disconnected", outcome: "disconnected" } as PodSessionState;

let access: ReturnType<typeof usePodGalleryAccess> = null;
function Probe() {
  access = usePodGalleryAccess();
  return <p data-testid="probe">{access ? access.sessionKey : "none"}</p>;
}

beforeEach(() => {
  world.built.length = 0;
  world.fail = false;
  access = null;
});
afterEach(cleanup);

describe("the host that offers the pod library to the gallery", () => {
  it("offers to sign in again, not the library, when the session ended in a window that can", async () => {
    let signedOut: ReturnType<typeof usePodGallerySignedOut> = null;
    function SignedOutProbe() {
      signedOut = usePodGallerySignedOut();
      return null;
    }
    const pod = fakePodSession(connected(ALICE), { canSignInAgain: (state) => state.kind === "error" });
    render(<PodGalleryHost session={pod.session}><Probe /><SignedOutProbe /></PodGalleryHost>);
    expect(signedOut).toBeNull();
    pod.set({ kind: "error", error: "session-ended" });
    expect(screen.getByTestId("probe").textContent).toBe("none");
    expect(signedOut).not.toBeNull();
    expect(pod.signInAgain).not.toHaveBeenCalled();
    signedOut!.signInAgain();
    expect(pod.signInAgain).toHaveBeenCalledTimes(1);
  });

  it("keeps My pod while the app asks and after its answer, and says what the answer was", async () => {
    let signedOut: ReturnType<typeof usePodGallerySignedOut> = null;
    function SignedOutProbe() {
      signedOut = usePodGallerySignedOut();
      return null;
    }
    // As the real session: only an ended session or a short wait can be signed in to again.
    const pod = fakePodSession(
      { kind: "error", error: "session-ended" },
      { canSignInAgain: (state) => state.kind === "disconnected" || (state.kind === "error" && state.error !== "sign-in-again-limit") },
    );
    render(<PodGalleryHost session={pod.session}><SignedOutProbe /></PodGalleryHost>);
    act(() => signedOut!.signInAgain());
    pod.set({ kind: "connecting", issuer: "https://pod.example" });
    expect(signedOut).toMatchObject({ asking: true });
    pod.set({ kind: "disconnected", outcome: "declined" });
    expect(signedOut).toMatchObject({ asking: false, canPress: true });
    expect(signedOut!.problem).toMatch(/declined/);
    pod.set({ kind: "error", error: "sign-in-again-wait" });
    expect(signedOut!.problem).toBeTruthy();
    pod.set({ kind: "error", error: "sign-in-again-limit" });
    expect(signedOut).toMatchObject({ canPress: false });
    expect(signedOut!.problem).toBeTruthy();
  });

  it("keeps My pod through the sign-in steps of a reloaded pod window, moving on only at the person's click", async () => {
    // Widened so the checks below are not narrowed to the initial null.
    let signedOut = null as ReturnType<typeof usePodGallerySignedOut>;
    function SignedOutProbe() {
      signedOut = usePodGallerySignedOut();
      return null;
    }
    // "Sign in again" reloaded the window: this new page never saw the press.
    const pod = fakePodSession({ kind: "ready-to-sign-in", issuer: "https://idp.example" }, { podWindow: true });
    render(<PodGalleryHost session={pod.session}><Probe /><SignedOutProbe /></PodGalleryHost>);
    expect(signedOut?.step?.action?.label).toBe("Continue sign-in");
    expect(pod.beginSignIn).not.toHaveBeenCalled();
    signedOut!.step!.action!.press();
    expect(pod.beginSignIn).toHaveBeenCalledTimes(1);
    pod.set({ kind: "confirm-provider", provider: "https://idp.example" });
    expect(signedOut?.step?.action?.label).toMatch(/Sign in at/);
    expect(pod.openBrowser).not.toHaveBeenCalled();
    pod.set({ kind: "signing-in", issuer: "https://idp.example", provider: "https://idp.example" });
    expect(signedOut?.step).toBeTruthy();
    expect(signedOut?.step?.action).toBeFalsy();
    // Allowing a new address is left to Settings, which explains it.
    pod.set({ kind: "needs-approval", origin: "https://other.example", phase: "sign-in", purpose: "sign-in" });
    expect(signedOut?.step?.status).toMatch(/Settings/);
    expect(signedOut?.step?.action).toBeFalsy();
    pod.set(connected(ALICE));
    expect(signedOut).toBeNull();
    expect(screen.getByTestId("probe").textContent).toBe(ALICE);
  });

  it("says what failed when a sign-in step of a reloaded pod window fails, without a press in this page", async () => {
    let signedOut = null as ReturnType<typeof usePodGallerySignedOut>;
    function SignedOutProbe() {
      signedOut = usePodGallerySignedOut();
      return null;
    }
    const pod = fakePodSession(
      { kind: "ready-to-sign-in", issuer: "https://idp.example" },
      { podWindow: true, canSignInAgain: (state) => state.kind === "error" && state.error !== "sign-in-again-limit" },
    );
    render(<PodGalleryHost session={pod.session}><SignedOutProbe /></PodGalleryHost>);
    signedOut!.step!.action!.press();
    for (const error of ["request-failed", "sign-in-failed", "sign-in-timed-out"] as const) {
      pod.set({ kind: "error", error });
      expect(signedOut?.step).toBeFalsy();
      expect(signedOut?.canPress).toBe(true);
      expect(signedOut?.problem).toBe(ERROR_TEXT[error]);
    }
    // An ended session is what the signed-out text already says.
    pod.set({ kind: "error", error: "session-ended" });
    expect(signedOut?.problem).toBeNull();
    expect(pod.signInAgain).not.toHaveBeenCalled();
  });

  it("offers no sign-in step outside a pod window", async () => {
    let signedOut: ReturnType<typeof usePodGallerySignedOut> = null;
    function SignedOutProbe() {
      signedOut = usePodGallerySignedOut();
      return null;
    }
    const pod = fakePodSession({ kind: "ready-to-sign-in", issuer: "https://idp.example" });
    render(<PodGalleryHost session={pod.session}><Probe /><SignedOutProbe /></PodGalleryHost>);
    expect(signedOut).toBeNull();
  });

  it("does not keep My pod for a connecting state it did not start", async () => {
    let signedOut: ReturnType<typeof usePodGallerySignedOut> = null;
    function SignedOutProbe() {
      signedOut = usePodGallerySignedOut();
      return null;
    }
    const pod = fakePodSession(disconnected, { canSignInAgain: (state) => state.kind === "error" });
    render(<PodGalleryHost session={pod.session}><SignedOutProbe /></PodGalleryHost>);
    pod.set({ kind: "connecting", issuer: "https://pod.example" });
    expect(signedOut).toBeNull();
  });

  it("offers nothing, and loads nothing, without a connected pod", async () => {
    const pod = fakePodSession(disconnected);
    render(<PodGalleryHost session={pod.session}><Probe /></PodGalleryHost>);
    await act(async () => undefined);
    expect(screen.getByTestId("probe").textContent).toBe("none");
    expect(world.loads).toBe(0);
    expect(world.built).toEqual([]);
  });

  it("offers the library of the connected WebID but builds nothing until it is opened", async () => {
    const pod = fakePodSession(connected(ALICE));
    render(<PodGalleryHost session={pod.session}><Probe /></PodGalleryHost>);
    expect(screen.getByTestId("probe").textContent).toBe(ALICE);
    expect(world.loads).toBe(0);
    const library = await access!.open();
    expect(world.built.map((entry) => [entry.webId, entry.getFetch()])).toEqual([[ALICE, FETCH]]);
    expect(await access!.open()).toBe(library);
    expect(world.built).toHaveLength(1);
  });

  it("purges both loaders when the pod is disconnected", async () => {
    const pod = fakePodSession(connected(ALICE));
    render(<PodGalleryHost session={pod.session}><Probe /></PodGalleryHost>);
    await access!.open();
    await pod.set(disconnected);
    expect(screen.getByTestId("probe").textContent).toBe("none");
    expect(world.built[0]?.library.tileLoader.purge).toHaveBeenCalledTimes(1);
    expect(world.built[0]?.library.viewerLoader.purge).toHaveBeenCalledTimes(1);
    expect(world.built[0]?.library.close).toHaveBeenCalledTimes(1);
  });

  it("gives the runtime the session's background fetch per request and its WebID as the loaders' key, both following the session", async () => {
    const pod = fakePodSession(connected(ALICE));
    render(<PodGalleryHost session={pod.session}><Probe /></PodGalleryHost>);
    await access!.open();
    const built = world.built[0]!;
    expect(built.getSessionKey()).toBe(ALICE);
    expect(built.getFetch()).toBe(FETCH);
    await pod.set(disconnected);
    // Nothing captured: once the session is gone there is no fetch to use and the key is empty.
    expect(built.getFetch()).toBeNull();
    expect(built.getSessionKey()).toBe("");
  });

  it("purges everything when the account changes, and builds the new library for the new WebID", async () => {
    const pod = fakePodSession(connected(ALICE));
    render(<PodGalleryHost session={pod.session}><Probe /></PodGalleryHost>);
    await access!.open();
    await pod.set(connected(BOB));
    expect(screen.getByTestId("probe").textContent).toBe(BOB);
    expect(world.built[0]?.library.tileLoader.purge).toHaveBeenCalledTimes(1);
    expect(world.built[0]?.library.viewerLoader.purge).toHaveBeenCalledTimes(1);
    await access!.open();
    expect(world.built.map((entry) => entry.webId)).toEqual([ALICE, BOB]);
    expect(world.built[1]?.library.tileLoader.purge).not.toHaveBeenCalled();
  });

  it("purges when the host goes away", async () => {
    const pod = fakePodSession(connected(ALICE));
    const view = render(<PodGalleryHost session={pod.session}><Probe /></PodGalleryHost>);
    await access!.open();
    view.unmount();
    expect(world.built[0]?.library.tileLoader.purge).toHaveBeenCalledTimes(1);
    expect(world.built[0]?.library.viewerLoader.purge).toHaveBeenCalledTimes(1);
  });

  it("reports a pod that could not be opened with a closed word and tries again next time", async () => {
    const pod = fakePodSession(connected(ALICE));
    render(<PodGalleryHost session={pod.session}><Probe /></PodGalleryHost>);
    world.fail = true;
    await expect(access!.open()).rejects.toMatchObject({ kind: "offline" });
    world.fail = false;
    await waitFor(async () => expect(await access!.open()).toBeDefined());
  });
});
