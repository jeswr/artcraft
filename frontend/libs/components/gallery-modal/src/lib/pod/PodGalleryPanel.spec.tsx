import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mintPodAssetRef, type PodAsset, type PodGalleryAccess, type PodLibrary, type PodListPage, type PodSourceResult } from "@storyteller/pod-gallery";
import type { MediaLoader } from "@jeswr/pod-media-loader";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PodGalleryPanel from "./PodGalleryPanel";

const POD = "https://alice.example/creative-assets/2026/06/";

class AlwaysVisible {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", AlwaysVisible);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function asset(n: number, over: Partial<PodAsset> = {}): PodAsset {
  return {
    ref: mintPodAssetRef(`${POD}d${n}`),
    kind: "image",
    name: `Item ${n}`,
    description: null,
    prompt: null,
    createdAt: "2026-06-01T10:00:00.000Z",
    declaredType: "image/png",
    contentUrl: `${POD}b${n}.png`,
    thumbnailUrl: null,
    ...over,
  };
}

type Acquire = (url: string) => Promise<unknown>;

function loaderWith(acquire?: Acquire) {
  const releases: ReturnType<typeof vi.fn>[] = [];
  const loader = {
    acquire: vi.fn(async (url: string) => {
      if (acquire) return acquire(url);
      const release = vi.fn();
      releases.push(release);
      return { ok: true, value: { url: `blob:fake/${releases.length}`, contentType: "image/png", bytes: 1, release } };
    }),
    purge: vi.fn(),
  };
  return { loader: loader as unknown as MediaLoader & typeof loader, releases };
}

function page(items: PodAsset[], next: string | null = null, unreadable = 0): PodSourceResult<PodListPage> {
  return { ok: true, value: { items, next, unreadable } };
}

function setup(pages: PodSourceResult<PodListPage>[], loaderAcquire?: Acquire) {
  let index = 0;
  const { loader, releases } = loaderWith(loaderAcquire);
  const source = {
    list: vi.fn(async () => pages[Math.min(index++, pages.length - 1)]!),
    get: vi.fn(async () => ({ ok: false as const, error: "not-found" as const })),
  };
  const library: PodLibrary = { source, loader };
  const access: PodGalleryAccess = { sessionKey: "https://alice.example/profile/card#me", open: async () => library };
  const onClose = vi.fn();
  const view = render(
    <PodGalleryPanel
      access={access}
      sourceSwitch={<span data-testid="switch" />}
      onClose={onClose}
      sliderValue={7}
      onSliderChange={() => undefined}
      minColumns={3}
      maxColumns={12}
      gridColumns={5}
      imageFit="contain"
    />,
  );
  return { ...view, loader, source, releases, onClose };
}

