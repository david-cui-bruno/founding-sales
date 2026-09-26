# G20: what a contract migration does to the declared schema ranges

**Date:** 22 September 2026. **Lane:** G20, migration 0015.

```
CURRENT_SCHEMA_VERSION         14  ->  15
PREVIOUS_RELEASE_SCHEMA_RANGE  { 1, 14 }   ->  { 1, 15 }
API_SCHEMA_RANGE               { 14, 14 }  ->  { 15, 15 }
WORKER_SCHEMA_RANGE            { 14, 14 }  ->  { 15, 15 }
```

Every migration in this tree so far has been expansion: a lane added a table or a
column, and the rule from `docs/archive/decisions/g10-worker-schema-minimum.md` settled the
minimum — *a binary declares the lowest version on which its first statement can
succeed, not the lowest it would like*. 0015 removes a column, and the rule does not
answer the question on its own.

## The API: the usual argument

`/templates/create` issues an INSERT that no longer names `footer_postal_address`. On
a version-14 database the column is `NOT NULL` with no default, so the statement fails
with `not_null_violation`. An API that accepted a template body and then had nowhere
to put it is the failure every earlier widening refused, so the minimum is 15.

## The worker: a choice, and why it went the way it did

The worker never writes `template_versions`. It reads it — `readTemplateVersion` in
`sequence.action`, and the `template-approval` eligibility source — and after this
release those SELECTs name only surviving columns. A worker's first statement would
therefore succeed on a version-14 database, and the letter of the rule gives
`{ 14, 15 }`.

It is `{ 15, 15 }` instead, and the reason is what a span *declares* rather than what
it permits. The ranges are what `infra/scripts/rehearsal-schema-ranges.sh` runs the
compatibility pairs from and what `verify-schema` gates a deploy on. A worker
declaring 14 would be declaring that the pre-contract database is a supported
deployment target for this image. It is not one: on a version-14 database the API of
this same release refuses to start, so the only environment that declaration admits
is half a deployment — a worker sending mail beside an API that will not answer.
`infra/scripts/release-deploy.sh` scales both services to zero, migrates, verifies and
scales back up precisely so that state cannot occur. A range that admits a state the
release procedure forbids is a promise nobody tests.

G9 left the worker behind at `{ 12, 13 }` and was right to: `workspace_settings` was a
table the worker never queried, so refusing a database it understood perfectly would
have been a refusal for no reason. `template_versions` is not that table. The worker
queries it, and the version of it the worker now queries is 15.

## The maxima, and Appendix G 22

Both maxima move to 15 on the same reasoning as every widening before: a binary that
refused the database it has just been deployed against would be a self-inflicted
outage.

The previous release's binaries declared `{ 14, 14 }`, so no pair overlaps.
`test/release/scenario22.check.ts` computes the overlap from the constants rather than
assuming one, and takes the refusal branch: the old images against the new schema are
`database_ahead_of_binary`, which is correct rather than conservative — their SELECT
lists name a column that is gone, and the old API's INSERT names one it must supply.

`PREVIOUS_RELEASE_SCHEMA_RANGE` widens to `{ 1, 15 }` in the same pull request, which
is what `packages/domain/test/db/migrations.test.ts` checks and what every lane since
G5 has done. That is honest only because nothing has been deployed; from the first
real deployment the widening must precede the migration by a release, and this is the
first migration in the tree where getting that order wrong would delete data rather
than merely refuse a start.
