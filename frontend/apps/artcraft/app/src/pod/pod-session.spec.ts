import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPodWindowForTests } from "@storyteller/pod-mode";
import { localStorageMarker } from "@storyteller/pod-session";
import { createTauriPodModeRequests } from "./tauri-requests";

afterEach(() => {
  vi.resetModules();
  delete (globalThis as Record<string, unknown>)["__ARTCRAFT_APP_IDENTIFIER__"];
  delete (globalThis as Record<string, unknown>)["__ARTCRAFT_POD_MODE__"];
  resetPodWindowForTests();
  localStorage.clear();
});

describe("createTauriPodModeRequests", () => {
  it("maps the app's answers and passes origins only", async () => {
    const call = vi.fn(async (_command: string, _args?: Record<string, unknown>): Promise<unknown> => "applied");
    const requests = createTauriPodModeRequests(call);
    await expect(requests.requestEnter({ issuer: "https://login.example" })).resolves.toBe("requested");
    await expect(requests.requestAddStorageOrigin("https://pod.example")).resolves.toBe("requested");
    await requests.requestLeave();
    await requests.requestReload();
    await requests.requestCredentialsCleared();
    expect(call.mock.calls).toEqual([
      ["pod_mode_enter_command", { issuer: "https://login.example" }],
      ["pod_mode_add_storage_origin_command", { origin: "https://pod.example" }],
      ["pod_mode_leave_command", undefined],
      ["pod_mode_reload_command", undefined],
      ["pod_mode_credentials_cleared_command", undefined],
    ]);
  });

  it("consumes the approved issuer and rejects anything but a string", async () => {
    const call = vi.fn(async (_c: string, _a?: Record<string, unknown>): Promise<unknown> => "https://id.example");
    await expect(createTauriPodModeRequests(call).requestConsumeFresh()).resolves.toBe("https://id.example");
    expect(call).toHaveBeenCalledWith("pod_mode_consume_fresh_command");
    await expect(createTauriPodModeRequests(async () => "").requestConsumeFresh()).rejects.toThrow();
    await expect(createTauriPodModeRequests(async () => 3).requestConsumeFresh()).rejects.toThrow();
  });

  it("asks the app to sign in again with no origin, and maps its consent answers", async () => {
    const call = vi.fn(async (_c: string, _a?: Record<string, unknown>): Promise<unknown> => "too_fast");
    await expect(createTauriPodModeRequests(call).requestSignInAgain()).resolves.toBe("too-fast");
    expect(call).toHaveBeenCalledWith("pod_mode_sign_in_again_command", undefined);
    await expect(createTauriPodModeRequests(async () => "applied").requestSignInAgain()).resolves.toBe("requested");
  });

  it("reports a declined confirmation", async () => {
    const requests = createTauriPodModeRequests(async () => "declined");
    await expect(requests.requestEnter({ issuer: "https://login.example" })).resolves.toBe("declined");
  });

  it("rejects an answer it does not know, and a refusal from the app", async () => {
    await expect(createTauriPodModeRequests(async () => "maybe").requestLeave()).rejects.toThrow();
    await expect(
      createTauriPodModeRequests(async () => {
        throw "forbidden";
      }).requestReload(),
    ).rejects.toBe("forbidden");
  });
});

describe("the window's session", () => {
  it("derives the redirect from the app identifier and keeps sign-in off without one", async () => {
    (globalThis as Record<string, unknown>)["__ARTCRAFT_APP_IDENTIFIER__"] = "ai.artcraft.app.dev";
    const { readAppIdentifier } = await import("./pod-session");
    expect(readAppIdentifier()).toBe("ai.artcraft.app.dev");
    const { readConfig, checkConfig } = await import("@storyteller/pod-session");
    expect(readConfig(readAppIdentifier()).redirectUri).toBe("ai.artcraft.app.dev:/oauth/callback");
    expect(checkConfig(readConfig(""))).not.toBe("ok");
  });

  it("builds one session, disabled while the client identifier is a placeholder", async () => {
    const { podSession } = await import("./pod-session");
    expect(podSession.configCheck()).toBe("not-configured");
    expect(podSession.inPodMode()).toBe(false);
    expect(podSession.getFetch()).toBeNull();
  });

  it("starts now in a pod window the app recorded, and not in an ordinary one", async () => {
    (globalThis as Record<string, unknown>)["__ARTCRAFT_POD_MODE__"] = { enabled: true, storageOrigins: [], headerPolicy: true, credentialsMayExist: true };
    const pod = await import("./pod-session");
    expect(pod.startPodSessionNow()).toBe(true);
    vi.resetModules();
    resetPodWindowForTests();
    (globalThis as Record<string, unknown>)["__ARTCRAFT_POD_MODE__"] = { enabled: false, storageOrigins: [], headerPolicy: false, credentialsMayExist: false };
    const ordinary = await import("./pod-session");
    expect(ordinary.startPodSessionNow()).toBe(false);
  });

  it("starts now in an ordinary window when a step is waiting, so its answer is shown", async () => {
    (globalThis as Record<string, unknown>)["__ARTCRAFT_POD_MODE__"] = { enabled: false, storageOrigins: [], headerPolicy: false, credentialsMayExist: false };
    localStorageMarker().set("done");
    const { startPodSessionNow } = await import("./pod-session");
    expect(startPodSessionNow()).toBe(true);
  });

  it("starts now in a finishing window, with no marker", async () => {
    (globalThis as Record<string, unknown>)["__ARTCRAFT_POD_MODE__"] = { enabled: false, storageOrigins: [], headerPolicy: false, credentialsMayExist: true };
    const { startPodSessionNow } = await import("./pod-session");
    expect(startPodSessionNow()).toBe(true);
  });
});
