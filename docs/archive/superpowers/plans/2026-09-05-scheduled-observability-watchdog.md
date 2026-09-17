# Scheduled Observability and Monthly Health Watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every scheduled sourcing run observable with trustworthy success or failure completion records, exact non-monthly health alarms, and a calendar-aware monthly watchdog, while keeping schedules and health notifications disabled by default.

**Architecture:** First, extend the closed safe-logging contract and all seven scheduled handlers so failures cannot become success heartbeats or backlog samples. Next, add source-level Terraform observability for the seven existing functions. Finally, build a standalone daily CloudWatch-metric watchdog in two layers, pure calendar evaluation followed by AWS I/O and Terraform wiring.

**Tech Stack:** TypeScript, Node.js 22 Lambda runtime, Node.js 24 build tooling, Vitest, esbuild, AWS SDK v3 CloudWatch client, OpenTofu/Terraform with AWS provider 5.x, CloudWatch Logs metric filters, CloudWatch Metrics and alarms, EventBridge.

**Spec:** `docs/superpowers/specs/2026-09-05-scheduled-observability-watchdog-design.md`

## Global Constraints

- Prefix every `npm` and `npx` command exactly with `export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH";`.
- Keep all existing exported scheduled-handler function signatures unchanged.
- Keep `SCHEDULED_RUN_COMPLETED` as the stable event code and add only the closed `status: "success" | "failure"` field.
- Keep logs PII-safe. Never serialize emails, phone numbers, names, addresses, provider payloads, credentials, raw errors, causes, or caller-controlled status strings.
- Keep every EventBridge rule gated by `schedules_enabled`, whose checked-in default must be `false`.
- Keep missing-success, persistent-work, and monthly-health alarm actions gated by both `schedules_enabled` and `scheduled_health_alerts_enabled`, whose checked-in default must be `false`.
- Do not deploy, apply, enable schedules, enable alarm actions, invoke AWS, query providers, use Callie or the Apple bridge, or read live founder data.
- Do not run `tofu init`, `terraform init`, any Terraform or OpenTofu plan command, any show command, or any JSON plan rendering command.
- Do not create or retain saved plan files. Do not supply `tracerfy_api_key`, `ntfy_topic`, AWS credentials, profiles, or replacement secret values.
- `tofu validate` is not part of this plan. If later attempted, it requires a separate no-network proof with installed providers, all AWS and secret environment variables unset, and no provider or data-source evaluation.
- Allowed infrastructure checks are source-level Vitest tests and `tofu fmt -check -recursive` only.
- Each task must commit exactly its declared files and finish with `git diff --check` plus an exact committed-file review.
- Each task requires independent spec and quality review before the next task starts. Final integration requires an independent whole-plan review with no unresolved Critical or Important finding.

---

## File Structure and Task Ownership

| Area | Responsibility | Task owner |
|---|---|---|
| `cloud/lambdas/shared/src/safeLog.ts` | Closed `ScheduledRunStatus` type and exact status sanitization | Task 1 |
| Seven scheduled package `src/handler.ts`, `src/log.ts`, and `test/handler.test.ts` files | Handler-owned outcome and truthful completion records | Task 1 |
| `cloud/terraform/variables.tf` | Disabled schedule and health-action defaults | Task 2 |
| `cloud/terraform/adapters.tf` | Exact cadence, timeout, unprocessed applicability, and error-description metadata | Task 2 |
| `cloud/terraform/iam.tf` | Resolver log permission in Task 2, dedicated watchdog role in Task 5 | Tasks 2 and 5, sequentially |
| `cloud/terraform/alarms.tf` | Source filters and alarms in Task 2, watchdog and monthly alarms in Task 5 | Tasks 2 and 5, sequentially |
| `cloud/terraform/dashboard.tf` | Seven-source views in Task 2, watchdog and monthly views in Task 5 | Tasks 2 and 5, sequentially |
| `tests/infrastructure/terraformHardening.test.ts` | Brace-aware static Terraform contract checks | Tasks 2 and 5, sequentially |
| `cloud/README.md` | Secret-safe local verification and deferred deployment hold point | Tasks 2 and 5, sequentially |
| `cloud/lambdas/schedule-watchdog/src/monthlyHealth.ts` | Pure monthly calendar and health evaluation | Task 3 |
| `cloud/lambdas/schedule-watchdog/src/cloudWatchMetrics.ts` | Metric history pagination, validation, and 0/1 gauge publication | Task 4 |
| `cloud/lambdas/schedule-watchdog/src/handler.ts` and `src/log.ts` | Daily evaluation orchestration, safe completion, fixed outward error | Task 4 |
| `cloud/terraform/watchdog.tf` | Watchdog Lambda, log group, daily schedule, target, and permission | Task 5 |

Task 2 produces complete, reviewable non-monthly observability before Task 5 adds any watchdog resources. Task 3 produces a complete, reviewable pure evaluator before Task 4 adds AWS access. No task may create a metric filter until Task 1 makes the completion status trustworthy.

---

### Task 1: Make Scheduled Completion Outcome Trustworthy

**Files:**
- Modify: `cloud/lambdas/shared/src/safeLog.ts`
- Modify: `cloud/lambdas/shared/test/safeLog.test.ts`
- Modify: `cloud/lambdas/adapter-boston-assessments/src/handler.ts`
- Modify: `cloud/lambdas/adapter-boston-assessments/src/log.ts`
- Modify: `cloud/lambdas/adapter-boston-assessments/test/handler.test.ts`
- Modify: `cloud/lambdas/adapter-boston-rentsmart/src/handler.ts`
- Modify: `cloud/lambdas/adapter-boston-rentsmart/src/log.ts`
- Modify: `cloud/lambdas/adapter-boston-rentsmart/test/handler.test.ts`
- Modify: `cloud/lambdas/adapter-pvd-taxroll/src/handler.ts`
- Modify: `cloud/lambdas/adapter-pvd-taxroll/src/log.ts`
- Modify: `cloud/lambdas/adapter-pvd-taxroll/test/handler.test.ts`
- Modify: `cloud/lambdas/enricher/src/handler.ts`
- Modify: `cloud/lambdas/enricher/src/log.ts`
- Modify: `cloud/lambdas/enricher/test/handler.test.ts`
- Modify: `cloud/lambdas/resolver/src/handler.ts`
- Modify: `cloud/lambdas/resolver/src/log.ts`
- Modify: `cloud/lambdas/resolver/test/handler.test.ts`
- Modify: `cloud/lambdas/scorer/src/handler.ts`
- Modify: `cloud/lambdas/scorer/src/log.ts`
- Modify: `cloud/lambdas/scorer/test/handler.test.ts`
- Modify: `cloud/lambdas/suppression-sync/src/handler.ts`
- Modify: `cloud/lambdas/suppression-sync/src/log.ts`
- Modify: `cloud/lambdas/suppression-sync/test/handler.test.ts`

**Interfaces:**
- Consumes: existing `createSafeLogger`, `defineLogPolicy`, `SafeHandlerError`, package-local typed `log(...)`, and each existing `RunResult` or suppression result.
- Produces: `export type ScheduledRunStatus = "success" | "failure"` from `@callie-sourcing/shared`.
- Produces: exactly one completion record per invocation with `{ status, durationMs, count, unprocessedCount }`.
- Produces: Providence `unprocessedCount` equal to `completed ? 0 : 1`.
- Preserves: all existing exported handler signatures and fresh `SafeHandlerError` behavior.

- [ ] **Step 1: Write the failing shared safe-logger tests**

Add `status` to the test policy and add exact assertions proving the closed domain:

```ts
const policy = defineLogPolicy({
  component: "suppression-sync",
  events: {
    SCHEDULED_RUN_COMPLETED: ["status", "durationMs", "count", "unprocessedCount"],
    SUPPRESSION_OBJECT_INVALID: [
      "objectKey",
      "objectVersionId",
      "objectEtag",
      "objectChecksumSha256",
      "invalidLineNumbers",
      "invalidLineCount",
      "lineNumber",
      "errorClass",
    ],
    SUPPRESSION_OBJECT_QUARANTINED: ["objectKey", "objectChecksumSha256"],
  },
});

it("retains only the two scheduled run statuses", () => {
  const success = capturedLogger();
  success.log("info", "SCHEDULED_RUN_COMPLETED", {
    status: "success",
    durationMs: 1,
    count: 1,
    unprocessedCount: 0,
  });
  expect(parsedOnly(success.output)).toMatchObject({ status: "success" });

  const failure = capturedLogger();
  failure.log("error", "SCHEDULED_RUN_COMPLETED", {
    status: "failure",
    durationMs: 1,
    count: 0,
    unprocessedCount: 0,
  });
  expect(parsedOnly(failure.output)).toMatchObject({ status: "failure" });

  for (const unsafeStatus of ["ok", "failed", "private@example.test", "token=secret"]) {
    const rejected = capturedLogger();
    rejected.log("info", "SCHEDULED_RUN_COMPLETED", {
      status: unsafeStatus,
      durationMs: 1,
      count: 0,
      unprocessedCount: 0,
    } as never);
    expect(parsedOnly(rejected.output)).not.toHaveProperty("status");
  }
});
```

