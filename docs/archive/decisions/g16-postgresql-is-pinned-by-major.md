# PostgreSQL is pinned by major, not by minor

**Lane:** G16 · **Date:** 21 September 2026 · **Evidence:** Actions run 35628963637

## What happened

`infra/modules/database/variables.tf` had `engine_version` defaulting to `"16.8"`.
David's fourth credentialed rehearsal reached RDS and was refused:

```
InvalidParameterCombination: Cannot find version 16.8 for postgres
```

AWS had retired it. The PostgreSQL 16 versions available in `us-east-1` on 21 September
2026 were **16.3, 16.4, 16.9, 16.10, 16.11, 16.12, 16.13, 16.14, 16.15** — 16.5 through
16.8 were gone.

## The decision

The default is `"16"`, the bare major.

`main.tf` already sets `auto_minor_version_upgrade = true` and
`allow_major_version_upgrade = false`. With automatic minor upgrades on, the AWS provider
treats a major-only `engine_version` as a **prefix** of the version actually running: it
records the full version AWS chose (`16.15`, say) in state, and the diff is suppressed for
as long as the running version still begins with the configured string. So `"16"` plans as
no change against 16.9 today and against 16.16 next quarter, where `"16.8"` planned as a
change against everything and then failed at the apply because it planned as a change to a
version that no longer existed.

The variable validation accepts `16` and `16.<minor>` and refuses anything else, so a
minor **may** still be pinned deliberately — to reproduce a bug, or to hold a restored
instance at the source instance's exact version — and a different major is refused as the
spec change it would be.

## Why no offline layer could see it, and what changes because of that

Nothing in this repository asks RDS which engine versions exist.
`terraform validate` checks types and references. `terraform test` with `mock_provider`
replaces the provider, so no version is ever resolved. A real `terraform plan` does
configure the provider, and it *would* have caught this — `plan` resolves
`engine_version` against `DescribeDBEngineVersions` for a new instance — which makes this
the fourth member of the class `docs/archive/decisions/g12k-the-rehearsal-has-stages-and-one-gate.md`
names: an error a plan can see and no offline layer can.

But the `plan` stage of run 35626442598 was green with `16.8` in it, and so was David's
local plan (138 to add). So a plan did *not* catch it, and the honest conclusion is
narrower than "run a plan first": **a pinned minor is a value whose validity is a fact
about AWS's retirement calendar on the day of the apply, and it can go stale between a
green plan and the apply that follows it.** A rehearsal is not where to discover that. The
fix is not a better check on the minor; it is not pinning one.

What the offline gate can now say, and does, is that the *default* is the major:
`infra/modules/database/tests/recovery_posture.tftest.hcl` asserts
`engine_version == "16"` rather than `startswith(engine_version, "16")`, which was true of
`"16.8"` and would be true of the next retired minor. It also asserts
`auto_minor_version_upgrade` in the same run, because the major-only value is only
diff-free while that is on: a lane that turned it off would leave a configuration whose
first plan proposes a version change nobody asked for.

## What is still unverified

- That the provider's diff suppression behaves as described against a real instance. It
  is the documented behaviour of `hashicorp/aws` for `aws_db_instance` with
  `auto_minor_version_upgrade = true`, and the symptom if it does not is a plan proposing
  an engine-version change — legible, and caught by the local production plan
  (`docs/greenfield/infra-apply-runbook.md`, "Plan first") before any apply.
- Which minor AWS actually selects for `"16"` on the day. It is the current default minor
  for the major, which is not something to predict; `aws rds describe-db-instances
  --query 'DBInstances[0].EngineVersion'` after the apply is the answer, and the restore
  drill's source and target will agree because a point-in-time restore takes the source's
  version.
- Whether the parameter group family `postgres16` is right for every minor of the major.
  It is by construction — RDS parameter group families are per-major — and the tftest
  asserts it holds when a minor is pinned as well as when it is not.
