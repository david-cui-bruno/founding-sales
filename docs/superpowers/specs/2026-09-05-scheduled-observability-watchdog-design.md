# Scheduled Observability and Monthly Health Watchdog Design

**Status:** Approved in chat on 2026-09-05; written specification awaiting review
**Supersedes:** Runtime Recovery Task 5 as written in `docs/superpowers/plans/2026-09-04-runtime-recovery-security-hardening.md`
**Extends:** `docs/superpowers/specs/2026-09-04-runtime-recovery-security-hardening-design.md`, section 4

## 1. Purpose

Make scheduled sourcing failures visible without weakening the existing production pause, leaking secrets into Terraform artifacts, or claiming live infrastructure safety from a stateless plan.

The design has three implementation phases:

1. make the scheduled-completion signal distinguish success from failure
2. add safe Terraform observability for all scheduled functions and exact non-monthly health alarms
3. add a daily watchdog Lambda for monthly health windows that standard CloudWatch metric alarms cannot represent

No phase deploys infrastructure, invokes AWS, enables schedules, enables new health notifications, or reads live founder data.

## 2. Confirmed problems

The existing Task 5 brief is not implementable safely as written:

- Standard CloudWatch metric alarms cannot evaluate the 56 to 62 day history required for two monthly expected runs.
- `schedules_enabled` defaults to `true`, so a future plan or apply without an override can enable every source schedule.
- `SCHEDULED_RUN_COMPLETED` is emitted in `finally`, including failed invocations. It is not currently a trustworthy success heartbeat.
- Providence tax-roll runs can return normally with a persisted continuation cursor while logging `unprocessedCount: 0`.
- The suppression-sync Errors alarm is duplicated by the generic adapter Errors alarm.
- Saved Terraform plans and JSON rendering can expose the sensitive Tracerfy value.
- A backend-disabled or incomplete-state plan can still evaluate providers and data sources and cannot prove that live resources will not be destroyed or replaced.
- Resolver is missing its CloudWatch log-group ARN in the shared execution-role policy.

An ignored pre-rotation `cloud/terraform/tf.plan` was found during design preflight. With founder approval, it was moved to the protected security quarantine, changed to mode 0600, and hash-verified. Its source path is now absent.

## 3. Goals

1. Produce one trustworthy, privacy-safe completion record per scheduled invocation with an explicit success or failure outcome.
2. Keep every EventBridge schedule disabled by default.
3. Keep notification actions for missing-success and persistent-work health alarms disabled by default until a reviewed rollout baseline exists.
4. Restore resolver log permissions in Terraform.
5. Provide Invocations, Errors, Throttles, p95 Duration, successful-run heartbeat, and applicable unprocessed-work visibility for every scheduled source.
6. Detect missing successful runs within a conservative twice-cadence window for 15-minute, hourly, and daily sources.
7. Detect positive unprocessed work across two consecutive expected periods when the source exposes a meaningful measure.
8. Detect two missed monthly expected runs and two consecutive positive monthly unprocessed windows with a separately tested daily watchdog.
9. Preserve structured PII-safe cloud logging and fixed outward `SafeHandlerError` behavior.
10. Validate source changes without creating a plan, rendering JSON, supplying a real secret, contacting AWS, or implying live drift safety.

## 4. Non-goals

- No Terraform apply, deployment, import, refresh, or live plan.
- No schedule or alarm-action enablement.
- No AWS, provider, Tracerfy, Callie, Apple bridge, outreach, or founder-data action.
- No new DynamoDB or S3 state for observability.
- No direct SNS publishing from the watchdog.
- No replacement for CloudWatch, the existing alert SNS topic, or the closed safe logger.
- No exact row-count backlog for sources that do not know their remaining row count.
- No state-aware no-destroy or no-replacement claim before Runtime Task 9 establishes approved state and secret handling.

## 5. Chosen architecture

### 5.1 Alternatives considered

#### A. CloudWatch metric history plus a daily watchdog

This is the selected approach. CloudWatch already retains the successful-run and unprocessed metrics needed for calendar-window evaluation. A daily Lambda queries those metrics and publishes small 0 or 1 health gauges. It adds no application database and no new durable business-data store.

#### B. DynamoDB health ledger written by every scheduled Lambda

Rejected. It would add a new table or new shared records, write permissions for every scheduled role, transactional semantics, retention behavior, and a larger failure surface solely to duplicate metric history CloudWatch already retains.

#### C. Approximate monthly health with standard CloudWatch alarms