- [ ] **Step 2: Run the shared test to verify RED**

Run:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/shared && npm test -- test/safeLog.test.ts)
```

Expected: FAIL because `sanitizeField("status", ...)` currently always returns `undefined`.

- [ ] **Step 3: Write failing exported-boundary tests in all seven scheduled packages**

Update each existing success assertion to include `status: "success"`, each existing failure assertion to include `status: "failure"`, and each exact key assertion to include `status`.

Use these exact expectations:

| Test file | Success assertion | Failure assertion |
|---|---|---|
| `adapter-boston-assessments/test/handler.test.ts` | every normal completion has `status: "success"` | safe-default completion has `status: "failure"` |
| `adapter-boston-rentsmart/test/handler.test.ts` | every normal completion has `status: "success"` | safe-default completion has `status: "failure"` |
| `adapter-pvd-taxroll/test/handler.test.ts` | complete run has `status: "success", unprocessedCount: 0` | provider failure has `status: "failure", unprocessedCount: 0` |
| `enricher/test/handler.test.ts` | normal return has `status: "success"` | throwing stop or provider failure has `status: "failure"` |
| `resolver/test/handler.test.ts` | every normal completion has `status: "success"` | safe-default completion has `status: "failure"` |
| `scorer/test/handler.test.ts` | normal completion has `status: "success"` | safe-default completion has `status: "failure"` |
| `suppression-sync/test/handler.test.ts` | incremental, replay, and reconcile returns have `status: "success"` | parser or object failure has `status: "failure"` |

In the Providence suite, add a real time-boxed exported-boundary regression:

```ts
it("reports one durable continuation while a Providence cursor remains", async () => {
  const pageA = Array.from({ length: 1000 }, (_, index) => ({
    ...ROW_TWO_FAMILY_OWNER_OCC,
    p_id: String(8000 + index),
  }));
  const pageB = [{ ...ROW_TWO_FAMILY_OWNER_OCC, p_id: "9999" }];
  const { deps } = fakeDeps([pageA, pageB]);
  let calls = 0;
  deps.now = () => new Date(calls++ < 1 ? 0 : 2);
  deps.env.MAX_RUNTIME_MS = 1;
  const output: string[] = [];
  const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
  try {
    await createHandler(() => deps, () => 10)(null);
  } finally {
    consoleSpy.mockRestore();
  }
  const completion = output.map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((record) => record.eventCode === "SCHEDULED_RUN_COMPLETED");
  expect(completion).toMatchObject({ status: "success", unprocessedCount: 1 });
});
```

- [ ] **Step 4: Run all seven focused handler suites to verify RED**

Run:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; for package_dir in cloud/lambdas/adapter-boston-assessments cloud/lambdas/adapter-boston-rentsmart cloud/lambdas/adapter-pvd-taxroll cloud/lambdas/enricher cloud/lambdas/resolver cloud/lambdas/scorer cloud/lambdas/suppression-sync; do (cd "$package_dir" && npm test -- test/handler.test.ts) || exit 1; done
```

Expected: FAIL in every package because completion records do not yet contain `status`. Providence also fails because incomplete normal returns still report zero unprocessed work.

- [ ] **Step 5: Implement the closed shared status type and sanitizer**

Add the exported type near `LogLevel` and replace the current status omission branch:

```ts
export type ScheduledRunStatus = "success" | "failure";

function safeScheduledRunStatus(value: unknown): ScheduledRunStatus | undefined {
  return value === "success" || value === "failure" ? value : undefined;
}
```

In `sanitizeField`:

```ts
case "requestId":
case "pollId":
  return undefined;
case "status":
  return safeScheduledRunStatus(value);
```

Do not accept aliases, case variants, booleans, numbers, objects, or arbitrary strings.

- [ ] **Step 6: Add handler-owned outcome to every package**

In every `createHandler` or `createSafeInvocation`, use this control-flow shape:

```ts
let status: ScheduledRunStatus = "failure";
let result: RunResult | undefined;
try {
  cachedDeps ??= depsFactory();
  result = await handlerWithDeps(event, cachedDeps);
  status = "success";
  return result;
} catch {
  throw new SafeHandlerError();
}
```

In each existing `finally` block, pass `status`, handler-owned elapsed milliseconds, and the exact package fields listed below to the package logger. Import `type ScheduledRunStatus` from `@callie-sourcing/shared` in each handler or logger where the type is declared. Add `status: ScheduledRunStatus` to every package-local completion event type. Add `"status"` to every package completion policy and pass the value to `safeLog`.

Use these exact unprocessed mappings:

```ts
// adapter-boston-assessments
Math.max(0, entitiesScanned - entitiesSwept)

// adapter-boston-rentsmart
0

// adapter-pvd-taxroll
completed ? 0 : 1

// enricher
Math.max(0, requestsSeen - eventsWritten)

// resolver
Math.max(0, personEvents - entitiesResolved)

// scorer
Math.max(0, unscored - scored)

// suppression-sync incremental
Math.max(0, filesSeen - filesProcessed - filesSkipped)

// suppression-sync replay
objectsQuarantined

// suppression-sync reconcile
missingMemberships
```

For suppression-sync, change the helper contract to:

```ts
function logScheduledCompletion(
  status: ScheduledRunStatus,
  result: HandlerResult | SuppressionReplayResult | undefined,
  event: unknown,
  durationMs: number,
): void;
```

Set `status = "success"` only after `run(event)` resolves. Pass `status` through both `suppression_sync_run` and `suppression_scheduled_maintenance_run` event types.

- [ ] **Step 7: Run focused GREEN tests**

Run:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/shared && npm test -- test/safeLog.test.ts)
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; for package_dir in cloud/lambdas/adapter-boston-assessments cloud/lambdas/adapter-boston-rentsmart cloud/lambdas/adapter-pvd-taxroll cloud/lambdas/enricher cloud/lambdas/resolver cloud/lambdas/scorer cloud/lambdas/suppression-sync; do (cd "$package_dir" && npm test -- test/handler.test.ts) || exit 1; done
```

Expected: PASS. Each success and failure path emits exactly one completion record, failures keep safe defaults, and Providence incomplete success emits `unprocessedCount: 1`.

- [ ] **Step 8: Run full affected-package verification**

Run:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/shared && npm run typecheck && npm test)
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; for package_dir in cloud/lambdas/adapter-boston-assessments cloud/lambdas/adapter-boston-rentsmart cloud/lambdas/adapter-pvd-taxroll cloud/lambdas/enricher cloud/lambdas/resolver cloud/lambdas/scorer cloud/lambdas/suppression-sync; do (cd "$package_dir" && npm run typecheck && npm test) || exit 1; done
git diff --check
```

Expected: all eight typechecks and all eight test suites pass. No raw error or PII assertion regresses.

- [ ] **Step 9: Commit exactly Task 1 files**

```bash
git add cloud/lambdas/shared/src/safeLog.ts cloud/lambdas/shared/test/safeLog.test.ts cloud/lambdas/adapter-boston-assessments/src/handler.ts cloud/lambdas/adapter-boston-assessments/src/log.ts cloud/lambdas/adapter-boston-assessments/test/handler.test.ts cloud/lambdas/adapter-boston-rentsmart/src/handler.ts cloud/lambdas/adapter-boston-rentsmart/src/log.ts cloud/lambdas/adapter-boston-rentsmart/test/handler.test.ts cloud/lambdas/adapter-pvd-taxroll/src/handler.ts cloud/lambdas/adapter-pvd-taxroll/src/log.ts cloud/lambdas/adapter-pvd-taxroll/test/handler.test.ts cloud/lambdas/enricher/src/handler.ts cloud/lambdas/enricher/src/log.ts cloud/lambdas/enricher/test/handler.test.ts cloud/lambdas/resolver/src/handler.ts cloud/lambdas/resolver/src/log.ts cloud/lambdas/resolver/test/handler.test.ts cloud/lambdas/scorer/src/handler.ts cloud/lambdas/scorer/src/log.ts cloud/lambdas/scorer/test/handler.test.ts cloud/lambdas/suppression-sync/src/handler.ts cloud/lambdas/suppression-sync/src/log.ts cloud/lambdas/suppression-sync/test/handler.test.ts
git diff --cached --name-only
git commit -m "fix: distinguish scheduled run outcomes"
```

