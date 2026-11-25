# @storyteller/pod-mode

Solid "pod mode" for the main window. Pod mode is entered before any pod sign-in so the window
that will hold pod credentials never runs third-party scripts and can only reach a short list
of origins. **The desktop app owns the mode; the page can only ask for it.**

## Who decides

- The Rust app keeps the pod-mode record (flag, issuer origin, storage origins) in its config
  directory (`crates/lib/pod_mode`, wired in `crates/desktop/artcraft/src/core/pod_mode`). The
  page cannot write it.
- To enter pod mode the page calls `enterPodMode({ issuer })`, which invokes the app's
  `pod_mode_enter_command`. The app validates the origin, shows a **native confirmation dialog
  that names the origin**, persists the record and rebuilds the main window. Adding a storage
  origin works the same way (`addStorageOrigin`). Leaving is `pod_mode_leave_command`; the app
  cannot verify the page wiped first, so `leavePodMode(wipe)` enforces the order (wipe, then
  ask) and this README states it as the control. No credential ever reaches Rust: the commands
  take origins only, and only the main window may call them.
- In pod mode the app adds the narrowed policy as a real `Content-Security-Policy` response
  header on the main window's HTML (`on_web_resource_request`), next to the static policy.
  Browsers enforce every policy they are given, so it can only restrict. Outside pod mode
  nothing changes: the static policy is untouched and `https:` is not added. In a dev build the
  page comes from the dev server, so no header is added and the meta policy below is the only
  one.
- An initialization script defines a frozen, non-writable global (`__ARTCRAFT_POD_MODE__`)
  before any page script. `readHostPodMode()` reads it; when it exists the `localStorage` flag
  is not consulted at all. The same script defines `__ARTCRAFT_APP_IDENTIFIER__`, from which
  the sign-in redirect scheme is derived.

## In the page

- The bootstrap (`/pod-bootstrap.js`, first element of `<head>`) calls `latchPodWindow()`
  once. `isPodMode()` and `analyticsAllowed()` return that value for the life of the window.
- **Fail closed:** with no app and unreadable `localStorage` (the dev fallback), or a malformed
  app answer, the window latches as pod mode, so no analytics load.
- `applyPodModePolicy(document)` inserts a `<meta http-equiv="Content-Security-Policy">` as the
  first child of `<head>` as defence in depth and as the dev fallback, and
  `markMetaPolicyApplied()` records it. `podPolicyApplied()` is true when the app's header or
  the meta element is confirmed; **the session library refuses to build pod-auth otherwise.**
- `sessionRestoreAllowed()` is true only in a pod window in which no analytics loader ran.
- `buildPodModeCsp` is the TypeScript twin of the Rust builder; the two have the same rules and
  the same tests.
- The dev fallback (no app, plain browser) keeps the old behaviour: origins and flag in
  `localStorage`, then a reload. It confers no protection beyond the meta policy and is for
  development only.

## Threat model and limits

Pod mode protects a window against passive third-party scripts going forward. It does not
protect against an origin that is already compromised.

What the native dialog now closes: a script running in an ordinary window can no longer put the
main window into pod mode, choose the issuer or storage origins, or widen the policy. Those
require a person to approve a dialog the page cannot click or draw over, and the record lives
outside the page's storage.

What remains:

- Clarity and the Google tag run arbitrary remote code in every ordinary window, and
  IndexedDB and the Cache API are shared between modes. A script that ran in an ordinary window
  can still plant IndexedDB content (key pairs it kept a copy of, client registrations, a fake
  session). The session library therefore wipes stale pod-auth databases at the start of every
  fresh sign-in, and the sign-in UI shows the WebID after restore. A separate data directory
  per mode would remove this; it is noted, not built.
- `pod_mode_leave_command` cannot check that the window wiped first. A compromised page can
  skip the wipe and leave, which restores analytics in a window that still holds pod data.
- The person can approve a malicious origin; the dialog names it, and nothing else defends
  against that.
- `img-src` and the HTTP plugin's `https://*` scope mean `connect-src` is not an exfiltration
  barrier, and top-level navigation is not restricted by the policy.
- Not verifiable without a real webview: that the header and the meta policy are enforced on
  WKWebView, WebKitGTK and WebView2, that the app runs cleanly under it (it drops
  `'unsafe-eval'`, blocks `data:` workers and inline module scripts, and something calls
  `eval` at start-up), and window rebuilding. Do not enable pod mode for users before that is
  checked.

Run `nx test @storyteller/pod-mode` for the unit tests (Vitest) and `cargo test -p pod_mode`
for the Rust side.