Rejected. Standard alarm evaluation windows cannot represent two monthly cadences. Shorter windows would page too early and would not prove two missed expected runs or two consecutive monthly positive-work states.

### 5.2 Trust boundaries

- Scheduled handlers own invocation outcome and numeric completion counts.
- The shared safe logger owns field validation and serialization.
- CloudWatch Logs metric filters convert only successful completion records into health metrics.
- Terraform defines alarm semantics and notification gates.
- The watchdog reads only CloudWatch metrics and publishes only enumerated component health gauges.
- No secret value enters the observability data path.

## 6. Trustworthy scheduled completion contract

### 6.1 Record shape

Every scheduled source continues to emit exactly one `SCHEDULED_RUN_COMPLETED` record per invocation, including failed invocations. The event adds an authorized `status` field with exactly two accepted values:

```ts
export type ScheduledRunStatus = "success" | "failure";
```

A representative safe record is:

```json
{
  "level": "info",
  "eventCode": "SCHEDULED_RUN_COMPLETED",
  "component": "resolver",
  "status": "success",
  "durationMs": 341,
  "count": 12,
  "unprocessedCount": 2
}
```

The safe logger must omit `status` unless its value is exactly `success` or `failure`. Package-level TypeScript contracts accept only those two values. Email addresses, phone numbers, person names, provider payloads, credentials, raw errors, causes, free text, and caller-controlled status strings remain forbidden.

### 6.2 Outcome rules

- `success` means the scheduled handler returned its typed result without throwing.
- `failure` means the handler caught or propagated a failure and replaced it with `SafeHandlerError` at the exported boundary.
- A normal, time-boxed result may be `success` with positive `unprocessedCount`.
- Metric filters must require both `eventCode = SCHEDULED_RUN_COMPLETED` and `status = success`.
- Failure records remain useful for invocation-finalization evidence but never become success heartbeats or unprocessed-work samples.

### 6.3 Providence continuation semantics

Providence tax-roll cannot know the exact remaining row count when a page-limited run leaves a continuation cursor. It therefore reports:

```ts
unprocessedCount: completed ? 0 : 1
```

`1` means one durable continuation remains, not one remaining parcel. This is sufficient for persistence detection without inventing a row count.

### 6.4 Applicability of unprocessed alarms

Terraform metadata explicitly identifies whether a component has a meaningful unprocessed measure.

- Meaningful: `adapter-pvd-taxroll`, `adapter-boston-assessments`, `scorer`, `resolver`, `enricher`, `suppression-sync`
- Not meaningful today: `adapter-boston-rentsmart`

RentSmart still receives success, error, throttle, duration, and missing-success monitoring. It does not receive a persistent-unprocessed alarm until its handler exposes a truthful pending-work measure.

## 7. Terraform observability

### 7.1 Safety defaults

`cloud/terraform/variables.tf` defines:

```hcl
variable "schedules_enabled" {
  type    = bool
  default = false
}

variable "scheduled_health_alerts_enabled" {
  description = "Enables notification actions for scheduled missing-success and persistent-work health alarms after an approved baseline."
  type        = bool
  default     = false
}
```

Every EventBridge source rule and the watchdog rule use `schedules_enabled`. No resource may bypass it.

`scheduled_health_alerts_enabled` controls notification actions for missing-success, persistent-unprocessed, and watchdog-derived monthly health alarms. Those actions are enabled only when both `schedules_enabled` and `scheduled_health_alerts_enabled` are true, so an intentionally paused schedule cannot page for missing work. Errors, Throttles, and near-timeout alarms remain notification-capable because they require an actual invocation and cannot fire merely because a schedule is intentionally paused.

### 7.2 Scheduled source metadata

Each of the seven current source functions declares:

- exact component key
- schedule expression
- cadence class: `quarter_hour`, `hourly`, `daily`, or `monthly`
- Lambda timeout seconds
- whether unprocessed work is meaningful
- any source-specific error description

The watchdog is an eighth scheduled component but is not a sourcing adapter and has its own role and package.

### 7.3 Resolver log permission

The shared adapter execution-role log resources add exactly:

```text
arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${var.name_prefix}-resolver*
```

Live stream creation remains a separately authorized post-deploy check.

### 7.4 Metric filters

Each scheduled source log group emits two metrics in namespace `Callie/Sourcing`:

1. `ScheduledRunSuccess`, value `1`, dimension `Component = $.component`
2. `ScheduledRunUnprocessed`, value `$.unprocessedCount`, dimension `Component = $.component`

