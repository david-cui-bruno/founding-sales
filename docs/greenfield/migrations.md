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

**Two checkouts, and which one runs what.** `--base` names a checkout whose own
`REQUIRED_SCHEMA` is N — in CI a `git worktree` of *the commit production's images were
built from*. Migrations 1..N are applied **from its migration directory**, and the
fixture is written **by its domain code**, as a child process inside it. HEAD supplies
N+1..M and every post-upgrade check — the constraint cases, the startup acceptance, the
workflows — each of which also runs as a child process inside HEAD, never as an import
into the tool. So `--tree` really does test that tree's application code.

Both halves matter. HEAD's commands know schema M: they would insert into columns that do
not exist yet and quietly write whatever subset of the fixture the new code could still
manage, and every step after it would be green and vacuous. And HEAD's *files* for the
deployed range would record HEAD's checksums: a branch that edited an already applied
migration would pass here and be refused by production with
`MIGRATION_CHECKSUM_MISMATCH`. **The deployed range is therefore compared byte for byte
between the two checkouts before anything is created, and any difference fails the run**
— which is also the answer to "it only changed a comment": the runner hashes the file's
bytes.

The base checkout gets a `node_modules` link farm from HEAD's — third-party modules
shared, `@fss/*` repointed at the base tree — **only when the two `package-lock.json` are
byte-identical**. When they differ, `npm ci` is run in the base worktree instead, because
HEAD's third-party versions under the base's code could produce data the base image never
could. The report says which happened. A base commit older than this lane has HEAD's
`tools/upgrade/` copied in for the run and removed afterwards; nothing writes a tracked
file there.

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
6. data preservation, against the `-- changes:` headers above: per-table content
   hashes, the catalogue **shape** of every table (so a change to a table the fixture
   leaves empty is still caught), and every **view definition** (`pg_get_viewdef`) in
   every schema the application owns — derived from the catalogue, not a hard-coded
   `public`, so a view a later migration puts elsewhere is covered the moment it
   exists. A view carries no rows of its own, so neither the hashes nor the shapes can
   see one being replaced, and `effective_suppressions` is the view the suppression
   system answers "is this handle suppressed?" from. View keys are schema-qualified
   (`public.effective_suppressions`); a bare name in a `-- changes:` header covers the
   one in `public` and no other. A redefined view no migration names fails;
7. the privileges at M, against a **committed baseline** (`tools/upgrade/grants-baseline.json`,
   taken at schema 22: both group roles' table and column grants, `PUBLIC`, sequences,
   functions and the schema grants) **plus** the `GRANT`/`REVOKE` lines migrations
   N+1..M declare, each of which must be **declared in
   `tools/upgrade/access-exceptions.json`**. Four rules, none of which the old
   replay-from-nothing check could state:
   - a privilege the baseline had and the database no longer has is a loss and fails;
   - **every table new since the baseline must carry an explicit
     `GRANT … TO app_runtime`**, or be listed under `runtimeAccessNone` in
     `access-exceptions.json`, because a table with neither is a feature nobody can
     reach;
   - **a `GRANT` or `REVOKE` on a table the baseline already knew needs a declared
     delta** in the same file. A `REVOKE` inside a migration used to *become* the
     expectation, so a feature quietly losing access passed;
   - the effective privileges are checked through the runtime **login** with
     `has_table_privilege('fss_runtime', …)`, not only through the group, including
     that `audit_events` DELETE and `suppression_events` UPDATE are still refused it.

   Every entry in `access-exceptions.json` carries a `why` a human wrote, and a missing
   or blank one is refused on read. The point of the file is that it is not the
   migration: a migration that carries its own exemption — which is what the old
   `-- runtime-access: none` header was — reviews itself. That header form is gone.

   **The baseline and a migration may not change in the same pull request.**
   `grants-baseline.json` is what every comparison is against, so a change that edits
   both it and a migration can launder any access change past the check. Regenerate it
   with `grantsBaselineMain` in a **pull request of its own**, containing no migration,
   where the diff is the review — separate commits in the same branch are not enough,
   and the `upgrade` job compares the whole branch against `origin/main`, so it refuses
   them;
8. `packages/domain/test/db/constraints.test.ts` at M, run by Vitest as itself, so the
   coverage gate at the bottom of that file applies: a new constraint with no failing
   insert fails the upgrade test too;
9. startup, in **both** checkouts, each declaring its own range. HEAD's own
   `buildReadinessReport` and `checkWorkerStartup` must report ready, and the base
   checkout's own must refuse — that refusal is the previous images' own, not a generic
   comparison against an invented range. The worker's handler registry must be built the
   way its bootstrap builds it; a checkout that cannot is a failure, not a note;
