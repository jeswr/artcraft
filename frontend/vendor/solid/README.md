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

These packages are experimental and security critical; they are unreleased and unaudited.
