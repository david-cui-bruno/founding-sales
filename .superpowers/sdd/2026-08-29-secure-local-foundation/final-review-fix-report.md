# Secure Local Foundation Final-Review Fix Report

Date: 2026-08-30

Base: `3f1a425989db5fac29f11205a172c895403f605e`

Implementation commit: `6addd282ba372931e122ca0922b071c2330a0257`

## Outcome

All five final-review findings are addressed. The final source verification is
22 test files / 92 tests passing, packaged E2E is 2/2 passing from an absent
`out/` directory, the independent packaged verifier passes, and the development
app launches against the exact localhost development origin. No signing or
notarization feature was added.

## Design and files

### 1. Complete Electron 44 fuse lock

- `build/electronFuses.ts` owns one closed Electron 44 V1 policy and calls
  `@electron/fuses` 2.1.3 directly. It sets `strictlyRequireAllFuses: true`, so
  packaging fails if the library discovers a future fuse without an explicit
  policy.
- `forge.config.ts` removed the Forge 7 `FusesPlugin`. Its direct
  `packageAfterCopy` hook flips fuses on the extracted Electron executable,
  before Packager signing. For unsigned Darwin arm64 packages it requests the
  fuse library's ad-hoc signature reset. A `postPackage` hook performs the final
  deep ad-hoc reset because Packager modifies bundle metadata after the early
  reset. Configured signing identities skip both unsigned-package behaviors.
- `scripts/verifyPackage.mjs` uses the installed 2.x reader. It requires fuse
  version V1, parses the complete enumeration, rejects duplicates, missing
  names, unknown names, inherited/removed states, and state mismatches, then
  verifies the final macOS signature.
- `test/electronFuses.test.ts` and `test/verifyPackage.test.mjs` cover the exact
  configuration, hook target/signature behavior, closed-world enumeration, bad
  version/state, and final signature failure.

The V8 browser-process snapshot fuse is deliberately **disabled**. The preferred
`true` setting was tested first, but the stock Electron 44 arm64 distribution
contains `v8_context_snapshot.arm64.bin` and not
`browser_v8_context_snapshot.bin`; both packaged processes terminated with
`SIGTRAP`. Disabling that fuse restored the supported stock runtime. Wasm trap
handlers remain enabled for the supported Apple Silicon guard-page path, and
legacy `file://` privileges are disabled because production uses `callie://`.

### 2. User-visible non-destructive database recovery

- `src/main/foundation/foundationRuntime.ts` adds a narrow runtime/coordinator
  that implements the existing health-provider capability. It lazily opens the
  exact configured database path, runs atomic migrations, recovers interrupted
  jobs, and retains the ready health service.
- Concurrent health requests share one initialization promise. Failure closes
  a partially opened database exactly once and leaves the runtime retryable;
  the next health request opens and migrates the same path. No runtime code
  deletes, replaces, or renames the database. Attempt identity and runtime
  state checks prevent a late initialization from becoming ready after
  shutdown.
- Shutdown is idempotent. It unregisters IPC first, marks the runtime stopping,
  awaits an in-flight migration, rejects that health request as cancelled,
  closes the partial database once, and prevents later health work.
- `src/main/startApplication.ts` registers health IPC and loads the bootstrap
  diagnostics window before database initialization. The first renderer health
  request initializes; a failure reaches the renderer's existing generic alert,
  and the existing Retry button issues a fresh `window.callie.health.get()`.
- `src/main/health/registerHealthIpc.ts` now awaits that provider while retaining
  the sole `health:get` channel. `src/preload.ts` is unchanged, so the exact
  surface remains `window.callie.health.get()` and no generic IPC was added.
- `src/main.ts` awaits asynchronous application cleanup on startup cancellation
  and normal quit, and suppresses activation during quit.
- `tests/main/foundationRuntime.test.ts`, `tests/main/startApplication.test.ts`,
  `tests/main/main.test.ts`, and `tests/main/registerHealthIpc.test.ts` cover
  retry, deduplication, one-time cleanup, cancellation, startup/window failure,
  IPC reachability, and no late work.
- `tests/integration/foundationRecovery.test.ts` creates a directory collision
  at an isolated temporary database path. The first real SQLite open rejects
  and the collision remains; after the test removes only its own blocker, the
  same path reaches schema 1 with FTS5.
- `tests/e2e/foundation.spec.ts` performs the same failure/Retry proof in the
  packaged application and asserts the generic alert and safe error code before
  recovery.

The successful health payload still reports the database path, schema version,
FTS5 status, pending jobs, and interrupted-job recovery count. SQLite remains
main-process-only.

### 3. Fresh-checkout release order

- `README.md` now documents `npm run verify:e2e` before
  `npm run verify:package`. The first script packages before launching E2E, so
  the sequence is valid with no `out/` directory.
- `test/releaseDocumentation.test.mjs` locks both the documented order and the
  package-before-E2E script contract.

### 4. Supported lint/toolchain versions

- `package.json` and `package-lock.json` upgrade both
  `@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin` to 8.68.0,
  pin `@electron/fuses` 2.1.3, remove `@electron-forge/plugin-fuses`, and declare
  `engines.node >=22.12.0`.
