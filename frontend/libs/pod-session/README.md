# @storyteller/pod-session

Solid pod session for the desktop app: a small state machine over `@jeswr/pod-auth` and
`@jeswr/desktop-auth`. No Tauri imports; the shell supplies `openUrl`, `onOpenUrl` and the
pod-mode requests.

States: `disconnected` (with an `outcome` of `disconnected` or `declined` so a rebuilt window
still shows the answer), `connecting` (the app's native dialog is open), `ready-to-sign-in` (the person approved the
address; nothing starts until they click Continue), `signing-in`,
`needs-approval(origin, phase)` (pod-auth needs to read from an address the window may not contact yet),
`connected(webId)`, `leaving`, `signed-out-locally` (disconnected here, but the provider could
not be told), `error(kind)` and `unsupported(reason)`. Error kinds and reasons are closed sets;
no state, message or log carries a token, a callback URL or a host's error text.

```ts
const session = createPodSession({
  config, // readConfig(identifier)
  createAuth: (options) => createDefaultAuth(config, { openUrl, onOpenUrl }, options),
  wipeStores: () => deletePodAuthDatabases(),
  podMode: realPodModePort(requests), // requests: the app's pod-mode commands
});
await session.start();           // settle a step left by a rebuild, self-test, restore
await session.connect(input);    // a WebID or a provider address: validates, asks the app, which confirms and rebuilds
await session.beginSignIn();     // the click in the rebuilt window that starts the sign-in
const podFetch = session.getFetch(); // pod-auth's fetch, or null unless connected
await session.approveOrigin();   // from needs-approval: asks the app (dialog, rebuild)
await session.retry();           // from a declined address: runs the restore again
await session.leave();           // from any state: revoke, wipe locally, ask the app to leave
```

## Flow and rules

- `connect` validates the typed issuer (a bare https origin; `http://localhost` only in a dev
  build with `VITE_SOLID_ALLOW_LOOPBACK=true`) and asks the app to enter pod mode. The app shows
  a native dialog naming the origin; on approval it records the issuer, remembers the approval
  in memory and rebuilds the window. There is no "connect" marker: the rebuilt window starts in
  `ready-to-sign-in` only when the app reports a fresh approval whose issuer equals the
  recorded one, and `beginSignIn()` (the Continue button, no autofocus) consumes that approval
  once and then wipes pod-auth's stores and signs in. A record merely loaded from disk only
  restores a session and never starts a sign-in. A declined dialog is shown as such.
- pod-auth is built only in a pod window, only when `sessionRestoreAllowed()`, only when a
  narrowing policy is confirmed (`podPolicyApplied()`), and only when the config is valid.
  Otherwise the state is a closed error. Building it happens inside the guarded section, so a
  throwing factory is a closed error too.
- Any failure after the token exchange (including a missing WebID or a cancel) logs out and
  wipes the stores.
- `leave()` works from every state. It revokes through pod-auth if it can, **always** deletes
  the local pod-auth databases, then asks the app to leave pod mode. A failed revocation does
  not stop the wipe and ends in `signed-out-locally`. A delete that is only queued behind an
  open connection (`deferred`) is not reported as done: the window is rebuilt and the delete
  runs before pod-auth opens anything. If the wipe cannot finish, the state is
  `error('wipe-failed')`, the `leave` marker is kept until a wipe is confirmed, and the window
  stays in pod mode (or, when it is not in pod mode, in the finishing window below). The order is wipe, then leave; the
  app cannot check it, so this library enforces it.
- A small `localStorage` marker with a closed set of words (`wipe`, `leave`,
  `leave-revocation-failed`, `done`, `done-revocation-failed`) carries the flow across window
  rebuilds. It never holds an origin, token or URL, and a value outside the set is ignored.
- A start-up self-test checks a secure context, that Web Locks exclude and release, IndexedDB,
  and that a non-extractable key persists, reopens on a fresh connection and still signs. A
  failure yields `unsupported(reason)`; leaving still works.
