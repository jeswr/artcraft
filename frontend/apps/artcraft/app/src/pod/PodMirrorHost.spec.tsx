// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { usePodMirrorSummary, usePodMirrorView } from "@storyteller/pod-mirror-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => {
  const username = { value: { username: "alice_hosted" } as { username: string } | null, peek: () => world.username.value };
  return {
    username,
    fakeMirror,
    started: [] as { webId: string; username: string; mirror: ReturnType<typeof fakeMirror>; dispose: ReturnType<typeof vi.fn> }[],
    loads: 0,
    startFails: false,
    gate: null as Promise<void> | null,
  };
  function fakeMirror() {
    const summary = { version: 1, running: true, paused: null, exposureTarget: null, counts: { saved: 0, pending: 0, failed: 0, skipped: 0, removing: 0 } };
    return { stateOf: vi.fn(), summary: vi.fn(() => summary), subscribe: vi.fn(() => () => undefined), retry: vi.fn(), retryAllFailed: vi.fn(), recheckExposure: vi.fn(), confirmPrivate: vi.fn(), forgetAccount: vi.fn(async () => undefined) };
  }
});
vi.mock("~/signals", () => ({ authentication: { userInfo: world.username } }));
vi.mock("@preact/signals-react/runtime", () => ({ useSignals: () => undefined }));
vi.mock("./mirror-runtime", () => {
  world.loads++;
  return {
    startPodMirror: async (deps: { webId: string; username: string }) => {
      if (world.gate) await world.gate;
      if (world.startFails) throw new Error("no journal");
      const mirror = world.fakeMirror();
      const entry = { webId: deps.webId, username: deps.username, mirror, dispose: vi.fn(async () => undefined) };
      world.started.push(entry);
      return { mirror, dispose: entry.dispose };
    },
  };
});

import type { PodSession, PodSessionState } from "@storyteller/pod-session";
import { PodMirrorHost } from "./PodMirrorHost";

function fakePodSession(initial: PodSessionState) {
  let state = initial;
  const listeners = new Set<() => void>();
  const session = { getState: () => state, subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)), getFetch: () => null } as unknown as PodSession;
  return { session, set: (next: PodSessionState) => act(() => { state = next; for (const l of listeners) l(); }) };
}
const connected = (webId: string) => ({ kind: "connected", webId }) as PodSessionState;
const ALICE = "https://alice.example/profile/card#me";

function Probe() {
  const view = usePodMirrorView();
  const summary = usePodMirrorSummary();
  return <p data-testid="probe">{view ? (view.unavailable ? "unavailable" : "mirror") : "none"}:{summary ? "summary" : "-"}</p>;
}

beforeEach(() => {
  world.username.value = { username: "alice_hosted" };
  world.started.length = 0;
  world.startFails = false;
  world.gate = null;
});
afterEach(cleanup);

describe("the host that runs the mirror", () => {
  it("builds nothing, and loads nothing, without a connected pod", async () => {
    const pod = fakePodSession({ kind: "disconnected" } as PodSessionState);
    render(<PodMirrorHost session={pod.session}><Probe /></PodMirrorHost>);
    await act(async () => undefined);
    expect(world.started).toEqual([]);
    expect(world.loads).toBe(0);
    expect(screen.getByTestId("probe").textContent).toBe("none:-");
  });

  it("builds nothing without a hosted user, even with a pod", async () => {
    world.username.value = null;
    const pod = fakePodSession(connected(ALICE));
    render(<PodMirrorHost session={pod.session}><Probe /></PodMirrorHost>);
    await act(async () => undefined);
    expect(world.started).toEqual([]);
    expect(world.loads).toBe(0);
  });

  it("starts one mirror for the connected WebID and hosted user, and shows it below", async () => {
    const pod = fakePodSession(connected(ALICE));
    render(<PodMirrorHost session={pod.session}><Probe /></PodMirrorHost>);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("mirror:summary"));
    expect(world.started.map((s) => [s.webId, s.username])).toEqual([[ALICE, "alice_hosted"]]);
  });

  it("stops the mirror and removes the view when the pod disconnects", async () => {
    const pod = fakePodSession(connected(ALICE));
    render(<PodMirrorHost session={pod.session}><Probe /></PodMirrorHost>);
    await waitFor(() => expect(world.started).toHaveLength(1));
    pod.set({ kind: "disconnected" } as PodSessionState);
    await waitFor(() => expect(world.started[0].dispose).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("probe").textContent).toBe("none:-");
  });

  it("replaces the mirror when the pod account changes, stopping the first", async () => {
    const pod = fakePodSession(connected(ALICE));
    render(<PodMirrorHost session={pod.session}><Probe /></PodMirrorHost>);
    await waitFor(() => expect(world.started).toHaveLength(1));
    pod.set(connected("https://bob.example/profile/card#me"));
    await waitFor(() => expect(world.started).toHaveLength(2));
    expect(world.started[0].dispose).toHaveBeenCalledTimes(1);
    expect(world.started[1].webId).toBe("https://bob.example/profile/card#me");
  });

  it("stops a mirror that finished starting after the pod had already gone", async () => {
    let open: () => void = () => undefined;
    world.gate = new Promise<void>((resolve) => (open = resolve));
    const pod = fakePodSession(connected(ALICE));
    render(<PodMirrorHost session={pod.session}><Probe /></PodMirrorHost>);
    await act(async () => undefined);
    pod.set({ kind: "disconnected" } as PodSessionState);
    open();
    await waitFor(() => expect(world.started).toHaveLength(1));
    await waitFor(() => expect(world.started[0].dispose).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("probe").textContent).toBe("none:-");
  });

  it("shows copying as unavailable when the mirror cannot start, instead of nothing", async () => {
    world.startFails = true;
    const pod = fakePodSession(connected(ALICE));
    render(<PodMirrorHost session={pod.session}><Probe /></PodMirrorHost>);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("unavailable:summary"));
  });

  it("forgetting the account clears its record and starts a fresh mirror", async () => {
    const pod = fakePodSession(connected(ALICE));
    let forget: () => Promise<void> = async () => undefined;
    function Forget() {
      const view = usePodMirrorView();
      forget = () => view!.forgetAccount();
      return null;
    }
    render(<PodMirrorHost session={pod.session}><Forget /></PodMirrorHost>);
    await waitFor(() => expect(world.started).toHaveLength(1));
    await act(async () => forget());
    expect(world.started[0].mirror.forgetAccount).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(world.started).toHaveLength(2));
    expect(world.started[0].dispose).toHaveBeenCalled();
  });
});
