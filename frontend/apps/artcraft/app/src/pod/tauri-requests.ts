import { invoke } from "@tauri-apps/api/core";
import type { PodModeRequests } from "@storyteller/pod-mode";

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * The app's pod-mode commands, as `PodModeRequests`. Each carries an origin at most; no
 * token, key or verifier is ever passed to Rust. The app asks the person in a native dialog
 * before it changes the mode, and answers `declined` when they say no.
 */
export function createTauriPodModeRequests(call: Invoke = invoke): PodModeRequests {
  const outcome = async (command: string, args?: Record<string, unknown>) => {
    const answer = await call(command, args);
    if (answer === "applied") return "requested" as const;
    if (answer === "declined") return "declined" as const;
    throw new Error("unexpected answer from the app");
  };
  return {
    requestEnter: ({ issuer }) => outcome("pod_mode_enter_command", { issuer }),
    requestAddStorageOrigin: (origin) => outcome("pod_mode_add_storage_origin_command", { origin }),
    requestLeave: async () => void (await outcome("pod_mode_leave_command")),
    requestReload: async () => void (await outcome("pod_mode_reload_command")),
    requestCredentialsCleared: async () => void (await outcome("pod_mode_credentials_cleared_command")),
    requestConsumeFresh: async () => {
      const issuer = await call("pod_mode_consume_fresh_command");
      if (typeof issuer !== "string" || issuer === "") throw new Error("unexpected answer from the app");
      return issuer;
    },
  };
}
