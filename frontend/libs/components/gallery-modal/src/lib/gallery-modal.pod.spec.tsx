import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PodGalleryProvider, type PodGalleryAccess, type PodGallerySignedOut } from "@storyteller/pod-gallery";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { galleryModalVisibleViewMode } from "./galleryModalSignals";
import { asset, page, pngFiles, testPod } from "./pod/podTestKit";

// The real panel is loaded; the mock only counts loads, can hold one back, and can make it throw.
const world = vi.hoisted(() => ({ panelLoads: 0, gate: null as Promise<void> | null, explode: false }));
vi.mock("./pod/PodGalleryPanel", async (importOriginal) => {
  world.panelLoads++;
  if (world.gate) await world.gate;
  const real = await importOriginal<typeof import("./pod/PodGalleryPanel")>();
  return { default: (props: Parameters<typeof real.default>[0]) => (world.explode ? Boom() : real.default(props)) };
});
function Boom(): never {
  throw new Error("https://alice.example/secret?token=abc");
}

import { GalleryModal } from "./gallery-modal";

const KEY = "https://alice.example/profile/card#me";

function accessFor(pod: ReturnType<typeof testPod>, sessionKey = KEY): PodGalleryAccess {
  return { sessionKey, open: async () => pod.library };
}

beforeEach(() => {
  world.panelLoads = 0;
  world.gate = null;
  world.explode = false;
  galleryModalVisibleViewMode.value = true;
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} unobserve() {} });
  // The ArtCraft library asks the hosted API; nothing here may reach a network.
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  galleryModalVisibleViewMode.value = false;
});

describe("the gallery's source switch", () => {
  it("is absent with no pod connected, and the pod code is never loaded", async () => {
    render(<GalleryModal mode="view" />);
    await act(async () => undefined);
    expect(screen.getByText("All Assets", { selector: "button" })).toBeTruthy();
    expect(screen.queryByText("My pod")).toBeNull();
    expect(screen.queryByRole("group", { name: "Library source" })).toBeNull();
    expect(world.panelLoads).toBe(0);
  });

  it("is absent in select mode even with a pod, because pod items cannot be selected", async () => {
    const pod = testPod([page([])]);
    render(
      <PodGalleryProvider access={accessFor(pod)}>
        <GalleryModal mode="select" isOpen />
      </PodGalleryProvider>,
    );
    await act(async () => undefined);
    expect(screen.queryByRole("group", { name: "Library source" })).toBeNull();
    expect(world.panelLoads).toBe(0);
  });

  it("opens on the ArtCraft library, loads the pod code only when My pod is chosen, and puts focus on the switch", async () => {
    const pod = testPod([page([asset(1)])], { files: pngFiles(1) });
    render(
      <PodGalleryProvider access={accessFor(pod)}>
        <GalleryModal mode="view" />
      </PodGalleryProvider>,
    );
    await act(async () => undefined);
    expect(screen.getByRole("button", { name: "ArtCraft library" }).getAttribute("aria-pressed")).toBe("true");
    expect(world.panelLoads).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "My pod" }));
    expect(await screen.findByRole("button", { name: "Item 1" })).toBeTruthy();
    expect(world.panelLoads).toBe(1);
    expect(screen.queryByText("All Assets", { selector: "button" })).toBeNull();
    // The switch was re-created by choosing; focus is on the chosen button, not lost.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "My pod" }));

    fireEvent.click(screen.getByRole("button", { name: "ArtCraft library" }));
    expect(screen.queryByRole("button", { name: "Item 1" })).toBeNull();
    expect(screen.getByText("All Assets", { selector: "button" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "ArtCraft library" }));
  });

  it("keeps the switch and the header on screen while the panel's code is loading", async () => {
    let open!: () => void;
    world.gate = new Promise<void>((resolve) => (open = resolve));
    const pod = testPod([page([asset(1)])], { files: pngFiles(1) });
    render(
      <PodGalleryProvider access={accessFor(pod)}>
        <GalleryModal mode="view" />
      </PodGalleryProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "My pod" }));
    expect(screen.getByTestId("pod-skeleton")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "My pod" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ArtCraft library" })).toBeTruthy();
    expect(screen.queryByText("All Assets", { selector: "button" })).toBeNull();
    await act(async () => open());
    expect(await screen.findByRole("button", { name: "Item 1" })).toBeTruthy();
  });

  it("shows a fixed sentence and a way back when the panel fails, never the error's text", async () => {
    world.explode = true;
    const pod = testPod([page([asset(1)])], { files: pngFiles(1) });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <PodGalleryProvider access={accessFor(pod)}>
        <GalleryModal mode="view" />
      </PodGalleryProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "My pod" }));
    expect(await screen.findByText("My pod couldn't be shown")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("secret");
    error.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "Back to the ArtCraft library" }));
    expect(screen.getByText("All Assets", { selector: "button" })).toBeTruthy();
  });

  it("starts the panel again for a different account, so nothing of the old one stays on screen", async () => {
    const alice = testPod([page([asset(1, { name: "Alice's" })])], { files: pngFiles(1) });
    const bob = testPod([page([asset(1, { name: "Bob's" })])], { files: pngFiles(1) });
    const { rerender } = render(
      <PodGalleryProvider access={accessFor(alice)}>
        <GalleryModal mode="view" />
      </PodGalleryProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "My pod" }));
    await screen.findByRole("button", { name: "Alice's" });
    rerender(
      <PodGalleryProvider access={accessFor(bob, "https://bob.example/profile/card#me")}>
        <GalleryModal mode="view" />
      </PodGalleryProvider>,
    );
    await screen.findByRole("button", { name: "Bob's" });
    expect(screen.queryByRole("button", { name: "Alice's" })).toBeNull();
  });
});

