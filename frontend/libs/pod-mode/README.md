# @storyteller/pod-mode

Solid "pod mode" for the main window. Pod mode is entered before any pod sign-in so the window
that will hold pod credentials never runs third-party scripts and can only reach a short list
of origins. **The desktop app owns the mode; the page can only ask for it.**

## Who decides

- The Rust app keeps the pod-mode record (flag, issuer origin, storage origins,
  `credentials_may_exist`) in the app's settings directory, one file per app identifier
  (`<settings>/pod_mode/<identifier>/pod_mode.json`, so a dev overlay never reads a release
  record). The logic is in `crates/lib/pod_mode` (controller, record, CSP, window rebuild) behind
  traits, and is tested without a webview; `crates/desktop/artcraft/src/core/pod_mode` holds the
  thin Tauri adapters. The record is written atomically and synced. A corrupt or unreadable
  record is treated as enabled with the flag set (fail closed).
  **No command and no frontend capability writes the record file; the page can only ask the
  app.** That is not the same as the page being unable to reach the file: see N2 below.
- To enter pod mode the page calls `enterPodMode({ issuer })`, which invokes
  `pod_mode_enter_command`. The app validates the origin, shows a **native confirmation dialog
  that names the origin** (the non-consenting button is first and default, it stays up at least
  800 ms, and a refusal starts a 5 s cool-down), persists the record, remembers the approval in
  process memory as a one-shot "fresh connect" and rebuilds the main window. Adding a storage
  origin works the same way (`addStorageOrigin`). Leaving is `pod_mode_leave_command`; the app
  cannot verify the page wiped first, so `leavePodMode(wipe)` enforces the order. After a wipe
  in a window that is not in pod mode, `pod_mode_credentials_cleared_command` clears the flag.
  No credential ever reaches Rust: the commands take origins only, and only the main window may
  call them. Commands are serialised: a second one while one is in progress answers `busy`.
- **One CSP header, read live.** In pod mode the app sets a single `Content-Security-Policy`
  response header on every response of the main window, **replacing** the static one (macOS
  keeps one header per name, so a second header is not reliable). The pod policy therefore
  admits nothing the static policy does not, except `connect-src` origins the person approved
  in a dialog; a Rust test parses the three config files to enforce this. The policy is read
  from shared state on each response, not captured when a window is built, because WebKitGTK
  keeps the first window's handler for later windows. A window that may still hold credentials
  (the flag is set while the record says disabled) gets the header too. In a dev build the page
  comes from the dev server, no header is added and the meta policy below is the only one.
- An initialization script defines frozen, non-writable globals before any page script:
  `__ARTCRAFT_POD_MODE__` (`enabled`, `storageOrigins`, `headerPolicy`, `credentialsMayExist`,
  and, for a connect approved in this process, `freshConnect`) and `__ARTCRAFT_APP_IDENTIFIER__`.
  `readHostPodMode()` reads the first; when it exists the `localStorage` flag is not consulted.
- A rebuild waits for the old window's `Destroyed` event before building the new one, retries a
  failed build, and holds back the window-driven `ExitRequested` while it runs; if the build
  fails the app restarts rather than leaving no window.

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

What the native dialog closes: a script running in an ordinary window can no longer put the
main window into pod mode, choose the issuer or storage origins, or widen the policy through
the app's commands. Those require a person to approve a dialog the page cannot click or draw
over.

What remains:

- **N2: the `upload` capability can write files.** The existing capability
  `upload:allow-download` (and `upload:default`) lets page script write an arbitrary file. A
  script running in an ordinary window could therefore plant a pod-mode record file, with a
  chosen issuer and the flag set, at the path the app reads at its next start. Not built: a MAC
  over the record, because the key would have to live where the page cannot reach and this app
  has no such place. Mitigations in place: a planted record does not start a sign-in (a
  record loaded from disk only restores; a sign-in needs the in-process "fresh connect" that a
  dialog produced, and the record's issuer must equal it); the sign-in window shows the
  connected WebID prominently with a prompt to leave if it is not recognised. Residual, stated
  plainly: a planted record together with planted pod-auth stores could restore a session that
  belongs to the attacker (a WebID the person did not choose). The WebID display is the only
  defence against that. **Reported to the maintainers**: remove `upload:allow-download` and
  `upload:default` from the main window's capability, or scope them to the downloads directory.
- Clarity and the Google tag run arbitrary remote code in every ordinary window, and
  IndexedDB and the Cache API are shared between modes. A script that ran in an ordinary window
  can plant IndexedDB content (key pairs it kept a copy of, client registrations, a fake
  session). The session library therefore deletes every pod-auth database (the names pod-auth's key-value store
  creates, whatever the client id) before a fresh sign-in, and the UI
  shows the WebID. A separate data directory per mode would remove this; it is noted, not built.
- **The finishing window.** Leaving or a failed wipe leaves the record disabled but the
  `credentials_may_exist` flag set, so the window is restricted (no analytics, header policy)
  and only offers "Finish disconnecting" until a wipe succeeds and the flag is cleared.
- `pod_mode_leave_command` cannot check that the window wiped first. A compromised page can
  skip the wipe and leave, which restores analytics in a window that still holds pod data.
- The person can approve a malicious origin; the dialog names it, and nothing else defends
  against that.
- `img-src` and the HTTP plugin's `https://*` scope mean `connect-src` is not an exfiltration
  barrier, and top-level navigation is not restricted by the policy.
- Checked in a throwaway Tauri app on WebKitGTK: the rebuild waits for `Destroyed`, the exit
  guard holds, and a single live header arrives on every response of a rebuilt window. Still
  webview-only: enforcement on WKWebView and WebView2, whether ArtCraft itself runs under the
  policy (it drops `'unsafe-eval'`, blocks `data:` workers and inline module scripts), the
  dialog button defaults on each OS, and the real window flow. Do not enable pod mode for
  users before that is checked.

Run `nx test @storyteller/pod-mode` for the unit tests (Vitest) and `cargo test -p pod_mode`
for the Rust side.
