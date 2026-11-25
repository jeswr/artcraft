import type { PodAsset } from "@storyteller/pod-gallery";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_MOUNTED_TILES } from "@storyteller/pod-gallery";
import { asset, contentUrl, page, png, pngFiles, testPod, thumbUrl } from "./podTestKit";
import { mount } from "./podMount";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const tileCount = (container: HTMLElement) => container.querySelectorAll("[data-pod-tile]").length;

describe("the My pod panel: the grid", () => {
  it("lists the items and shows them only through blob URLs, from thumbnails, never the pod's addresses", async () => {
    const pod = testPod([page([asset(2), asset(1)])], { files: pngFiles(2) });
    const { container } = mount(pod);
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(2));
    for (const img of Array.from(container.querySelectorAll("img"))) expect(img.getAttribute("src")).toMatch(/^blob:/);
    expect([...pod.reads].sort()).toEqual([thumbUrl(1), thumbUrl(2)]);
    expect(container.innerHTML).not.toContain("alice.example");
    expect(screen.getByRole("button", { name: "Item 2" })).toBeTruthy();
  });

  it("never pulls a full-size original into the grid: an image without a thumbnail is a generic tile with its name", async () => {
    const files = pngFiles(2);
    const pod = testPod([page([asset(1, { thumbnail: null }), asset(2)])], { files });
    const { container } = mount(pod);
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(1));
    const generic = screen.getByTestId("pod-generic-tile");
    expect(generic.textContent).toContain("Item 1");
    expect(pod.reads).toEqual([thumbUrl(2)]);
    // Only the viewer reads the original.
    fireEvent.click(screen.getByRole("button", { name: "Item 1" }));
    await waitFor(() => expect(pod.reads).toContain(contentUrl(1)));
  });

  it("gives a 3D model and a video without a thumbnail a generic tile and reads nothing for them", async () => {
    const pod = testPod([page([asset(1, { kind: "model3d", thumbnail: null }), asset(2, { kind: "video", thumbnail: null })])]);
    mount(pod);
    await waitFor(() => expect(screen.getAllByTestId("pod-generic-tile")).toHaveLength(2));
    expect(pod.reads).toEqual([]);
  });

  it("says the items are view-only", async () => {
    mount(testPod([page([asset(1)])], { files: pngFiles(1) }));
    await screen.findByRole("button", { name: "Item 1" });
    expect(screen.getByTestId("pod-view-only").textContent).toMatch(/view-only/);
  });

  it("announces what is shown to a screen reader", async () => {
    mount(testPod([page([asset(2), asset(1)])], { files: pngFiles(2) }));
    await waitFor(() => expect(screen.getByTestId("pod-announcement").textContent).toBe("2 items loaded"));
  });

  it("shows the empty state with a pointer to the mirror status", async () => {
    mount(testPod([page([])]));
    await screen.findAllByText("Nothing in your pod yet");
    expect(screen.getByText(/Settings, under Solid pod/)).toBeTruthy();
  });

  it("names an offline pod and retries on request", async () => {
    const pod = testPod([{ ok: false, error: "offline" }, page([asset(1)])], { files: pngFiles(1) });
    mount(pod);
    await screen.findAllByText("Your pod can't be reached");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "Item 1" });
    expect(pod.source.list).toHaveBeenCalledTimes(2);
  });

  it("says to sign in again when the session has ended, points at the reconnect path, and never says offline", async () => {
    mount(testPod([{ ok: false, error: "sign-in" }]));
    await screen.findAllByText("Sign in to your pod again");
    expect(screen.getByText(/Settings, under Solid pod/)).toBeTruthy();
    expect(screen.queryAllByText(/offline/i)).toHaveLength(0);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("counts files it cannot show without naming them", async () => {
    mount(testPod([page([asset(1)], null, 3)], { files: pngFiles(1) }));
    await screen.findByText("3 files in your pod library can't be shown here.");
  });

  it("groups by day, newest day first and undated last, whatever order the store listed them in", async () => {
    mount(
      testPod(
        [
          page([
            asset(1, { createdAt: null }),
            asset(2, { createdAt: "2026-06-01T10:00:00.000Z" }),
            asset(3, { createdAt: "2026-06-03T10:00:00.000Z" }),
            asset(4, { createdAt: "2026-06-02T10:00:00.000Z" }),
          ]),
        ],
        { files: pngFiles(4) },
      ),
    );
    await screen.findByRole("button", { name: "Item 3" });
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual([expect.stringMatching(/Jun 3/), expect.stringMatching(/Jun 2/), expect.stringMatching(/Jun 1/), "Undated"]);
  });

  it("asks for the next page near the end of the list and shows when there are no more", async () => {
    const first = Array.from({ length: 40 }, (_, index) => asset(index + 1));
    const pod = testPod([page(first, "c2"), page([asset(41)])], { files: pngFiles(41, false) });
    const { container } = mount(pod);
    await screen.findByRole("button", { name: "Item 1" });
    expect(pod.source.list).toHaveBeenCalledTimes(1);
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 700, configurable: true });
    Object.defineProperty(scroller, "scrollTop", { value: 1250, configurable: true });
    act(() => {
      fireEvent.scroll(scroller);
    });
    await waitFor(() => expect(pod.source.list).toHaveBeenCalledTimes(2));
    expect((pod.source.list.mock.calls as unknown[][])[1]?.[0]).toMatchObject({ cursor: "c2" });
    expect(screen.getByText("No more items")).toBeTruthy();
  });

  it("offers Retry after a failed 'load more' and keeps what is shown", async () => {
    const pod = testPod([page([asset(2)], "c2"), { ok: false, error: "offline" }, page([asset(1)])], { files: pngFiles(2) });
    const { container } = mount(pod);
    await screen.findByRole("button", { name: "Item 2" });
    // The list does not fill the view, so the second page is asked for by itself and fails.
    await screen.findByText("Couldn't load more.");
    expect(container.querySelectorAll("[data-pod-tile]")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "Item 1" });
  });
});

