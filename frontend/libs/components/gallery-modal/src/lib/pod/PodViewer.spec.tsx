import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asset, contentUrl, gifBomb, mp4, page, png, pngFiles, testPod, thumbUrl } from "./podTestKit";
import { mount } from "./podMount";

afterEach(cleanup);

async function openItem(name: string) {
  const tile = await screen.findByRole("button", { name });
  fireEvent.click(tile);
  return { tile, dialog: await screen.findByRole("dialog", { name }) };
}

describe("the pod viewer", () => {
  it("opens an item over the gallery with every hosted-only action off but reachable, each with the reason", async () => {
    const pod = testPod([page([asset(1, { description: "see https://evil.example/x <b>bold</b>", prompt: "<script>alert(1)</script>" })])], { files: pngFiles(1) });
    mount(pod);
    const { dialog } = await openItem("Item 1");
    for (const name of ["Use in a generation", "Add to a scene or board", "Delete"]) {
      const button = within(dialog).getByRole("button", { name });
      expect(button.hasAttribute("disabled")).toBe(false);
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("aria-describedby")).toBe("pod-view-only-note");
      button.focus();
      expect(document.activeElement).toBe(button);
      fireEvent.click(button);
    }
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(within(dialog).getByText(/view-only for now/)).toBeTruthy();
    // Text from the pod is text: no link, no element, no script.
    expect(within(dialog).getByText("see https://evil.example/x <b>bold</b>")).toBeTruthy();
    expect(within(dialog).getByText("<script>alert(1)</script>")).toBeTruthy();
    expect(dialog.querySelector("a, b, script")).toBeNull();
    await waitFor(() => expect(dialog.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/));
    expect(pod.reads).toContain(contentUrl(1));
  });

  it("asks the store for the item when it opens it", async () => {
    const pod = testPod([page([asset(1)])], { files: pngFiles(1) });
    mount(pod);
    await openItem("Item 1");
    await waitFor(() => expect(pod.source.get).toHaveBeenCalledTimes(1));
  });

  it("moves focus in, keeps Tab inside, and on Escape closes only itself and returns focus to the tile", async () => {
    const pod = testPod([page([asset(1)])], { files: pngFiles(1) });
    const { onClose } = mount(pod);
    const { tile, dialog } = await openItem("Item 1");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));

    // Tab from the last control wraps to the first, and Shift+Tab from the first wraps to the last.
    const stops = Array.from(dialog.querySelectorAll<HTMLElement>("button"));
    stops[stops.length - 1]!.focus();
    fireEvent.keyDown(stops[stops.length - 1]!, { key: "Tab" });
    expect(document.activeElement).toBe(stops[0]);
    fireEvent.keyDown(stops[0]!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(stops[stops.length - 1]);
    // Focus that has strayed outside comes back in.
    tile.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    // The gallery's own Escape handling (a capture listener on the document) never sees it.
    const gallery = vi.fn();
    document.addEventListener("keydown", gallery, true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    document.removeEventListener("keydown", gallery, true);
    expect(gallery).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(tile);
  });

  it("chooses the element from the type the loader sniffed, not the one the pod declared", async () => {
    const files = pngFiles(1);
    files.set(contentUrl(1), { bytes: png(1) });
    const pod = testPod([page([asset(1, { kind: "video", declaredType: "video/mp4" })])], { files });
    mount(pod);
    const { dialog } = await openItem("Item 1");
    await waitFor(() => expect(dialog.querySelector("img")).toBeTruthy());
    expect(dialog.querySelector("video")).toBeNull();
  });

  it("shows real video in a <video> that cannot be dragged, downloaded, cast or popped out", async () => {
    const files = pngFiles(1);
    files.set(contentUrl(1), { bytes: mp4() });
    const pod = testPod([page([asset(1, { kind: "video", declaredType: "image/png" })])], { files });
    mount(pod);
    const { dialog } = await openItem("Item 1");
    const video = await waitFor(() => {
      const node = dialog.querySelector("video");
      expect(node).toBeTruthy();
      return node as HTMLVideoElement;
    });
    expect(video.getAttribute("src")).toMatch(/^blob:/);
    expect(video.getAttribute("draggable")).toBe("false");
    expect(video.hasAttribute("disablepictureinpicture")).toBe(true);
    expect(video.hasAttribute("disableremoteplayback")).toBe(true);
    expect(video.getAttribute("controlslist")).toContain("nodownload");
    expect(fireEvent.dragStart(video)).toBe(false);
    expect(fireEvent.contextMenu(video)).toBe(false);
    expect(dialog.querySelector("img")).toBeNull();
  });

  it("cannot drag the picture out of the viewer, nor out of a tile", async () => {
    const pod = testPod([page([asset(1)])], { files: pngFiles(1) });
    const { container } = mount(pod);
    await waitFor(() => expect(container.querySelector("img")).toBeTruthy());
    const tileImage = container.querySelector("img")!;
    expect(tileImage.getAttribute("draggable")).toBe("false");
    expect(fireEvent.dragStart(tileImage)).toBe(false);
    const { dialog } = await openItem("Item 1");
    const image = await waitFor(() => {
      const node = dialog.querySelector("img");
      expect(node).toBeTruthy();
      return node as HTMLImageElement;
    });
    expect(image.getAttribute("draggable")).toBe("false");
    expect(fireEvent.dragStart(image)).toBe(false);
    expect(fireEvent.contextMenu(image)).toBe(false);
  });

  it("refuses the decompression-bomb GIF from the review: 1x1 logical screen, 65535x65535 frame", async () => {
    const files = pngFiles(1);
    files.set(contentUrl(1), { bytes: gifBomb() });
    const pod = testPod([page([asset(1, { declaredType: "image/gif" })])], { files });
    mount(pod);
    const { dialog } = await openItem("Item 1");
    await waitFor(() => expect(within(dialog).getByTestId("pod-viewer-placeholder")).toBeTruthy());
    expect(dialog.querySelector("img, video")).toBeNull();
    // Nothing was made for the bomb: the only object URL is the grid's thumbnail.
    expect(pod.objectUrls.createObjectURL).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByTestId("pod-viewer-placeholder").textContent).toMatch(/too large|Couldn't|can't be previewed/i);
  });

  it("shows a model by its thumbnail only and never reads its file", async () => {
    const pod = testPod([page([asset(1, { kind: "model3d", declaredType: "model/gltf-binary" })])], { files: pngFiles(1) });
    mount(pod);
    const { dialog } = await openItem("Item 1");
    await waitFor(() => expect(dialog.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/));
    expect(pod.reads).not.toContain(contentUrl(1));
    expect(pod.reads).toContain(thumbUrl(1));
  });

  it("says a model without a thumbnail has no preview", async () => {
    const pod = testPod([page([asset(1, { kind: "model3d", thumbnail: null })])]);
    mount(pod);
    const { dialog } = await openItem("Item 1");
    expect(within(dialog).getByText("3D preview isn't available for pod items yet")).toBeTruthy();
    expect(pod.reads).toEqual([]);
  });

  it("shows an ended session (a purge while it is open) as not loaded and releases its hold", async () => {
    const pod = testPod([page([asset(1)])], { files: pngFiles(1) });
    mount(pod);
    const { dialog } = await openItem("Item 1");
    await waitFor(() => expect(dialog.querySelector("img")).toBeTruthy());
    expect(pod.viewerCounts.acquired).toBe(1);
    act(() => pod.viewerLoader.purge());
    expect(dialog.querySelector("img")).toBeNull();
    expect(within(dialog).getByTestId("pod-viewer-placeholder").textContent).toContain("Not loaded");
    expect(pod.objectUrls.revokeObjectURL).toHaveBeenCalled();
  });

  it("releases the original when it closes", async () => {
    const pod = testPod([page([asset(1)])], { files: pngFiles(1) });
    mount(pod);
    const { dialog } = await openItem("Item 1");
    await waitFor(() => expect(dialog.querySelector("img")).toBeTruthy());
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(pod.viewerCounts.released).toBe(pod.viewerCounts.acquired);
    expect(pod.viewerCounts.acquired).toBe(1);
  });
});
