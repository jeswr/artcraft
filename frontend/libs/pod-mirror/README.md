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

Assets are named by content hash, and the library is sharded by the month of the hosted creation
time, so several hosted tokens can share ONE pod copy when they hold the same bytes and were created
in the same month: two hosted accounts used with one pod, or one account holding the same bytes
twice. A hosted delete removes the pod copy only when NO other journal record in this browser
profile's journal, of any hosted account or WebID, pairs with the same pod description (and is not
itself being removed); otherwise only that token's pairing is dropped. The check and the delete run
under a per-copy lock: a queue within this running app, and, where the browser has the Web Locks API
(`navigator.locks`), a lock named by the copy's address, so two windows of the app on one database
are covered too. A copy that a delete took while another item was writing the same bytes is written
again rather than left as a dead link (an adopting put asks the pod before it is called saved). A
delete the store recorded and did not finish (the store's durable delete journal) is withdrawn when a
record comes to pair with the copy, is never listed to `resumePending` while any record pairs with
it (`guardDeletes`), and nothing is deleted while the journal cannot be read or written. The
description of a kept copy stays the first writer's (its prompt and provenance), including after
that hosted item is deleted.

Limits that cannot be fixed from here: the guarantee is per running app (one browser profile on one
device). Another device, or another profile, that mirrors a different hosted account into the same
pod is invisible, so its delete of the shared bytes can remove a copy this device still pairs with.
The verification pass reduces the damage. It has two halves, recorded apart (`verifiedAt`,
`podVerifiedAt`) so one that could not run never makes the other repeat: the hosted half marks saved
items ArtCraft no longer lists, and the pod half asks the pod for the description of every saved item
and queues the ones it says are gone to be copied again. Each runs at start when its last pass is over
an hour old (the pod half once the store is open), then once a day. Only the pod's own 404 or 410
counts as gone; a network error, 401, 403, 5xx or an unreadable description is "cannot tell" and
changes nothing. The 404 is believed only with a second opinion and under a ceiling: the library
container must answer with the current session in the same pass, and if more than max(5, 10%) of the
items asked are missing the pass stops, queues nothing and raises `summary.libraryMissing`, which the
person answers with "Copy again" (`copyAgain()`, shown by `PodLibraryMissingBlock`). A pass keeps a
cursor and continues after an interruption. A missing copy is requeued and written again, never
deleted; the check costs one description read per saved item per pass, paced by `podCheckPaceMs`.
A copy deleted elsewhere is found at the next pass, not at once.

## Copy my existing library

Pause stops the walk and every import item that has not started uploading: those wait as `pending`
(an item already uploading finishes). Resume goes on from the saved cursor (one page back). The
progress counter `walked` is where the walk has been, by position, and survives pause, resume,
catch-up passes and restarts. An item the pod check queued to be copied again no longer belongs to
the run.

If another window upgrades the journal's database, this window's connection is closed and the
mirror pauses as `journal-closed` (reload needed): nothing is copied or removed without a record.

Verified only in a real webview or against a real pod: CDN byte download through plain `fetch`
(CORS), IndexedDB durability, and the owner-only probe on a real server.

## Size ceiling and memory

The CDN response is read into a `Blob` (bounded; larger than `DEFAULT_MAX_BYTES`, 50 MiB, the media
store's own default, is `skipped(too-large)`), and that same `Blob` goes to the store. Sniffing reads
only the first 4096 bytes.

Memory is several times a file's size while it uploads, not one to two times. All figures below are
from the end-to-end harness against a real Community Solid Server 7.2 with DPoP, in Node 24
(undici); the webview was not measured. One image at a time:

| File | RSS increase (peak) | `arrayBuffers` increase (peak) | Runs |
|---|---|---|---|
| 16 MiB + 1234 B | 150 to 158 MiB (9x to 10x) | 90 to 106 MiB (5.4x to 6.3x) | 2 before this work, 2 after |
| 48 MiB | 275 to 295 MiB (5.7x to 6.1x) | not recorded | 2 before, 2 after |

The per-item cost did not change with this work. RSS did not fall back afterwards (allocator
retention). Where it goes, in a separate micro-measurement of a 16 MiB `Blob` (`arrayBuffers`
increase): the download held as a `Blob` 19 to 32 MiB, the store's SHA-256 read
(`blob.arrayBuffer()`, WebCrypto has no streaming digest) 32 MiB, and a `fetch` PUT of the `Blob`
21 to 27 MiB (undici buffers a `Blob` body; measured without DPoP, to a plain local server). Only the
download is ArtCraft's. The hash read and the PUT happen inside `@jeswr/pod-media-store` and
`@jeswr/storage-client` (vendored): the store reads the body once to hash it, then uploads a fresh
`Blob` made from it. Hashing from `blob.stream()` incrementally, and sending a stream with a known
length, are the SDK-side changes that would remove most of it; nothing here can.

What ArtCraft does about it: the upload step is admitted by bytes in flight, not only by item count
(`maxBytesInFlight`, default 32 MiB, on top of `concurrency`, default 2). An item that does not fit
waits, holding its downloaded `Blob`, until the uploads ahead of it finish; one item larger than the
whole budget runs alone. Four 24 MiB images offered at once (peak increase over the pre-batch
state, two runs each):

| `concurrency` | Budget | RSS increase | `arrayBuffers` increase |
|---|---|---|---|
| 4 | off | 586 and 631 MiB | 360 and 408 MiB |
| 4 | 32 MiB (default) | 420 and 424 MiB | 251 and 254 MiB |
| 2 (default) | off | 358 and 359 MiB | 222 and 222 MiB |
| 2 (default) | 32 MiB (default) | 318 and 340 MiB | 192 and 218 MiB |

So at the default `concurrency` of 2 the budget helps a little (about 5% to 11% of RSS), and the
bound matters when `concurrency` is raised. The batch took 2.1 to 2.5 s with `concurrency` 4
against 2.0 s without the budget (1.9 s against 1.7 to 1.8 s at `concurrency` 2). A planning figure for the
worst case the 50 MiB ceiling admits: about 300 MiB of RSS for the item uploading (275 to 295 MiB
measured at 48 MiB), plus the downloaded `Blob` of each other item waiting for room. Lower `maxBytes`
for a small webview. Folding the download into `Blob` segments as it streams was tried and removed:
no difference could be measured in Node.

Splats: PLY, and SPZ when the hosted record declares it (`media_type` or file name), are written as
`model3d` with the store's sniffed type (`application/octet-stream`, `.ply` / `.spz`). Other mesh
formats (FBX, OBJ, glTF) are not recognised by the store's sniffer and end `skipped(unsupported-type)`.

Unknown exposure: a container the probe cannot judge is written to only after the person confirmed it;
the confirmation is stored per container and WebID and handed to the store as
`allowUnknownExposureFor`, which asks per container (the library and its shards) on every write.
