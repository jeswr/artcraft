# @storyteller/pod-gallery

The "My pod" source of the gallery: a read-only list of the assets in the person's Solid pod
library. The panel that draws it is in `libs/components/gallery-modal/src/lib/pod/` (a lazy chunk);
the app opens the store and the two media loaders in `apps/artcraft/app/src/pod/gallery-runtime.ts`
(also lazy) and offers the result through `PodGalleryHost`. Without a connected pod none of it
renders or loads.

## What is where

- `PodAssetRef`, `PodMediaAddress`: opaque objects, not strings (a unique-symbol brand plus a
  private `WeakMap`). Every hosted media token, reference image, delete id, lightbox source and
  generation input in the app is a `string`, so a pod item handed to any of them does not compile
  (`ref.spec.ts` and `address.spec.ts` pin this with `@ts-expect-error`). The only things that can
  open an address are the hooks in `@storyteller/pod-gallery/media`, which hand it to a media loader.
  The package index exports no accessor that returns a raw URL (`address.spec.ts` checks the export
  list). There is no way to turn an item into a hosted token here; that is the later, explicit
  import step.
- `createPodLibrarySource(store)`: `list` and `get` over an opened `@jeswr/pod-media-store`
  store. Content and thumbnail addresses are the ones the store returns (always inside the library);
  none is built from a container and a name. The parameter type has no write method. Bidirectional
  control characters are removed from pod text.
- `PodLibrary`: the source, a **tile loader** (thumbnails: image types only, 512 KiB per file,
  at most 1.1 megapixels, 64 MiB total, `maxEntries` twice `MAX_MOUNTED_TILES`), a **viewer loader**
  (originals: 25 MiB per file, 4 entries, 2 reads at a time) and `sessionEnded()`.
  The pixel cap: a tile is a few hundred pixels across, so a thumbnail up to 1024 x 1024 is already
  larger than any tile can show, while a 16 MP file (the earlier cap) decodes to about 64 MB and a
  screen of them is gigabytes. A thumbnail over the cap, or over 512 KiB, is not an error: the tile is
  the generic tile with the item's name. 512 KiB also keeps a tile that cannot fit the budget from
  holding a connection open while it waits (`budgetWaitMs` is 5 s).
- `createPodLibraryController`: owns the one open library and purges both loaders when the pod is
  disconnected, when the WebID changes and on dispose. The loaders also take `getSessionKey` (the
  WebID) and purge themselves when it changes; the controller does not rely on that alone.
- `usePodAssets`: paging, empty and error states, refresh, a retry when the network returns, and a
  back-off after a failed "load more" (2 s, doubling to 30 s; the Retry button skips it).
- `@storyteller/pod-gallery/media`: `usePodMedia` (the loader's `useMedia`: acquires on mount,
  releases on unmount, retries `over-budget` by itself three times) and `usePodOriginal` (the viewer's
  file with its sniffed type).
- `PodSourceSwitch`: the "ArtCraft library" / "My pod" switch; renders nothing without a pod.

## Rules kept

- Pod bytes reach the screen only as `blob:` URLs from `@jeswr/pod-media-loader`, typed by what the
  loader sniffed in the bytes, never by the pod's declared type or kind. The loader's default type
  list is kept for originals; the grid's loader is narrowed to images.
- The grid reads **thumbnails only**. An item without a thumbnail is a generic tile with its name;
  its original is read only when the viewer opens it. A model or video never has its file read for a
  tile, and a model's file is never read at all (3D preview is not offered).
- The grid is drawn by row: only the rows in the view plus one row of overscan are mounted, so the
  view is always full. The tile count follows from the window (12 columns in a 1056 x 1400 view is
  about 240); `MAX_MOUNTED_TILES` (320) sizes the tile loader (`maxEntries` 640) and only trims rows
  beyond the view. `podLayout.spec.ts` checks the fill at 12 columns.
- Pod text is rendered as text and nothing in it is followed. Nothing is written to the pod and
  nothing is logged.
- Media in the viewer and tiles are not draggable and have no context menu, and a `<video>` has no
  download, remote-playback or picture-in-picture entry (an `<audio>` has no download or
  remote-playback entry in its controls list).
- Closing the gallery frees the pictures: the panel purges and resumes both loaders when it
  unmounts, so every blob URL is revoked (released holds alone would leave them cached).
- The hooks return the `blob:` URL as a plain string, so the compile-time guarantee ends there: no
  code passes it to hosted code today, and a `blob:` URL is fetchable by same-origin code. Closing
  that would take `PodImage`/`PodVideo` components that keep the URL to themselves (not done).