describe("the My pod panel: tiles that fail", () => {
  it("shows a generic tile with the name for a thumbnail the loader refuses: too many pixels, or too large", async () => {
    const files = pngFiles(3);
    // 2000 x 2000 is 4 MP: far more than a tile can use, and about 16 MB decoded.
    files.set(thumbUrl(2), { bytes: png(2, 2000, 2000) });
    files.set(thumbUrl(3), { bytes: png(3), declared: 5 * 1024 * 1024 });
    const pod = testPod([page([asset(1), asset(2), asset(3)])], { files });
    const { container } = mount(pod);
    await waitFor(() => expect(screen.getAllByTestId("pod-generic-tile")).toHaveLength(2));
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(screen.getAllByTestId("pod-generic-tile").map((tile) => tile.textContent)).toEqual(["Item 2", "Item 3"]);
    expect(screen.queryByTestId("pod-failed-tile")).toBeNull();
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
    // The refused picture was never given a blob URL.
    expect(pod.objectUrls.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("offers Try again for a pod that could not be reached, and loads the picture when it comes back", async () => {
    const pod = testPod([page([asset(1)])], { files: pngFiles(1) });
    const working = pod.storage.read.getMockImplementation()!;
    pod.storage.read.mockImplementation(async () => {
      throw Object.assign(new Error("network"), { code: "network" });
    });
    const { container } = mount(pod);
    await waitFor(() => expect(screen.getByTestId("pod-failed-tile").textContent).toBe("Can't reach your pod"));
    pod.storage.read.mockImplementation(working);
    fireEvent.click(screen.getByRole("button", { name: "Try again: Item 1" }));
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(1));
    expect(screen.queryByTestId("pod-failed-tile")).toBeNull();
  });

  it("keeps the mounted tiles well under the loader's entry limit however long the list is", async () => {
    const items: PodAsset[] = Array.from({ length: 600 }, (_, index) => asset(index + 1, { createdAt: `2026-06-01T${String(10 + (index % 10)).padStart(2, "0")}:00:00.000Z` }));
    const pod = testPod([page(items)], { files: pngFiles(600, false) });
    const { container } = mount(pod);
    await screen.findByTestId("pod-grid");
    await waitFor(() => expect(tileCount(container)).toBeGreaterThan(0));
    expect(tileCount(container)).toBeLessThanOrEqual(MAX_MOUNTED_TILES);
    await waitFor(() => expect(pod.tileLoader.stats().entries).toBeGreaterThan(0));
    expect(pod.tileLoader.stats().entries).toBeLessThanOrEqual(MAX_MOUNTED_TILES);
    // Far fewer reads than items: tiles off screen are not mounted, so not read.
    expect(pod.reads.length).toBeLessThan(100);
  });

  it("virtualises by row: scrolling mounts the rows now in view and releases the ones that left", async () => {
    const items = Array.from({ length: 30 }, (_, index) => asset(index + 1));
    const pod = testPod([page(items)], { files: pngFiles(30, false) });
    const { container } = mount(pod, { gridColumns: 1 });
    await waitFor(() => expect(pod.tileCounts.acquired).toBeGreaterThan(0));
    const first = pod.tileCounts.acquired;
    expect(screen.queryByRole("button", { name: "Item 30" })).toBeNull();
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    Object.defineProperty(scroller, "scrollTop", { value: 12_000, configurable: true, writable: true });
    act(() => {
      fireEvent.scroll(scroller);
    });
    await waitFor(() => expect(pod.tileCounts.released).toBeGreaterThan(0));
    expect(pod.tileCounts.acquired).toBeGreaterThan(first);
    expect(screen.queryByRole("button", { name: "Item 1" })).toBeNull();
  });
});

describe("an ended session is 'sign in again' on every path", () => {
  const SIGN_IN = "Sign in to your pod again";
  const network = () => {
    throw Object.assign(new Error("network"), { code: "network" });
  };

  it("while paging: a failed 'load more' says to sign in, not 'couldn't load more'", async () => {
    const first = Array.from({ length: 40 }, (_, index) => asset(index + 1));
    const pod = testPod([page(first, "c2"), { ok: false, error: "sign-in" }], { files: pngFiles(40, false) });
    const { container } = mount(pod);
    await screen.findByRole("button", { name: "Item 1" });
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 700, configurable: true });
    Object.defineProperty(scroller, "scrollTop", { value: 1250, configurable: true });
    act(() => {
      fireEvent.scroll(scroller);
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(SIGN_IN);
    expect(alert.textContent).not.toMatch(/Couldn't load more|offline/i);
  });

  it("on a tile: a read that fails once the session has ended is not 'Can't reach your pod' or 'refused'", async () => {
    const pod = testPod([page([asset(1), asset(2)])], { files: pngFiles(2) });
    pod.session.ended = true;
    pod.storage.read.mockImplementation(async () => network());
    mount(pod);
    await waitFor(() => expect(screen.getAllByTestId("pod-tile-status")).toHaveLength(2));
    expect(screen.getAllByTestId("pod-tile-status").map((node) => node.textContent)).toEqual([SIGN_IN, SIGN_IN]);
    expect(screen.queryByText(/Can't reach|refused/)).toBeNull();
  });

  it("on a tile: the loader's 'refused' (a 401 answer) is also the sign-in sentence while the session has ended", async () => {
    const pod = testPod([page([asset(1)])], { files: pngFiles(1) });
    pod.session.ended = true;
    pod.storage.read.mockImplementation(async () => {
      throw Object.assign(new Error("401"), { code: "unauthorized", status: 401 });
    });
    mount(pod);
    await waitFor(() => expect(screen.getByTestId("pod-tile-status")).toBeTruthy());
    expect(screen.getByTestId("pod-tile-status").textContent).toBe(SIGN_IN);
  });

  it("in the viewer: the original's failure says to sign in", async () => {
    const pod = testPod([page([asset(1)])], { files: pngFiles(1) });
    mount(pod);
    const tile = await screen.findByRole("button", { name: "Item 1" });
    await waitFor(() => expect(pod.tileCounts.acquired).toBe(1));
    pod.session.ended = true;
    pod.storage.read.mockImplementation(async () => network());
    fireEvent.click(tile);
    const placeholder = await screen.findByTestId("pod-viewer-placeholder");
    await waitFor(() => expect(placeholder.textContent).toContain(SIGN_IN));
    expect(placeholder.textContent).not.toMatch(/reach|refused/);
  });

  it("without an ended session the same failures keep their own words", async () => {
    const pod = testPod([page([asset(1)])], { files: pngFiles(1) });
    pod.storage.read.mockImplementation(async () => network());
    mount(pod);
    await waitFor(() => expect(screen.getByTestId("pod-tile-status").textContent).toBe("Can't reach your pod"));
  });
});

describe("closing the gallery and refreshing", () => {
  it("revokes every blob URL when the panel closes (tiles and the open original), and the loaders load again after", async () => {
    const pod = testPod([page([asset(1), asset(2)])], { files: pngFiles(2) });
    const { container, unmount } = mount(pod);
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Item 1" }));
    await waitFor(() => expect(pod.viewerCounts.acquired).toBe(1));
    unmount();
    expect(pod.objectUrls.revokeObjectURL).toHaveBeenCalledTimes(pod.objectUrls.createObjectURL.mock.calls.length);
    expect(pod.tileLoader.stats().entries).toBe(0);
    expect(pod.viewerLoader.stats().entries).toBe(0);
    // Purged and resumed: a later open reads again.
    const again = await pod.tileLoader.acquire(thumbUrl(1));
    expect(again.ok).toBe(true);
  });

  it("closes the viewer when the list is refreshed", async () => {
    const pod = testPod([page([asset(1)])], { files: pngFiles(1) });
    mount(pod);
    fireEvent.click(await screen.findByRole("button", { name: "Item 1" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Refresh list" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("the My pod panel: the real loader and the real useMedia hook", () => {
  it("a purge while tiles are mounted revokes every picture and shows them as not loaded, with no retry", async () => {
    const pod = testPod([page([asset(1), asset(2)])], { files: pngFiles(2) });
    const { container } = mount(pod);
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(2));
    const created = pod.objectUrls.createObjectURL.mock.calls.length;
    expect(created).toBe(2);
    act(() => pod.tileLoader.purge());
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(pod.objectUrls.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId("pod-failed-tile")).toHaveLength(2);
    expect(screen.getAllByTestId("pod-tile-status").map((node) => node.textContent)).toEqual(["Not loaded", "Not loaded"]);
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
  });

  it("a tile that finds no room says so, offers Try again, and picks up room that appears later", async () => {
    const pod = testPod([page([asset(1), asset(2), asset(3)])], { files: pngFiles(3), tile: { maxEntries: 2, budgetWaitMs: 30 } });
    const { container } = mount(pod, { gridColumns: 3 });
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId("pod-failed-tile").textContent).toBe("Waiting for room to load"));
    const retry = screen.getByRole("button", { name: "Try again: Item 3" });
    const before = pod.tileLoader.stats().entries;
    expect(before).toBe(2);
    // Still no room: another attempt is made and the tile says so again.
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByTestId("pod-failed-tile").textContent).toBe("Waiting for room to load"));
    expect(pod.tileLoader.stats().entries).toBe(2);
  });

  it("when a tile scrolls away its room goes to the tile that arrives, without a click", async () => {
    const items = Array.from({ length: 3 }, (_, index) => asset(index + 1));
    const pod = testPod([page(items)], { files: pngFiles(3, false), tile: { maxEntries: 2, budgetWaitMs: 5000 } });
    const { container } = mount(pod, { gridColumns: 1 });
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(2));
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    Object.defineProperty(scroller, "scrollTop", { value: 2000, configurable: true, writable: true });
    act(() => {
      fireEvent.scroll(scroller);
    });
    await screen.findByRole("button", { name: "Item 3" });
    await waitFor(() => expect(pod.reads).toContain(thumbUrl(3)));
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(2));
    expect(screen.queryByTestId("pod-failed-tile")).toBeNull();
  });

  it("releases every hold when it unmounts", async () => {
    const pod = testPod([page([asset(1), asset(2)])], { files: pngFiles(2) });
    const { container, unmount } = mount(pod);
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(2));
    expect(pod.tileCounts.acquired).toBe(2);
    expect(pod.tileCounts.released).toBe(0);
    unmount();
    expect(pod.tileCounts.released).toBe(2);
  });
});