Expected committed paths: exactly the 23 files declared above.

---

### Task 2: Add Safe Observability for the Seven Existing Scheduled Sources

**Files:**
- Modify: `cloud/terraform/variables.tf`
- Modify: `cloud/terraform/adapters.tf`
- Modify: `cloud/terraform/iam.tf`
- Modify: `cloud/terraform/alarms.tf`
- Modify: `cloud/terraform/dashboard.tf`
- Create: `tests/infrastructure/terraformHardening.test.ts`
- Modify: `cloud/README.md`

**Interfaces:**
- Consumes: Task 1 completion records with exact fixed component keys and `status: "success" | "failure"`.
- Produces: `local.adapter_functions` entries with `cadence`, `has_unprocessed_metric`, `timeout`, and `error_description`.
- Produces: `local.scheduled_health_alarm_actions`, which is nonempty only when both safety gates are true.
- Produces: `ScheduledRunSuccess` and `ScheduledRunUnprocessed` metrics in namespace `Callie/Sourcing`, dimensioned by exact component.
- Produces: non-monthly missing-success and applicable persistent-unprocessed alarms.
- Preserves: one Lambda Errors alarm per source and the suppression-specific error description without a duplicate resource.

- [ ] **Step 1: Create the failing brace-aware static Terraform test harness**

Create `tests/infrastructure/terraformHardening.test.ts` with these exact source helpers:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const terraformDirectory = join(process.cwd(), "cloud", "terraform");
const readTerraform = (name: string): string =>
  readFileSync(join(terraformDirectory, name), "utf8");

function extractBlock(source: string, header: string): string {
  const headerIndex = source.indexOf(header);
  if (headerIndex < 0) throw new Error(`missing Terraform block: ${header}`);
  const openIndex = source.indexOf("{", headerIndex + header.length);
  if (openIndex < 0) throw new Error(`missing opening brace: ${header}`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(headerIndex, index + 1);
    }
  }
  throw new Error(`unterminated Terraform block: ${header}`);
}

const SOURCES = {
  "adapter-pvd-taxroll": { cadence: "monthly", timeout: 900, unprocessed: true },
  "adapter-boston-rentsmart": { cadence: "daily", timeout: 900, unprocessed: false },
  "adapter-boston-assessments": { cadence: "monthly", timeout: 900, unprocessed: true },
  scorer: { cadence: "quarter_hour", timeout: 600, unprocessed: true },
  resolver: { cadence: "hourly", timeout: 300, unprocessed: true },
  enricher: { cadence: "quarter_hour", timeout: 300, unprocessed: true },
  "suppression-sync": { cadence: "quarter_hour", timeout: 60, unprocessed: true },
} as const;
```

Add failing tests with these exact names:

- `defaults schedules and scheduled health notifications to disabled`
- `declares exact cadence timeout and unprocessed metadata for seven sources`
- `keeps every adapter EventBridge rule behind the schedule gate`
- `grants the shared role the resolver log ARN exactly once`
- `turns only successful completion records into component metrics`
- `creates one Errors one Throttles and one p95 duration alarm per source`
- `uses exact non-monthly missing-success windows and dual-gated actions`
- `uses two-period Minimum backlog alarms only where meaningful`
- `does not duplicate the suppression-sync Errors alarm`
- `shows distinct seven-source invocation error throttle duration success and work series`
- `documents source-only verification without saved plans JSON rendering or secrets`

Each test body must call `readTerraform` or `extractBlock` and make the source assertions specified in Steps 3 through 9. The exact matrices are:

```ts
const MISSING = {
  quarter_hour: { period: 300, evaluationPeriods: 6, datapoints: 6 },
  hourly: { period: 600, evaluationPeriods: 12, datapoints: 12 },
  daily: { period: 3600, evaluationPeriods: 48, datapoints: 48 },
} as const;

const PERSISTENT = {
  quarter_hour: { period: 900 },
  hourly: { period: 3600 },
  daily: { period: 86400 },
} as const;
```

For metric filters, assert the pattern contains both `$.eventCode = "SCHEDULED_RUN_COMPLETED"` and `$.status = "success"`. Assert all seven sources have both filters. Assert the unprocessed transformation uses `value = "$.unprocessedCount"`, has `dimensions = { Component = "$.component" }`, and does not contain `default_value`. Assert monthly keys are absent from standard missing and persistent `for_each` maps.

- [ ] **Step 2: Run the static test to verify RED**

Run:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/infrastructure/terraformHardening.test.ts
```

Expected: FAIL on true schedule default, absent health gate, absent resolver ARN, absent metadata, absent filters and alarms, incomplete dashboard, and unsafe saved-plan documentation.

- [ ] **Step 3: Add exact source metadata and disabled defaults**

In `variables.tf`, make omission safe:

```hcl
variable "schedules_enabled" {
  description = "Master switch for every scheduled sourcing and watchdog EventBridge rule. Keep false until an approved production rollout."
  type        = bool
  default     = false
}

variable "scheduled_health_alerts_enabled" {
  description = "Enables notification actions for scheduled missing-success and persistent-work health alarms after an approved baseline."
  type        = bool
  default     = false
}
```

In every `local.adapter_functions` entry, add exact metadata. Use these values:

```hcl
cadence                 = "monthly"      # Providence, Boston assessments
cadence                 = "daily"        # RentSmart
cadence                 = "quarter_hour" # scorer, enricher, suppression-sync
cadence                 = "hourly"       # resolver
has_unprocessed_metric  = true            # all except RentSmart
has_unprocessed_metric  = false           # RentSmart only
```

Add `error_description` to every entry. Suppression-sync must retain:

```hcl
error_description = "Suppression sync or replay failed; outbound enrichment must remain paused."
```

Use these exact descriptions for the other six entries:

```hcl
# adapter-pvd-taxroll
error_description = "Sourcing adapter-pvd-taxroll Lambda failed."
# adapter-boston-rentsmart
error_description = "Sourcing adapter-boston-rentsmart Lambda failed."
# adapter-boston-assessments
error_description = "Sourcing adapter-boston-assessments Lambda failed."
# scorer
error_description = "Sourcing scorer Lambda failed."
# resolver
error_description = "Sourcing resolver Lambda failed."
# enricher
error_description = "Sourcing enricher Lambda failed."
```

- [ ] **Step 4: Restore resolver logging and define safe alarm maps**

Add exactly one resolver log resource in `iam.tf`:

```hcl
"arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${var.name_prefix}-resolver*",
```

At the top of `alarms.tf`, define:

```hcl
locals {
  scheduled_health_alarm_actions = var.schedules_enabled && var.scheduled_health_alerts_enabled ? [aws_sns_topic.alerts.arn] : []

  missing_success_cadences = {
    quarter_hour = { period = 300, evaluation_periods = 6, datapoints_to_alarm = 6 }
    hourly       = { period = 600, evaluation_periods = 12, datapoints_to_alarm = 12 }
    daily        = { period = 3600, evaluation_periods = 48, datapoints_to_alarm = 48 }
  }

  persistent_unprocessed_cadences = {
    quarter_hour = { period = 900 }
    hourly       = { period = 3600 }
    daily        = { period = 86400 }
  }

  non_monthly_sources = {
    for key, source in local.adapter_functions : key => merge(
      source,
      lookup(local.missing_success_cadences, source.cadence, {}),
    )
    if source.cadence != "monthly"
  }

  non_monthly_unprocessed_sources = {
    for key, source in local.adapter_functions : key => merge(
      source,
      lookup(local.persistent_unprocessed_cadences, source.cadence, {}),
    )
    if source.cadence != "monthly" && source.has_unprocessed_metric
  }
}
```

- [ ] **Step 5: Add successful-completion metric filters**

Create one success filter and one unprocessed filter per source:

```hcl
resource "aws_cloudwatch_log_metric_filter" "scheduled_run_success" {
  for_each = local.adapter_functions

  name           = "${var.name_prefix}-${each.key}-scheduled-run-success"
  log_group_name = aws_cloudwatch_log_group.adapters[each.key].name
  pattern        = "{ $.eventCode = \"SCHEDULED_RUN_COMPLETED\" && $.status = \"success\" }"

  metric_transformation {
    name       = "ScheduledRunSuccess"
    namespace  = "Callie/Sourcing"
    value      = "1"
    unit       = "Count"
    dimensions = { Component = "$.component" }
  }
}

resource "aws_cloudwatch_log_metric_filter" "scheduled_run_unprocessed" {
  for_each = local.adapter_functions

  name           = "${var.name_prefix}-${each.key}-scheduled-run-unprocessed"
  log_group_name = aws_cloudwatch_log_group.adapters[each.key].name
  pattern        = "{ $.eventCode = \"SCHEDULED_RUN_COMPLETED\" && $.status = \"success\" && $.unprocessedCount = * }"

  metric_transformation {
    name       = "ScheduledRunUnprocessed"
    namespace  = "Callie/Sourcing"
    value      = "$.unprocessedCount"
    unit       = "Count"
    dimensions = { Component = "$.component" }
  }
}
```

Do not define `default_value`.

- [ ] **Step 6: Replace duplicate and incomplete base alarms**

Delete the standalone `aws_cloudwatch_metric_alarm.suppression_sync_errors`. Keep one generic Errors resource keyed by all seven sources. Give Errors and Throttles exact five-minute semantics and both alarm and recovery actions:

```hcl
resource "aws_cloudwatch_metric_alarm" "adapter_errors" {
  for_each = local.adapter_functions

  alarm_name          = "${var.name_prefix}-${each.key}-errors"
  alarm_description   = each.value.error_description
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.adapters[each.key].function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
```

Create the matching Throttles resource:

```hcl
resource "aws_cloudwatch_metric_alarm" "adapter_throttles" {
  for_each = local.adapter_functions

  alarm_name          = "${var.name_prefix}-${each.key}-throttles"
  alarm_description   = "Sourcing ${each.key} Lambda was throttled."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = aws_lambda_function.adapters[each.key].function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
```

Create p95 near-timeout alarms:

```hcl
resource "aws_cloudwatch_metric_alarm" "adapter_near_timeout" {
  for_each = local.adapter_functions

  alarm_name                              = "${var.name_prefix}-${each.key}-near-timeout"
  alarm_description                       = "Sourcing ${each.key} p95 duration reached 90 percent of its Lambda timeout."
  namespace                               = "AWS/Lambda"
  metric_name                             = "Duration"
  dimensions                              = { FunctionName = aws_lambda_function.adapters[each.key].function_name }
  extended_statistic                      = "p95"
  period                                  = 300
  evaluation_periods                      = 1
  threshold                               = each.value.timeout * 1000 * 0.90
  comparison_operator                     = "GreaterThanOrEqualToThreshold"
  treat_missing_data                      = "notBreaching"
  evaluate_low_sample_count_percentiles   = "evaluate"
  alarm_actions                           = [aws_sns_topic.alerts.arn]
  ok_actions                              = [aws_sns_topic.alerts.arn]
}
```

- [ ] **Step 7: Add exact non-monthly health alarms**

Add missing-success alarms:

```hcl
resource "aws_cloudwatch_metric_alarm" "scheduled_missing_success" {
  for_each = local.non_monthly_sources

  alarm_name          = "${var.name_prefix}-${each.key}-missing-success"
  alarm_description   = "No successful ${each.key} completion was observed within twice its expected cadence."
  namespace           = "Callie/Sourcing"
  metric_name         = "ScheduledRunSuccess"
  dimensions          = { Component = each.key }
  statistic           = "Sum"
  period              = each.value.period
  evaluation_periods  = each.value.evaluation_periods
  datapoints_to_alarm = each.value.datapoints_to_alarm
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.scheduled_health_alarm_actions
  ok_actions          = local.scheduled_health_alarm_actions
}
```

Add persistent work alarms:

```hcl
resource "aws_cloudwatch_metric_alarm" "scheduled_persistent_unprocessed" {
  for_each = local.non_monthly_unprocessed_sources

  alarm_name          = "${var.name_prefix}-${each.key}-persistent-unprocessed"
  alarm_description   = "${each.key} reported positive unprocessed work in two consecutive expected periods."
  namespace           = "Callie/Sourcing"
  metric_name         = "ScheduledRunUnprocessed"
  dimensions          = { Component = each.key }
  statistic           = "Minimum"
  period              = each.value.period
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.scheduled_health_alarm_actions
  ok_actions          = local.scheduled_health_alarm_actions
}
```

RentSmart and both monthly sources must not enter the persistent alarm map. Both monthly sources must not enter the standard missing-success map.

- [ ] **Step 8: Complete seven-source dashboard coverage**

Keep the existing Invocations, Errors, and p95 Duration widgets. Add a Throttles widget over all seven `aws_lambda_function.adapters` entries. Add successful-run and unprocessed-work widgets using exact component dimensions:

```hcl
metrics = [for key in keys(local.adapter_functions) :
  ["Callie/Sourcing", "ScheduledRunSuccess", "Component", key]
]
```

For unprocessed work, iterate only sources where `has_unprocessed_metric` is true. Do not use a metric-math expression that merges components into one series.

- [ ] **Step 9: Replace unsafe cloud verification guidance**

In `cloud/README.md`:

1. Expand the layout to mention all scheduled packages and the future `schedule-watchdog` package.
2. Replace the current saved-plan and apply example with a section titled `Local source verification only`.
3. Include only these implementation-time commands:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/infrastructure/terraformHardening.test.ts
tofu fmt -check -recursive cloud/terraform
```

4. State that live planning is deferred until trusted managed state and managed secret identifiers exist, needs separate founder approval, must keep both gates false, must use a human-readable unsaved plan, and must retain only a sanitized summary.
5. Explicitly forbid saved plans, JSON rendering, raw Terraform secret variables, and backend-disabled create-only plans as proof of live safety.

- [ ] **Step 10: Run source-level GREEN verification**

Run:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/infrastructure/terraformHardening.test.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run typecheck
tofu fmt -check -recursive cloud/terraform
git diff --check
```

Expected: static tests and root typecheck pass, HCL is formatted, no provider or AWS access occurs, and no plan artifact is created.

- [ ] **Step 11: Commit exactly Task 2 files**

```bash
git add cloud/terraform/variables.tf cloud/terraform/adapters.tf cloud/terraform/iam.tf cloud/terraform/alarms.tf cloud/terraform/dashboard.tf tests/infrastructure/terraformHardening.test.ts cloud/README.md
git diff --cached --name-only
git commit -m "feat: add safe scheduled source observability"
```

Expected committed paths: exactly the seven files declared above.

---

### Task 3: Build the Pure Monthly Calendar Health Evaluator

**Files:**
- Create: `cloud/lambdas/schedule-watchdog/package.json`
- Create: `cloud/lambdas/schedule-watchdog/package-lock.json`
- Create: `cloud/lambdas/schedule-watchdog/tsconfig.json`
- Create: `cloud/lambdas/schedule-watchdog/vitest.config.ts`
- Create: `cloud/lambdas/schedule-watchdog/src/monthlyHealth.ts`
- Create: `cloud/lambdas/schedule-watchdog/test/monthlyHealth.test.ts`

**Interfaces:**
- Consumes: no AWS client and no environment variables.
- Produces: closed `MONTHLY_TARGETS` with Providence day 1 at 09:00 UTC and Boston assessments day 2 at 11:00 UTC, each with six-hour grace.
- Produces: `eligibleDueInstants(target, now): readonly [Date, Date]` returning `[olderDue, newerDue]`.
- Produces: `evaluateMonthlyHealth(target, samples, now): MonthlyHealthEvaluation`.
- Produces: failure when any successful window lacks an unprocessed sample.

- [ ] **Step 1: Scaffold the isolated package and lockfile**

Create `package.json`:

```json
{
  "name": "callie-sourcing-schedule-watchdog",
  "version": "1.0.0",
  "private": true,
  "description": "Calendar-aware monthly health evaluation for scheduled sourcing functions",
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@callie-sourcing/shared": "file:../shared"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

Use these exact `tsconfig.json` contents:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src", "test"]
}
```

Use these exact `vitest.config.ts` contents:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
```

Install the isolated package toolchain and generate only this package's tracked lockfile:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/schedule-watchdog && npm install --ignore-scripts)
```

- [ ] **Step 2: Write failing calendar and health tests**

Define test helpers:

```ts
const sample = (iso: string, value: number): MetricSample => ({
  timestamp: new Date(iso),
  value,
});

const samples = (
  success: readonly MetricSample[],
  unprocessed: readonly MetricSample[],
): MonthlyTargetSamples => ({ success, unprocessed });
```

