import { beforeEach, describe, expect, it, vi } from "vitest";

const parts = vi.hoisted(() => ({
  journal: { close: vi.fn() },
  openMirrorJournal: vi.fn(),
  failStart: false,
  mirrors: [] as { options: Record<string, unknown>; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[],
}));
vi.mock("@storyteller/pod-mirror", () => ({
  openMirrorJournal: parts.openMirrorJournal,
  createPublicBytesFetcher: () => "bytes-fetcher",
  PodMirror: class {
    start = vi.fn(async () => {
      if (parts.failStart) throw new Error("start failed");
    });
    stop = vi.fn(async () => undefined);
    constructor(public options: Record<string, unknown>) {
      parts.mirrors.push(this);
    }
  },
}));
vi.mock("./mirror-hosted", () => ({ createHostedClient: (username: string) => ({ hosted: username }) }));
vi.mock("./mirror-events", () => ({ createTauriMirrorEvents: () => "events" }));
vi.mock("./mirror-ports", () => ({ browserNetworkPort: () => "network", sessionPortFor: (_s: unknown, webId: string) => ({ session: webId }) }));
vi.mock("./mirror-store", () => ({ createStoreOpener: (deps: { webId: string }) => ({ opener: deps.webId }) }));

import { RECONCILE_INTERVAL_MS, startPodMirror } from "./mirror-runtime";

const deps = { session: { getFetch: () => null, getBackgroundFetch: () => null } as never, webId: "https://alice.example/profile/card#me", username: "alice_hosted", currentUsername: () => "alice_hosted" };

beforeEach(() => {
  vi.clearAllMocks();
  parts.mirrors.length = 0;
  parts.failStart = false;
  parts.openMirrorJournal.mockResolvedValue(parts.journal);
});

describe("starting the mirror", () => {
  it("builds it for this account from the app's own pieces, and starts it", async () => {
    const running = await startPodMirror(deps);
    const { options, start } = parts.mirrors[0];
    expect(options).toMatchObject({
      account: { webId: deps.webId, username: "alice_hosted" },
      journal: parts.journal,
      hosted: { hosted: "alice_hosted" },
      openStore: { opener: deps.webId },
      fetchPublicBytes: "bytes-fetcher",
      session: { session: deps.webId },
      network: "network",
      events: "events",
      reconcileIntervalMs: RECONCILE_INTERVAL_MS,
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(running.mirror).toBe(parts.mirrors[0]);
  });

  it("stops the mirror before it closes the journal", async () => {
    const order: string[] = [];
    parts.journal.close.mockImplementation(() => order.push("close"));
    const running = await startPodMirror(deps);
    parts.mirrors[0].stop.mockImplementation(async () => void order.push("stop"));
    await running.dispose();
    expect(order).toEqual(["stop", "close"]);
  });

  it("does not start without a durable journal", async () => {
    parts.openMirrorJournal.mockRejectedValueOnce(new Error("no IndexedDB"));
    await expect(startPodMirror(deps)).rejects.toThrow("no IndexedDB");
    expect(parts.mirrors).toHaveLength(0);
  });

  it("closes the journal it opened when the mirror fails to start", async () => {
    parts.failStart = true;
    await expect(startPodMirror(deps)).rejects.toThrow("start failed");
    expect(parts.journal.close).toHaveBeenCalledTimes(1);
  });
});
