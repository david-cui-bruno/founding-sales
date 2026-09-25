# Migrations: expand, migrate, contract

Specification revision 3, sections 4.2 and 16.1. This is the rule every greenfield
migration follows. It exists because production and the binaries that talk to it are
never updated at the same instant: under a rolling deployment an old API and a new
worker run side by side, and a restore can put the database behind both.

## The shape of a migration

* One SQL file per pull request, in `packages/domain/db/migrations/`, named
  `NNNN_snake_case.sql` with a contiguous four-digit prefix.
* Forward only. There is no down migration. A mistake is repaired by a later
  migration, never by reversing an applied one.
* Immutable once applied anywhere. The runner records a sha256 of the file's bytes in
  `schema_versions`; changing an applied file fails with `MIGRATION_CHECKSUM_MISMATCH`
  rather than silently diverging from production.
* Applied by `applyMigrations`, which holds `pg_advisory_lock` on a stable,
  version-independent key for the whole run and commits each file in its own
  transaction. Two deployments overlapping serialize on that key.
* Seeded rows carry a named constant instant, never `now()`. A migration must produce
  the same rows at 23:59 UTC as it does at 09:00; the only thing that records the real
  migration time is `schema_versions.applied_at`.

## The three phases

**Expand.** Add the new column, table, index or constraint in a form the *currently
deployed* binaries already accept. Additive only: a new column is nullable or has a
default, a new table is unreferenced, a new constraint is `NOT VALID` until the data
is known to satisfy it.

**Migrate.** Backfill the data and enable the behaviour. The backfill is a job or a
migration of its own, and the new behaviour is only switched on once the backfill has
been proved complete.

**Contract.** In a *later release*, after every binary that read the old shape is
gone, drop the old column or constraint. Never in the same release as the code that
stopped using it.

## Schema ranges

Both services declare the range of schema versions they accept, in
`packages/domain/db/schemaRange.ts`:

* `API_SCHEMA_RANGE` and `WORKER_SCHEMA_RANGE` — what this source tree accepts.
* `PREVIOUS_RELEASE_SCHEMA_RANGE` — what the release before this one declared.

The deployment order is: widen the range, ship that release, then ship the migration.
So `PREVIOUS_RELEASE_SCHEMA_RANGE.maximum` must already cover the version the next
migration produces.

Where the ranges do not overlap, and from migration 0006 every declared range is a
strict `{N,N}`, there is no rolling path and the order is stop, apply, deploy:
`infra/scripts/release-stop.sh` scales both services to zero **before** the apply that
registers the new task definitions, the apply replaces them and starts nothing, and
`infra/scripts/release-deploy.sh --schema-change` refuses unless both are still at zero,
migrates, verifies and starts the worker and then the API (`docs/greenfield/release.md`
4.1 and 8.0af). The worker exits non-zero when the database is outside its range
(`WORKER_EXIT_CODES.schemaOutOfRange`) rather than writing rows another binary cannot
read; the API reports `degraded` on `/health` with the reason.

## The compatibility test

`packages/domain/test/db/migrations.test.ts` runs every migration against two
databases on a real PostgreSQL 16:

1. **(a) an empty database** — the fresh case. Every table, constraint, index, trigger
   and seeded row is asserted afterwards.
2. **(b) a database seeded at the previous version with data** — created with
   `createTestDatabase({ throughVersion: previous })`, given rows, then migrated the
   rest of the way. This is the case that catches a migration which is only correct on
   an empty table.

It then asserts that `PREVIOUS_RELEASE_SCHEMA_RANGE` still accepts the resulting
version. That assertion is the gate: adding migration `NNNN` without having widened
the previous release's range first fails the build.

## Adding a migration: the checklist

1. Write `NNNN_description.sql`. Additive only.
2. If a service needs the new shape, raise `CURRENT_SCHEMA_VERSION` and both service
   ranges — and confirm `PREVIOUS_RELEASE_SCHEMA_RANGE` was widened one release ago.
3. Add a failing-insert case in `test/db/constraints.test.ts` for **every** new
   constraint. The coverage test at the bottom of that file asks the catalog for the
   enforced set and fails when one has no case, so this is not optional.
4. If the table is workspace-scoped, add its unique lookup keys to
   `FOUNDATION_LOOKUP_KEYS`. Every key begins with `workspace_id`, and
   `test/db/workspaceScope.test.ts` checks each declared key against a real unique
   index.
5. Grant privileges explicitly. `GRANT … ON ALL TABLES` in migration 0001 covers only
   the tables that existed then; a new table needs its own grant, and an append-only
   table needs its own `REVOKE UPDATE, DELETE, TRUNCATE`.
6. Run `npm run gate:greenfield`.