Cover these exact cases in `monthlyHealth.test.ts`:

1. January to December year rollover.
2. February in a 28-day year.
3. February 29 in a leap year.
4. 30-day to 31-day month transitions.
5. Six-hour grace boundary one millisecond before and exactly at eligibility.
6. Both windows without success gives `missingSuccess: true`.
7. Older success plus missing newer success gives `missingSuccess: false`.
8. Manual retry success inside the newer window counts.
9. Positive minimum unprocessed in both successful windows gives `persistentUnprocessed: true`.
10. Any zero sample in either successful window clears persistence.
11. A success in either window without any unprocessed sample in that window throws.
12. Samples at `olderDue` and `newerDue` obey `[olderDue, newerDue)` and `[newerDue, now]` exactly.
13. Invalid timestamps, negative values, `NaN`, and infinity throw.

Representative assertion:

```ts
it("detects two missed monthly expected runs", () => {
  const result = evaluateMonthlyHealth(
    MONTHLY_TARGETS[0],
    samples([], []),
    new Date("2026-09-10T18:00:00.000Z"),
  );
  expect(result).toMatchObject({
    component: "adapter-pvd-taxroll",
    missingSuccess: true,
    persistentUnprocessed: false,
  });
  expect(result.olderDue.toISOString()).toBe("2026-08-01T09:00:00.000Z");
  expect(result.newerDue.toISOString()).toBe("2026-09-01T09:00:00.000Z");
});
```

- [ ] **Step 3: Run evaluator tests to verify RED**

Run:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/schedule-watchdog && npm test -- test/monthlyHealth.test.ts)
```

Expected: FAIL because `src/monthlyHealth.ts` does not exist.

- [ ] **Step 4: Implement the closed targets and exact calendar windows**

Create these public contracts:

```ts
const HOUR_MS = 60 * 60 * 1000;