describe("the My pod panel", () => {
  it("lists the items and shows them only through blob URLs from the loader", async () => {
    const { loader, container } = setup([page([asset(2), asset(1, { thumbnailUrl: `${POD}b1-thumb.png` })])]);
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(2));
    const sources = Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src") ?? "");
    expect(sources.every((src) => src.startsWith("blob:"))).toBe(true);
    // The loader was asked for the thumbnail when there is one, and for the file itself otherwise.
    expect(loader.acquire.mock.calls.map((call) => call[0]).sort()).toEqual([`${POD}b1-thumb.png`, `${POD}b2.png`]);
    expect(container.innerHTML).not.toContain("alice.example");
    expect(screen.getByRole("button", { name: "Item 2" })).toBeTruthy();
  });

  it("says the items are view-only", async () => {
    setup([page([asset(1)])]);
    await screen.findByRole("button", { name: "Item 1" });
    expect(screen.getByTestId("pod-view-only").textContent).toMatch(/view-only/);
  });

  it("shows the empty state with a pointer to the mirror status", async () => {
    setup([page([])]);
    await screen.findByText("Nothing in your pod yet");
    expect(screen.getByText(/Settings, under Solid pod/)).toBeTruthy();
  });

  it("names an offline pod and retries on request", async () => {
    const { source } = setup([{ ok: false, error: "offline" }, page([asset(1)])]);
    await screen.findByText("You're offline");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "Item 1" });
    expect(source.list).toHaveBeenCalledTimes(2);
  });

  it("puts a placeholder where one file fails and keeps the rest", async () => {
    const failing = `${POD}b2.png`;
    const { container } = setup([page([asset(1), asset(2)])], async (url) =>
      url === failing ? { ok: false, error: { code: "too-large", message: "x" } } : { ok: true, value: { url: "blob:fake/ok", contentType: "image/png", bytes: 1, release: vi.fn() } },
    );
    await waitFor(() => expect(screen.getByTestId("pod-failed-tile")).toBeTruthy());
    expect(screen.getByTestId("pod-failed-tile").textContent).toBe("Too large to preview");
    expect(container.querySelectorAll("img")).toHaveLength(1);
  });

  it("gives a 3D model a generic tile and never asks the loader for its bytes", async () => {
    const { loader } = setup([page([asset(1, { kind: "model3d", declaredType: "model/gltf-binary", contentUrl: `${POD}b1.glb` })])]);
    await screen.findByTestId("pod-generic-tile");
    expect(loader.acquire).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Item 1" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("3D preview isn't available for pod items yet")).toBeTruthy();
    expect(loader.acquire).not.toHaveBeenCalled();
  });

  it("does not download a video to draw its tile", async () => {
    const { loader } = setup([page([asset(1, { kind: "video", declaredType: "video/mp4", contentUrl: `${POD}b1.mp4` })])]);
    await screen.findByTestId("pod-generic-tile");
    expect(loader.acquire).not.toHaveBeenCalled();
  });

  it("opens an item in a viewer with every hosted-only action off, and says why", async () => {
    const { loader } = setup([page([asset(1, { description: "see https://evil.example/x <b>bold</b>", prompt: "<script>alert(1)</script>" })])]);
    fireEvent.click(await screen.findByRole("button", { name: "Item 1" }));
    const dialog = await screen.findByRole("dialog", { name: "Item 1" });
    for (const name of ["Use in a generation", "Add to a scene or board", "Delete"]) {
      const button = within(dialog).getByRole("button", { name });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      expect(button.getAttribute("aria-describedby")).toBe("pod-view-only-note");
    }
    expect(within(dialog).getByText(/view-only for now/)).toBeTruthy();
    // Text from the pod is text: no link, no element, no script.
    expect(within(dialog).getByText("see https://evil.example/x <b>bold</b>")).toBeTruthy();
    expect(within(dialog).getByText("<script>alert(1)</script>")).toBeTruthy();
    expect(dialog.querySelector("a, b, script")).toBeNull();
    await waitFor(() => expect(dialog.querySelector("img")?.getAttribute("src")?.startsWith("blob:")).toBe(true));
    expect(loader.acquire).toHaveBeenCalledWith(`${POD}b1.png`, expect.anything());
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks the store for the item when it opens it", async () => {
    const { source } = setup([page([asset(1)])]);
    fireEvent.click(await screen.findByRole("button", { name: "Item 1" }));
    await waitFor(() => expect(source.get).toHaveBeenCalledTimes(1));
  });

  it("releases every picture when it unmounts", async () => {
    const { releases, unmount, container } = setup([page([asset(1), asset(2)])]);
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(2));
    expect(releases.every((release) => release.mock.calls.length === 0)).toBe(true);
    unmount();
    await waitFor(() => expect(releases.length).toBeGreaterThanOrEqual(2));
    expect(releases.every((release) => release.mock.calls.length >= 1)).toBe(true);
  });

  it("asks for the next page near the end of the list and shows when there are no more", async () => {
    const { source, container } = setup([page([asset(2)], "c2"), page([asset(1)])]);
    await screen.findByRole("button", { name: "Item 2" });
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 700, configurable: true });
    Object.defineProperty(scroller, "scrollTop", { value: 1250, configurable: true });
    act(() => {
      fireEvent.scroll(scroller);
    });
    await screen.findByRole("button", { name: "Item 1" });
    expect((source.list.mock.calls as unknown[][])[1]?.[0]).toMatchObject({ cursor: "c2" });
    expect(screen.getByText("No more items")).toBeTruthy();
  });

  it("counts files it cannot show without naming them", async () => {
    setup([page([asset(1)], null, 3)]);
    await screen.findByText("3 files in your pod library can't be shown here.");
  });

  it("groups by day in the order the store listed", async () => {
    setup([page([asset(3, { createdAt: "2026-06-02T10:00:00.000Z" }), asset(2, { createdAt: "2026-06-01T10:00:00.000Z" }), asset(1, { createdAt: null })])]);
    await screen.findByRole("button", { name: "Item 3" });
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual([expect.stringMatching(/Jun 2/), expect.stringMatching(/Jun 1/), "Undated"]);
  });
});
