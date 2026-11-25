// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { PodLibraryOpenError, usePodGalleryAccess, type PodLibrary } from "@storyteller/pod-gallery";
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

import type { PodSession, PodSessionState } from "@storyteller/pod-session";
import { PodGalleryHost } from "./PodGalleryHost";

const ALICE = "https://alice.example/profile/card#me";
const BOB = "https://bob.example/profile/card#me";
const FETCH = vi.fn() as unknown as typeof fetch;

function fakePodSession(initial: PodSessionState) {
  let state = initial;
  const listeners = new Set<() => void>();
  const session = {
    getState: () => state,
    subscribe: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)),
    getFetch: () => (state.kind === "connected" ? FETCH : null),
  } as unknown as PodSession;
  return {
    session,
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

  it("gives the runtime the session's fetch per request and its WebID as the loaders' key, both following the session", async () => {
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
