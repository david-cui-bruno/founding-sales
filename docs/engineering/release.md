# Release, gate and backup manual

This is the operating manual for `npm run legacy:verify:release` and `npm run legacy:backup:pre-release`. It was moved verbatim from the repository `README.md` on 16 September 2026 (main `abfd259`) so that the README could become a short onboarding page; no sentence was changed, and the only edit is the relative link to the Apple feasibility procedure, rewritten for this directory. The current delivery state lives in [`docs/ROADMAP.md`](../ROADMAP.md) and the system map in [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md).

**Since 25 September 2026 (lane g89)** every root `npm` script for this app carries a `legacy:` prefix, because the root defaults now mean the greenfield product: a bare script name below (`verify:release`, `test:swift`, …) means its `legacy:` form, except `verify:secrets`, which guards the whole repository and kept its name; the commands are updated. `npm ci` no longer builds the native modules; run `npm run legacy:setup` once after it. What remains of this app and how to run it: [`docs/greenfield/legacy.md`](../greenfield/legacy.md).

## Apple Silicon development and verification

This foundation targets Apple Silicon macOS. Build and package it on an arm64
Mac; the package verifier intentionally rejects an x64 executable or a native
SQLite module that is not a Darwin arm64 Mach-O binary.

Use Node.js 24. The encrypted native driver is staged separately for the
supported Node 24 ABI and Electron 44 ABI; other Node majors fail closed.
`package.json` declares the exact policy and npm enforces it through the project
`.npmrc`.

### Exact-commit release checkpoint

Use **Node 24.20.0** for release gates. Do not run full root, package, E2E or
native acceptance concurrently with another checkpoint owner. Install each
independent Lambda lockfile. The root is not an npm workspace:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm ci
while IFS= read -r -d '' lock; do
  export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm ci --prefix "${lock%/package-lock.json}"
done < <(git ls-files -z -- 'cloud/lambdas/*/package-lock.json')
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run legacy:verify:release
```

Install the matching Playwright Chromium browser and the reviewed
**Gitleaks 8.30.1** before this sequence. The wrapper never
installs or substitutes a scanner. CI verifies the public Darwin ARM64 archive
SHA-256 before installation. Missing tools, incomplete history, process errors,
invalid reports and findings fail closed. This is not proof of universal secret
absence or coverage of remote history that was never fetched.

`verify:release` runs types, tracked lint, root tests, NativeDesk browser tests,
Swift tests, the Node helper build/verifier tests (`test:helpers:node`), the explicit
synthetic Electron backup-host test (`test:backup:electron`), and the two independent
Lambda gates (`shared`, then `delegated-worker`), then **packages once**. The host flag is local to its named command. It verifies that package, scans complete
fetched Git history plus the bounded source/generated build context, extracts
and scans the final ASAR and actual unpacked/helper bundle resources, runs
fixture E2E against that same artifact, and verifies its embedded marker again.
The runner checks the selected executable path, commit/build marker and actual
ASAR SHA256 before E2E spawns and after verification, then confirms unchanged clean HEAD.
`CALLIE_RELEASE_OUT_DIR` selects one output directory (default `<root>/out`) for
Forge, both package verifications, extracted scanning and E2E. A conflicting inherited
`CALLIE_E2E_OUT_DIR` fails before any build/test process. Standalone `test:e2e`
still accepts `CALLIE_E2E_OUT_DIR` for a separately built candidate. Expected release
identity metadata belongs to the test runner only, never the isolated app child environment.
Do not chain `verify:e2e` and `verify:package` as release evidence: those legacy
convenience commands each rebuild. No rebuild may intervene in the final
package/scan/E2E/marker sequence.

`lint:tracked` uses Git NUL paths, explicit JS/TS/config extensions and bounded
argument arrays, excluding generated output/dependencies at any depth. It does
not claim ESLint validation of JSON, YAML or Terraform. Lambda source uses its
nearest package TypeScript import-resolution options, not root substitutes.
`verify:lambdas` discovers tracked immediate package manifests in name order and
runs typecheck/test/build in each, today only `delegated-worker`; the nine legacy
sourcing packages were removed on 17 September 2026 after their stack was
destroyed, and the `shared` event-schema package was pruned once nothing imported
it. It never installs, deploys, scouts or contacts providers.

The marker is strict `{format:'callie-release',version:1,commitSha,builtAt}`.
`release:marker` derives actual full HEAD and refuses index, tracked or nonignored
untracked dirt. Forge captures this original marker before rebuilding Vite,
embeds it at ASAR root during afterCopy, and rechecks provenance after packaging.
Verification reads the **actual final ASAR bytes**, not a sibling/listed filename.
Changing HEAD, source or the generated marker invalidates the old artifact.
Existing executable/native arm64, ABI149, renderer, ATS, exact fuse, helper and
signature gates remain required. The packaged native target is
`better-sqlite3-multiple-ciphers/bin/darwin-arm64-149/better-sqlite3-multiple-ciphers.node`.
The Node ABI137 artifact and mutable build scratch are still stripped from the
app copy. `build:operational-tools` checks the fixed seven-module read-only audit
graph separately from the allowlisted writable pre-release host graph. It does
not relax the identity reader's exact-schema15 guard.

### Manual pre-release backup prerequisite

CI never runs `backup:pre-release`, resolves the founder profile, retrieves a
workspace key or copies founder data. The local sequence is: commit reviewed
source, build and verify a Task12-capable local package, obtain a **separately
authorized** real pre-release backup, then submit that exact SHA for audit/release
approval. A local package is neither an installation nor backup authorization.
After authorization only:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run legacy:backup:pre-release
```