export const MONTHLY_TARGETS = [
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

export type MonthlyTarget = (typeof MONTHLY_TARGETS)[number];

export interface MetricSample {
  timestamp: Date;
  value: number;
}

export interface MonthlyTargetSamples {
  success: readonly MetricSample[];
  unprocessed: readonly MetricSample[];
}

export interface MonthlyHealthEvaluation {
  component: MonthlyTarget["component"];
  olderDue: Date;
  newerDue: Date;
  missingSuccess: boolean;
  persistentUnprocessed: boolean;
}
```

Use UTC month arithmetic only:

```ts
function scheduledInstant(target: MonthlyTarget, year: number, monthIndex: number): Date {
  return new Date(Date.UTC(
    year,
    monthIndex,
    target.dayOfMonth,
    target.hourUtc,
    target.minuteUtc,
    0,
    0,
  ));
}

function previousMonth(target: MonthlyTarget, instant: Date): Date {
  return scheduledInstant(target, instant.getUTCFullYear(), instant.getUTCMonth() - 1);
}

export function eligibleDueInstants(
  target: MonthlyTarget,
  now: Date,
): readonly [Date, Date] {
  assertValidDate(now);
  let newerDue = scheduledInstant(target, now.getUTCFullYear(), now.getUTCMonth());
  if (newerDue.getTime() + target.graceHours * HOUR_MS > now.getTime()) {
    newerDue = previousMonth(target, newerDue);
  }
  return [previousMonth(target, newerDue), newerDue] as const;
}
```

Evaluate windows exactly:

```ts
const olderSuccess = positiveValuesInWindow(samples.success, olderDue, newerDue, false);
const newerSuccess = positiveValuesInWindow(samples.success, newerDue, now, true);
const olderUnprocessed = valuesInWindow(samples.unprocessed, olderDue, newerDue, false);
const newerUnprocessed = valuesInWindow(samples.unprocessed, newerDue, now, true);

if (olderSuccess.length > 0 && olderUnprocessed.length === 0) {
  throw new Error("missing unprocessed metric for successful older monthly window");
}
if (newerSuccess.length > 0 && newerUnprocessed.length === 0) {
  throw new Error("missing unprocessed metric for successful newer monthly window");
}

return {
  component: target.component,
  olderDue,
  newerDue,
  missingSuccess: olderSuccess.length === 0 && newerSuccess.length === 0,
  persistentUnprocessed:
    olderSuccess.length > 0 &&
    newerSuccess.length > 0 &&
    Math.min(...olderUnprocessed) > 0 &&
    Math.min(...newerUnprocessed) > 0,
};
```

Validate every sample before filtering. Require a valid `Date`, finite numeric value, and value greater than or equal to zero.

- [ ] **Step 5: Run evaluator GREEN verification**

Run:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/schedule-watchdog && npm run typecheck && npm test)
git diff --check
```

Expected: typecheck and all pure evaluator tests pass without AWS dependencies or network calls.

- [ ] **Step 6: Commit exactly Task 3 files**

```bash
git add cloud/lambdas/schedule-watchdog/package.json cloud/lambdas/schedule-watchdog/package-lock.json cloud/lambdas/schedule-watchdog/tsconfig.json cloud/lambdas/schedule-watchdog/vitest.config.ts cloud/lambdas/schedule-watchdog/src/monthlyHealth.ts cloud/lambdas/schedule-watchdog/test/monthlyHealth.test.ts
git diff --cached --name-only
git commit -m "feat: evaluate monthly scheduled health"
```

Expected committed paths: exactly the six files declared above.

---

### Task 4: Add CloudWatch Metric I/O and the Safe Watchdog Handler

**Files:**
- Modify: `cloud/lambdas/schedule-watchdog/package.json`
- Modify: `cloud/lambdas/schedule-watchdog/package-lock.json`
- Create: `cloud/lambdas/schedule-watchdog/build.mjs`
- Create: `cloud/lambdas/schedule-watchdog/src/cloudWatchMetrics.ts`
- Create: `cloud/lambdas/schedule-watchdog/src/log.ts`
- Create: `cloud/lambdas/schedule-watchdog/src/handler.ts`
- Create: `cloud/lambdas/schedule-watchdog/test/cloudWatchMetrics.test.ts`
- Create: `cloud/lambdas/schedule-watchdog/test/handler.test.ts`

**Interfaces:**
- Consumes: Task 3 `MONTHLY_TARGETS`, `MonthlyTargetSamples`, and `evaluateMonthlyHealth`.
- Consumes: Task 1 `ScheduledRunStatus` and `SafeHandlerError`.
- Produces: `loadMonthlyMetricHistory(cloudwatch, now): Promise<MonthlyMetricHistory>`.
- Produces: `publishMonthlyHealth(cloudwatch, evaluations, now): Promise<void>`.
- Produces: `runWatchdog(deps): Promise<WatchdogResult>`.
- Produces: unchanged exported Lambda shape `handler(): Promise<WatchdogResult>`.
- Produces: exactly one safe completion record with component `schedule-watchdog` per invocation.

- [ ] **Step 1: Add the CloudWatch SDK and build contract**

Update `package.json`:

```json
{
  "name": "callie-sourcing-schedule-watchdog",
  "version": "1.0.0",
  "private": true,
  "description": "Calendar-aware monthly health evaluation for scheduled sourcing functions",
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "build": "node build.mjs",
    "prebuild": "npm run typecheck"
  },
  "dependencies": {
    "@aws-sdk/client-cloudwatch": "^3.700.0",
    "@callie-sourcing/shared": "file:../shared"
  },
  "devDependencies": {
    "@types/aws-lambda": "^8.10.145",
    "@types/node": "^22.10.0",
    "esbuild": "^0.24.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

Regenerate the package lock:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/schedule-watchdog && npm install --ignore-scripts)
```

Create `build.mjs` with the same bundling policy as resolver:

```js
import { build } from "esbuild";

await build({
  entryPoints: ["src/handler.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist/handler.js",
  sourcemap: false,
  minify: false,
  logLevel: "info",
});
```

- [ ] **Step 2: Write failing CloudWatch pagination and publication tests**

In `cloudWatchMetrics.test.ts`, use a fake `send` implementation that records command constructor names and inputs. Cover:

1. Exactly four `MetricDataQueries`, two metrics for each closed monthly component.
2. Namespace `Callie/Sourcing`, exact `Component` dimension, hourly `Period = 3600`.
3. `ScheduledRunSuccess` uses `Stat = "Sum"`.
4. `ScheduledRunUnprocessed` uses `Stat = "Minimum"`.
5. `StartTime = now - 70 days`, `EndTime = now`, and `ScanBy = "TimestampAscending"`.
6. Pagination continues with `NextToken` and merges pages.
7. Returned timestamp and value arrays must have equal lengths.
8. Every result status must be `Complete` or `PartialData`; `PartialData` is accepted only on a response that also has `NextToken`, and every expected query must reach `Complete` before pagination ends. Global response messages must be absent.
9. Unknown query IDs, invalid timestamps, non-finite values, and negative values fail closed.
10. Samples are sorted ascending after page merge.
11. Publication is one `PutMetricDataCommand` with exactly four data points, each value exactly `0` or `1`, `Unit = "Count"`, exact component dimension, and shared evaluation timestamp.
12. Read and publish errors propagate internally without copying messages into returned structures.

Representative query contract:

```ts
{
  Id: "target0success",
  ReturnData: true,
  MetricStat: {
    Metric: {
      Namespace: "Callie/Sourcing",
      MetricName: "ScheduledRunSuccess",
      Dimensions: [{ Name: "Component", Value: "adapter-pvd-taxroll" }],
    },
    Period: 3600,
    Stat: "Sum",
  },
}
```

Representative published data:

```ts
{
  MetricName: "MonthlyMissingSuccess",
  Dimensions: [{ Name: "Component", Value: evaluation.component }],
  Timestamp: now,
  Unit: "Count",
  Value: evaluation.missingSuccess ? 1 : 0,
}
```

- [ ] **Step 3: Write failing handler-boundary tests**

In `handler.test.ts`, cover:

1. Both targets evaluated, one publish call, `targetsEvaluated = 2`.
2. `unhealthyGaugeCount` equals the number of 1-valued gauges, not the number of unhealthy targets.
3. A read failure yields a fresh `SafeHandlerError` and one `status: "failure"` completion.
4. Missing unprocessed data after success yields a fresh `SafeHandlerError` and no publication.
5. A publish failure yields a fresh `SafeHandlerError` and one `status: "failure"` completion.
6. Success yields one `status: "success"` completion with `count = 2`.
7. Handler-owned monotonic timing includes cold dependency creation, rounds fractional milliseconds, and excludes warm idle time.
8. Logs and outward errors exclude raw AWS names, messages, causes, emails, phones, person names, credentials, and payloads.

Use the existing fixed boundary expectation:

```ts
expect(error.name).toBe("SafeHandlerError");
expect(error.message).toBe("Cloud handler invocation failed");
expect(Object.getOwnPropertyNames(error).sort()).toEqual(["message", "name", "stack"].sort());
expect(error).not.toHaveProperty("cause");
```

- [ ] **Step 4: Run both new suites to verify RED**

Run:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/schedule-watchdog && npm test -- test/cloudWatchMetrics.test.ts test/handler.test.ts)
```

Expected: FAIL because metric I/O and handler modules do not exist.

- [ ] **Step 5: Implement metric query IDs, pagination, and validation**

Create `cloudWatchMetrics.ts` with exact public contracts:

```ts
import {
  GetMetricDataCommand,
  PutMetricDataCommand,
  type CloudWatchClient,
  type MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";
import {
  MONTHLY_TARGETS,
  type MetricSample,
  type MonthlyHealthEvaluation,
  type MonthlyTargetSamples,
} from "./monthlyHealth";

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 70;

export type MonthlyMetricHistory = Readonly<Record<
  (typeof MONTHLY_TARGETS)[number]["component"],
  MonthlyTargetSamples
>>;

export type CloudWatchSender = Pick<CloudWatchClient, "send">;

export async function loadMonthlyMetricHistory(
  cloudwatch: CloudWatchSender,
  now: Date,
): Promise<MonthlyMetricHistory>;

export async function publishMonthlyHealth(
  cloudwatch: CloudWatchSender,
  evaluations: readonly MonthlyHealthEvaluation[],
  now: Date,
): Promise<void>;
```

Use stable query IDs `target0success`, `target0unprocessed`, `target1success`, and `target1unprocessed`. Send the same query set, start, end, scan order, and any returned `NextToken` until pagination ends. Reject any nonempty top-level `Messages`. Accept only `Complete` or `PartialData` result status, accept `PartialData` only when that response also returns `NextToken`, require every expected ID to reach `Complete` before pagination ends, and reject any unexpected ID. Pair timestamps and values only when array lengths match, validate every point, merge all pages, and sort ascending.

Publish all four gauges in one call:

```ts
await cloudwatch.send(new PutMetricDataCommand({
  Namespace: "Callie/Sourcing",
  MetricData: evaluations.flatMap((evaluation) => [
    {
      MetricName: "MonthlyMissingSuccess",
      Dimensions: [{ Name: "Component", Value: evaluation.component }],
      Timestamp: now,
      Unit: "Count",
      Value: evaluation.missingSuccess ? 1 : 0,
    },
    {
      MetricName: "MonthlyPersistentUnprocessed",
      Dimensions: [{ Name: "Component", Value: evaluation.component }],
      Timestamp: now,
      Unit: "Count",
      Value: evaluation.persistentUnprocessed ? 1 : 0,
    },
  ]),
}));
```

- [ ] **Step 6: Implement the closed watchdog logger**

Create `src/log.ts`:

```ts
import {
  createSafeLogger,
  defineLogPolicy,
  type LogLevel,
  type ScheduledRunStatus,
} from "@callie-sourcing/shared";

interface WatchdogCompletion {
  status: ScheduledRunStatus;
  durationMs: number;
  targetsEvaluated: number;
  unhealthyGaugeCount: number;
}

const safeLog = createSafeLogger(defineLogPolicy({
  component: "schedule-watchdog",
  events: {
    SCHEDULED_RUN_COMPLETED: ["status", "durationMs", "count", "unprocessedCount"],
  },
}));

export function logScheduledRunCompleted(
  level: LogLevel,
  completion: WatchdogCompletion,
): void {
  safeLog(level, "SCHEDULED_RUN_COMPLETED", {
    status: completion.status,
    durationMs: completion.durationMs,
    count: completion.targetsEvaluated,
    unprocessedCount: completion.unhealthyGaugeCount,
  });
}
```

- [ ] **Step 7: Implement orchestration and the fresh safe boundary**

Create `src/handler.ts`:

```ts
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import {
  SafeHandlerError,
  type ScheduledRunStatus,
} from "@callie-sourcing/shared";
import {
  loadMonthlyMetricHistory,
  publishMonthlyHealth,
  type CloudWatchSender,
} from "./cloudWatchMetrics";
import {
  MONTHLY_TARGETS,
  evaluateMonthlyHealth,
} from "./monthlyHealth";
import { logScheduledRunCompleted } from "./log";

export interface HandlerDeps {
  cloudwatch: CloudWatchSender;
  now?: () => Date;
}

export interface WatchdogResult {
  targetsEvaluated: number;
  unhealthyGaugeCount: number;
}

export async function runWatchdog(deps: HandlerDeps): Promise<WatchdogResult> {
  const now = deps.now?.() ?? new Date();
  const history = await loadMonthlyMetricHistory(deps.cloudwatch, now);
  const evaluations = MONTHLY_TARGETS.map((target) =>
    evaluateMonthlyHealth(target, history[target.component], now));
  await publishMonthlyHealth(deps.cloudwatch, evaluations, now);
  return {
    targetsEvaluated: evaluations.length,
    unhealthyGaugeCount: evaluations.reduce(
      (count, evaluation) => count + Number(evaluation.missingSuccess) + Number(evaluation.persistentUnprocessed),
      0,
    ),
  };
}

function defaultDeps(): HandlerDeps {
  return { cloudwatch: new CloudWatchClient({}) };
}

export function createHandler(
  depsFactory: () => HandlerDeps,
  monotonicNow: () => number = () => performance.now(),
): () => Promise<WatchdogResult> {
  let cachedDeps: HandlerDeps | null = null;
  return async () => {
    const startedAt = monotonicNow();
    let status: ScheduledRunStatus = "failure";
    let result: WatchdogResult | undefined;
    try {
      cachedDeps ??= depsFactory();
      result = await runWatchdog(cachedDeps);
      status = "success";
      return result;
    } catch {
      throw new SafeHandlerError();
    } finally {
      logScheduledRunCompleted(status === "success" ? "info" : "error", {
        status,
        durationMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
        targetsEvaluated: result?.targetsEvaluated ?? 0,
        unhealthyGaugeCount: result?.unhealthyGaugeCount ?? 0,
      });
    }
  };
}

const productionHandler = createHandler(defaultDeps);

export async function handler(): Promise<WatchdogResult> {
  return productionHandler();
}
```

- [ ] **Step 8: Run focused and full package GREEN verification**

Run:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/schedule-watchdog && npm test -- test/cloudWatchMetrics.test.ts test/handler.test.ts)
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/schedule-watchdog && npm run typecheck && npm test && npm run build)
git diff --check
```

Expected: all watchdog tests pass, the Node.js 22 CommonJS bundle is created locally, and no AWS call occurs because every test injects a fake sender.

- [ ] **Step 9: Inspect the bundle export without executing provider calls**

Run:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/schedule-watchdog && node -e 'const bundle = require("./dist/handler.js"); if (typeof bundle.handler !== "function") process.exit(1); console.log("schedule-watchdog handler export: ok")')
```

Expected: `schedule-watchdog handler export: ok`. Do not invoke `handler()`.

- [ ] **Step 10: Commit exactly Task 4 source files**

Do not stage `dist/`.

```bash
git add cloud/lambdas/schedule-watchdog/package.json cloud/lambdas/schedule-watchdog/package-lock.json cloud/lambdas/schedule-watchdog/build.mjs cloud/lambdas/schedule-watchdog/src/cloudWatchMetrics.ts cloud/lambdas/schedule-watchdog/src/log.ts cloud/lambdas/schedule-watchdog/src/handler.ts cloud/lambdas/schedule-watchdog/test/cloudWatchMetrics.test.ts cloud/lambdas/schedule-watchdog/test/handler.test.ts
git diff --cached --name-only
git commit -m "feat: add monthly health watchdog Lambda"
```

Expected committed paths: exactly the eight files declared above.

---

### Task 5: Wire the Watchdog, Monthly Alarms, and Complete Dashboard

**Files:**
- Create: `cloud/terraform/watchdog.tf`
- Modify: `cloud/terraform/iam.tf`
- Modify: `cloud/terraform/alarms.tf`
- Modify: `cloud/terraform/dashboard.tf`
- Modify: `tests/infrastructure/terraformHardening.test.ts`
- Modify: `cloud/README.md`

**Interfaces:**
- Consumes: Task 4 bundle entry `cloud/lambdas/schedule-watchdog/dist/handler.js` with exported `handler`.
- Consumes: Task 2 `local.scheduled_health_alarm_actions` and source metrics.
- Produces: daily 18:00 UTC watchdog rule gated by `schedules_enabled`.
- Produces: dedicated role with only own logs, `cloudwatch:GetMetricData`, and namespace-restricted `cloudwatch:PutMetricData`.
- Produces: watchdog base alarms, a 48-hour watchdog heartbeat alarm, and two daily 0/1 gauge alarms for each monthly target.
- Produces: dashboard coverage for all seven sources, the watchdog, and both monthly gauge families.

- [ ] **Step 1: Extend static tests with failing watchdog infrastructure assertions**

Add `WATCHDOG_COMPONENT = "schedule-watchdog"` and `MONTHLY_COMPONENTS`:

```ts
const WATCHDOG_COMPONENT = "schedule-watchdog";
const MONTHLY_COMPONENTS = [
  "adapter-pvd-taxroll",
  "adapter-boston-assessments",
] as const;
```

Add these exact test names:

- `packages a Node 22 watchdog behind a disabled daily 18 UTC rule`
- `gives the watchdog only own logs GetMetricData and namespace-bound PutMetricData`
- `creates watchdog success and unprocessed metric filters`
- `creates one watchdog Errors Throttles p95 duration and 48-hour heartbeat alarm`
- `creates daily Maximum monthly health alarms for both monthly targets`
- `dual-gates every monthly health alarm action and treats missing gauges as nonbreaching`
- `adds distinct watchdog and monthly gauges to the dashboard`
- `documents watchdog build and preserves the future explicit hold point`

Each test body must read `watchdog.tf`, `iam.tf`, `alarms.tf`, `dashboard.tf`, or `cloud/README.md` and make the exact assertions below.

- `runtime = "nodejs22.x"`, `handler = "handler.handler"`, `architectures = ["arm64"]`, `timeout = 60`, `memory_size = 256`.
- Watchdog schedule expression is exactly `cron(0 18 * * ? *)` and state is exactly `var.schedules_enabled ? "ENABLED" : "DISABLED"`.
- IAM actions are exactly own CloudWatch Logs stream and event writes, `cloudwatch:GetMetricData`, and `cloudwatch:PutMetricData`.
- There are no S3, DynamoDB, SNS, SES, Route53, Tracerfy, or provider-data actions in the watchdog policy.
- `PutMetricData` has `StringEquals` condition `cloudwatch:namespace = ["Callie/Sourcing"]`.
- Watchdog base alarm semantics match source base alarms.
- Watchdog missing-success uses 3600-second periods, 48 evaluation periods, 48 datapoints, threshold 1, `LessThanThreshold`, and missing breaching.
- Monthly gauge alarms use `Maximum >= 1`, period 86400, one evaluation period, and missing non-breaching.
- Monthly alarm and recovery actions use `local.scheduled_health_alarm_actions`.
- The dashboard lists watchdog function metrics and both monthly target dimensions separately.

- [ ] **Step 2: Run watchdog infrastructure tests to verify RED**

Run:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/infrastructure/terraformHardening.test.ts
```

