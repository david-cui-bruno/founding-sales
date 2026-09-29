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
* A `-- changes:` header line names every table the file changes that already existed.
  `-- changes: none` is the explicit form of "this file touches nothing that is
  already there", and a file with no line at all is read as `none`. The line is a
  comment, so it costs the database nothing and travels with the file's checksum.

## The `-- changes:` header, and what checks it

```sql
-- 0024_example.sql — one sentence about what this is for
--
-- changes: contacts, outbound_messages
```

The upgrade test (below) snapshots every table's row count and an order-independent
content hash before the apply and again after it, and **fails on any table whose count
or hash moved and which no migration in the range named**. New tables may appear; that
is what `additive` means. The header is therefore not documentation: it is the list of
exceptions, and a backfill that rewrites a column nobody declared is a failed build
rather than a surprise in production.

Two things follow from the hash being the whole row cast to text. Adding a column with
a default changes the hash of every row in that table, so an `ALTER TABLE … ADD COLUMN
… DEFAULT` has to name its table. And `schema_versions` is left out of the comparison
entirely: appending a row to it is what an upgrade *is*.

## The automated upgrade test

`npm run upgrade:test -- --from N --to M --base <checkout>` replaces the schema
rehearsal (David, 29 September 2026: *"The reported 48-minute rehearsal starts from an
empty database, so it does not test the actual upgrade."*). It runs against the same
cluster the gate uses, makes no cloud call, and needs no credential.

**Two checkouts, and which one runs what.** The fixture is the data production already
holds, so it is written by the code production is already running: `--base` names a
checkout whose own `REQUIRED_SCHEMA` is N — in CI a `git worktree` of the base commit —
and the loader runs as a child process inside it, against that commit's
`packages/domain`. HEAD's commands know schema M: they would insert into columns that do
not exist yet and quietly write whatever subset of the fixture the new code could still
manage, and every step after it would be green and vacuous. HEAD then applies N+1..M and
runs everything from step 6 on. The base checkout gets a `node_modules` link farm from
HEAD's — third-party modules shared, `@fss/*` repointed at the base tree — rather than a
second `npm ci`, and a base commit older than this lane has HEAD's `tools/upgrade/`
copied in for the run and removed afterwards. Nothing writes a tracked file there.

**A skipped fixture part fails the run.** The loader reports every part as `loaded` or
`skipped` with the objects it found missing, and a skip is only excused when everything
missing is one of `sessions`, `oidc_authorization_requests`, `command_receipts`,
`deletion_requests`, `departures`, `retention_runs` — written by the API's sign-in path,
or only by the workflows in step 10. Anything else fails with the part's name and reason,
so "almost nothing loaded" cannot pass quietly.

Eleven steps, each printing its wall-clock seconds:

1. a fresh database owned by a non-superuser migrator login role, as the RDS master is;
2. migrations 1..N applied as that role, then `fss admin database-users ensure` — the
   order a release runs them in, because 0001 is what creates the `app_runtime` and
   `migration` group roles the command needs;
3. a representative fixture loaded **as `app_runtime`**, through the ordinary commands,
   by the base checkout's own code;
4. a snapshot: per-table row counts and content hashes;
5. migrations N+1..M applied as the migration role, with `pg_locks` and
   `pg_stat_activity` sampled every 100 ms in a second connection — the printed table
   names every relation locked, the strongest mode taken and the longest
   `ACCESS EXCLUSIVE` held;
6. data preservation, against the `-- changes:` headers above;
7. the privileges `app_runtime` and `migration` hold at M, against the `GRANT` and
   `REVOKE` lines the migration files declare — replayed in order, `GRANT … ON ALL
   TABLES` included, and compared with `information_schema.role_table_grants`. A new
   table with no grant fails here;
8. `packages/domain/test/db/constraints.test.ts` at M, run by Vitest as itself, so the
   coverage gate at the bottom of that file applies: a new constraint with no failing
   insert fails the upgrade test too;
9. startup — the API's `buildReadinessReport` and the worker's `checkWorkerStartup`,
   with the range `{M,M}` (accepts) and `{N,N}` (refuses), plus the worker's handler
   registry;
10. the workflows, as `app_runtime`: Today built and read for both users, the firm page,
    the pipeline, step eligibility for an active enrollment, the provider-free half of
    the reconcile pass, a job claimed → progress → completed with its fencing token, a
    funnel fact, a contact deleted through the retention path, and the dashboard;
11. recovery — the migrator run again at M is a no-op, and a synthetic migration whose
    second statement is invalid leaves the schema and the step-4 snapshot untouched.

`--migrations <dir>` and `--tree <path>` point the apply and the constraint cases at
another checkout, which — with `--base` — is how a migration can be tested before the
branch that carries it is merged.

**In CI** the `upgrade` job of `greenfield.yml` runs it whenever the diff against the
base commit touches `packages/domain/db/migrations/**` or `schemaRange.ts`. `FROM` is
`REQUIRED_SCHEMA` read out of the *base commit's own copy* of `schemaRange.ts`
(`git show <sha>:…`), `TO` is HEAD's; when they are equal the job prints why and passes
without doing anything. The printed evidence — the timings, the lock table and the
recovery sentence — is uploaded as `upgrade-evidence-<sha>.txt`, and
`docs/greenfield/release.md` 3 says which releases cite it instead of a rehearsal.

The job lives in `greenfield.yml` rather than a workflow of its own, so that the run a
release record names (`gateRunId`) is the run that holds the evidence, and so that a red
upgrade test makes the *Greenfield gate* run red — which is what stops `record.sh
from-ci` writing a record for that commit at all.

## What a migration's class means

`infra/scripts/classify-migration.sh <file>` prints `additive`, `touches-existing`,
`privilege` or `destructive` and the statements that decided it. "Existing" is the set
of tables the earlier migrations in the same directory create and do not drop — not a
guess from a name — and a statement inside a `CREATE OR REPLACE FUNCTION` body is not a
statement the migration performs. `release.md` 3 rehearses the last three and does not
rehearse the first.

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

* `API_SCHEMA_RANGE` and `WORKER_SCHEMA_RANGE` — what this source tree accepts. Both are
  `{REQUIRED_SCHEMA, REQUIRED_SCHEMA}`, so a release moves the schema by changing
  `REQUIRED_SCHEMA` and nothing else in that file.
* `PREVIOUS_RELEASE_SCHEMA_RANGE` — `{1, REQUIRED_SCHEMA}`, the overlap *input* of the
  rehearsal's `rehearsal.sh ranges` step (Appendix G 22). It is not what the previous
  release's images accept: those declare the schema before this one and refuse this one.

From migration 0006 every declared range is a strict `{N,N}`, so no two ranges overlap,
there is never a rolling path across a migration, and the order is stop, apply, deploy:
`infra/scripts/stop.sh` scales both services to zero **before** the apply that
registers the new task definitions, the apply replaces them and starts nothing, and
`infra/scripts/deploy.sh release --schema-change` refuses unless both are still at zero,
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

It then holds the two service ranges to `{CURRENT_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION}`
and asserts that the previous release's images — the range `{previous, previous}` — accept
the seeded database before the migration and refuse it after. That assertion is the gate:
adding migration `NNNN` without raising `REQUIRED_SCHEMA` fails the build, and so does
raising it without the migration.

## Adding a migration: the checklist

1. Write `NNNN_description.sql`. Additive only.
2. If a service needs the new shape, raise `REQUIRED_SCHEMA` in
   `packages/domain/db/schemaRange.ts`. Every range in that file derives from it, so
   there is nothing else to change there.
3. Add a failing-insert case in `packages/domain/test/db/constraints.test.ts` for **every** new
   constraint. The coverage test at the bottom of that file asks the catalog for the
   enforced set and fails when one has no case, so this is not optional.
4. Grant privileges explicitly. `GRANT … ON ALL TABLES` in migration 0001 covers only
   the tables that existed then; a new table needs its own grant, and an append-only
   table needs its own `REVOKE UPDATE, DELETE, TRUNCATE`. Step 7 of the upgrade test
   is what catches a table that has none.
5. Write the `-- changes:` header. `none` when the file only creates new objects.
6. Run `infra/scripts/classify-migration.sh` on it and read the deciding statements.
7. Run `npm run gate:greenfield`, and `npm run upgrade:test -- --from <previous> --to
   <this one>`.
