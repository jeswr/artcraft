import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { DesktopHost } from "@jeswr/desktop-auth";

/**
 * The shell side of Solid sign-in: the official opener and deep-link plugins' own JS APIs,
 * passed to `@jeswr/desktop-auth` unchanged. `onOpenUrl` hands the callback URL (authorization
 * code and state) straight to the listener desktop-auth registers. Nothing here reads, stores,
 * logs or re-emits it, and no custom Rust command is involved.
 */
export const tauriDesktopHost: DesktopHost = {
  openUrl: (url) => openUrl(url),
  onOpenUrl: (listener) => onOpenUrl(listener),
};