10. the workflows, in HEAD, as `app_runtime`, each asserting something specific rather
    than not throwing. "Specific" is load-bearing: two of these used to pass over an
    empty set, which proves nothing (GPT-6 review of PR 314, P1-3).
    - Today built (at least five cards) and read for both users, with the fixture's own
      firm on **the lane it is supposed to be on**, not merely some lane. Two are
      pinned: the primary firm is `callback`, which is the *precedence* answer — it
      also has an open `new_firm` task — and the one firm the fixture never opens an
      opportunity for is `new_firm`, which is the single-source answer. Both are
      deterministic because the fixture's confirmed callback is at a fixed instant in
      the past; the constants say so.
    - the firm page with its zone and stage history; the pipeline board.
    - step eligibility for an active enrolment, which must reach one named decision and
      fails on a skip.
    - the provider-free half of the reconcile pass, which must return **the fixture's
      own owed fence by id**, and its mailbox. The fixture seeds one through the real
      commands (`prepareOutboundMessage` → `claimForDispatch` → `beginReconciling`,
      which leaves `reconcile_last_attempt_at` null so it is owed now). Zero fences or
      zero mailboxes is a failure, not a pass.
    - a job claimed → progress → completed with its fencing token and a stale token
      refused; a funnel fact; a contact deleted through the retention path, leaving a
      tombstone; the dashboard with its live sources.
    - **`effective_suppressions`**, read twice over — `isSuppressed` for the exact
      handle the fixture suppressed, and `listEffectiveSuppressions` for the set
      containing it — plus a handle nobody suppressed, which must come back absent. A
      replacement view that returns nothing fails here; nothing else in the tool could
      see it.

    A migration that replaced a routine must have had it **called** —
    `pg_stat_user_functions` counts it, and an uncalled replacement fails the step. The
    evidence prints one row per overload with its signature; the rule sums them by bare
    name, and **which overload the migration replaced is not attributed** — a name with
    two overloads passes when either was called;
11. recovery — the migrator run again at M is a no-op, and a synthetic migration whose
    second statement is invalid leaves the schema, every `schema_versions` row, the
    catalogue shape and a row written just before it exactly as they were. The snapshot
    that case compares against is taken immediately before the injection, not at step 4:
    step 4 is before the upgrade and before step 10, and step 10's workflows change rows
    on purpose.

`--migrations <dir>` and `--tree <path>` point the apply and the constraint cases at
another checkout, which — with `--base` — is how a migration can be tested before the
branch that carries it is merged.

**In CI, `FROM` is what production runs**, not what git history says. Two repository
variables hold it and the `upgrade` job of `greenfield.yml` fails closed on every
unreadable answer:

| variable | what it is | who moves it |
| --- | --- | --- |
| `FSS_PROD_COMMIT` | the full sha of the commit production's images were built from | **by hand, with the release helper.** CI cannot: `GITHUB_TOKEN` has no `variables` scope, so `permissions:` cannot grant Variables: write. `greenfield-deploy.yml`'s read-back job prints the value to set, attested **from ECR** after the rollout and the smoke, and fails if ECR names a commit other than the one deployed |
| `FSS_PROD_SCHEMA` | the schema version production is on | a schema release, by hand, in the step that migrates |

**The schema is attested from production itself.** A variable is what the release
process last recorded, not what is running, so before it reads either one the job
fetches production's public `GET /health` — no credential, the same origin the deploy
smoke uses — and takes `schema.databaseVersion` from it. `FSS_PROD_SCHEMA` must equal
that, and so must the `REQUIRED_SCHEMA` in `FSS_PROD_COMMIT`'s own `schemaRange.ts`.
An unreachable or malformed `/health` fails the job after three attempts: "cannot tell
what production runs" is never "nothing to check".

**The commit is not attestable from the gate job, and that is survivable.** `/health`
does not report the commit its image was built from (a follow-up will add it), so
`FSS_PROD_COMMIT` is cross-checked rather than proved: it must be a commit in this
repository, an ancestor of the branch *and* of `origin/main`, and declare the attested
schema. What a wrong-but-plausible value could cost is bounded by immutability — any
commit deployed at schema *N* has byte-identical migrations 1..*N* — so a lagging
variable degrades the *fixture*, which is written by that commit's application code,
and never the migration comparison. The job prints a warning naming the newest commit
on main still at that schema when the variable is behind it.

The job then checks out `FSS_PROD_COMMIT` as the base worktree and takes `FROM` from
that checkout's own `schemaRange.ts`; `TO` is HEAD's.