Both filters require `SCHEDULED_RUN_COMPLETED` and `status = success`. The unprocessed filter also requires the numeric field to be present. Neither filter defines a default value.

The fixed component values written by the package loggers match the Terraform component keys exactly.

### 7.5 Base alarms

Every scheduled source has exactly one alarm for each applicable AWS/Lambda metric:

- Errors: `Sum >= 1`, period 300 seconds, one evaluation period, missing non-breaching
- Throttles: `Sum >= 1`, period 300 seconds, one evaluation period, missing non-breaching
- near-timeout Duration: `extended_statistic = "p95"`, threshold `timeout_seconds * 1000 * 0.90`, period 300 seconds, one evaluation period, low samples evaluated, missing non-breaching

Every alarm has alarm and recovery actions routed to the existing `aws_sns_topic.alerts`.

There is exactly one Errors alarm and one Throttles alarm per function. Suppression-sync retains its compliance-specific description and short detection behavior through per-function metadata rather than a duplicate resource.

### 7.6 Non-monthly missing-success alarms

These alarms use `ScheduledRunSuccess`, `Sum`, `LessThanThreshold`, threshold `1`, all datapoints required, and missing data treated as breaching.

| Cadence | Period | Evaluation periods | Datapoints to alarm | Expected worst-case alert delay after last success |
|---|---:|---:|---:|---:|
| 15 minutes | 300 seconds | 6 | 6 | 30 to 35 minutes |
| 1 hour | 600 seconds | 12 | 12 | 120 to 130 minutes |
| 1 day | 3600 seconds | 48 | 48 | 48 to 49 hours |

Alarm actions are enabled only when both `schedules_enabled` and `scheduled_health_alerts_enabled` are true.

Monthly components are excluded from these standard missing-success alarms.

### 7.7 Non-monthly persistent-unprocessed alarms

Applicable components use `ScheduledRunUnprocessed`, `Minimum`, `GreaterThanThreshold`, threshold `0`, `evaluation_periods = 2`, `datapoints_to_alarm = 2`, and missing data treated as non-breaching.

| Cadence | Period |
|---|---:|
| 15 minutes | 900 seconds |
| 1 hour | 3600 seconds |
| 1 day | 86400 seconds |

A manual or retry success counts within its wall-clock period. A successful zero sample clears that period because `Minimum` becomes zero. Failed invocations do not emit this metric.

Alarm actions are enabled only when both `schedules_enabled` and `scheduled_health_alerts_enabled` are true.

### 7.8 Dashboard

The pipeline dashboard adds or completes widgets for:

- Invocations
- Errors
- Throttles
- p95 Duration in milliseconds
- successful-run heartbeat
- unprocessed work
- monthly watchdog missing-success gauges
- monthly watchdog persistent-unprocessed gauges

All seven source functions and the watchdog appear where their metrics apply. Widgets must not aggregate function identities into one undifferentiated series.

## 8. Daily monthly-health watchdog

### 8.1 Package and schedule

Create a standalone Node.js 22 Lambda package at:

```text
cloud/lambdas/schedule-watchdog/
```

It follows existing TypeScript, esbuild, Vitest, and shared-safe-logger conventions.

The EventBridge rule runs daily at 18:00 UTC:

```text
cron(0 18 * * ? *)
```

It is `DISABLED` unless `schedules_enabled = true`.

### 8.2 Monthly targets

The code contains a closed target list:

```ts
const MONTHLY_TARGETS = [
  {
    component: "adapter-pvd-taxroll",
    dayOfMonth: 1,
    hourUtc: 9,
    minuteUtc: 0,
    graceHours: 6,
  },
  {
    component: "adapter-boston-assessments",
    dayOfMonth: 2,
    hourUtc: 11,
    minuteUtc: 0,
    graceHours: 6,
  },
] as const;
```

The watchdog reads 70 days of metric history. This covers both required calendar windows across 28, 29, 30, and 31 day months with additional ingestion margin.

### 8.3 Inputs

For each target, query CloudWatch metric history for:

- `ScheduledRunSuccess` with the exact `Component` dimension
- `ScheduledRunUnprocessed` with the exact `Component` dimension

Use hourly buckets. Metric timestamps and values are ordinary numeric health data. The watchdog does not query logs, S3, DynamoDB, source payloads, or provider APIs.

### 8.4 Calendar-window evaluation

At evaluation time:

1. Compute the two most recent target schedule instants whose six-hour grace period has ended.
2. Define the older window as `[older_due, newer_due)`.
3. Define the newer window as `[newer_due, now]`.
4. A successful manual or retry invocation counts in the window where its metric timestamp falls.

For each target:

```ts
missingSuccess =
  noSuccessInOlderWindow && noSuccessInNewerWindow;

persistentUnprocessed =
  hasSuccessInOlderWindow &&
  hasSuccessInNewerWindow &&
  minimumUnprocessedInOlderWindow > 0 &&
  minimumUnprocessedInNewerWindow > 0;
```

If a window has a success heartbeat but no corresponding unprocessed sample, evaluation fails closed and the watchdog invocation throws. The watchdog Errors alarm then owns the alert instead of publishing a guessed healthy state.

### 8.5 Published gauges

One `PutMetricData` call publishes these 0 or 1 metrics in `Callie/Sourcing`, dimensioned by exact target component:

- `MonthlyMissingSuccess`
- `MonthlyPersistentUnprocessed`

The watchdog never publishes string payloads or source identifiers outside the closed component list.

### 8.6 Watchdog logging and outward error

The watchdog emits exactly one `SCHEDULED_RUN_COMPLETED` record per invocation using the same contract:

- `status = success` after both targets are evaluated and metrics are published
- `status = failure` on any CloudWatch read, validation, calendar, or publish failure
- `count` is the number of targets evaluated
- `unprocessedCount` is the number of target health gauges currently equal to 1
- `durationMs` is handler-owned monotonic elapsed time

The exported boundary discards internal error identity, message, cause, response, and payload and throws a fresh `SafeHandlerError`.

### 8.7 Watchdog IAM

Use a dedicated role with only:

- CloudWatch Logs create stream and put events for its own log group
- `cloudwatch:GetMetricData`
- `cloudwatch:PutMetricData`

CloudWatch metric actions require resource `*`. The role gets no S3, DynamoDB, SNS, SES, provider, or founder-data permission.

### 8.8 Watchdog alarms

The watchdog has Errors, Throttles, p95 Duration, and a 48-hour successful-run heartbeat alarm using the same base semantics.

Each monthly target has:

- `MonthlyMissingSuccess`: `Maximum >= 1`, period 86400 seconds, one evaluation period
- `MonthlyPersistentUnprocessed`: `Maximum >= 1`, period 86400 seconds, one evaluation period

Missing gauge data is non-breaching because watchdog failure and watchdog missing-success alarms cover absent evaluation. Monthly health alarm actions and recovery actions are enabled only when both `schedules_enabled` and `scheduled_health_alerts_enabled` are true.

## 9. Static verification and secret safety

### 9.1 Allowed implementation-time checks

- focused Vitest suites
- all affected Lambda package typechecks and tests
- root typecheck when required by shared contracts
- `tofu fmt -check -recursive`
- `tofu validate` only if installed providers are already available and the command succeeds with all AWS and Terraform secret environment variables unset, without initialization, credential resolution, remote provider access, or data-source evaluation
- source-level Terraform tests that parse exact files and values
- `git diff --check`, exact scope checks, and secret-pattern scans that do not display secret values

### 9.2 Forbidden implementation-time checks

- `tofu plan`
- `terraform plan`
- saved plan files
- `tofu show` or `terraform show`
- any JSON plan rendering
- provider initialization that requires credentials or remote access
- Route53 or other AWS data-source evaluation
- real `tracerfy_api_key`, `ntfy_topic`, or replacement secret values
- AWS, Lambda, EventBridge, CloudWatch, SNS, provider, Callie, Apple bridge, or live founder-data calls

If `tofu validate` cannot run inside these limits, record it as acceptance-blocked and rely on formatting plus static Terraform tests. A local provider-plugin schema process is acceptable, but network access, credential resolution, and remote data-source evaluation are not. Do not weaken the boundary to make validation pass.

### 9.3 Future state-aware hold point

A live plan is deferred until Runtime Task 9 establishes approved managed-secret identifiers and trusted remote or imported state.

That later hold point requires separate founder approval and must:

1. build every referenced Lambda bundle first
2. use trusted state and refresh-enabled provider access
3. set `schedules_enabled=false`
4. set `scheduled_health_alerts_enabled=false`
5. avoid raw secret values in configuration and process inputs
6. use restrictive `umask 077`
7. avoid `-out` and every JSON rendering path
8. review a human-readable unsaved plan
9. prove zero destroys and zero replacements against trusted state
10. retain only a sanitized summary with no provider payload or secret material

No apply is implied by plan approval.

