# Vendored Solid sign-in packages (placeholder)

These tarballs are a **placeholder** until the maintainers decide how ArtCraft consumes the
`@jeswr` Solid packages (npm publishing is undecided). They are the packed output of five
workspace packages of the Solid SDK monorepo (four are private there; `guarded-fetch` is a public package), branch `feat/desktop-auth`, commit
`225a553` ("fix(desktop-auth): address review findings M1-M3, L1-L7"). Replace them with a
registry dependency, or remove them, when that decision is made.

**`jeswr-pod-auth-0.1.0.tgz` is the exception to the branch above: it was packed from the
unmerged draft PR #677 of the Solid SDK (`feat/pod-auth-identity-hook` at `b58caad`), which adds
`PodAuthOptions.fetch`. Its SHA-256 is `b2d2ba406b7f8f36e4295a7fd0fae6f4f6e1a7ea4313635f2e15c3f329db7c2e`; the hash
in the list below for that file is the older one. Pinned code is normally merged upstream first
(AGENTS rule 10); this one is not yet, and ArtCraft's cross-origin WebID sign-in depends on it.
Replace it with the merged build when #677 lands.**

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
b2d2ba406b7f8f36e4295a7fd0fae6f4f6e1a7ea4313635f2e15c3f329db7c2e  jeswr-pod-auth-0.1.0.tgz
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
`b2d2ba406b7f8f36e4295a7fd0fae6f4f6e1a7ea4313635f2e15c3f329db7c2e`; the list above carries it now (the earlier
`349742b5...` is gone). Every other tarball is unchanged.

It was packed a fourth time from `origin/feat/pod-media-store` at `690ecee7c` (adds `resumePending({ signal, shouldResume })`
with a per-delete veto that may answer `true`, `false` or `"withdraw"`, `ResumeSummary.skipped` and per-entry `entries`,
`withdrawPending(descriptionUrl)`, a per-copy lock inside the store, a `put` that withdraws a pending delete for a copy it
adopts, and the `reentrant` reason). It was built in a scratch git worktree of the SDK with the recipe above. SHA-256 now
`2814fa93aee8e4edb1bf2f986d97b96cd0dbe27c4435ff2dbd39ef2b8032a998`; the `frontend/package-lock.json` integrity is the
tarball's SHA-512 (`sha512-qdXo998c...`).

These packages are experimental and security critical; they are unreleased and unaudited.

## Pod media loader (added with the "My pod" gallery source)

