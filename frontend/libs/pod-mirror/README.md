# @storyteller/pod-mirror

Copies every asset that enters ArtCraft's hosted library to the person's Solid pod, with a
description and the provenance the hosted side states. The hosted library stays the working
library; nothing here changes how the gallery, editors or Rust use hosted tokens. No React, no
Tauri: everything external (hosted calls, byte download, session, network, events, the store) is
injected by the app.

- `PodMirror`: `start`, `stop`, `enqueue(token)`, `retry(token)`, `reconcile()`, `stateOf`,
  `subscribe`, `summary`, `forgetAccount`. Every item ends `saved`, `pending`, `failed(reason,
  attempts)` or `skipped(reason)` (or `removing` / `remove-failed` after a hosted delete).
- `MirrorJournal`: IndexedDB pairing of (WebID, hosted username, hosted token) with the pod
  description address and content hash, the connect-time watermark, and the delete journal the
  media store needs. Survives sign-out; `forgetAccount` is the only purge.
- `mapping`: pure functions from a hosted media file and prompt to the description input. Nothing
  is inferred; a provider is written only when the hosted value already is an IRI.
- `assets-store`: the creative-assets model plugged into `@jeswr/pod-media-store`. All RDF is
  built and read by `@jeswr/solid-creative-assets`.

Rules kept here: pod requests use only the session's `fetch` (through the store); the hosted
token is never written to the pod; the library is checked private before the first write and the
mirror pauses (`exposed` / `exposure-unknown`) rather than write; access rules are never written;
audio, scenes and intermediate files are skipped with a visible reason.

Verified only in a real webview or against a real pod: CDN byte download through plain `fetch`
(CORS), IndexedDB durability, and the owner-only probe on a real server.
