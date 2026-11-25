import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PodGalleryProvider, type PodGalleryAccess } from "@storyteller/pod-gallery";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { galleryModalVisibleViewMode } from "./galleryModalSignals";

const world = vi.hoisted(() => ({ panelLoads: 0 }));
vi.mock("./pod/PodGalleryPanel", () => {
  world.panelLoads++;
  return {
    default: ({ sourceSwitch }: { sourceSwitch: React.ReactNode }) => (
      <div data-testid="pod-panel">
        {sourceSwitch}
      </div>
    ),
  };
});

import { GalleryModal } from "./gallery-modal";

const access: PodGalleryAccess = { sessionKey: "https://alice.example/profile/card#me", open: async () => Promise.reject(new Error("unused")) };

beforeEach(() => {
  world.panelLoads = 0;
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
    render(
      <PodGalleryProvider access={access}>
        <GalleryModal mode="select" isOpen />
      </PodGalleryProvider>,
    );
    await act(async () => undefined);
    expect(screen.queryByRole("group", { name: "Library source" })).toBeNull();
    expect(world.panelLoads).toBe(0);
  });

  it("opens on the ArtCraft library with a pod, and loads the pod code only when My pod is chosen", async () => {
    render(
      <PodGalleryProvider access={access}>
        <GalleryModal mode="view" />
      </PodGalleryProvider>,
    );
    await act(async () => undefined);
    expect(screen.getByRole("button", { name: "ArtCraft library" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("All Assets", { selector: "button" })).toBeTruthy();
    expect(world.panelLoads).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "My pod" }));
    expect(await screen.findByTestId("pod-panel")).toBeTruthy();
    expect(world.panelLoads).toBe(1);
    expect(screen.queryByText("All Assets", { selector: "button" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "ArtCraft library" }));
    expect(screen.queryByTestId("pod-panel")).toBeNull();
    expect(screen.getByText("All Assets", { selector: "button" })).toBeTruthy();
  });

  it("drops the pod view when the gallery closes or the pod is disconnected", async () => {
    const { rerender } = render(
      <PodGalleryProvider access={access}>
        <GalleryModal mode="view" />
      </PodGalleryProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "My pod" }));
    expect(await screen.findByTestId("pod-panel")).toBeTruthy();

    act(() => {
      galleryModalVisibleViewMode.value = false;
    });
    expect(screen.queryByTestId("pod-panel")).toBeNull();
    act(() => {
      galleryModalVisibleViewMode.value = true;
    });
    expect(await screen.findByTestId("pod-panel")).toBeTruthy();

    rerender(
      <PodGalleryProvider access={null}>
        <GalleryModal mode="view" />
      </PodGalleryProvider>,
    );
    expect(screen.queryByTestId("pod-panel")).toBeNull();
    expect(screen.queryByText("My pod")).toBeNull();
    expect(screen.getByText("All Assets", { selector: "button" })).toBeTruthy();
  });
});
