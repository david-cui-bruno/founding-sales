# The greenfield workspace

The new tree lives beside the old one in the same repository. The root
`package.json` is the npm workspace root; the old trees (`src/`, `client/`, `cloud/`,
`tests/`, `native/`) are untouched and keep their own gate.

```
apps/api          skeleton API: health, request limits, redacted errors, scope wiring
apps/worker       skeleton worker: connects, checks its schema range, exits non-zero
packages/domain   pure rules (src/rules) and database conventions (db/)
packages/contracts zod schemas for the foundation rows, reason codes, client versions
infra/            Terraform (G1 owns it)
```

## Install

```
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH"
npm install --ignore-scripts --no-audit --no-fund
npm rebuild @embedded-postgres/darwin-arm64
```

`--ignore-scripts` skips the old tree's `postinstall`, which downloads Electron and
builds two native modules that nothing in the greenfield tree uses. The `npm rebuild`
line runs one install script that *is* needed locally: the PostgreSQL 16 binaries ship
as real files but their version symlinks (`libzstd.1.dylib` and friends) are created by
that package's `postinstall`. Without it `postgres` fails with `Library not loaded`.

CI does not need the rebuild: it uses a `postgres:16` service container instead.

## The gate

```
npm run gate:greenfield     # typecheck + lint + tests, all four packages
npm run typecheck:greenfield
npm run lint:greenfield
npm run test:greenfield
```

The old gate (`npm run typecheck`, `npm test`, `npm run lint`, `npm run lint:tracked`)
excludes `apps/` and `packages/` and behaves exactly as it did before.

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
  `packages/domain/db/queryable.ts`, and every scoped statement is built by
  `scopedQueries.ts`, which supplies `workspace_id` from the scope.
* No HTTP framework. `apps/api` uses `node:http`; see
  `docs/decisions/g0-api-http-server.md`.
* No secret, key, token or real address anywhere in the tree. Test credentials are
  generated at run time; public identifiers only in configuration.
