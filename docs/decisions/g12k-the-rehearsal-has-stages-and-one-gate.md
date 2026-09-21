# The rehearsal has stages, and one of them is the gate

**Lane:** G12k · **Spec:** 16.2, Appendix G 22, 39, 42 · **Date:** 21 September 2026

## What happened

Three credentialed rehearsals on 21 September, three errors, one per run:

1. Actions 35548888865 — the rehearsal's own guard refused the rehearsal's
   production-inventory read (`docs/decisions/g12f-…`).
2. Actions 35602423640 — the apply named six of the root's eight required variables
   (`docs/decisions/g12i-…`).
3. Actions 35611374218 — `terraform plan` failed twice over: the Google provider had no
   credential in CI, and `count = var.kms_key_arn == null ? 1 : 0` depends on a value
   unknown until apply (`release.md` 8.0c; G12j fixes both).

Each of the three is a fact about this repository rather than about AWS, each was
invisible to every offline layer, and each cost about an hour of David's attention —
because the workflow had exactly one credentialed mode: the whole thirteen-step gate.
Finding one error per hour is not a rate at which a first release happens.

David decided on 21 September: the rehearsal gains stages, production stays a local
apply a person reads, and only the full stage is a release gate.

## Decision 1 — four stages, nested, defaulting to the cheapest

`stage` is a `workflow_dispatch` choice: `plan` (default), `create`, `deploy`, `full`.
Each runs everything the one before it runs and then its own steps. The nesting is the
point — a `deploy` that skipped something `create` does would be deploying to an
environment nobody created — so it is a property the release suite reads rather than a
convention a reviewer keeps. `test/release/support/releaseWorkflow.ts` turns each step's
`if:` into the set of stages that admit it; scenario 39 requires every such set to be a
*suffix* of `[plan, create, deploy, full]` and every stage to run strictly more steps
than the one before it, so a `create` identical to `plan` is a failure rather than a
tautology.

Two grammars are allowed and no others: `inputs.stage == 'full'` and
`contains(fromJSON('["deploy","full"]'), inputs.stage)`. A condition in any other shape
makes the reader throw, because the permissive reading of an unrecognised condition is
"every stage", and a mistake that reads as "every stage" is the one this check exists to
catch.

The default is `plan`. The expensive run is then always something a person chose.

## Decision 2 — only `full` writes a release record, by the step's own condition

`if: inputs.stage == 'full'` on the release-record step, and nothing else. 16.2 makes
the record the thing an admin points at when enabling sending, so a cheap discovery run
must be unable to produce one — not unlikely to, unable. Scenario 42 asserts the exact
condition, asserts the step is absent from the step list of each of the other three
stages, and keeps the existing assertion that the record is written after the teardown
and the post-run guard. A mutation drops the condition and requires the suite to go red.

The apply's condition carries the same weight from the other side: a `plan` run that
applied would have something to record. A second mutation drops that one.

## Decision 3 — the teardown and the production-prefix guard carry no stage condition

They keep `if: always()`, unchanged. The temptation is to skip the teardown for a stage
that creates nothing, and it is wrong: those two steps are what protects against a stage
condition being *wrong*, so they must not depend on one. If the apply's condition were
mistyped, a `plan` run would create an environment, and the step that destroys it would
have been skipped by the same typo. The teardown is tolerant of a run that created
nothing — it reports `destroyed=nothing_created` — so the cost of running it on a `plan`
is seconds, and the cost of not running it is an environment standing at hourly cost
holding prospect-shaped data. The step that writes `run.auto.tfvars.json` runs in every
stage for the same reason: a teardown that cannot read its variables refuses (G12i).

## Decision 4 — the apply applies the plan the plan stage summarised

The create step is now four steps: write the variables, initialise the backend,
`terraform plan -out`, and `terraform apply <that file>`. The `-var` list lives on the
plan and the apply passes none of its own. Two consequences, both wanted: the variable
list is exercised in *every* stage rather than only in the expensive one (which is
exactly what the second credentialed run died of), and the summary a `plan` run
published cannot describe an apply different from the one that happens.

## Decision 5 — a plan run publishes addresses and counts, never values

`terraform plan`'s own output is values: both image references, the certificate ARN, the
hostname, and every attribute Terraform can already resolve. Four of those are assembled
from repository secrets, the job summary is published, and the reports artifact is kept
for ninety days. So:

1. the plan's stdout goes to a file in `$RUNNER_TEMP`, which the artifact does not
   include; its diagnostics are on stderr and still reach the log, which is what the
   stage exists to show, and on a failure the tail of the file follows them;
2. the summary is built from `terraform show -json` reading each change's `address` and
   `change.actions` and nothing else — never `before`, `after`, `after_unknown`,
   `after_sensitive`, `variables` or `configuration`;
3. a second program refuses to publish the summary if any value of a secret-backed
   variable appears in it, whole or as either half of an `<repository>@<digest>` pair,
   and refuses just as loudly if `run.auto.tfvars.json` has stopped naming those four —
   a guard with nothing to look for is a failure, not a pass.

Both programs live in the workflow and are lifted out of it and *run* by scenario 39,
against a summary that leaks a hostname, one that leaks half an image reference, one
that leaks nothing, and a variables file that has stopped naming what it checks. A third
mutation breaks the guard's comparison and requires the suite to go red.

GitHub's log masking is not the mechanism here. It covers secrets in logs, it is
best-effort, and it says nothing about a file kept for ninety days.

## What this does not weaken

Nothing about `full`. It runs the same steps in the same order as before this lane, with
the single difference that its apply consumes a saved plan. The gate is still the whole
of section 3, the record is still written last, still only for a green suite, and still
refuses a production name in any argument. What changed is that the three cheaper ways
of *failing before the gate* are now runnable on their own.

## What this cost

Two things a reader should know. A `plan` stage costs a state-lock acquisition and a
refresh against an empty state, which is why it needs the same identity check and the
same teardown as any other stage. And the numbered list in `release.md` section 3 is now
tagged by stage, which means a lane adding a step to that workflow has to decide which
stage it belongs to — the suffix check will refuse a step that belongs to none.

## Open, for the coordinator

`rehearsal-schema-ranges.sh` is in `full` rather than in `deploy`, because David's brief
lists the deploy stage as the two database entries, `release-deploy.sh` and the smoke.
It is an assertion about a deployment rather than part of making one, and it launches
one-off ECS tasks that only a deployed environment can answer — so a `deploy` run does
not exercise it. If the first `deploy` stage passes and the first `full` then fails
inside that script, moving it into `deploy` is a one-line change and this paragraph is
the reason it was not made now.
