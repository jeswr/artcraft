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
  cannot verify the page wiped first, so `leavePodMode(wipe)` enforces the order, but leaving
  **never clears `credentials_may_exist`**: it records "not in pod mode, credentials may still
  exist" and rebuilds the window as a restricted "finishing" window. Only
  `pod_mode_credentials_cleared_command`, sent by a window that is not in pod mode after its own
  wipe reported success, clears the flag (and leaving outside pod mode is refused, so the flag
  cannot be raised that way).
  No credential ever reaches Rust: the commands take origins only, and only the main window may
  call them. Commands are serialised: a second one while one is in progress answers `busy`.
- **Storage origins (a pod whose storage is on another origin than its sign-in server).** The
  policy starts with the issuer only. `@storyteller/pod-session` wraps the session's
  authenticated `getFetch()` so that, before the first request to an origin the window's policy
  does not list (the storage root, a Type Index elsewhere), it calls `addStorageOrigin(origin)`
  with that bare origin, nothing else. **The limits are the app's, not the page's**, because a
  compromised page can call `pod_mode_add_storage_origin_command` directly:
  - The app validates the origin: https only (`localhost` and `127.0.0.1`, http or https, only
    in a debug build); a public DNS host of at least two labels of `[a-z0-9-]`, no trailing dot,
    empty label, `xn--` label, IP literal or all-digit last label; no path, wildcard, userinfo,
    explicit default port or list separator. The Rust and TypeScript validators are tested
    against one table of vectors (`crates/lib/pod_mode/testdata/origin-vectors.json`).
  - The issuer's own origin and an origin already saved need no dialog. Anything else shows a
    native dialog that names the origin and says only what the app knows: "ArtCraft is asking
    to connect to <origin>. Only allow this if it is where your Solid pod or profile lives",
    that it cannot check why it is being asked, and that the window reloads. Cancel is the
    default button; an Allow that comes back in under 800 ms is reported as `too_fast` (nothing
    changes, the origin is not recorded as refused, ask again after the wait).
  - The record persists a count of dialogs shown (counted and saved **before** the dialog
    opens): at most 6 in a pod-mode session, however they were answered. It also persists the
    origins the person declined; a declined origin is never asked about again until pod mode is
    left and entered anew (a Settings action to forget refusals is not built). Each refusal
    doubles the wait before the next dialog (5 s, 10 s, 20 s, up to 5 min). At most 8 origins
    are saved. Entering pod mode again starts a new budget.
  - Only a considered "Allow" persists the origin and rebuilds the window; the rebuilt window
    restores the session with the origin already in its header policy, and so does every later
    launch.
  **A hostile profile cannot put an origin into `connect-src` silently:** it can only cause a
  dialog, at most 6 per session and never twice for an origin the person declined. The page-side
  gate is a convenience over this: one ask per origin, in turn, remembers a decline per origin
  (a limit from the app for the window), treats `busy` / `cooling_down` / `too_fast` as "try
  later", honours the caller's `AbortSignal`, and rejects with `StorageOriginRefused` (a closed
  `reason`, fixed message, no URL). What is left: a person who clicks Allow on a hostile
  origin, an Allow dialog that reloads the window under someone who is working (the dialog says
  so), and requests a redirect sends to an unadmitted origin (the policy blocks those; the gate
  only sees the first URL).
  **pod-auth's own reads go through the same gate, explained first.** pod-auth's `fetch` option
  (issuer metadata, the Client Identifier Document, the WebID profile, storage descriptions;
  body-less GET and HEAD only) receives the gate in a mode that refuses an unlisted origin at
  once instead of opening the dialog, so a profile on another origin than the provider is not
  fetched before the person has seen why: the page explains, the person clicks Allow, and only
  then does the app's dialog appear. A WebID typed in Settings enters pod mode for its own
  origin. After an accepted add the app leaves the rebuilt window a one-shot fresh grant for the
  recorded origin, so a sign-in interrupted by an approval can continue with one click; the page
  only uses it with a pending hint of its own for that exact origin (see `libs/pod-session`).
  The trade-off: a planted record and hint plus a dialog the person allowed could offer one
  Continue click, and the page shows the address first. Token, registration and revocation POSTs
  and redirect hops are not gated and fail untyped under the policy (see `libs/pod-session`,
  "Remaining limits").
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
- **The finishing window.** Leaving, or a quit or crash at any point after the app saved the
  leave, leaves the record disabled but the `credentials_may_exist` flag set, so every launch
  is restricted (no analytics, header policy) and the window deletes the pod-auth data before
  doing anything else; it offers "Finish disconnecting" if that delete cannot be confirmed.
  Only a confirmed wipe in that window clears the flag. This also covers a page that skipped
  its wipe before asking to leave: the finishing window repeats it.
  **If the wipe can never be confirmed** (the webview cannot list or delete IndexedDB
  databases, or a delete keeps failing), the app stays in the finishing window on every launch
  and cannot connect again. That is deliberate: any way out that cleared the flag without a
  confirmed wipe would let analytics scripts run next to stored credentials. The window says
  so, offers "Finish disconnecting" again, and suggests quitting and reopening. A person who
  cannot get past it has to remove ArtCraft's web storage by the operating system's means
  (platform paths are not documented here, unchecked) and only then delete
  `<settings>/pod_mode/<identifier>/pod_mode.json` by hand; deleting the record first would
  drop the restriction while the credentials may still be stored.
- `pod_mode_leave_command` needs no dialog and cannot check that the window wiped first. A
  compromised page can end pod mode at any time (a forced disconnect), but the result is the
  finishing window above, which is first-party only and wipes before anything else; a
  compromise would have to survive a rebuild to matter. `credentials_cleared` is a claim by a
  freshly loaded window, not a verification the app can make. `enter` is refused while pod mode
  is on or while the flag is set, so an issuer cannot be swapped under stored credentials; in an
  ordinary window `credentials_cleared` and `reload` answer without rebuilding, so a script
  there cannot destroy the window in a loop.
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
