import { afterEach, describe, expect, it, vi } from "vitest";
import { latchPodWindow, resetPodWindowForTests } from "@storyteller/pod-mode";
import { initPostHogIfAllowed } from "./posthog-init";

afterEach(() => {
  resetPodWindowForTests();
  localStorage.clear();
});

describe("initPostHogIfAllowed", () => {
  it("initialises outside pod mode", () => {
    const init = vi.fn();
    expect(initPostHogIfAllowed("key", init)).toBe(true);
    expect(init).toHaveBeenCalledWith("key", expect.objectContaining({ api_host: expect.any(String) }));
  });

  it("does not initialise in a pod window", () => {
    localStorage.setItem("artcraft.podMode", "1");
    latchPodWindow();
    const init = vi.fn();
    expect(initPostHogIfAllowed("key", init)).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });
});
