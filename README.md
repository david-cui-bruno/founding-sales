# Callie Founder Sales System

Local-first macOS founder-sales application.

## Apple Silicon development and verification

This foundation targets Apple Silicon macOS. Build and package it on an arm64
Mac; the package verifier intentionally rejects an x64 executable or a native
SQLite module that is not a Darwin arm64 Mach-O binary.

Use Node.js 24. The encrypted native driver is staged separately for the
supported Node 24 ABI and Electron 44 ABI; other Node majors fail closed.
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
unpacking, and exactly one Darwin arm64 encrypted SQLite native artifact. The
packaged artifact is fixed at
`better-sqlite3-multiple-ciphers/bin/darwin-arm64-149/better-sqlite3-multiple-ciphers.node`.
Development also retains a separate ABI 137 artifact for bundled Node tests;
the generated app copy strips that artifact and all mutable `build/Release`
scratch output before ASAR assembly.

Packaged E2E files run with one Playwright worker because Callie acquires a
single-instance lock before resolving a workspace key or touching SQLite. They
also pass Chromium's `--use-mock-keychain` test switch so repeated ad-hoc
packages never read, create, modify, or prompt for the founder's real Keychain;
the production app does not add that switch.

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

Normal launches use Electron's per-app macOS user-data directory. The database
is encrypted with the fixed SQLCipher/legacy-4 profile; its 32-byte workspace
key is protected by macOS Keychain through Electron safeStorage and stored only
as a protected `callie.key-envelope.json` sibling:

```text
~/Library/Application Support/Callie Founder Sales System/callie.sqlite3
```

The app refuses to create a replacement key when any existing database or
interrupted-conversion artifact is present. Plaintext schema-1 conversion uses
fsynced `.encrypting`, `.plaintext-recovery`, and state-marker siblings and
never deletes the only independently validated copy.

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
will show `Encrypted SQLite ready`, `FTS5 available`, `Schema 1`, and the shared
`$CALLIE_TEST_PROFILE/callie.sqlite3` path.

```bash
npm run package
export CALLIE_PACKAGED_APP="$PWD/out/Callie Founder Sales System-darwin-arm64/Callie Founder Sales System.app"
export CALLIE_TEST_PROFILE="$(mktemp -d -t callie-isolated-profile.XXXXXX)"
"$CALLIE_PACKAGED_APP/Contents/MacOS/Callie Founder Sales System" --user-data-dir="$CALLIE_TEST_PROFILE"
# Quit the app, then repeat exactly the previous launch command.
# Remove only the temporary profile after both launches (for example via Finder).
```

Only remove `CALLIE_TEST_PROFILE` after both launches have been inspected; it
is the temporary test profile created above, not the normal Application Support
directory. The isolated launch is also suitable for CDP inspection with an
additional `--remote-debugging-port=<unused-port>` argument.
