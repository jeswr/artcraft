# @storyteller/pod-mode

Inert "pod mode" window state. Pod mode is entered before any pod sign-in so the window that
will hold pod credentials never runs third-party scripts. Nothing in the app calls
`enterPodMode` yet.

- The bootstrap (`/pod-bootstrap.js`, the first element of `<head>`) calls `latchPodWindow()`
  once. `isPodMode()` and `analyticsAllowed()` return that latched value for the life of the
  window, so writing the flag later (as `enterPodMode` does before it reloads) never changes
  what the current window is.
- **Fail closed:** if `localStorage` cannot be read, the window latches as pod mode, so no
  analytics load. The cost is that an ordinary user with blocked site data gets the pod policy.
- `sessionRestoreAllowed()` is true only in a pod window in which no analytics loader ever ran
  (`markAnalyticsLoaded()` is called by the loaders). Session restore must check it.
- `enterPodMode({ issuer, storage? })` validates the origins (https, or http for
  `localhost`/`127.0.0.1`; bare origins only, hosts of `[a-z0-9.-]`), persists origins then
  flag, then reloads.
- `leavePodMode(wipeCredentials)` awaits the required async callback that deletes every stored
  credential, and only then clears the flag and reloads. If the callback rejects, the window
  stays in pod mode and the error is rethrown.
- `buildPodModeCsp(origins, hostedHosts)` and `applyPodModePolicy(document)` build and insert
  a `<meta http-equiv="Content-Security-Policy">` as the first child of `<head>`. A meta
  policy can only narrow the static one. Every fetch-type directive is explicit.

## Threat model and limits

Pod mode protects a window against passive third-party scripts going forward. It does not
protect against an origin that is already compromised.

- Clarity and the Google tag run arbitrary remote code in every non-pod window, and
  `localStorage`, IndexedDB and the Cache API are shared between modes. A script that ran in a
  non-pod window can plant the flag, the remembered origins, and IndexedDB content (key pairs it
  kept a copy of, client registrations, a fake session).
- So the remembered origins are untrusted hints. The sign-in UI must show the issuer origin and
  get the user's confirmation in the clean window before any redirect, delete auth databases
  and generate keys inside the latched pod window on every fresh sign-in, and show the WebID
  after restore.
- A window with its own origin or data directory and a policy set from Rust is the stronger
  design. It is future work.
- `img-src` and the HTTP plugin's `https://*` scope mean `connect-src` is not an exfiltration
  barrier, and top-level navigation is not restricted by the policy.
- The policy is not verified on WKWebView, WebKitGTK or WebView2, and the app does not yet run
  cleanly under it: it drops `'unsafe-eval'`, blocks `data:` workers and inline module scripts,
  and something calls `eval` at start-up (see the commit message). Do not enable pod mode for
  users before that is resolved.

Run `nx test @storyteller/pod-mode` for the unit tests (Vitest).
