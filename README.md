# Callie Founder Sales System

Local-first macOS founder-sales application.

## Apple Silicon development and verification

This foundation targets Apple Silicon macOS. Build and package it on an arm64
Mac; the package verifier intentionally rejects an x64 executable or a native
SQLite module that is not a Darwin arm64 Mach-O binary.

Use Node.js 22.13 or newer on the Node 22 release line, or Node.js 24 or newer.
Node 23 is not supported. Installed test and lint tooling sets the 22.13 floor;
`package.json` declares the exact policy and npm enforces it through the project
`.npmrc`.

Run the clean verification sequence from the project root:

```bash
npm ci
npm run rebuild
npm run verify
npm run verify:e2e
npm run verify:package
npm run start
```

`npm run verify:e2e` packages before launching the packaged E2E suite, so this
sequence works from a fresh checkout with no `out/` directory. The following
`npm run verify:package` intentionally rebuilds and checks exactly one intended
`.app` bundle. It verifies executable permissions and arm64 architecture,
populated bundle metadata, ATS denial of arbitrary network loads, bundled
preload and renderer resources, the exact Electron 44 V1 fuse set, ASAR
unpacking, and a usable Darwin arm64 `better-sqlite3` native artifact. The
artifact is located recursively: current `better-sqlite3` v13 packages it as
`prebuilds/darwin-arm64.node`, rather than requiring the older
`better_sqlite3.node` filename.

Package verification also checks the nested `Callie Apple Bridge.app`: its
fixed bundle identifier and macOS 26.4 minimum, thin arm64 executable, strict
code signature, and exact Apple Events automation entitlement. A stable-signed
package must expose matching non-empty Team IDs on the parent and helper. A
local ad-hoc package skips only Team-ID equality; both code objects must still
have valid strict signatures and the helper must retain its entitlement. Ad-hoc
verification does not establish permission persistence across rebuilds.

The standard packaged E2E command includes an inert Apple smoke test. To run
only that suite after packaging:

```bash
npm run test:e2e:apple
```

It launches the packaged app with an isolated temporary profile and the gated
Apple feasibility panel, proves helper packaging, protocol handshake, exact
status reporting, and helper/process-tree cleanup when Callie closes. It does
not click capability, permission, call-observation, Notes, Messages, or send
controls. Therefore it does not prompt for TCC access, read founder Apple
databases, place a call, send a message, prove TCC grants, or prove live
communication. Those remain separate consenting manual checks.

The [Apple communications manual feasibility procedure](docs/engineering/apple-feasibility-procedure.md)
is the only approved live-capability check. It is manual-only and is never run
by `npm test`, `npm run test:swift`, `npm run verify`, `npm run verify:e2e`,
`npm run verify:package`, or CI.

Packaging sets every Electron 44 V1 fuse with
`strictlyRequireAllFuses: true`, so a future Electron fuse addition stops the
build until its policy is chosen explicitly. The browser-process-specific V8
snapshot is deliberately disabled for the stock Electron 44 arm64 runtime:
that distribution contains `v8_context_snapshot.arm64.bin` but no
`browser_v8_context_snapshot.bin`, and enabling the fuse makes the packaged
process terminate with `SIGTRAP`. It can be reconsidered only with a compatible
browser snapshot artifact. Wasm trap handlers remain enabled for the supported
Apple Silicon guard-page runtime path; legacy `file://` extra privileges are
disabled because the production renderer uses `callie://`. Unsigned Apple
Silicon packages reset Electron's ad-hoc signature during fuse mutation and
again after Packager finishes changing bundle metadata. Signing identities and
notarization remain outside this foundation scope.

For development, run:

```bash
npm run start
```

## Local data and test isolation

Normal launches use Electron's per-app macOS user-data directory:

```text
~/Library/Application Support/Callie Founder Sales System/callie.sqlite3
```

The automated tests never use that founder-data location. Their E2E processes
create temporary explicit `--user-data-dir` profiles. They verify healthy
restart persistence and also create an isolated directory collision at the
would-be database path, confirm the generic failure alert, remove only that
test collision, click `Retry`, and confirm the same path reaches schema 1 with
FTS5. Runtime initialization never deletes, replaces, or renames a database;
Retry opens and migrates the same Application Support path again.

To repeat that proof manually without touching founder data, package first and
launch the executable twice with one temporary profile. Quit the app after the
first launch, then run the same launch command again. The diagnostics screen
will show `SQLite ready`, `FTS5 available`, `Schema 1`, and the shared
`$CALLIE_TEST_PROFILE/callie.sqlite3` path.

```bash
npm run package
export CALLIE_PACKAGED_APP="$PWD/out/Callie Founder Sales System-darwin-arm64/Callie Founder Sales System.app"
export CALLIE_TEST_PROFILE="$(mktemp -d -t callie-isolated-profile.XXXXXX)"
"$CALLIE_PACKAGED_APP/Contents/MacOS/Callie Founder Sales System" --user-data-dir="$CALLIE_TEST_PROFILE"
# Quit the app, then repeat exactly the previous launch command.
rm -rf "$CALLIE_TEST_PROFILE"
```

Only remove `CALLIE_TEST_PROFILE` after both launches have been inspected; it
is the temporary test profile created above, not the normal Application Support
directory. The isolated launch is also suitable for CDP inspection with an
additional `--remote-debugging-port=<unused-port>` argument.
