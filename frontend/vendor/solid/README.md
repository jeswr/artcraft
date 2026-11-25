# Vendored Solid sign-in packages (placeholder)

These tarballs are a **placeholder** until the maintainers decide how ArtCraft consumes the
`@jeswr` Solid packages (npm publishing is undecided). They are the packed output of five
workspace packages of the Solid SDK monorepo (four are private there; `guarded-fetch` is a public package), branch `feat/desktop-auth`, commit
`225a553` ("fix(desktop-auth): address review findings M1-M3, L1-L7"). Replace them with a
registry dependency, or remove them, when that decision is made.

| Tarball | Role | Licence |
| --- | --- | --- |
| `jeswr-desktop-auth-0.1.0.tgz` | desktop (system browser plus private-use scheme) sign-in | MIT |
| `jeswr-pod-auth-0.1.0.tgz` | session, DPoP-bound `fetch`, restore, logout | MIT |
| `jeswr-reactive-authentication-0.1.5.tgz` | OIDC protocol engine under pod-auth | MIT |
| `jeswr-suite-native-0.1.0.tgz` | native redirect and code driver checks | MIT |
| `jeswr-guarded-fetch-0.1.0.tgz` | pod-auth dependency (redirect refusal helper) | MIT |

`frontend/package.json` references `pod-auth` and `desktop-auth` with `file:` specs and maps the
other three through `overrides`, because the packed manifests name each other by plain version.

Licence check. The allowlist is `standards/licences.md` in storytold/craft-contrib, fetched from
https://raw.githubusercontent.com/storytold/craft-contrib/main/standards/licences.md on
2026-11-25. Its rule, lines 9 and 11-25 to 33:

> A licence expression is allowed when every identifier in it is on this list. A licence not on
> it MUST NOT be used until an RFC adds it.
> `ISC`, `MIT`, `BSD-2-Clause`, `BSD-3-Clause`, `Apache-2.0`, `Apache-2.0 WITH LLVM-exception`, ...
> `0BSD`, `Unlicense`, ..., `CC0-1.0`, `CC-BY-4.0`, ...
> Each keeps its notice: you MUST record it in `ATTRIBUTION.md` and `NOTICE`.

Every new package was checked against that list: each npm package below and each new Rust crate
(`const-random`, `const-random-macro`, `dlv-list` MIT OR Apache-2.0; `ordered-multimap`,
`rust-ini` MIT; `tauri-plugin-deep-link`, `tauri-plugin-single-instance` Apache-2.0 OR MIT;
`tiny-keccak` CC0-1.0) carries only allowlisted identifiers. They are recorded in the repository
`NOTICE`; this repository has no `ATTRIBUTION.md`, so `NOTICE` is the record. The workspace crate
`pod_mode` is our own code and declares `MIT OR Apache-2.0`.

Third-party packages these add (production closure, all licences are on the allowlist in
`standards/licences.md`): `@capacitor/core` MIT, `@key-value-kit/core` MIT,
`@key-value-kit/storage` MIT, `@rdfjs/wrapper` MIT, `dpop` MIT, `http-link-header` MIT,
`idb-keyval` Apache-2.0, `jose` MIT, `multiformats` Apache-2.0 OR MIT, `n3` MIT (with `buffer`
MIT and `readable-stream` MIT), `oauth4webapi` MIT, `process` MIT, `undici` MIT. The two Tauri
JS plugins, `@tauri-apps/plugin-deep-link` and `@tauri-apps/plugin-opener`, are MIT OR
Apache-2.0. The test-only `fake-indexeddb` (Apache-2.0) is a dev dependency of `libs/pod-session`. `undici` is only reachable from `@jeswr/guarded-fetch/node`, which ArtCraft does not
import.

## Rebuilding

From a checkout of the SDK at the commit above, with Node 24:

```sh
pnpm install --frozen-lockfile --filter "@jeswr/desktop-auth..." --filter "@jeswr/pod-auth..."
for p in suite-native guarded-fetch reactive-authentication pod-auth desktop-auth; do
  (cd packages/$p && pnpm run build && pnpm pack --pack-destination <this directory>)
done
```

SHA-256 of the tarballs as committed:

```
75f91bdc463a3a3d0ca96f5dd6e406364dbb71299dd4ed2528a099a6bee070ea  jeswr-desktop-auth-0.1.0.tgz
198d0b6b78381df298071345d87d7769888ab467140d94b2ea11417e812d4f97  jeswr-guarded-fetch-0.1.0.tgz
349742b51085983059f54d37caa3a6b360c28de710b49c60ee8cbfb429ac04ef  jeswr-pod-auth-0.1.0.tgz
5acce3f79351b6e7efb69f5e5d1c214fe4ae03f4d35d2bf5d4be9f533e43a0a2  jeswr-reactive-authentication-0.1.5.tgz
89d27479963625ada5355a62d9a277d18a9f08ebd63948039fe11d3bcd4229a0  jeswr-suite-native-0.1.0.tgz
```

## Pod mirror packages (added with `libs/pod-mirror`)

Twelve more packed workspace packages of the Solid SDK monorepo, all private there, all MIT.
`pod-media-store` was packed from the local branch `feat/pod-media-store` at `ce7d766`
(no `origin/feat/pod-media-store` ref exists in the checkout; the same commit is on the remote
under `refs/heads/feat/pod-media-store`). `solid-creative-assets` was packed from
`feat/creative-assets` at `d6dcc9a`. Every other package was packed from the first of those two
branches, whose other packages equal main at `d20ddf6`. `jeswr-guarded-fetch-0.1.0.tgz` above is
unchanged: its built `dist/` is byte-identical to the one at this commit.

| Tarball | Role | Licence |
| --- | --- | --- |
| `jeswr-pod-media-store-0.1.0.tgz` | content-addressed binary plus description store | MIT |
| `jeswr-solid-creative-assets-0.1.0.tgz` | the asset description model (build and parse) | MIT |
| `jeswr-storage-client-0.1.0.tgz` | `createPodClient`, the one pod I/O interface | MIT |
| `jeswr-storage-capabilities-0.1.0.tgz` | storage discovery under storage-client | MIT |
| `jeswr-pod-type-index-0.1.0.tgz` | Type Index discovery and registration | MIT |
| `jeswr-pod-access-0.1.0.tgz` | read-only owner-only check for the exposure probe | MIT |
| `jeswr-fetch-rdf-0.1.0.tgz` | bounded RDF fetch and parse | MIT |
| `jeswr-model-runtime-0.2.0.tgz` | runtime under the generated model | MIT |
| `jeswr-rdf-serialize-0.1.0.tgz` | `n3.Writer` serialisation helper | MIT |
| `jeswr-suite-vocab-0.1.0.tgz` | vocabulary constants | MIT |
| `jeswr-solid-odrl-0.1.0.tgz` | pod-access dependency | MIT |
| `solid-agent-notify-0.1.0.tgz` | pod-access dependency | MIT |

`frontend/package.json` references `pod-media-store`, `solid-creative-assets`, `storage-client`,
`pod-type-index` and `pod-access` with `file:` specs and maps the other seven through `overrides`.

New third-party packages in the production closure, each checked against the same allowlist
(quoted above, fetched 2026-11-25): `@solid/object` MIT, `jsonld-streaming-parser` MIT,
`jsonld-context-parser` MIT, `rdf-data-factory` MIT, `relative-to-absolute-iri` MIT,
`@bergos/jsonparse` MIT, `canonicalize` Apache-2.0, `content-type` MIT, `abort-controller` MIT,
`event-target-shim` MIT, `events` MIT, `base64-js` MIT, `ieee754` BSD-3-Clause,
`safe-buffer` MIT, `string_decoder` MIT; type-only packages `@rdfjs/types`, `@types/n3`,
`@types/http-link-header`, `@types/readable-stream` (MIT). Nothing is Node-only in the paths the
app imports (`undici` is reachable only from `@jeswr/guarded-fetch/node`). The app imports
`@jeswr/storage-client` only at its root, as the SDK layer rules ask; the memory pod
(`@jeswr/storage-client/memory`) is imported only by the integration test.

Rebuilding, from a checkout of the SDK with Node 24, one worktree per branch:

```sh
# branch feat/creative-assets
pnpm install --frozen-lockfile --filter "@jeswr/solid-creative-assets..." --filter "@jeswr/solid-sdk-workspace"
pnpm exec turbo run build --filter "@jeswr/solid-creative-assets..."
for p in fetch-rdf model-runtime suite-vocab solid-creative-assets; do (cd packages/$p && pnpm pack --pack-destination <dir>); done
# branch feat/pod-media-store
pnpm install --frozen-lockfile --filter "@jeswr/pod-media-store..." --filter "@jeswr/pod-access..." --filter "@jeswr/solid-sdk-workspace"
pnpm exec turbo run build --filter "@jeswr/pod-media-store..." --filter "@jeswr/pod-access..."
for p in pod-media-store storage-client storage-capabilities pod-type-index pod-access rdf-serialize solid-odrl solid-agent-notify; do (cd packages/$p && pnpm pack --pack-destination <dir>); done
```

