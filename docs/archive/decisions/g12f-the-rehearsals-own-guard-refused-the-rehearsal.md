# The rehearsal's own guard refused the rehearsal

**Lane:** G12f · **Spec:** 16.2, Appendix E, Appendix G 11, 20, 39, 42 · **Date:** 21 September 2026

The first credentialed rehearsal (Actions run 35548888865, commit 68cee601) authenticated,
named its principal correctly, and then refused itself:

```
FAIL: a rehearsal command names a production resource: Key=Name,Values=fss-prod*
```

That string is the production-inventory read the rehearsal makes *on purpose*
(`docs/greenfield/release.md` 3, step 3): Appendix G 39's last clause — "rehearsal
teardown cannot address production resources" — is measured rather than asserted, by
comparing the production inventory before and after the run. A comparison needs a read,
and a read of production names production. `rehearsal_refuse_production_arguments`
refuses every argument that names production. The two rules are both right and they
collided.

Because creation never ran, the teardown then failed at its first step with `DBInstance
fss-rh-202609210049-pg-restored not found`, which stopped it before it reached the
object-locked bucket and the root; and the post-run guard repeated the inventory
refusal. No release record was written, which is correct and is the only part of the run
that behaved as designed.

## Decision 1 — the exemption is a function, not a string

The cheap fix is to allow the substring. It is wrong twice over: a substring exception
lets `rds delete-db-instance --db-instance-identifier fss-prod-pg` through if it happens
to carry the same filter, and a test asserting "the guard has an exception" passes
against a guard that has stopped refusing anything at all.

So the exemption is structural. `rehearsal_read_production_inventory` in
`infra/scripts/rehearsal-common.sh` is the only caller allowed to name production, and:

1. it takes the service and operation it is about to run and checks them against
   `REHEARSAL_INVENTORY_READ_ONLY` (`resourcegroupstaggingapi:get-resources`, and nothing
   else), so the read-only constraint is a test over a value rather than a property of
   one literal nobody varies — `rehearsal_read_production_inventory rds
   delete-db-instance` is refused from inside the exemption;
2. it builds the production filter itself and refuses any further argument, so no caller
   can push a name through it;
3. `rehearsal_aws`, `rehearsal_terraform` and `rehearsal_refuse_production_arguments` are
   otherwise untouched: every other command naming `fss-prod`, mutating or not, is still
   refused.

Paging stays the CLI's. If a second read-only verb is ever needed it goes in that one
constant and nowhere else.

**A defect found on the way.** `rehearsal_aws` called
`rehearsal_refuse_production_arguments "$@"` and ignored the result, relying on `set -e`
to stop the script. Under errexit that works; inside an `if`, a `&&` chain or a command
substitution it does not, and the wrapper printed `FAIL: …` and then planned the command
anyway. Both wrappers now `|| return 1`. A refusal that returns 0 is a refusal only while
the caller happens to be arranged correctly.

## Decision 2 — absence is the AWS error code, and nothing else

Every teardown step now goes through `rehearsal_tolerate_absent`, which succeeds when the
command succeeded *or* when it failed with one of a named list of AWS absence codes —
matched as the CLI prints them, in parentheses: `(DBInstanceNotFound)`, `(NoSuchBucket)`,
`(DBSnapshotNotFound)`, and so on. An `AccessDenied`, a throttle or a timeout still fails
the teardown. "It is gone" and "I was not allowed to look" must never report the same
thing, or the rehearsal environment is reported destroyed while it is still standing and
still holding prospect-shaped data.

The Terraform step is the same rule in Terraform's vocabulary: "Backend initialization
required" and "No state file was found" are what a job whose creation step never ran looks
like, and an empty state is the same fact with the init done. Both are
`destroyed=nothing_created` in the report. Any other unreadable state is a failure.

The teardown also gained a step: manual RDS snapshots carrying the run prefix are deleted,
because a snapshot outlives the instance and holds the drill's data. Every identifier goes
through `rehearsal_classify_name` first, so only `rehearsal-run` names are candidates.

## Decision 3 — the dry run reads the plan it printed

The refusal happens when a command is issued, so a command no pull request ever issues is
first judged on a credentialed run. That is the whole shape of this failure, and it will
recur for the next credentialed-only command unless the plan itself is judged.

`infra/scripts/rehearsal-prefix-guard.sh <prefix> plan <file>` re-applies the
production-name refusal to the plan the dry-run job printed. Every line naming production
must carry `REHEARSAL_INVENTORY_MARKER` and be the inventory read; a marked line that is
anything else, or names a mutating verb, is refused; and **the marker must appear at
least once**, so a plan that quietly stopped reading the inventory fails rather than
passing a search for the absence of a string.

