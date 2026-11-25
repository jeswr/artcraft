# @storyteller/pod-gallery

The "My pod" source of the gallery: a read-only list of the assets in the person's Solid pod
library. The panel that draws it is in `libs/components/gallery-modal/src/lib/pod/` (a lazy chunk);
the app opens the store and the media loader in `apps/artcraft/app/src/pod/gallery-runtime.ts`
(also lazy) and offers the result through `PodGalleryHost`. Without a connected pod none of it
renders or loads.

- `PodAssetRef`: an opaque object, not a string. Every hosted media token, reference image,
  delete id and generation input in the app is a `string`, so a pod item handed to any of them
  does not compile (`ref.spec.ts` pins this with `@ts-expect-error`). There is no way to turn one
  into a hosted token here; that is the later, explicit import step.
- `createPodLibrarySource(store)`: `list` and `get` over an opened `@jeswr/pod-media-store`
  store. Content and thumbnail URLs are the ones the store returns (always inside the library);
  none is built from a container and a name. The parameter type has no write method.
- `createPodLibraryController`: owns the one open library and purges the media loader when the
  pod is disconnected, when the WebID changes (the session key is the WebID) and on dispose. The
  loader has no session-key option of its own, so this is where an account switch is enforced.
- `usePodAssets`: paging, empty and error states, refresh, and a retry when the network returns.
- `PodSourceSwitch`: the "ArtCraft library" / "My pod" switch; renders nothing without a pod.

Rules kept: pod bytes reach the screen only as `blob:` URLs from `@jeswr/pod-media-loader`
(sniffed type only, default allowlist, its limits); pod text is rendered as text and nothing in
it is followed; 3D models and videos without a thumbnail are generic tiles; nothing is written
to the pod; nothing is logged.

Not verified here (needs a real webview): `blob:` images and video under the pod-mode CSP, the
CORS behaviour of `auth.fetch`, and how many large files the webview holds comfortably at the
loader's limits.