**Before any "nothing to do", the deployed files are compared.** Migrations 1..`FROM`
are compared between the two trees as a manifest of *name and blob id*, not as a diff:
`git diff --name-only` follows renames and prints only the post-image name, so renaming
`0022_a.sql` to `0023_b.sql` while leaving `REQUIRED_SCHEMA` alone printed one path
above the deployed schema, nothing to filter, and a green skip — while production, which
holds a sha256 for the applied `0022_a.sql`, would refuse the release with
`MIGRATION_CHECKSUM_MISMATCH`. The skip is allowed only when the manifests are
identical. An unset, non-numeric, zero, non-ancestral or disagreeing value fails the
job; none of them is a green skip. `test/ops/upgradeJobGuard.check.ts` runs the step's
own shell over throwaway repositories, the rename case included.

The printed evidence — the timings, the lock table and the recovery sentence — is
uploaded as `upgrade-evidence-<sha>.txt`, and `docs/greenfield/release.md` 3 says which
releases cite it instead of a rehearsal.

The job lives in `greenfield.yml` rather than a workflow of its own, so that the run a
release record names (`gateRunId`) is the run that holds the evidence, and so that a red
upgrade test makes the *Greenfield gate* run red — which is what stops `record.sh
from-ci` writing a record for that commit at all.

## What a migration's class means

`infra/scripts/classify-migration.sh <file>` prints one of six words and the statements
that decided it:

| class | what earns it |
| --- | --- |
| `additive` | every statement recognised, and every object it names is new — a `CREATE VIEW` of a name no earlier migration creates included |
| `replaces-routine` | `CREATE OR REPLACE FUNCTION`/`PROCEDURE`/`TRIGGER`, or `ALTER FUNCTION`, of a routine that already exists |
| `touches-existing` | `ALTER TABLE`, `CREATE INDEX`, `UPDATE`, `INSERT`, `DELETE … WHERE`, a `CREATE TRIGGER`, a default change, a `CHECK` added — on something that already exists. **`CREATE OR REPLACE VIEW` or `ALTER VIEW` of a view that already exists** is here too, and `REFRESH MATERIALIZED VIEW` with it |
| `privilege` | `GRANT`/`REVOKE`/`ALTER ROLE` touching an existing object or role |
| `destructive` | `DROP TABLE`/`COLUMN`/`CONSTRAINT`/`FUNCTION`/`TRIGGER`/`INDEX`, `TRUNCATE`, `DELETE` with no `WHERE` |
| `unclassified` | a top-level form the classifier does not recognise, or a `DO $$ … $$` block whose body it cannot fully classify |

**It fails closed.** Anything it does not recognise is `unclassified`, and the worst
class any statement earns is the file's. That matters because a `DO $$ BEGIN DELETE FROM
sessions; END $$` used to be called `additive` — `sessions` has no fixture rows, so the
content hash never moved, and the release procedure would have said no rehearsal was
needed. A `DO` block whose body does parse is classified by its contents, so that example
now reports `destructive` and names the `DELETE`.

**Why a replaced view rehearses and a replaced routine does not.** `replaces-routine`
releases without a rehearsal because the upgrade test *proves the new body ran*:
`track_functions` is on and `pg_stat_user_functions` counts the call during the workflow
step, so a replacement nothing exercised fails. There is no equivalent proof for a view.
A view is not called, it is selected from, and the server keeps no per-view read counter,
so a replacement returning an empty set is indistinguishable from one nobody queried.
`effective_suppressions` is the view the suppression system answers "is this handle
suppressed?" from; until there is such a proof, a replaced view rehearses.

"Existing" is the set of tables, views and routines the earlier migrations in the same
directory create and do not drop — not a guess from a name — and a statement inside a
function body is not a statement the migration performs. `release.md` 3 rehearses
`touches-existing`, `privilege`, `destructive` and `unclassified`, and does not rehearse
`additive` or `replaces-routine`.

**One narrowing, and only one.** A `DROP CONSTRAINT x` whose `x` the same file adds back
on the same table is a *swap*, and a swap loses no data: it is how a `CHECK` is widened
while keeping the name its failing-insert case is written against. Migration 0014 says so
in its own comment — "The constraint keeps its name, so its failing-insert case in
`test/db/constraints.test.ts` keeps covering it" — and 0020 does the same inside a single
`ALTER`. Both forms read as `touches-existing`, which still rehearses. A `DROP CONSTRAINT`
with no matching `ADD`, or one that drops two and puts back one, stays `destructive`.

**The class of a migration that has already been applied is informational.** The
classifier decides whether a release needs a rehearsal, and a release of applied history
is not a thing. So a conservative answer on an old file costs nothing, and several of
them get one: 0001, 0004, 0007 and 0014 come out `unclassified`, because each ends in a
bare `SELECT seed_…(…)` or a `DO` block with an `EXCEPTION` clause whose effect the
classifier cannot read. That is the fail-closed answer working as intended, not a finding
about those migrations.

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