- `getFetch()` is pod-auth's fetch wrapped by an origin gate (`storage-origins.ts`): the first
  request to an origin the window's policy does not list asks the app to admit it (see the
  pod-mode README, "Storage origins", for the limits, which the app enforces). Only the origin
  is sent; a refusal rejects with `StorageOriginRefused` (`reason`: `declined`, `limit`,
  `invalid`, `too-fast`, `busy`, `unavailable`). Without a shell (a plain browser) the fetch is
  returned unwrapped.
- All pod HTTP uses `getFetch()`. Never route pod or identity-provider traffic through the
  Tauri HTTP plugin or `FetchProxy`: that would move tokens and DPoP proofs into Rust.

- **Finishing.** An ordinary window the app flags as possibly holding credentials
  (`finishing()`) loads no pod-auth and offers only "Finish disconnecting" (`leave()`); once
  the wipe is confirmed the app clears its flag (`requestCredentialsCleared`). Leaving pod
  mode always passes through this window: the app keeps the flag when it ends pod mode, so the
  window that follows a leave (or a launch after an interrupted one) repeats the wipe and is
  the only thing that clears the flag.

## Build-time configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_SOLID_CLIENT_ID` | a `.invalid` placeholder URL | https URL of the Client Identifier Document |
| `VITE_SOLID_ALLOW_LOOPBACK` | unset | `true` in a Vite dev run only (`import.meta.env.DEV` must also be true): allow an `http://localhost` or `http://127.0.0.1` issuer in the UI. It does not make pod-auth accept an insecure issuer, and the https requirement on the client identifier is unchanged |

Both are read through `import.meta.env`, so they are baked in when the frontend is built; they
are listed as Nx cache inputs (`nx.json`), so changing one is not served from a stale cache.
There is no run-time way to change the client identifier. There is also **no variable for the
redirect**: it is always `<app identifier>:/oauth/callback`. The scheme the OS hands to the app
comes from `plugins.deep-link` in each Tauri config file, which happens to equal the identifier
in each of them (a Rust test, `deep_link_tests`, fails if they ever differ); an override would
point the callback at a scheme nothing handles.

The redirect is derived from the app identifier (`<identifier>:/oauth/callback`, a private-use
scheme), so release (`ai.artcraft.app`) and the dev overlays (`ai.artcraft.app.dev`) never
share a callback or a single-instance lock. The Client Identifier Document must be served as
`application/ld+json` with `application_type: native` and list exactly that redirect (build it
with `desktopClientIdDocument` from `@jeswr/desktop-auth`); a dev build needs its own. Where the
document is hosted is the owner's decision: until a real URL is set the config is
`not-configured` and Connect stays disabled.

## Verified only in a real webview

Web Locks and key persistence on WebKitGTK/WKWebView/WebView2, that a queued IndexedDB delete
completes after the rebuild, deep-link delivery, single-instance forwarding, CORS from the
webview origin, and the window rebuild itself. Unit tests use fakes; the integration spec runs
real pod-auth and desktop-auth against pod-auth's in-memory provider and `fake-indexeddb`, and
checks that the wipe finds the database names pod-auth really creates.

`wipe.ts` matches pod-auth's IndexedDB database names (key-value-kit naming) as of the vendored
packages; the integration spec fails if a later version renames them.

## A WebID on another origin than the provider

The person may type either a **WebID** (`https://id.example/alice#me`) or a **provider address**
(`https://login.example`). `parseSignInInput` tells them apart: a bare origin is a provider, an
https URL with a path or fragment (no credentials, no query) is a WebID. Nothing is fetched to
decide.

