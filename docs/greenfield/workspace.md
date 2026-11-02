# The greenfield workspace

The root `package.json` owns the npm workspace. The web app is the product under [ADR0027](../adr/0027-web-product.md).

- `apps/web`: browser selling journeys, signed session gateway and private command custody.
- `apps/api`: authenticated requests, commands, webhooks and current domain authority.
- `apps/worker`: registered research, mail and other bounded background jobs.
- `packages/domain` / `packages/contracts`: business rules, PostgreSQL lifecycle and shared wire schemas.
- `infra`: existing hosted release and Terraform resources.

## Install and checks

Use Node24 and `npm ci --no-audit --no-fund`. Dependency install scripts hydrate the pinned embedded PostgreSQL native links locally. With `--ignore-scripts`, rebuild the local `@embedded-postgres/darwin-arm64` package before database checks; CI hydrates its pinned Linux equivalent for owned lifecycle checks and uses its service container for normal tests.

The root typecheck/lint/test commands cover the remaining workspaces. CI selects actual API/web consumers and always retains operations controls; main runs broad regression. `npm run test:web:e2e` is the signed browser harness, separate from ordinary mounted tests. Use changed-path checks from the [verification guide](../features/verification.md), existing fictional fixtures and exact owned cleanup. Real provider/audio/usefulness remains separate.

## The database harness

Tests run against a real PostgreSQL 16, never a mock or an in-memory substitute.

* One cluster per Vitest run, started by `packages/domain/db/testing/globalSetup.ts`.
  Locally that is `embedded-postgres` in a temporary directory that is removed on
  stop; in CI it is the service container named by `FSS_TEST_POSTGRES_URL`. Either
  way it runs with `fsync`, `synchronous_commit` and `full_page_writes` off: it lives
  for one run.
* globalSetup applies the migrations once, to a template database. A failing
  migration fails the run there.
* One database per test file: `createTestDatabase()` copies the template
  (`CREATE DATABASE … TEMPLATE …`) and hands back a superuser session. `drop()`
  removes it.
* `database.appRuntimeSession()` gives a session that has done `SET ROLE app_runtime`,
  so a privilege test is subject to the application role rather than the owner.
* `createTestDatabase({ throughVersion: n })` is not a copy: it starts empty and stops
  after migration `n`, which is how the compatibility test seeds a previous version.

* Every test database is pinned to `timezone=UTC` (`ALTER DATABASE … SET timezone`),
  because CI's container is UTC and a local cluster otherwise inherits the machine's
  zone. Constraints such as `crm_mail_imports`' `to_at-from_at=interval '90 days'`
  hold only when no DST shift falls inside the window; in a DST zone, within 90 days
  after a clock change, every fixture inserting `now()-interval '90 days'` was refused
  as `crm_mail_imports_check`. Do not work around such failures with `TZ=UTC` per run.
* `test/sourcing/prospectPhoneRefusalOriginal.pg.test.ts` is grant-gated. A local run
  without `FSS_PHONE_REFUSAL_ORIGINAL_PG_GRANT=retained-only` reports its cases as
  skipped (a bare `CI=true`, which agent shells export, is not hosted authority); hosted
  GitHub Actions without the canonical service authority still fails. To run them,
  from `packages/domain`:
  `FSS_PHONE_REFUSAL_ORIGINAL_PG_GRANT=retained-only npx vitest run --config vitest.phoneRefusalOriginal.pg.config.ts`.

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
