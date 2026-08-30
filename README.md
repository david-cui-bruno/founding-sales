# Callie Founder Sales System

Local-first macOS founder-sales application.

## Apple Silicon development and verification

This foundation targets Apple Silicon macOS. Build and package it on an arm64
Mac; the package verifier intentionally rejects an x64 executable or a native
SQLite module that is not a Darwin arm64 Mach-O binary.

Run the clean verification sequence from the project root:

```bash
npm ci
npm run rebuild
npm run verify
npx playwright test tests/e2e/foundation.spec.ts
npm run verify:package
```

`npm run verify:package` packages the app and checks exactly one intended
`.app` bundle. It verifies the executable permissions and arm64 architecture,
the populated bundle identifier/display-name/version fields, bundled preload
and renderer resources, the required Electron fuses, ASAR unpacking, and a
usable Darwin arm64 `better-sqlite3` native artifact. The artifact is located
recursively: current `better-sqlite3` v13 packages it as
`prebuilds/darwin-arm64.node`, rather than requiring the older
`better_sqlite3.node` filename.

For development, run:

```bash
npm run start
```

## Local data and test isolation

Normal launches use Electron's per-app macOS user-data directory:

```text
~/Library/Application Support/Callie Founder Sales System/callie.sqlite3
```

The automated tests never use that founder-data location. Their E2E process
creates a temporary explicit `--user-data-dir`, runs the packaged app twice
against it, confirms both launches report the same SQLite path and schema 1
with FTS5 available, then deletes that temporary directory.

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