Expected: Task 2 assertions pass and new watchdog assertions fail because watchdog resources do not exist.

- [ ] **Step 3: Create the watchdog Lambda and disabled daily schedule**

Create `cloud/terraform/watchdog.tf`:

```hcl
data "archive_file" "schedule_watchdog" {
  type        = "zip"
  source_dir  = "${path.module}/../lambdas/schedule-watchdog/dist"
  output_path = "${path.module}/.build/schedule-watchdog.zip"
}

resource "aws_lambda_function" "schedule_watchdog" {
  function_name = "${var.name_prefix}-schedule-watchdog"
  role          = aws_iam_role.lambda_schedule_watchdog.arn

  filename         = data.archive_file.schedule_watchdog.output_path
  source_code_hash = data.archive_file.schedule_watchdog.output_base64sha256

  runtime       = "nodejs22.x"
  handler       = "handler.handler"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 60
}

resource "aws_cloudwatch_log_group" "schedule_watchdog" {
  name              = "/aws/lambda/${aws_lambda_function.schedule_watchdog.function_name}"
  retention_in_days = 30
}

resource "aws_cloudwatch_event_rule" "schedule_watchdog" {
  name                = "${var.name_prefix}-schedule-watchdog-schedule"
  schedule_expression = "cron(0 18 * * ? *)"
  state               = var.schedules_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "schedule_watchdog" {
  rule = aws_cloudwatch_event_rule.schedule_watchdog.name
  arn  = aws_lambda_function.schedule_watchdog.arn
}

resource "aws_lambda_permission" "schedule_watchdog_events" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.schedule_watchdog.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.schedule_watchdog.arn
}
```

- [ ] **Step 4: Add the dedicated least-privilege role**

Append to `iam.tf`:

```hcl
resource "aws_iam_role" "lambda_schedule_watchdog" {
  name               = "${var.name_prefix}-lambda-schedule-watchdog"
  path               = var.iam_path
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "lambda_schedule_watchdog" {
  statement {
    sid    = "Logs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${var.name_prefix}-schedule-watchdog*",
    ]
  }

  statement {
    sid       = "ReadScheduledHealthMetrics"
    effect    = "Allow"
    actions   = ["cloudwatch:GetMetricData"]
    resources = ["*"]
  }

  statement {
    sid       = "PublishMonthlyHealthMetrics"
    effect    = "Allow"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["Callie/Sourcing"]
    }
  }
}

resource "aws_iam_role_policy" "lambda_schedule_watchdog" {
  name   = "${var.name_prefix}-lambda-schedule-watchdog"
  role   = aws_iam_role.lambda_schedule_watchdog.id
  policy = data.aws_iam_policy_document.lambda_schedule_watchdog.json
}
```

Do not grant SNS. Alarms own notification delivery.

- [ ] **Step 5: Add watchdog metric filters and base alarms**

Add two watchdog metric filters:

