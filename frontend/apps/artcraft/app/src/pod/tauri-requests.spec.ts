import { describe, expect, it, vi } from "vitest";
import { createTauriPodModeRequests } from "./tauri-requests";

describe("createTauriPodModeRequests", () => {
  it("sends only the origin to the add-storage-origin command and maps the app's answers", async () => {
    const answers = ["applied", "declined", "too_fast"];
    const call = vi.fn(async () => answers.shift());
    const requests = createTauriPodModeRequests(call);
    expect(await requests.requestAddStorageOrigin("https://pod.example", "sign-in")).toBe("requested");
    expect(await requests.requestAddStorageOrigin("https://pod.example", "sign-in")).toBe("declined");
    expect(await requests.requestAddStorageOrigin("https://pod.example", "sign-in")).toBe("too-fast");
    expect(call.mock.calls).toEqual(Array(3).fill(["pod_mode_add_storage_origin_command", { origin: "https://pod.example", purpose: "sign-in" }]));
  });

  it("rejects an answer it does not know, and passes the app's error word through", async () => {
    const requests = createTauriPodModeRequests(async () => "surprise");
    await expect(requests.requestAddStorageOrigin("https://pod.example", "sign-in")).rejects.toThrow();
    await expect(requests.requestEnter({ issuer: "https://login.example" })).rejects.toThrow();
    const failing = createTauriPodModeRequests(async () => {
      throw "cooling_down";
    });
    await expect(failing.requestAddStorageOrigin("https://pod.example", "storage")).rejects.toBe("cooling_down");
  });

  it("treats too_fast as an answer to the two consent dialogs only", async () => {
    const requests = createTauriPodModeRequests(async () => "too_fast");
    await expect(requests.requestEnter({ issuer: "https://login.example" })).resolves.toBe("too-fast");
    await expect(requests.requestLeave()).rejects.toThrow();
    await expect(requests.requestReload()).rejects.toThrow();
    await expect(requests.requestCredentialsCleared()).rejects.toThrow();
  });

  it("names every purpose the page may give, and nothing else, to the app", async () => {
    const call = vi.fn(async () => "applied");
    const requests = createTauriPodModeRequests(call);
    for (const purpose of ["profile", "storage", "sign-in", "app-identity"] as const) {
      await requests.requestAddStorageOrigin("https://pod.example", purpose);
    }
    expect(call.mock.calls.map((c) => (c as unknown[])[1])).toEqual(
      ["profile", "storage", "sign-in", "app-identity"].map((purpose) => ({ origin: "https://pod.example", purpose })),
    );
  });
});