The no-argument launcher uses only the exact repository-relative
`out/Callie Founder Sales System-darwin-arm64/Callie Founder Sales System.app/Contents/MacOS/Callie Founder Sales System`.
It requires production identity and a clean-HEAD-matching ASAR marker. There is
no alternate executable, profile, DB, envelope, key or environment override and
no /Applications fallback. The packaged reserved mode obtains the same Electron
application lock, refuses a running app before key/DB/output work, and starts no
windows, sourcing, recovery setup, IPC or timers. It uses existing protected
safeStorage material with `databaseExists:true`, rejects unsafe/missing paths,
plaintext, unsupported schema or changed receipt structures, and never creates
or migrates a workspace. Current support is exact current schema24 only, validated
against the production readiness ledger and full catalog. This explicitly
supersedes the unreleased schema15-only host. A schema15 workspace is
refused without migration or backup/receipt writes, as are older or future schemas.
The historical schema15 audit and its seven-module graph remain unchanged and
reject schema16 and current schema24. Backup or upgrade of an older founder workspace remains a
separately approved protected-copy workflow, including historical audit/repair,
migration-backup and restore-acceptance hold points. Never migrate an older
workspace merely to make this command usable. Legacy packages also require a
separately approved bootstrap/copy procedure.

The actual BackupService creates an immutable verified `pre_release` copy and
same-database receipt, drains, closes and zeroes owned keys before releasing the
lock. The output contains only non-secret receipt fields. This is intentionally
writable (checkpoint/receipt/retention), not a read-only inspection. A verified
artifact is retained even if receipt recording fails. A fresh real backup and
restore-readiness acceptance remain manual prerequisites, never mocked CI proof.

### Startup diagnosis without a live launch

A failed start shows only `APPLICATION_STARTUP_FAILED`. Two retained traces exist
so nobody has to relaunch blind:

- The local log (`<userData>/logs/<date>.ndjson`) gets one `STARTUP_FAILED`
  record per failed start with three closed fields only: `stage` (`key`,
  `prepare`, `open`, `migrate`, `domain`, `health`, `compose`, `window`),
  `errorClass` (our own error names or `SqliteError`) and `code` (a domain fatal
  code or a SQLite result code). No message, path or value is written.