SHA-256 of the added tarballs as committed:

```
0dbcc9440b342e6dea45a7e29fe47918e417b300abce592ee0318c4faaf9af63  jeswr-fetch-rdf-0.1.0.tgz
cf164e21246efe5c8ef3455df3f604592bf39eaaa8e7e457e27e48d852f71351  jeswr-model-runtime-0.2.0.tgz
9295bc1f24ddcaf7dd0e4be2860ebf0a5e1057a533e614de30126f1e1819220c  jeswr-pod-access-0.1.0.tgz
eaa3464c4d0e752c686b3795fd4a0a75be8d7f7680f90b2e9b939859fa24ab75  jeswr-pod-media-store-0.1.0.tgz
ecc187de5fc5bfd202da239ada0a957ce69b067cda31b7deec670d833039d3cf  jeswr-pod-type-index-0.1.0.tgz
f99e60e4b33c8bd66232680f1782f305a3af6a623b7451fd88c00a637e2f3a74  jeswr-rdf-serialize-0.1.0.tgz
228dc2a65acbbde1db2f7ab45484c1ca8c6be8a4bab0690e628e0ed5e3b46e34  jeswr-solid-creative-assets-0.1.0.tgz
1165f1d01c8b021471c374fb446bead14d76a030c6183f74f81f175e5244cea4  jeswr-solid-odrl-0.1.0.tgz
5bea6ce143ea34ad9c5428d08a29dd42908a1ed18caf81ef24f3ec9bea596b72  jeswr-storage-capabilities-0.1.0.tgz
4cf3522225827b709c949fc41b17c0815866dc9ac55f6a2623047a71490facfe  jeswr-storage-client-0.1.0.tgz
f4ed44e367e4344b5bfa97674c6d5cc1fa3dee7c6a9c3711f1a3b345dbc3b4a6  jeswr-suite-vocab-0.1.0.tgz
3ed8c7e94a5c0463e166889b43a6b49f0983db18ed43c2ef543f24ce037bb933  solid-agent-notify-0.1.0.tgz
```

Re-vendored later: `jeswr-pod-media-store-0.1.0.tgz` from `origin/feat/pod-media-store` at `bd52f77`
(Blob pass-through, `allowUnknownExposureFor`, PLY and SPZ sniffing) and `jeswr-pod-type-index-0.1.0.tgz`
from `origin/fix/pod-type-index-vite-regex` at `2f1ece2` (regex literals hoisted to constants), each
built and packed as described above in its own worktree; the hashes above are the new ones. Every
other tarball is unchanged. With the new pod-type-index the app's `vite build` no longer needs the
regex rewrite plugin, which was removed.

`jeswr-pod-media-store-0.1.0.tgz` was packed once more from `origin/feat/pod-media-store` at `de074a7`
(the body is read once and the hashed bytes are the sent bytes; a failed exposure probe cannot be
lifted by `allowUnknownExposureFor`; HTTP 413 and 507 are reported as `too-large` with reasons
`payload-too-large` and `insufficient-storage`). Its SHA-256 is now
`0e04678aa9bc81059adaf825b1a6892a6708405530ac81f5f2dbcd94cec5c7e4`; the hash in the list above is the
older one. Every other tarball is unchanged.

It was packed a third time from `origin/feat/pod-media-store` at `fa9889c` (adds `ensureLibrary({ signal })`, which
finds or creates the library and reports its exposure before the first `put`, and an `update` that never
resurrects a concurrently deleted description). SHA-256 now
`dddf848335bf654db3e5b57b7aa74f5d6cd01ac330213f8ae0c92ba766761b61`.

`jeswr-pod-auth-0.1.0.tgz` was packed again from solid-sdk `feat/pod-auth-identity-hook` at `b58caad`
(draft PR #677; adds `PodAuthOptions.fetch`, `InjectedFetchError` and `InvalidInjectedResponseError`: pod-auth's own
body-less GET and HEAD reads go through an injected fetch). Its `package.json` is the old one apart from
dependency key order, and it works with the vendored reactive-authentication 0.1.5. SHA-256 now
`b2d2ba406b7f8f36e4295a7fd0fae6f4f6e1a7ea4313635f2e15c3f329db7c2e`; the pod-auth hash in the list above
(`349742b5...`) is the older one. Every other tarball is unchanged.

These packages are experimental and security critical; they are unreleased and unaudited.