```hcl
resource "aws_cloudwatch_log_metric_filter" "schedule_watchdog_run_success" {
  name           = "${var.name_prefix}-schedule-watchdog-run-success"
  log_group_name = aws_cloudwatch_log_group.schedule_watchdog.name
  pattern        = "{ $.eventCode = \"SCHEDULED_RUN_COMPLETED\" && $.status = \"success\" }"

  metric_transformation {
    name       = "ScheduledRunSuccess"
    namespace  = "Callie/Sourcing"
    value      = "1"
    unit       = "Count"
    dimensions = { Component = "$.component" }
  }
}

resource "aws_cloudwatch_log_metric_filter" "schedule_watchdog_run_unprocessed" {
  name           = "${var.name_prefix}-schedule-watchdog-run-unprocessed"
  log_group_name = aws_cloudwatch_log_group.schedule_watchdog.name
  pattern        = "{ $.eventCode = \"SCHEDULED_RUN_COMPLETED\" && $.status = \"success\" && $.unprocessedCount = * }"

  metric_transformation {
    name       = "ScheduledRunUnprocessed"
    namespace  = "Callie/Sourcing"
    value      = "$.unprocessedCount"
    unit       = "Count"
    dimensions = { Component = "$.component" }
  }
}
```

Add exact watchdog base alarms:

```hcl
resource "aws_cloudwatch_metric_alarm" "schedule_watchdog_errors" {
  alarm_name          = "${var.name_prefix}-schedule-watchdog-errors"
  alarm_description   = "Monthly schedule health evaluation failed."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.schedule_watchdog.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "schedule_watchdog_throttles" {
  alarm_name          = "${var.name_prefix}-schedule-watchdog-throttles"
  alarm_description   = "Monthly schedule health evaluation was throttled."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = aws_lambda_function.schedule_watchdog.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "schedule_watchdog_near_timeout" {
  alarm_name                            = "${var.name_prefix}-schedule-watchdog-near-timeout"
  alarm_description                     = "Monthly schedule health p95 duration reached 90 percent of its Lambda timeout."
  namespace                             = "AWS/Lambda"
  metric_name                           = "Duration"
  dimensions                            = { FunctionName = aws_lambda_function.schedule_watchdog.function_name }
  extended_statistic                    = "p95"
  period                                = 300
  evaluation_periods                    = 1
  threshold                             = 60 * 1000 * 0.90
  comparison_operator                   = "GreaterThanOrEqualToThreshold"
  treat_missing_data                    = "notBreaching"
  evaluate_low_sample_count_percentiles = "evaluate"
  alarm_actions                         = [aws_sns_topic.alerts.arn]
  ok_actions                            = [aws_sns_topic.alerts.arn]
}
```

Add watchdog heartbeat:

```hcl
resource "aws_cloudwatch_metric_alarm" "schedule_watchdog_missing_success" {
  alarm_name          = "${var.name_prefix}-schedule-watchdog-missing-success"
  alarm_description   = "No successful schedule-watchdog completion was observed for 48 hours."
  namespace           = "Callie/Sourcing"
  metric_name         = "ScheduledRunSuccess"
  dimensions          = { Component = "schedule-watchdog" }
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 48
  datapoints_to_alarm = 48
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.scheduled_health_alarm_actions
  ok_actions          = local.scheduled_health_alarm_actions
}
```

- [ ] **Step 6: Add exact monthly gauge alarms**

Define:

```hcl
locals {
  monthly_health_targets = toset([
    "adapter-pvd-taxroll",
    "adapter-boston-assessments",
  ])
}
```

Create both resources explicitly:

```hcl
resource "aws_cloudwatch_metric_alarm" "monthly_missing_success" {
  for_each = local.monthly_health_targets

  alarm_name          = "${var.name_prefix}-${each.key}-monthly-missing-success"
  alarm_description   = "Two eligible monthly ${each.key} windows had no successful completion."
  namespace           = "Callie/Sourcing"
  metric_name         = "MonthlyMissingSuccess"
  dimensions          = { Component = each.key }
  statistic           = "Maximum"
  period              = 86400
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.scheduled_health_alarm_actions
  ok_actions          = local.scheduled_health_alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "monthly_persistent_unprocessed" {
  for_each = local.monthly_health_targets

  alarm_name          = "${var.name_prefix}-${each.key}-monthly-persistent-unprocessed"
  alarm_description   = "Two eligible monthly ${each.key} windows retained positive unprocessed work."
  namespace           = "Callie/Sourcing"
  metric_name         = "MonthlyPersistentUnprocessed"
  dimensions          = { Component = each.key }
  statistic           = "Maximum"
  period              = 86400
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.scheduled_health_alarm_actions
  ok_actions          = local.scheduled_health_alarm_actions
}
```

- [ ] **Step 7: Complete dashboard coverage**

Append the watchdog function to Invocations, Errors, Throttles, and p95 Duration widgets as a distinct metric row. Append `schedule-watchdog` to the successful-run heartbeat widget. Add these two exact metric arrays:

```hcl
metrics = [for component in local.monthly_health_targets :
  ["Callie/Sourcing", "MonthlyMissingSuccess", "Component", component]
]
```

```hcl
metrics = [for component in local.monthly_health_targets :
  ["Callie/Sourcing", "MonthlyPersistentUnprocessed", "Component", component]
]
```

Both monthly widgets use `stat = "Maximum"` and `period = 86400`. Do not aggregate the two targets.

- [ ] **Step 8: Update cloud build and hold-point documentation**

In `cloud/README.md`, add the exact watchdog package to the layout and build list. Keep implementation verification limited to package tests/build, static Terraform tests, and formatting. Preserve the future hold point conditions:

- trusted managed state and managed secret identifiers
- separate founder approval
- both gates false
- restrictive `umask 077`
- human-readable unsaved plan only
- zero destroy and zero replacement proof
- sanitized summary only
- no apply implied

Do not add a runnable plan, show, JSON, provider, AWS, or raw-secret command.

- [ ] **Step 9: Run Task 5 GREEN verification**

Run:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/infrastructure/terraformHardening.test.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/schedule-watchdog && npm run typecheck && npm test && npm run build)
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run typecheck
tofu fmt -check -recursive cloud/terraform
git diff --check
```

Expected: all static and watchdog checks pass with no AWS or provider call and no plan artifact.

- [ ] **Step 10: Run the complete scheduled-observability package gate**

Run:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/shared && npm run typecheck && npm test)
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; for package_dir in cloud/lambdas/adapter-boston-assessments cloud/lambdas/adapter-boston-rentsmart cloud/lambdas/adapter-pvd-taxroll cloud/lambdas/enricher cloud/lambdas/resolver cloud/lambdas/scorer cloud/lambdas/suppression-sync cloud/lambdas/schedule-watchdog; do (cd "$package_dir" && npm run typecheck && npm test) || exit 1; done
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/infrastructure/terraformHardening.test.ts
```

Expected: shared plus all eight scheduled packages pass. The infrastructure suite proves exact gates, periods, component identity, IAM scope, and absence of duplicate source alarms.

- [ ] **Step 11: Run non-disclosing secret and artifact guards**

Run only name and existence checks. Do not print values:

```bash
test ! -e cloud/terraform/tf.plan
test -z "$(find cloud/terraform -maxdepth 1 -type f \( -name '*.tfplan' -o -name '*.plan' \) -print -quit)"
```

Expected: exit 0. The infrastructure test remains responsible for checking that `cloud/README.md` does not prescribe saved plans, JSON rendering, raw secrets, or backend-disabled create-only plans.

- [ ] **Step 12: Commit exactly Task 5 files**

```bash
git add cloud/terraform/watchdog.tf cloud/terraform/iam.tf cloud/terraform/alarms.tf cloud/terraform/dashboard.tf tests/infrastructure/terraformHardening.test.ts cloud/README.md
git diff --cached --name-only
git commit -m "feat: wire monthly health watchdog observability"
```

Expected committed paths: exactly the six files declared above.

---

## Final Integration and Review Gate

After all five task commits and their independent reviews:

- [ ] Re-run the complete Task 5 gate from Task 5 Step 10.
- [ ] Re-run `tofu fmt -check -recursive cloud/terraform`.
- [ ] Run `git diff --check` and verify tracked status is clean.
- [ ] Verify the five commit subjects and exact file lists.
- [ ] Verify `schedules_enabled` and `scheduled_health_alerts_enabled` still default to false.
- [ ] Verify no generated `dist/`, plan, JSON plan, secret file, Terraform state, or credential artifact is staged.
- [ ] Request an independent whole-plan review against the approved spec, every task report, every task review, and the complete implementation diff.
- [ ] Stop if the review finds any Critical or Important issue. Fix and re-review before integration.
- [ ] Record that implementation proves source correctness only. It does not prove live drift, resolver stream creation, alarm transitions, metric ingestion, watchdog execution, schedule state, or deployment safety.
- [ ] Keep deployment, state-aware planning, apply, schedule enablement, and health-action enablement behind the separate future founder-approved hold point.
