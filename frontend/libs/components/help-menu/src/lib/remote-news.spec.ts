import { afterEach, describe, expect, it, vi } from "vitest";
import { latchPodWindow, resetPodWindowForTests } from "@storyteller/pod-mode";
import { fetchRemoteNews } from "./remote-news";

const ok = (body: unknown) =>
  vi.fn(async () => ({ ok: true, json: async () => body }) as unknown as Response);

afterEach(() => {
  resetPodWindowForTests();
  localStorage.clear();
});

describe("fetchRemoteNews", () => {
  it("fetches and returns the feed outside pod mode", async () => {
    const f = ok([{ slug: "a" }]);
    expect(await fetchRemoteNews(f)).toEqual([{ slug: "a" }]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("returns null for a non-array body or a failed response", async () => {
    expect(await fetchRemoteNews(ok({ not: "an array" }))).toBeNull();
    const bad = vi.fn(async () => ({ ok: false }) as unknown as Response);
    expect(await fetchRemoteNews(bad)).toBeNull();
  });

  it("makes no request at all in a pod window", async () => {
    localStorage.setItem("artcraft.podMode", "1");
    latchPodWindow();
    const f = ok([{ slug: "a" }]);
    expect(await fetchRemoteNews(f)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