- `npm run legacy:diagnose:startup` launches the same packaged executable as
  `backup:pre-release` in its second reserved mode, `--callie-diagnose-startup`.
  It copies the workspace database (and any write-ahead log) into a private
  temporary directory, runs open, readiness, `migrateToLatest` and the domain
  bootstrap on the copy, deletes the copy, and prints one JSON report: sidecar
  sizes, per-stage outcome, error class, closed code and a path-free message.
  The live database is never opened. The launcher hands the host a fixed
  environment (`HOME`, `PATH`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`,
  `LC_ALL`, `TERM`) so shell-carried `NODE_*` variables do not trip the host's
  environment refusal. Same clean-HEAD marker, identity and lock rules as the
  backup launcher; refusals print `STARTUP_DIAGNOSE_FAILED <reason>`.

### Hosted gate prerequisites (workflow source only)

`.github/workflows/ci.yml` uses disposable GitHub-hosted macOS runners for PR/main
source gates. `.github/workflows/release.yml` is gate-only, not publication. It
requires dispatch **on the exact tag**, and checks peeled tag = audited input =
HEAD = GITHUB_SHA, detached checkout, full history and fetched-main ancestry.
Release requires a separately provisioned restricted macOS ARM64 runner with
macOS/SDK >=26.4, Electron44/native/Swift support and no founder profile or cloud
credentials. Labels and ancestry do not prove runner trust or branch protection.

Before any hosted execution, the coordinator must independently configure and
review protected-main/tag policy, the `callie-release-gate` environment and its
required reviewers, restricted runner access, `CALLIE_RELEASE_RUNNER_APPROVED`
and the per-release `CALLIE_APPROVED_RELEASE_SHA` variables. Missing approval
values fail closed. The variable/input labels are not themselves an audit.
No SHA/tag is nominated by this source change. Checkout/setup-node actions use
reviewed full public commit pins; this is provenance review, not a complete
upstream dependency audit. No workflow publishes, pushes, uses cloud state or
performs founder backup. Signing credentials, stable-signing acceptance and
hosted enforcement are external approvals, not results of fixture tests.

Secret scans emit counts/status only, capture scanner output privately and clean
redacted reports/staging afterward. History has no generated-path exemption.
Context selection uses tracked source and explicit generated application,
operational-tool and Lambda outputs, never ignored local runtime/state/receipt
or quarantine roots. Package coverage includes decoded ASAR and actual bundle
resources separately. Gitleaks is a text-pattern scanner with bounded archive
and decode recursion, not binary forensics or a universal absence proof.

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

`npm run legacy:test:e2e` covers the packaged company workflow: foundation health and
the diagnostics screen, the composed shell booting to Today, the meeting-first
workspace, local company preparation (create, reopen, restart), navigation
continuity across Today, Accounts, Campaigns and Settings, the presentation
identity in both themes, and an axe accessibility gate that fails on any serious
or critical violation across those four routes. Every packaged test uses a fresh
`mkdtemp` `--user-data-dir`; production founder data is never read or written by
tests. Separate owned encrypted migration/transition fixtures seed specific
retained workspace states directly to test upgrades and transitions. Those
fixtures do not prove the UI can create that starting state. The legacy person
routes (Leads, Pipeline, Conversations, Learnings, Friday, Inbox), the CSV person
import and the lead inspector were removed on 17 September 2026 together with
their packaged specs; their tables and history remain in the database.

The Apple feasibility spike, its packaged smoke test (`test:e2e:apple`) and the
manual feasibility procedure were removed on 18 September 2026. The nested helper
is still packaged, signed and verified as above because the phone route opens
calls through it; nothing launches it at startup any more.

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
again after Packager finishes changing bundle metadata. Notarization remains
outside this foundation scope.

## Local code signing

On macOS, `npm run legacy:package` signs with a stable local identity by default so
the app's code identity survives rebuilds and macOS Keychain "Always Allow"
grants for safeStorage keep working without new password prompts. Resolution
order:

1. A non-blank `CALLIE_MAC_SIGN_IDENTITY` environment variable wins.
2. Otherwise the first `Developer ID Application:` identity in the login
   keychain is used, then the first `Apple Development:` identity.
3. With no usable identity (or off macOS), packaging falls back to the
   previous ad-hoc signature. Ad-hoc identities change every rebuild, so
   Keychain re-prompts after each package are expected in that mode.

For development, run:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run legacy:start
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
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run legacy:package
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
