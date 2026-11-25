import { describe, expect, it, vi } from "vitest";
import { createTauriPodModeRequests } from "./tauri-requests";

describe("createTauriPodModeRequests", () => {
  it("sends only the origin to the add-storage-origin command and maps the app's answers", async () => {
    const answers = ["applied", "declined", "too_fast"];
    const call = vi.fn(async () => answers.shift());
    const requests = createTauriPodModeRequests(call);
    expect(await requests.requestAddStorageOrigin("https://pod.example")).toBe("requested");
    expect(await requests.requestAddStorageOrigin("https://pod.example")).toBe("declined");
    expect(await requests.requestAddStorageOrigin("https://pod.example")).toBe("too-fast");
    expect(call.mock.calls).toEqual(Array(3).fill(["pod_mode_add_storage_origin_command", { origin: "https://pod.example" }]));
  });

  it("rejects an answer it does not know, and passes the app's error word through", async () => {
    const requests = createTauriPodModeRequests(async () => "surprise");
    await expect(requests.requestAddStorageOrigin("https://pod.example")).rejects.toThrow();
    await expect(requests.requestEnter({ issuer: "https://login.example" })).rejects.toThrow();
    const failing = createTauriPodModeRequests(async () => {
      throw "cooling_down";
    });
    await expect(failing.requestAddStorageOrigin("https://pod.example")).rejects.toBe("cooling_down");
  });

  it("does not treat too_fast as an answer to the other dialogs", async () => {
    const requests = createTauriPodModeRequests(async () => "too_fast");
    await expect(requests.requestEnter({ issuer: "https://login.example" })).rejects.toThrow();
  });
});
