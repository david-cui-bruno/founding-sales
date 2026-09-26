# g86: the parameter group names the apply method AWS holds

Lane g86, 25 September 2026. The recurring production plan diff noted in
`docs/greenfield/release.md` 8.0s ("a perpetual diff on the RDS parameter group's
`apply_method` which changes nothing when it is applied").

## The evidence

The saved production plan of 25 September (`fss-prod-plan-64b5095d…`, read offline with
`terraform show -json`) proposes one in-place update of
`module.stack.module.database.aws_db_parameter_group.main`, and only two parameters in
it differ:

| Parameter | Value | State (as AWS reports it) | Configuration |
|---|---|---|---|
| `log_autovacuum_min_duration` | `10000` | `pending-reboot` | `immediate` |
| `rds.force_ssl` | `1` | `pending-reboot` | `immediate` |

The other six already agree at `immediate`. The configuration never set `apply_method`
at all, so it took the provider's default, `immediate`.

## Why it recurs

The AWS provider's documentation for `aws_db_parameter_group` describes exactly this. If
only a parameter's apply method changes, the AWS API does not register the change, so the
apply reports success and the next plan shows the same update. To change the method, the
value must change too. `lifecycle { ignore_changes }` cannot help: it cannot name one
attribute of one element of the `parameter` set, and ignoring the whole set would hide
real parameter changes.

## Decision

Name `apply_method = "pending-reboot"` on those two parameters in
`infra/modules/database/main.tf`, which is what AWS holds, so the plan has nothing to
propose. `infra/modules/database/tests/recovery_posture.tftest.hcl` asserts both carry
`pending-reboot` and every other parameter `immediate`.

## What it changes

- **Production:** the next plan no longer shows the parameter group. Nothing is applied
  to the instance, and no reboot is needed or scheduled.
- **A new environment** (a rehearsal) creates the group with the two parameters marked
  `pending-reboot`. The group is attached when the instance is created, so every
  parameter is in force at its first boot, as before.
- **A later change of either value** takes effect at the next reboot, unless the same
  change also sets `apply_method = "immediate"`. AWS registers a method change together
  with a new value. `log_autovacuum_min_duration` is dynamic in PostgreSQL, so whoever
  changes it should make it `immediate` in the same edit. `rds.force_ssl` should not
  change.