- A key map (`podAssetKey`) lives at module level; it is cleared when a library is torn down
  (sign-out, account change).

## Session problems

A refused request (401), an ended or changed session (`Session expired`, `Session changed during
authentication`) or a missing session fetch is reported as `sign-in`: "Sign in to your pod again",
with a pointer to Settings, under Solid pod, where a pod window offers "Sign in again". The kind is carried
through every path: opening, the first page, a failed "load more" (`loadMoreError`), tiles and the
viewer. The loaders cannot say "session": an expired session reaches them as `offline` and a 401
as `forbidden`, so a tile or the viewer asks `library.sessionEnded()` (set by the session fetch
wrapper on a 401 or an ended session, cleared by the next good answer or a new listing) and shows
"Sign in to your pod again" instead. A 403 from the pod with the session intact is `forbidden`.
"Can't reach your pod" is the one sentence for network failures.

A read never opens the system browser: `pod-session`'s sign-in gate refuses pod-auth's request
for a new authorization unless the person started a sign-in, and ends the session instead
(`apps/artcraft/app/src/pod/background-read.spec.ts` pins this with real pod-auth). The gallery's
access then goes away. When the window can sign in again, `PodGalleryProvider` gets `signedOut`
instead: the source switch and "My pod" stay, and "My pod" says the session ended and offers
"Sign in again", whose click only calls `signedOut.signInAgain()` (the session then asks the app,
and the browser opens after the person's later clicks). Without it, the gallery returns to the
ArtCraft library as before. Nothing in the gallery starts a sign-in on its own.

## Requests (measured)

`apps/artcraft/app/src/pod/gallery-runtime.http.spec.ts` runs the real store, SDK client and
loaders over a Solid pod served as an HTTP `fetch` and counts requests (120 items, `PAGE_SIZE` 50):

| When | Requests |
| --- | --- |
| Opening the library (once per gallery open) | 8 on the test pod: `HEAD` x3, `GET` the storage description, `OPTIONS`, `GET` the profile, preferences and private type index |
| Page 1 | 3 container listings (library, year, month) plus 52 description `GET`s |
| Pages 2 and 3 | **0** container listings; 52 and 20 description `GET`s |
| One tile | 1 `GET` of its thumbnail, only while mounted |
| Opening an item | 1 `GET` of its description (`store.get`) and 1 of its original (counted at the loader, not over HTTP) |

Container listings are cached for the life of the library (`withListingCache` in
`gallery-runtime.ts`), so paging does not list the pod's folders again; opening the panel and the
refresh button list afresh (`invalidateListing`). The store reads a few descriptions more than a page
needs in its last batch, so a page costs up to eight more than its item count. Only `GET`, `HEAD`
and `OPTIONS` are sent, on an empty pod, a pod with a type index but no library, and a populated
one (same spec). The one extra request an LWS pod makes for discovery (a `QUERY`) is not exercised:
no LWS fixture is available offline.

## Not reused from the mirror

The mirror's `createStoreOpener` builds a store that can write, over the mirror's journal. The
gallery needs a store that cannot, so it opens its own client and store (an in-memory journal that
is never read, an exposure probe that answers "unknown", which makes any write refuse) and the
discovery above is repeated once per gallery open. No public API of `pod-mirror` returns the
mirror's already-opened, read-only client, and this change does not touch `pod-mirror`.

## Dependencies

`package.json` declares none: like its sibling libraries it uses `react` and the `@jeswr/*`
packages (`pod-media-loader`, `pod-media-store`, `solid-creative-assets`, all vendored under
`frontend/vendor/solid`) from the single `frontend/package.json`. Only types are imported from
the store and model packages; the loader's React hook is imported by `./media` only.

## Chunks

Measured with `vite build` of `apps/artcraft`: the entry chunk contains this library's controller,
hooks, source mapper and switch, and the gallery's small header frame and error boundary
(`PodPanelFrame`, `PodPanelBoundary`). The panel, tile, viewer, `@jeswr/pod-media-loader` and its
hook are in the `PodGalleryPanel` chunk; the store, SDK client and runtime are in the
`gallery-runtime` chunk. Both load only when "My pod" is first chosen.

Not verified here (needs a real webview): `blob:` images and video under the pod-mode CSP, the
CORS behaviour of `auth.fetch`, and how the webview copes with the loaders' limits on a real pod.