- `README.md` documents that Node floor. `tsconfig.json` supplies the narrow
  type path needed by the repository's legacy TypeScript resolver for the
  exports-only fuse package.
- The newer lint rules exposed redundant unsafe declaration merging in
  `src/main/jobs/jobRepository.ts`; the duplicate interface declaration was
  removed without changing the exported class API or job behavior.
- Final lint output contains no unsupported-TypeScript warning.

### 5. Explicit packaged ATS denial

- `forge.config.ts` sets
  `NSAppTransportSecurity.NSAllowsArbitraryLoads: false` in packaged bundle
  metadata.
- `scripts/verifyPackage.mjs` requires the raw plist value to be `false`, and
  its tests reject `true`.
- Development renderer trust remains exactly `http://localhost:5173/`; the
  packaged renderer remains exactly under `callie://` trust.

## TDD evidence

Focused regression tests were introduced before their corresponding production
changes:

1. The fuse/configuration and verifier tests initially failed because there was
   no direct fuse hook, only six required states, no closed enumeration, no ATS
   rejection, and no final-signature check. After the direct hook/verifier work,
   the focused set passed 19 tests.
2. Runtime/startup tests initially failed against eager initialization: a failed
   migration quit before a renderer existed, Retry could not make a second open,
   and no coordinator existed to deduplicate or clean an in-flight attempt.
   The runtime/main/service/integration focused set then passed 24 tests.
3. The real isolated filesystem recovery test failed before lazy retry support
   and passed after it, proving that the blocker was not destructively changed.
4. Packaged E2E with the preferred snapshot fuse enabled produced two `SIGTRAP`
   exits. Inspecting the stock bundle established the missing browser snapshot;
   the deliberate disabled policy made both the healthy and retry E2E cases
   pass.
5. The documentation regression test now asserts both the README sequence and
   that `verify:e2e` is `npm run package && npm run test:e2e`.

The untouched baseline was 18 test files / 79 tests passing. The final suite is
22 files / 92 tests passing.

## Fresh verification evidence

Environment:

- Node `v25.9.0`; npm `11.12.1` (declared minimum Node is 22.12.0).
- Direct dependencies resolve to `@electron/fuses@2.1.3`,
  `@typescript-eslint/parser@8.68.0`, and
  `@typescript-eslint/eslint-plugin@8.68.0`; the Forge fuses plugin is absent.

Required clean gate:

- `npm ci` — exit 0; 930 packages installed; postinstall native rebuild passed.
- `npm run rebuild` — exit 0; `better-sqlite3` rebuild complete.
- `npm run verify` — exit 0; typecheck and lint clean; 21 files / 91 tests at
  this gate.

Fresh documented sequence:

- Existing `out/` was moved safely to
  `/tmp/callie-out-backup.88otK7/out`; `test ! -e out` passed.
- `npm ci` — exit 0, including postinstall rebuild.
- `npm run rebuild` — exit 0.
- `npm run verify` — exit 0; 21 files / 91 tests.
- `test ! -e out && npm run verify:e2e` — exit 0; packaging created `out/`
  and Playwright passed 2/2 in 18.0s. The retry case passed in 5.5s after
  rendering `LOCAL_DATABASE_UNAVAILABLE`, preserving its isolated blocker,
  removing only that blocker, clicking Retry, and reaching the same path with
  schema 1 and FTS5.
- `npm run verify:package` — exit 0 after an independent repackage. It reported
  a Darwin arm64 executable, a Darwin arm64 `better-sqlite3` bundle, valid
  metadata/resources, ATS false, exact fuses, and a valid deep signature.
- `npm run start` — Vite reported the exact local URL
  `http://localhost:5173/` and Forge reported `Launched Electron app`. The smoke
  process was then intentionally interrupted and no matching app/dev process
  remained.
- Final post-documentation `npm run verify` — exit 0; 22 files / 92 tests.
- `git diff --check` — exit 0.

Packaged ATS raw plist value:

```text
false
```

Packaged Electron 44 V1 fuse reader output:

```text
RunAsNode is Disabled
EnableCookieEncryption is Enabled
EnableNodeOptionsEnvironmentVariable is Disabled
EnableNodeCliInspectArguments is Disabled
EnableEmbeddedAsarIntegrityValidation is Enabled
OnlyLoadAppFromAsar is Enabled
LoadBrowserProcessSpecificV8Snapshot is Disabled
GrantFileProtocolExtraPrivileges is Disabled
WasmTrapHandlers is Enabled
```

## Audit and remaining concerns

`npm audit --json` reports 35 transitive findings: 3 low, 3 moderate, 26 high,
and 3 critical. That is one fewer than the broader 36-finding review count,
naturally resulting from the requested dependency changes/removal; no broad
audit remediation was attempted because it is outside this fix scope. `npm ci`
also reports existing transitive deprecation notices, and Vite reports harmless
Rollup annotation warnings from Zod during builds.

The stock Electron 44 browser snapshot limitation is documented and enforced as
an explicit disabled fuse; changing to a distribution that includes a compatible
browser snapshot should trigger a deliberate policy review. Distribution
signing and notarization remain future work; current unsigned Apple Silicon
artifacts receive a valid ad-hoc signature only.
