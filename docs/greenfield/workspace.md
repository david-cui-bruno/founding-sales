# The greenfield workspace

The greenfield tree is the whole repository: the previous-generation app was deleted
in lane g95 (`docs/greenfield/legacy.md`; the tag `legacy-final` holds it). The root
`package.json` is the npm workspace root.

```
apps/api          the API: health, request limits, redacted errors, scope wiring,
                  Google sign-in, sessions, commands, admin routes
apps/worker       skeleton worker: connects, checks its schema range, exits non-zero
apps/desktop      the Mac: Electron main, preload, renderer; sign-in, device,
                  serialised renewal, version gate, expiring encrypted cache
packages/domain   pure rules (src/rules) and database conventions (db/)
packages/contracts zod schemas for the foundation rows, reason codes, client versions
infra/            Terraform (G1 owns it)
```

## Install

```
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH"
npm ci --no-audit --no-fund
```

Since lane g89 the root `postinstall` only fetches the Electron binary
(`install-electron`, from the local cache when it is there), which
`npm run test:desktop:host` needs, and nothing else. The dependencies' own install scripts still run, and one of them is needed
locally: the PostgreSQL 16 binaries ship as real files but their version symlinks
(`libzstd.1.dylib` and friends) are created by `@embedded-postgres/darwin-arm64`'s
`postinstall`. Without it `postgres` fails with `Library not loaded`.

`npm install --ignore-scripts` still works, and is what CI runs; after it, run
`npm rebuild @embedded-postgres/darwin-arm64` for a local gate and
`node node_modules/electron/install.js` for the host tests.

CI does not need the rebuild: it uses a `postgres:16` service container instead.

## The gate

```
npm run gate:greenfield     # typecheck + lint + tests + the release suite, what CI runs
npm run typecheck:greenfield
npm run lint                # one ESLint flat config (eslint.config.mjs) over apps, packages, test/release and scripts
npm run test:greenfield
npm run test:desktop:e2e    # the window, in chromium; not part of the gate
```

`test:desktop:e2e` is separate because it needs a chromium binary that
`npx playwright install chromium` provides and no `npm` install fetches. See
`docs/archive/decisions/g2-desktop-test-layers.md`.

`npm run typecheck` is `typecheck:greenfield` and `npm test` is `test:greenfield` plus
`test:release`.

## The database harness

Tests run against a real PostgreSQL 16, never a mock or an in-memory substitute.

* One cluster per Vitest run, started by `packages/domain/db/testing/globalSetup.ts`.
  Locally that is `embedded-postgres` in a temporary directory that is removed on
  stop; in CI it is the service container named by `FSS_TEST_POSTGRES_URL`.
* One database per test file: `createTestDatabase()` creates it, applies the
  migrations, and hands back a superuser session. `drop()` removes it.
* `database.appRuntimeSession()` gives a session that has done `SET ROLE app_runtime`,
  so a privilege test is subject to the application role rather than the owner.
* `createTestDatabase({ throughVersion: n })` stops after migration `n`, which is how
  the compatibility test seeds a previous version.

Set `FSS_TEST_POSTGRES_VERBOSE=1` to see the server's own log.

To exercise the CI branch on this machine:

```
node packages/domain/scripts/serviceClusterCheck.mjs
```

It starts a cluster, hands its URL to the gate through `FSS_TEST_POSTGRES_URL`, and
stops it. Note the comment at the top of that file: the gate must be spawned
asynchronously, because a synchronous child blocks the event loop, the server's log
pipe fills, and the cluster freezes in a way that looks exactly like a deadlock.

## Two-workspace discipline

Every fixture that creates business rows creates two workspaces with colliding
external identifiers — the same command id, the same calling number, the same job
idempotency key, two users sharing a display email — and asserts nothing crosses. The
fixture is `packages/domain/test/db/support/fixtures.ts`; use it rather than writing a
single-workspace setup.

## Things that are deliberately absent

* No ORM. Repositories are written against the narrow `Queryable` interface in
  `packages/domain/db/queryable.ts`.
* No HTTP framework. `apps/api` uses `node:http`; see
  `docs/archive/decisions/g0-api-http-server.md`.
* No secret, key, token or real address anywhere in the tree. Test credentials are
  generated at run time; public identifiers only in configuration.