## Decision 4 — the dry run records a sentinel, not an empty list

The `before` phase used to write `[]` in dry mode. The workflow runs that phase in dry
mode when it decides the run prefix, so a run whose real `before` failed would leave a
fabricated empty inventory for the `after` phase to compare production against — a pass by
construction. Dry mode now writes `["dry-run: no production inventory was read"]` and the
`after` phase refuses to compare against it.

## Decision 5 — the tag filter cannot do the filtering

`Values=fss-prod*` is not a wildcard. `resourcegroupstaggingapi get-resources` matches tag
values exactly, so that filter would have returned nothing and the before/after comparison
would have been a comparison of two empty lists — a vacuous pass wearing the shape of a
measurement, and worse than the refusal that replaced it. The read now filters by
`Key=Name` alone and selects the production names locally, sorted (the API promises no
order, and an unstable one would fail the comparison for no reason). This could not be
tested against AWS and is item 1 of `release.md` 8.1; the change is strictly a superset
read, so it cannot see *fewer* production resources than the version it replaces.

## Item 4: reading the run's shape end to end

Everything below came out of reading the seven scripts in the order the workflow calls
them. Fixed offline where a test could prove it; listed otherwise.

**Fixed.**

1. The inventory read refusing itself (decision 1).
2. `rehearsal_aws` / `rehearsal_terraform` printing `FAIL` and returning 0 (decision 1).
3. The teardown stopping at its first absent resource (decision 2), plus the missing
   snapshot cleanup and the uninitialised-root case.
4. The post-run guard's `terraform state list … || true`, which turned "I could not read
   the state" into "the state holds nothing named `fss-prod`". It now says which, and
   reports `state_read=true|false` in `prefix-guard.txt`.
5. The dry-run inventory sentinel (decision 4).
6. The tag-filter wildcard and the unstable ordering (decision 5).
7. `FSS_RESTORE_TARGET`: both branches of the drill's `minus()` parse exactly
   `YYYY-MM-DDTHH:MM:SSZ`, and anything else died inside a command substitution with
   `date: illegal time format`. The format is now checked and named. (The GNU branch's
   `date -u -d "<instant> - 3600 seconds"` was verified against GNU coreutils; it parses.)
8. The `fss` executable: nothing in this repository declares one and no workflow step
   installs one, so every non-dry `fss admin …` would have failed with `command not
   found` — the drill's, after step 1 had created a restored RDS instance. Both scripts
   now refuse before they address anything.
9. The smoke step's canary age: an empty `Datapoints` list makes the CloudWatch query
   print `None`, which becomes `NaN` and reports `age=Nones`. The step now waits up to ten
   minutes for a datapoint and then fails naming the cause.

**Listed, not fixed.**

10. **RDS will refuse the restore time.** The drill defaults `RESTORE_TARGET` to *now*, and
    a point-in-time restore must be no later than `LatestRestorableTime`, which trails the
    present. `--use-latest-restorable-time` is the likely answer, but it changes which
    instant `fss admin counts --as-of` is measured at, and the two have to agree or the
    baseline stops being the baseline. Not a change to make without the CLI existing.
    `release.md` 8.1 item 3.
11. **`resourcegroupstaggingapi` is regional.** The inventory sees `us-east-1` only. A
    production resource in another region is outside the comparison, permanently.
    `release.md` 8.1 item 5.
12. **Whether the rehearsal role may make the read at all.** Unchanged from G12: if it
    cannot, the scenario still passes on its own terms ("could not address" is the claim)
    but the diff is between two errors. `release.md` 8.1 item 1.
13. **The release record and the smoke script name no production resource today.** The
    record's arguments are a rehearsal prefix, two digests, a commit stamp, a suite result
    and a path under `$GITHUB_WORKSPACE`; the smoke origin is
    `https://${{ secrets.FSS_REHEARSAL_API_HOSTNAME }}`. Neither can reach `fss-prod`
    unless a secret is set to a production value, and scenario 42 now runs the record with
    a production name buried in the desktop stamp and requires the refusal. If the record
    is ever asked to *compare* production task definitions, as the brief anticipated, that
    read needs the same treatment as the inventory read and must not reuse its exemption.
14. **`jq` is not used anywhere in these scripts** — every JSON read is `python3`, and each
    one already tolerates `null` (`.get("Objects") or []`, `json.loads(raw) or []`). The
    one remaining unguarded parse, `describe-db-snapshots`, is covered by a test that
    hands it `[]`.

## What this cost and what it bought

Nothing in this lane was provable against AWS. What is provable is that the plan the pull
request prints is now the plan the rehearsal runs, and that the same guard judges both. The
next thing the first credentialed run finds should be a fact about AWS, not a fact about
this repository.