describe("what the gallery lets go of", () => {
  it("releases every picture the pod view held when the gallery closes, and does not show the ArtCraft library as it goes", async () => {
    const pod = testPod([page([asset(1), asset(2)])], { files: pngFiles(2) });
    render(
      <PodGalleryProvider access={accessFor(pod)}>
        <GalleryModal mode="view" />
      </PodGalleryProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "My pod" }));
    await waitFor(() => expect(pod.tileCounts.acquired).toBe(2));
    fireEvent.click(await screen.findByRole("button", { name: "Item 1" }));
    await waitFor(() => expect(pod.viewerCounts.acquired).toBe(1));
    expect(pod.tileCounts.released).toBe(0);

    act(() => {
      galleryModalVisibleViewMode.value = false;
    });
    // Neither the panel nor the hosted library is on screen at any point after closing.
    expect(screen.queryByRole("button", { name: "Item 1" })).toBeNull();
    expect(screen.queryByText("All Assets", { selector: "button" })).toBeNull();
    // Closing frees the pictures, not just the holds: every blob URL made is revoked.
    expect(pod.objectUrls.revokeObjectURL).toHaveBeenCalledTimes(pod.objectUrls.createObjectURL.mock.calls.length);
    expect(pod.tileLoader.stats().entries).toBe(0);
    expect(pod.viewerLoader.stats().entries).toBe(0);
  });

  it("releases everything when the pod is disconnected, and returns to the ArtCraft library", async () => {
    const pod = testPod([page([asset(1), asset(2)])], { files: pngFiles(2) });
    const { rerender } = render(
      <PodGalleryProvider access={accessFor(pod)}>
        <GalleryModal mode="view" />
      </PodGalleryProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "My pod" }));
    await waitFor(() => expect(pod.tileCounts.acquired).toBe(2));
    rerender(
      <PodGalleryProvider access={null}>
        <GalleryModal mode="view" />
      </PodGalleryProvider>,
    );
    expect(pod.objectUrls.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("My pod")).toBeNull();
    expect(screen.getByText("All Assets", { selector: "button" })).toBeTruthy();
  });

  it("keeps My pod when the session ends there, says to sign in again and offers it, and releases the pictures", async () => {
    const pod = testPod([page([asset(1), asset(2)])], { files: pngFiles(2) });
    const { rerender } = render(
      <PodGalleryProvider access={accessFor(pod)}>
        <GalleryModal mode="view" />
      </PodGalleryProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "My pod" }));
    await waitFor(() => expect(pod.tileCounts.acquired).toBe(2));
    // The gate ended the session: no access to the pod, but the window can sign in again.
    const signedOut: PodGallerySignedOut = { signInAgain: vi.fn() };
    rerender(
      <PodGalleryProvider access={null} signedOut={signedOut}>
        <GalleryModal mode="view" />
      </PodGalleryProvider>,
    );
    expect(pod.objectUrls.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "My pod" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("alert").textContent).toMatch(/Sign in to your pod again/);
    // Not the ArtCraft library behind it.
    expect(screen.queryByText("All Assets", { selector: "button" })).toBeNull();
    expect(signedOut.signInAgain).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(signedOut.signInAgain).toHaveBeenCalledTimes(1);
    // The person can still go to the ArtCraft library.
    fireEvent.click(screen.getByRole("button", { name: "ArtCraft library" }));
    expect(screen.getByText("All Assets", { selector: "button" })).toBeTruthy();
  });
});