## 10. Test strategy

### 10.1 Completion contract tests

- safe logger accepts only `success` and `failure`
- arbitrary status strings and PII-shaped values are absent or rejected
- each of the seven scheduled packages emits one success record on return and one failure record on throw
- failed invocations do not qualify for success or unprocessed metric filters
- existing `SafeHandlerError`, duration, count, and privacy assertions remain intact
- Providence emits `unprocessedCount = 1` when its continuation remains and `0` when complete

### 10.2 Terraform static tests

Enumerate the seven exact source keys and the watchdog. Require:

- `schedules_enabled` default false
- `scheduled_health_alerts_enabled` default false
- every EventBridge rule uses the schedule gate
- resolver log-group ARN is present exactly once
- success filters require success status and fixed event code
- unprocessed filters extract numeric `$.unprocessedCount` with no default
- per-function metric identity is preserved
- exact non-monthly period matrices
- monthly sources are excluded from unsupported standard missing-success and persistence alarms
- Errors and Throttles have one alarm per function
- suppression-sync has no duplicate function/metric alarm pair
- Duration uses p95, milliseconds, 90 percent threshold, and explicit low-sample behavior
- alarm and recovery actions route to the existing alert topic
- health alarm actions are gated off by default
- dashboard coverage is complete
- no plan, JSON-render, or real-secret command is prescribed

### 10.3 Watchdog unit tests

Use injected CloudWatch clients and clocks to cover:

- February and leap-year boundaries
- 28, 29, 30, and 31 day month transitions
- grace-period boundary before and after eligibility
- two missed expected runs
- one missed run after a previous success
- success from a manual retry inside a window
- two positive unprocessed windows
- a zero sample clearing one window
- missing unprocessed data after success failing closed
- CloudWatch pagination and timestamp ordering
- read and publish failures
- exact 0 or 1 gauges and exact component dimensions
- one safe completion record and fresh `SafeHandlerError`
- absence of raw AWS errors, credentials, emails, phones, names, payloads, and causes

### 10.4 Package and integration checks

- watchdog typecheck, tests, and build
- shared logger typecheck and tests
- all seven affected scheduled package tests
- infrastructure static tests
- scratch bundle inspection of the Node.js 22 handler export if needed
- exact changed-file review and clean tracked status

## 11. File ownership

Expected implementation areas include:

- `cloud/lambdas/shared/src/safeLog.ts` and its tests
- seven scheduled Lambda handler/log/test surfaces
- new `cloud/lambdas/schedule-watchdog/` package
- `cloud/terraform/variables.tf`
- `cloud/terraform/adapters.tf`
- `cloud/terraform/iam.tf`
- `cloud/terraform/alarms.tf`
- `cloud/terraform/dashboard.tf`
- a focused new watchdog Terraform file if it keeps responsibilities clearer
- `tests/infrastructure/terraformHardening.test.ts`
- `cloud/README.md` only for safe validation and future hold-point instructions

The implementation plan must divide these into independently reviewable tasks and name exact files. It must not let a task commit partial metric semantics that can treat failures as successful runs.

## 12. Compatibility and rollout

- Existing scheduled handlers keep their exported function signatures.
- The completion event code remains stable; only a closed status field is added.
- Existing counts and outward error behavior remain stable.
- Terraform schedule state becomes safer because omission now means disabled.
- New health notification actions remain disabled until a separately approved baseline.
- No live resolver stream, alarm transition, metric filter, watchdog run, or schedule state is claimed during implementation.
- Rollback is a source revert before deployment. After deployment, rollback must keep both schedule and health-alert gates false while restoring the previous reviewed configuration.

## 13. Acceptance criteria

The design is complete when:

1. successful and failed scheduled invocations are distinguishable without PII leakage
2. failed completions cannot become health heartbeats or backlog samples
3. Providence continuation state produces a truthful positive unprocessed signal
4. schedules and health notifications default to false
5. resolver log IAM is restored in configuration
6. every scheduled function has exact, nonduplicated base observability
7. non-monthly health alarms use the specified supported windows
8. monthly health is evaluated by the daily calendar-aware watchdog, not an invalid standard alarm window
9. the watchdog uses only CloudWatch metric history and publishes only closed 0 or 1 gauges
10. static and package verification pass without a plan, JSON rendering, AWS/provider access, live data, or real secrets
11. independent task reviews and a final whole-plan review find no unresolved Critical or Important issue
12. no deployment, apply, schedule enablement, or health-action enablement occurs without a later explicit hold point
