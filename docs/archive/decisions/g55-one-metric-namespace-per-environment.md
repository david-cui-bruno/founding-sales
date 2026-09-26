# One metric namespace per environment, not an environment dimension

**Lane:** g55 · **Date:** 24 September 2026 · **Closes:** open item g42 · **Evidence:** the tenth full rehearsal, run 35943001092, 23 September 2026 (`docs/greenfield/release.md` 8.0s)

## What happened

Every FSS metric, every log metric filter and every alarm used the CloudWatch namespace
`FSS`. The rehearsal (`fss-rh-<run>`) and production (`fss-prod`) share an account, so
they shared every metric stream. The tenth full run's smoke failed on a canary age of
837.9 s that was production's, and production's alarms could be tripped or masked by a
rehearsal worker's heartbeats, canary age and safety counters.

## Decision

Each environment gets its own namespace, `FSS/<name_prefix>`: `FSS/fss-prod` and
`FSS/fss-rh-<run>`. It is derived once, as `local.metric_namespace` in
`infra/modules/stack`, and passed to observability (metric filters), cluster
(`FSS_METRIC_NAMESPACE` on all five task definitions, and the `cloudwatch:namespace`
condition on the four task roles' `PublishOperationalMetrics`), and alerts (all sixteen
metric alarms). The three module variables have no default and refuse anything that is
not `FSS/<prefix>`. The worker refuses to start if it would publish with no namespace,
or with one that is not `FSS/` followed by its `FSS_NAME_PREFIX`. The roots output
`metric_namespace`, and the rehearsal smoke reads that output.

## Why a namespace and not a dimension

- **IAM can enforce a namespace.** `cloudwatch:PutMetricData` can be conditioned on
  `cloudwatch:namespace` but not on dimensions. With per-environment namespaces, a
  rehearsal task role cannot publish into production's metrics at all. A dimension would
  only be a convention.
- **The zero default survives.** A log metric filter with dimensions cannot have a
  `default_value` (`observability/main.tf`), and the safety filters rely on publishing
  0 so their alarms never sit in `INSUFFICIENT_DATA`. An `Environment` dimension on every
  filter would lose that.
- **Same size of change.** A dimension changes each metric's identity too, so every alarm
  would need the same update, plus a dimension block.

Dedicated accounts (PR 173) are still worth having. The two fixes are independent.

## What production sees when the change is applied

In a `terraform plan` of `infra/roots/production` with the running image digests:

- **In place:** 8 metric filters, 16 metric alarms (15 in `alarms`, plus
  `all_sequences_held`, whose two `metric_query` metrics change inside the set), the 4
  task-role policies, and the 2 services (`task_definition`).
- **Replaced:** the 5 task definitions (`api`, `worker`, `migration`, `operations`,
  `drill`), because `container_definitions` forces replacement. That is the same
  deregister-and-register every image release does.
- **Nothing else:** no alarm is replaced (only `alarm_name` forces a new alarm), no
  composite alarm changes, and nothing else is destroyed. There is a new output,
  `metric_namespace = "FSS/fss-prod"`.

The same apply rolls both services, so no separate redeploy is needed. The running image
already publishes wherever `FSS_METRIC_NAMESPACE` points; only the startup refusal
needs a new image. In the minutes between the alarm update and the new worker's first
metrics pass, `FSS/fss-prod` has no data. The alarms that treat missing data as breaching
will go to ALARM, each sending its own email, and clear with an OK email after the first
publish: the four heartbeat alarms, `canary-stale`, `gmail-watch-expiring` and the
critical composite. Expect about seven of each, once.
`today-snapshot-absent` (ignore) and the not-breaching alarms stay as they are. Series
already in the bare `FSS` namespace stop getting data. There is nothing to delete.

Neither deployment-role document conditions on a metric namespace. Reads are
`cloudwatch:Get*` on `*` (`AccountMetadata`), and alarms are authorised by their
`<prefix>*` names. So no policy changes, and `fss-prod-deploy` is untouched.
