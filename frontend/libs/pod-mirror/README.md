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

## Shared pod copies, delete, and the verification pass

Assets are named by content hash, so several hosted tokens can share ONE pod copy: two hosted
accounts used with one pod, or one account holding the same bytes twice. A hosted delete removes
the pod copy only when NO other journal record on this device, of any hosted account or WebID, pairs
with the same pod description (and is not itself being removed); otherwise only that token's pairing
is dropped. The check and the delete run under a per-copy lock shared by every mirror in the process,
and a copy that a delete took while another item was writing the same bytes is written again rather
than left as a dead link. If the journal cannot answer, nothing is deleted.

Limits that cannot be fixed from here: the journal is per device and per browser profile. Another
device (or another profile) that mirrors a different hosted account into the same pod is invisible,
so its delete of the shared bytes can remove a copy this device still pairs with. The verification
pass reduces the damage: once a day (and at start), it asks the pod for the description of every
saved item whose hosted item still exists. Only the pod's own 404 or 410 counts as gone; a network
error, 401, 403, 5xx or an unreadable description is "cannot tell" and changes nothing (an offline or
refused answer ends the pod checks for that pass, which is then not recorded as done). A missing copy
is requeued and written again, never deleted. This costs one description read per saved item per
pass. A deleted copy is found at the next pass, not at once.

## Copy my existing library

Pause stops the walk and every import item that has not started uploading: those wait as `pending`
(an item already uploading finishes). Resume goes on from the saved cursor (one page back). The
progress counter `walked` is where the walk has been, by position, and survives pause, resume,
catch-up passes and restarts.

Verified only in a real webview or against a real pod: CDN byte download through plain `fetch`
(CORS), IndexedDB durability, and the owner-only probe on a real server.

## Size ceiling and memory

The CDN response is read into a `Blob` (bounded; larger than `DEFAULT_MAX_BYTES`, 50 MiB, the media
store's own default, is `skipped(too-large)`), and that same `Blob` goes to the store. Sniffing reads
only the first 4096 bytes.

Memory is several times a file's size while it uploads, not one to two times. Measured against a
real Community Solid Server 7.2 with DPoP, in Node 24 (undici), through the end-to-end harness (the
webview was not measured): one 16 MiB item raised the process's RSS by 142 to 157 MiB (9x to 10x the file) and its
`arrayBuffers` by 91 to 101 MiB (about 6x); one 48 MiB item raised RSS by 240 to
323 MiB (about 5x to 7x, it varied between runs). RSS did not fall back afterwards (allocator retention). Where it goes,
from separate micro-measurements of 16 MiB: the download held as a `Blob` (about 1x to 2x), the
store's SHA-256 read (`blob.arrayBuffer()`, about 2x, WebCrypto has no streaming digest) and the
`fetch` PUT of the `Blob` (about 1x to 2x more: undici buffers a `Blob` body). Only the download is
ArtCraft's. The hash read and the PUT both happen inside `@jeswr/pod-media-store` and
`@jeswr/storage-client` (vendored): the store reads the body once to hash it, then uploads a fresh
`Blob` made from it. Hashing from `blob.stream()` incrementally and sending a stream with a known
length are the SDK-side changes that would remove most of it; nothing here can.

What ArtCraft does about it, and what was measured:

- The upload step is admitted by bytes in flight, not only by item count (`maxBytesInFlight`,
  default 32 MiB, on top of `concurrency`, default 2). An item that does not fit waits (holding its
  downloaded `Blob`) until the uploads ahead of it finish; one item larger than the whole budget runs
  alone. Four 24 MiB items offered at once with `concurrency: 4`: peak RSS +588 MiB and `arrayBuffers`
  +392 to 416 MiB with the budget off, +382 to 432 MiB and +240 MiB with the default (two runs each);
  the batch took about 1.9 s instead of 3 to 4.6 s.
- A reasonable planning figure for one item is about 6x its size in transient memory during its
  upload, so the worst case the 50 MiB ceiling admits is about 300 MiB for the item uploading, plus
  about 1x to 2x for each other downloaded item waiting for room. Lower `maxBytes` for a small webview.
- Folding the download into `Blob` segments as it streams was tried and removed: it made no
  difference that could be measured in Node.

Splats: PLY, and SPZ when the hosted record declares it (`media_type` or file name), are written as
`model3d` with the store's sniffed type (`application/octet-stream`, `.ply` / `.spz`). Other mesh
formats (FBX, OBJ, glTF) are not recognised by the store's sniffer and end `skipped(unsupported-type)`.

Unknown exposure: a container the probe cannot judge is written to only after the person confirmed it;
the confirmation is stored per container and WebID and handed to the store as
`allowUnknownExposureFor`, which asks per container (the library and its shards) on every write.