`jeswr-pod-media-loader-0.1.0-fdf084a.tgz` is the packed `@jeswr/pod-media-loader` (MIT, `securityCritical`,
private in the SDK, experimental and unaudited). It reads authenticated pod media through the storage
client, sniffs the bytes against a passive-media allowlist and hands out reference-counted `blob:` URLs typed by
the sniffed type only, inside a hard memory budget. It was packed from `origin/feat/pod-media-loader` of the SDK
at commit `fdf084ab4029a2d2cf8cd4ac2cacdf2f8be48a68` ("fix(pod-media-loader): reserve declared length at header
time, wait for room, retryable over-budget"). An earlier build (5810c65) was replaced: it had no hard memory bound
and a pixel-limit bypass for GIF.

`jeswr-storage-client-0.1.0-fdf084a.tgz` was re-packed from the same commit, because the loader reads the new
optional `ReadResult.contentLength` that the storage client gained there. Against the previous tarball the
built output differs only by that field (`http.js`, `memory.js`, `types.d.ts`, `http.d.ts`); its manifest and
dependencies are unchanged, so every vendored package that depends on it (`pod-media-store`, `pod-type-index`,
`pod-access`, `solid-creative-assets` through them) still resolves to it. The file names carry the short SDK
commit so a re-vendor is visible in the name.

```sh
pnpm install --frozen-lockfile --filter "@jeswr/pod-media-loader..." --filter "@jeswr/solid-sdk-workspace"
pnpm exec turbo run build --filter "@jeswr/pod-media-loader..."
(cd packages/pod-media-loader && pnpm pack --pack-destination <this directory>)
(cd packages/storage-client && pnpm pack --pack-destination <this directory>)
# then rename each to <name>-0.1.0-fdf084a.tgz
```

Nothing else is added: the loader's dependencies are `@jeswr/storage-client` and `@jeswr/guarded-fetch`, both
vendored; its only peer, `react`, is optional and already present. No new third-party package enters the
production closure; the licence (MIT) is on the allowlist. The lockfile integrity values are the real sha512 of
these files.

```
b69d680862d923516b339df849693303ca7b73416f4f3feca8079e9163b3e9fc  jeswr-pod-media-loader-0.1.0-fdf084a.tgz
a72b3814f2769d25916e6e273f9c7395465a5e8b8129f1c5e3f39cd86c6f87bf  jeswr-storage-client-0.1.0-fdf084a.tgz
```

The hash listed for `jeswr-storage-client-0.1.0.tgz` in the older section above is the previous tarball, which
this file replaces.

## Current vendored set (integration of sign-in-fixes, pod-mirror-fixes and pod-gallery)

One tarball per package. Where a package was re-packed several times in the sections above, only the newest SDK commit is kept. This table is the authority; earlier hash lists in this file describe tarballs that were replaced.

| Tarball | SDK source | SHA-256 |
| --- | --- | --- |
| `jeswr-desktop-auth-0.1.0.tgz` | feat/desktop-auth 225a553 | `75f91bdc463a3a3d0ca96f5dd6e406364dbb71299dd4ed2528a099a6bee070ea` |
| `jeswr-fetch-rdf-0.1.0.tgz` | feat/creative-assets d6dcc9a (main d20ddf6) | `0dbcc9440b342e6dea45a7e29fe47918e417b300abce592ee0318c4faaf9af63` |
| `jeswr-guarded-fetch-0.1.0.tgz` | feat/desktop-auth 225a553 (dist identical at d20ddf6) | `198d0b6b78381df298071345d87d7769888ab467140d94b2ea11417e812d4f97` |
| `jeswr-model-runtime-0.2.0.tgz` | feat/creative-assets d6dcc9a (main d20ddf6) | `cf164e21246efe5c8ef3455df3f604592bf39eaaa8e7e457e27e48d852f71351` |
| `jeswr-pod-access-0.1.0.tgz` | feat/pod-media-store ce7d766 | `9295bc1f24ddcaf7dd0e4be2860ebf0a5e1057a533e614de30126f1e1819220c` |
| `jeswr-pod-auth-0.1.0-eb76ddf.tgz` | eb76ddf75 (draft PR #690, review fixes) + b58caad (draft PR #677), local merge f44edab4d (bundle below) | `526c35bb27fbeb2bcc70d21ba9a9cc8b272eb8055c5d56a4739156ab35b02e6f` |
| `jeswr-pod-media-loader-0.1.0-fdf084a.tgz` | feat/pod-media-loader fdf084a | `b69d680862d923516b339df849693303ca7b73416f4f3feca8079e9163b3e9fc` |
| `jeswr-pod-media-store-0.1.0.tgz` | feat/pod-media-store 690ecee7c | `2814fa93aee8e4edb1bf2f986d97b96cd0dbe27c4435ff2dbd39ef2b8032a998` |
| `jeswr-pod-type-index-0.1.0.tgz` | fix/pod-type-index-vite-regex 2f1ece2 | `ecc187de5fc5bfd202da239ada0a957ce69b067cda31b7deec670d833039d3cf` |
| `jeswr-rdf-serialize-0.1.0.tgz` | feat/pod-media-store ce7d766 | `f99e60e4b33c8bd66232680f1782f305a3af6a623b7451fd88c00a637e2f3a74` |
| `jeswr-reactive-authentication-0.1.5-14143e0.tgz` | 14143e09b (draft PR #690) | `6e877ba9633aab98dfd9940705157dd2501a238865d41d09f4079d6336f922fb` |
| `jeswr-solid-creative-assets-0.1.0.tgz` | feat/creative-assets d6dcc9a | `228dc2a65acbbde1db2f7ab45484c1ca8c6be8a4bab0690e628e0ed5e3b46e34` |
| `jeswr-solid-odrl-0.1.0.tgz` | feat/pod-media-store ce7d766 | `1165f1d01c8b021471c374fb446bead14d76a030c6183f74f81f175e5244cea4` |
| `jeswr-storage-capabilities-0.1.0.tgz` | feat/pod-media-store ce7d766 | `5bea6ce143ea34ad9c5428d08a29dd42908a1ed18caf81ef24f3ec9bea596b72` |
| `jeswr-storage-client-0.1.0-14143e0.tgz` | 14143e09b (draft PR #690) + fdf084a `contentLength` patch, local commit 324f75d24 | `55c95f6a73f380ad9df09c0a18bf9abed8d68c0f097f9f1984ea3fdced44359c` |
| `jeswr-suite-native-0.1.0.tgz` | feat/desktop-auth 225a553 | `89d27479963625ada5355a62d9a277d18a9f08ebd63948039fe11d3bcd4229a0` |
| `jeswr-suite-vocab-0.1.0.tgz` | feat/creative-assets d6dcc9a (main d20ddf6) | `f4ed44e367e4344b5bfa97674c6d5cc1fa3dee7c6a9c3711f1a3b345dbc3b4a6` |
| `solid-agent-notify-0.1.0.tgz` | feat/pod-media-store ce7d766 | `3ed8c7e94a5c0463e166889b43a6b49f0983db18ed43c2ef543f24ce037bb933` |

## Re-vendor at SDK draft PR #690 (`14143e09b`)

Three tarballs were re-packed so the app gets pod-auth's `nonInteractiveFetch`, the typed replay
cap (`ReplayBodyTooLargeError`), `identity.storageDiscovery` (the credential boundary learned from
the WebID server's storage description when the profile has no `pim:storage`), the storage
client's `allow` fix and `parentOf({ signal })`, and the reactive-authentication engine changes
under them. #690 (`claude/project-thread-jn2p5t` at `14143e09b`) does not contain the two draft
branches the replaced tarballs needed, so the build commit is a local, unpushed one on top of it:

1. `git merge origin/feat/pod-auth-identity-hook` (`b58caad`, draft PR #677, `PodAuthOptions.fetch`).
   Six files conflicted, all in `packages/pod-auth`; every conflict was resolved by keeping both
   sides: the union of the `AUTHORED-BY` lines, both import blocks in `index.ts`, and the export
   list `AmbiguousIssuerError, InjectedFetchError, InvalidInjectedResponseError,
   OwnershipChangedError`. No code line of either side was dropped. Result: `330d69c2d`.
2. `git diff 8a51401fb origin/feat/pod-media-loader -- packages/storage-client | git apply --3way`
   (the optional `ReadResult.contentLength` from `fdf084a` that the vendored media loader reads;
   applies cleanly). Result: `324f75d24`.

**Known open review finding.** An adversarial review of `14143e09b` found a high-severity issue
in the new storage discovery: on a Community Solid Server with the default root-storage
configuration, pod-auth learns the origin root `/` as the credential boundary. It was fixed on the same SDK
branch in `7c09caa78`, and pod-auth was re-vendored from it (see below); the `14143e0` pod-auth
build described here is gone. (The test server used for ArtCraft's webview runs uses per-pod storage, which this does
not affect.)

At that commit the pod-auth (944), storage-client (1305) and reactive-authentication (623) test
suites pass. Built and packed as before, in a scratch worktree, with Node 24:

```sh
pnpm install --frozen-lockfile --filter "@jeswr/pod-auth..." --filter "@jeswr/storage-client..." \
  --filter "@jeswr/pod-type-index..." --filter "@jeswr/pod-access..." --filter "@jeswr/solid-sdk-workspace"
pnpm exec turbo run build --concurrency=2 --filter "@jeswr/pod-auth..." --filter "@jeswr/storage-client..."
for p in pod-auth reactive-authentication storage-client; do (cd packages/$p && pnpm pack --pack-destination <dir>); done
# then rename each to <name>-<version>-14143e0.tgz
```

Only these three are replaced. Every other tarball is kept, for one of two reasons:

- `desktop-auth`, `pod-media-store`, `pod-media-loader` and `solid-creative-assets` do not exist
  at `14143e09b`; they come from the draft branches named in the table. Their manifests name
  `@jeswr/storage-client` and the others by plain version, which the `overrides` map to the new
  tarballs; every name they import from `@jeswr/storage-client` (root and `/helpers`) is still
  exported by the new build.
- The rest (`guarded-fetch`, `storage-capabilities`, `pod-type-index`, `pod-access`, `fetch-rdf`,
  `model-runtime`, `rdf-serialize`, `suite-vocab`, `solid-odrl`, `solid-agent-notify`,
  `suite-native`) either did not change in #690 or changed only in ways the app does not need
  (`pod-type-index` gained an abort option and, on main, a generated model needing newer
  `model-runtime` and `suite-vocab`, which the kept `solid-creative-assets` was not built
  against). Every name the new pod-auth and storage-client import from `guarded-fetch`,
  `storage-capabilities`, `fetch-rdf`, `rdf-serialize` and `reactive-authentication` is exported
  by the vendored copy.

No package manifest's dependencies changed, so no third-party package enters the production
closure. The lockfile integrity values are the real SHA-512 of the new files. These replace the
older `pod-auth`, `reactive-authentication` and `storage-client` builds listed above; the
current-set table above carries the new names and hashes. Replace them with merged builds when
#677, #690 and the loader's storage-client change land.

### pod-auth re-packed at `7c09caa78` (review fix)

The review finding above was fixed on the same SDK branch in `7c09caa78` ("fail closed in
WebID-document storage discovery; prefer the nearest storage": on CSS's default configuration a
user now learns `/alice/`, never `/`; unreadable, contradictory or failed evidence gives
`source: "none"` with the new reasons `storage-unconfirmed` and `discovery-failed`, and
`storage-ineligible` gains `declaredBy`). The local build branch was brought up to it with
`git merge origin/claude/project-thread-jn2p5t` (result `8362139e6`). One file conflicted,
`packages/pod-auth/src/boundary.ts`: the fix moved the storage description read into
`readStorageDescription`; the resolution takes the fix's version and keeps #677's rule there that
a refusal by the injected fetch (`injectedFetchFailure`) is rethrown rather than read as "no
roots" or a transient failure. The pod-auth suite (964 tests) passes at that commit. Only
`jeswr-pod-auth-0.1.0-14143e0.tgz` was replaced, by `jeswr-pod-auth-0.1.0-7c09caa.tgz` (its
manifest and dependencies are unchanged; only `dist/boundary.js` and `dist/types.d.ts` differ,
plus the README and skill). The reactive-authentication and storage-client tarballs from
`14143e0` are unchanged: the fix touches neither.

It was packed once more from `c86c6eab7` ("never widen past a passed container in WebID-document
storage discovery"), merged into the same local build branch without conflicts (result
`80eacc891`; #677's rethrow of host refusals is still in `readStorageDescription`). The pod-auth
suite (979 tests) passes there. Behaviour that matters here: on a server whose storage description
claims each pod root itself (CSS's file-based configuration, as on the webview test server), a
profile without `pim:storage` now learns no storage at all (`source: "none"`), on purpose, because
that case cannot be told apart from an attack; only CSS's default layout (a typed pod container
under a claimed origin root) is discovered. `jeswr-pod-auth-0.1.0-7c09caa.tgz` is replaced by
`jeswr-pod-auth-0.1.0-c86c6ea.tgz`, SHA-256 `9da5779d304951aa834fcc3714e97b102f3d93298aa2985f15900296e2198dbd`; manifest and dependencies unchanged.

### pod-auth re-packed at `eb76ddf75` (origin root never a boundary)

`eb76ddf75` ("never learn the origin root as a user's storage boundary") refuses the origin root
at every step of the storage-description walk: a WebID document stored directly in an
origin-root storage no longer makes the whole origin the credential boundary; it gives
`source: "none"` with reason `no-storage-declared`. Following the recipe above, a scratch SDK
worktree at `eb76ddf75` merged the previous local build commit `80eacc891` (which carries #677,
the `contentLength` patch and the earlier conflict resolutions) without conflicts; the result is
`f44edab4d`, whose tree differs from `80eacc891` only by `eb76ddf75`'s own change. The pod-auth suite
(981 tests) passes there with coverage off, and `tsc --noEmit` is clean. With coverage on, the
package's 100% threshold is not met (statements 99.95%, branches 99.93%); this was not
investigated. `jeswr-pod-auth-0.1.0-c86c6ea.tgz` is replaced by `jeswr-pod-auth-0.1.0-eb76ddf.tgz`.
Against it only `dist/boundary.js` (and its maps) and the README differ; the manifest is
identical.

The local build commit is not pushed to the SDK. To make the build reproducible it is saved as a
git bundle, `solid-sdk-artcraft-vendor-eb76ddf.bundle` in the project files
(`/mnt/project-files/artcraft/vendor-builds/`, SHA-256
`487b5806dd81491bc4b626a719b4acfc5de8492926247dd46104754686c200e3`). It holds the ref
`refs/heads/artcraft-vendor-eb76ddf` at `f44edab4d` and the four local commits under it
(`330d69c2d`, `324f75d24`, `8362139e6`, `80eacc891`). Its prerequisites are all on pushed SDK
branches: `eb76ddf75`, `c86c6eab7`, `7c09caa78` and `14143e09b` on `claude/project-thread-jn2p5t`,
and `b58caad06` on `feat/pod-auth-identity-hook`.

```sh
# in a clone of jeswr/solid-sdk that has both branches fetched
git bundle verify <path>/solid-sdk-artcraft-vendor-eb76ddf.bundle
git fetch <path>/solid-sdk-artcraft-vendor-eb76ddf.bundle artcraft-vendor-eb76ddf
git worktree add ../vendor-build FETCH_HEAD   # f44edab4d
cd ../vendor-build
pnpm install --frozen-lockfile --filter "@jeswr/pod-auth..." --filter "@jeswr/solid-sdk-workspace"
pnpm exec turbo run build --filter "@jeswr/pod-auth..."
(cd packages/pod-auth && pnpm pack --pack-destination <dir>)   # then rename to jeswr-pod-auth-0.1.0-eb76ddf.tgz
```
