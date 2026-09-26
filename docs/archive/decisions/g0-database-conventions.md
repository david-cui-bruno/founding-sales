# G0: database conventions the specification left open

## Where the conventions live

`packages/domain/db/`, not `apps/api/db/`. The brief offered both; the worker's startup
check and the API's health route already share `schemaRange.ts`, and every later slice
has business logic in both processes, so a package was the only answer that does not
end in one service importing the other.

## Roles are named `app_runtime` and `migration`

Exactly the brief's names, unprefixed. They are cluster-wide objects, created
idempotently by migration 0001.

The creation is wrapped in per-role subtransactions that catch `duplicate_object`
**and** `unique_violation`. `IF NOT EXISTS (SELECT 1 FROM pg_roles …)` is a
check-then-create race, and the loser's `CREATE ROLE` reports a unique violation on
`pg_authid`, not a duplicate object. This was not theoretical: one database per test
file means several migrations reach that block within the same millisecond, and the
first full-suite run failed there.

## Append-only is a privilege, not a convention

`audit_events` and `suppression_events` grant `SELECT, INSERT` and have `UPDATE`,
`DELETE` and `TRUNCATE` revoked from both `app_runtime` and `migration`. The tests
connect and `SET ROLE app_runtime`, which drops the superuser bypass, so the refusals
in `test/db/privileges.test.ts` are the refusals production would give.

`hold_reason_codes` is read-only for `app_runtime`: the vocabulary is a release
artefact, not runtime data.

## Closed sets: reference table, not a PostgreSQL enum

The reason codes of specification section 15 live in a seeded `hold_reason_codes`
table with a foreign key from `active_holds` and `administrative_pauses`. A PostgreSQL
`ENUM` would have forced an `ALTER TYPE` into every migration that adds a code, and
`ALTER TYPE … ADD VALUE` cannot run inside a transaction block before PostgreSQL 12's
relaxation in all the cases we need.

Smaller closed sets (`role`, `status`, `state`, `scope_kind`, …) are `CHECK (… IN
(…))`, which is visible in the table definition and testable by a failing insert.

A test compares the seeded table with the `@fss/contracts` enum row for row, including
the `recoverable` flag, so the two cannot drift.

## Time-zone names are shape-checked in SQL, validated in the domain

`CHECK (business_time_zone ~ '^[A-Za-z]…')` is the most a `CHECK` constraint can do: a
real IANA lookup reads a catalog and is not immutable, so PostgreSQL cannot use it in
a constraint honestly. `isKnownTimeZone` in `@fss/domain` asks `Intl`, and that is
where a zone is actually validated.

## Composite keys everywhere a child will reference a parent

Every workspace-scoped table has `PRIMARY KEY (workspace_id, id)` or an equivalent
composite unique key, and every foreign key between scoped tables uses the composite.
A cross-workspace foreign key is refused by the database, not by a repository check —
`test/db/workspaceScope.test.ts` proves it with a real refused insert.

`calling_identities.owner_user_id` is deliberately nullable with a `MATCH SIMPLE`
composite foreign key, so a null-owner row skips the check entirely. That is what
reserves the future shared line without pointing it at a membership that does not
exist; a second `CHECK` keeps such a row permanently disabled.

## `system_generations` carries no `workspace_id`

Specification section 6 says "every business table carries `workspace_id`". The system
generation is not a business table: a restore replaces the whole database, and the
generation is what tells a service it is looking at restored data. `schema_versions`
and `hold_reason_codes` are unscoped for the same reason, and `heartbeats` is scoped
only for the `mailbox` component, enforced by a pair of checks.

## Device secrets

`devices.secret_hash` has `CHECK (secret_hash ~ '^[0-9a-f]{64}$')`. A plaintext secret
written there by mistake is refused by the database. The plaintext lives in the macOS
Keychain and nowhere else.
