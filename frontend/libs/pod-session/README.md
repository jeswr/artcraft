# @storyteller/pod-session

Solid pod session for the desktop app: a small state machine over `@jeswr/pod-auth` and
`@jeswr/desktop-auth`. No Tauri imports; the shell supplies `openUrl`, `onOpenUrl` and the
pod-mode requests.

States: `disconnected` (with an `outcome` of `disconnected` or `declined` so a rebuilt window
still shows the answer), `connecting` (the app's native dialog is open), `ready-to-sign-in` (the person approved the
address; nothing starts until they click Continue), `signing-in`,
`connected(webId)`, `leaving`, `signed-out-locally` (disconnected here, but the provider could
not be told), `error(kind)` and `unsupported(reason)`. Error kinds and reasons are closed sets;
no state, message or log carries a token, a callback URL or a host's error text.

```ts
const session = createPodSession({
  config, // readConfig(identifier)
  createAuth: () => createDefaultAuth(config, { openUrl, onOpenUrl }),
  wipeStores: () => deletePodAuthDatabases(),
  podMode: realPodModePort(requests), // requests: the app's pod-mode commands
});
await session.start();           // settle a step left by a rebuild, self-test, restore
await session.connect(issuer);   // validates, asks the app, which confirms and rebuilds
await session.beginSignIn();     // the click in the rebuilt window that starts the sign-in
const podFetch = session.getFetch(); // pod-auth's fetch, or null unless connected
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

## Known limit: a WebID on another origin than the issuer

During `login()` and `restore()`, `@jeswr/pod-auth` reads the WebID document itself
(`boundary.learn` -> `secureDocumentFetch`) on the global fetch it captured when it was built
(`nonReactiveFetch()` in `createProviders`; there is no `fetch` option for the browser
`PodAuth`, only for the agent path). The window's policy lists the issuer's origin only, so a
WebID on any other origin (issuer `https://login.example`, WebID `https://id.example/...`; or
issuer `https://solidcommunity.net`, WebID `https://alice.solidcommunity.net/...`) is blocked
after the token exchange: `login()` rejects, the session is scrubbed and the state is
`error('sign-in-failed')`, with no dialog. `learn` runs **before** the session is persisted, so
even an approved origin could not resume with `restore()`.

This cannot be fixed in ArtCraft without editing the vendored SDK. The change that is needed in
`@jeswr/pod-auth` (API shape, not implemented here):

1. `PodAuthOptions.fetch?: typeof fetch`, the transport for pod-auth's own unauthenticated
   requests (WebID and storage-description reads, issuer metadata, token endpoints), as
   `createAgentProviders` already accepts through `policy.fetch`. ArtCraft would pass a fetch
   that asks the app to admit an unlisted origin first.
2. An ordering guarantee plus a hook: `ui.onIdentity?(identity: { webId: string; issuer: string },
   signal: AbortSignal): Promise<'continue' | 'interrupted'>`, called after the token exchange
   **and after the session (tokens, DPoP key) has been durably remembered**, before
   `boundary.learn`. ArtCraft would admit the WebID origin there (the app rebuilds the window);
   `'interrupted'` makes `login()` reject with a typed code (`interrupted`) without discarding the
   remembered session, so the rebuilt window's `restore()` runs `learn` with the origin allowed
   and there is no second trip to the identity provider.

Until then only a WebID on the issuer's origin signs in; a storage root or Type Index on another
origin works through the gate.

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