`@jeswr/pod-auth` reads some documents itself before and after the sign-in: issuer metadata, the
Client Identifier Document, the WebID profile (also the engine's verify read) and storage
descriptions. Its `fetch` option is the transport for exactly those body-less, credential-less
GET and HEAD reads, never for token, registration or revocation POSTs and never for
`auth.fetch`. The session passes the origin gate there, in explain-first mode
(`{ prompt: false }`): a request to an origin the window's policy does not list is **not sent**;
it is refused with `StorageOriginRefused('needs-approval', origin)`, which pod-auth reports as
`InjectedFetchError` with the refusal as its `cause` (`refusalOf` finds it there). The gate passes
the request through unchanged (so `redirect` is honoured) and returns the real response.

- **WebID typed.** The app is asked to enter pod mode for the WebID's own origin, which becomes the
  window's recorded origin. After the dialog and rebuild, Continue runs `login({ webId })`;
  pod-auth reads the profile first, finds the issuer there, and goes to it. A refusal before the
  authorization request costs no trip to the provider.
- **Provider typed.** The window allows the provider only. If pod-auth then needs another origin
  (the WebID the provider reports, the Client Identifier Document host), the state is
  `needs-approval`: the page says which address and that nothing was sent there, and **Allow**
  calls `approveOrigin()` (native dialog, rebuild). The rebuilt window offers Continue again with
  what was typed.
- **Restore.** A refusal while restoring keeps the stored session: nothing is wiped, logged out
  or revoked. `needs-approval` offers Allow (and Leave); a declined or too-fast answer is an
  error that `retry()` runs again.
- `InvalidInjectedResponseError` (the supplied fetch returned something pod-auth cannot accept)
  is the fixed plain failure `invalid-response`.

What survives the rebuild is a `localStorage` entry (`artcraft.podSession.pending`) holding only
the hint the person typed and the origin awaiting approval: never a token, code, verifier or
callback URL. It is read back through the same validators as fresh input, and used only when the
app also reports a fresh approval for that exact origin. It is cleared on success, decline,
cancel and leave. The app sets that fresh approval after an accepted add as well; without a
pending hint (a connected session's later approvals) the window just restores. The trade-off: a
planted hint plus a planted record plus an Allow the person clicked could offer one Continue click,
and the page shows the address (and WebID) before it.

**Remaining limits.**

- **An issuer-only sign-in costs a second sign-in when the WebID is elsewhere.** The engine
  verifies the WebID profile before persisting the session, so a refusal then fails the sign-in
  after authentication with nothing stored, and the retry goes to the provider again. Typing the
  WebID avoids this.
- POSTs (token, registration, revocation) and the browser's own redirect hops are not routed
  through the gate. Under the window's policy they fail untyped, and a provider whose token
  endpoint is on another origin than the issuer is not supported.
- The first sign-in may ask about the Client Identifier Document host (it is another origin than
  the provider).

## Deep links (the sign-in callback)

The callback is `<identifier>:/oauth/callback`. On Linux and Windows the OS starts a new instance
with the URL as its argument and learns the scheme from the installer. A dev run is not
installed, so a debug build whose identifier ends in `.dev` (the two dev overlays) registers its
own scheme at start (`register_dev_deep_links`; `is_registered` first; never the release scheme,
so a debug binary built from the base config does not take over an installed release's
callback). It writes a `.desktop` file or a registry key naming the current binary and nothing
removes it: delete `~/.local/share/applications/<binary>-handler.desktop` (Linux) or
`HKCU\Software\Classes\ai.artcraft.app.dev` (Windows) to undo it.

**A release AppImage is not registered, so sign-in cannot complete there.** An AppImage is not
installed, so no handler exists. This is a question for the ArtCraft maintainers; the options
are: register at run time when `app.env().appimage.is_some()` (the plugin documents
`register_all` for AppImages that were not integrated; it writes a per-user `.desktop` file
that goes stale when the file moves, needs `xdg-mime` and `update-desktop-database`, and is a
change to the person's desktop that they should be told about); require AppImageLauncher or
similar integration and say so; or ship the `.deb`/`.rpm`, whose installers register the scheme.
Nothing is done silently here.
