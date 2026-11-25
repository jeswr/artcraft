// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { PodLibraryOpenError, usePodGalleryAccess, type PodLibrary } from "@storyteller/pod-gallery";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({
  loads: 0,
  built: [] as { webId: string; podFetch: unknown; library: { loader: { purge: ReturnType<typeof vi.fn> }; close: ReturnType<typeof vi.fn> } }[],
  fail: false,
}));
vi.mock("./gallery-runtime", () => {
  world.loads++;
  return {
    buildPodLibrary: async (podFetch: unknown, webId: string) => {
      if (world.fail) throw new PodLibraryOpenError("offline");
      const library = { source: { list: vi.fn(), get: vi.fn() }, loader: { purge: vi.fn() }, close: vi.fn() };
      world.built.push({ webId, podFetch, library });
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
    expect(world.built.map((entry) => [entry.webId, entry.podFetch])).toEqual([[ALICE, FETCH]]);
    expect(await access!.open()).toBe(library);
    expect(world.built).toHaveLength(1);
  });

  it("purges the loader when the pod is disconnected", async () => {
    const pod = fakePodSession(connected(ALICE));
    render(<PodGalleryHost session={pod.session}><Probe /></PodGalleryHost>);
    await access!.open();
    await pod.set(disconnected);
    expect(screen.getByTestId("probe").textContent).toBe("none");
    expect(world.built[0]?.library.loader.purge).toHaveBeenCalledTimes(1);
    expect(world.built[0]?.library.close).toHaveBeenCalledTimes(1);
  });

  it("purges everything when the account changes, and builds the new library for the new WebID", async () => {
    const pod = fakePodSession(connected(ALICE));
    render(<PodGalleryHost session={pod.session}><Probe /></PodGalleryHost>);
    await access!.open();
    await pod.set(connected(BOB));
    expect(screen.getByTestId("probe").textContent).toBe(BOB);
    expect(world.built[0]?.library.loader.purge).toHaveBeenCalledTimes(1);
    await access!.open();
    expect(world.built.map((entry) => entry.webId)).toEqual([ALICE, BOB]);
    expect(world.built[1]?.library.loader.purge).not.toHaveBeenCalled();
  });

  it("purges when the host goes away", async () => {
    const pod = fakePodSession(connected(ALICE));
    const view = render(<PodGalleryHost session={pod.session}><Probe /></PodGalleryHost>);
    await access!.open();
    view.unmount();
    expect(world.built[0]?.library.loader.purge).toHaveBeenCalledTimes(1);
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
