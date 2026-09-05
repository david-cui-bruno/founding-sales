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

function extractContainingBlock(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`missing block marker: ${marker}`);
  const stack: number[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") stack.push(index);
    else if (char === "}") {
      const openIndex = stack.pop();
      if (openIndex === undefined) throw new Error(`unmatched closing brace: ${marker}`);
      if (openIndex < markerIndex && markerIndex < index) {
        return source.slice(openIndex, index + 1);
      }
    }
  }
  throw new Error(`missing containing block: ${marker}`);
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

const WATCHDOG_COMPONENT = "schedule-watchdog";
const MONTHLY_COMPONENTS = [
  "adapter-pvd-taxroll",
  "adapter-boston-assessments",
] as const;

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

const ERROR_DESCRIPTIONS = {
  "adapter-pvd-taxroll": "Sourcing adapter-pvd-taxroll Lambda failed.",
  "adapter-boston-rentsmart": "Sourcing adapter-boston-rentsmart Lambda failed.",
  "adapter-boston-assessments": "Sourcing adapter-boston-assessments Lambda failed.",
  scorer: "Sourcing scorer Lambda failed.",
  resolver: "Sourcing resolver Lambda failed.",
  enricher: "Sourcing enricher Lambda failed.",
  "suppression-sync":
    "Suppression sync or replay failed; outbound enrichment must remain paused.",
} as const;

function occurrences(source: string, value: string): number {
  return source.split(value).length - 1;
}

describe("scheduled source Terraform hardening", () => {
  it("defaults schedules and scheduled health notifications to disabled", () => {
    const variables = readTerraform("variables.tf");
    const schedules = extractBlock(variables, 'variable "schedules_enabled"');
    const health = extractBlock(
      variables,
      'variable "scheduled_health_alerts_enabled"',
    );

    expect(schedules).toContain("default     = false");
    expect(schedules).toContain(
      "Master switch for every scheduled sourcing and watchdog EventBridge rule. Keep false until an approved production rollout.",
    );
    expect(health).toContain("default     = false");
    expect(health).toContain(
      "Enables notification actions for scheduled missing-success and persistent-work health alarms after an approved baseline.",
    );
  });

  it("declares exact cadence timeout and unprocessed metadata for seven sources", () => {
    const adapters = readTerraform("adapters.tf");
    const adapterFunctions = extractBlock(adapters, "adapter_functions =");

    expect(Object.keys(SOURCES)).toHaveLength(7);
    expect(occurrences(adapterFunctions, "source_dir")).toBe(7);
    expect(occurrences(adapterFunctions, "has_unprocessed_metric")).toBe(7);
    expect(occurrences(adapterFunctions, "error_description")).toBe(7);
    for (const [component, expected] of Object.entries(SOURCES)) {
      const source = extractBlock(adapterFunctions, `"${component}" =`);
      expect(source).toMatch(
        new RegExp(`cadence\\s*=\\s*"${expected.cadence}"`),
      );
      expect(source).toMatch(new RegExp(`timeout\\s*=\\s*${expected.timeout}`));
      expect(source).toMatch(
        new RegExp(`has_unprocessed_metric\\s*=\\s*${expected.unprocessed}`),
      );
      expect(source).toMatch(
        new RegExp(
          `error_description\\s*=\\s*"${ERROR_DESCRIPTIONS[component as keyof typeof ERROR_DESCRIPTIONS]}"`,
        ),
      );
    }
  });

  it("keeps every adapter EventBridge rule behind the schedule gate", () => {
    const adapters = readTerraform("adapters.tf");
    const rule = extractBlock(
      adapters,
      'resource "aws_cloudwatch_event_rule" "adapters"',
    );

    expect(rule).toContain("for_each = local.adapter_functions");
    expect(rule).toContain(
      'state               = var.schedules_enabled ? "ENABLED" : "DISABLED"',
    );
    expect(occurrences(adapters, 'resource "aws_cloudwatch_event_rule"')).toBe(1);
  });

  it("grants the shared role the resolver log ARN exactly once", () => {
    const iam = readTerraform("iam.tf");
    const sharedRole = extractBlock(
      iam,
      'data "aws_iam_policy_document" "lambda_adapters"',
    );
    const resolverArn =
      '"arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${var.name_prefix}-resolver*"';

    expect(sharedRole).toContain(resolverArn);
    expect(occurrences(iam, resolverArn)).toBe(1);
  });

  it("turns only successful completion records into component metrics", () => {
    const alarms = readTerraform("alarms.tf");
    const success = extractBlock(
      alarms,
      'resource "aws_cloudwatch_log_metric_filter" "scheduled_run_success"',
    );
    const unprocessed = extractBlock(
      alarms,
      'resource "aws_cloudwatch_log_metric_filter" "scheduled_run_unprocessed"',
    );

    for (const filter of [success, unprocessed]) {
      expect(filter).toContain("for_each = local.adapter_functions");
      expect(filter).toContain(
        "log_group_name = aws_cloudwatch_log_group.adapters[each.key].name",
      );
      expect(filter).toContain('$.eventCode = \\"SCHEDULED_RUN_COMPLETED\\"');
      expect(filter).toContain('$.status = \\"success\\"');
      expect(filter).toContain('namespace  = "Callie/Sourcing"');
      expect(filter).toContain(
        'dimensions = { Component = "$.component" }',
      );
      expect(filter).not.toContain("default_value");
    }
    expect(success).toContain('name       = "ScheduledRunSuccess"');
    expect(success).toContain('value      = "1"');
    expect(unprocessed).toContain('name       = "ScheduledRunUnprocessed"');
    expect(unprocessed).toContain('value      = "$.unprocessedCount"');
    expect(unprocessed).toContain('$.unprocessedCount = *');
  });

  it("creates one Errors one Throttles and one p95 duration alarm per source", () => {
    const alarms = readTerraform("alarms.tf");
    const errors = extractBlock(
      alarms,
      'resource "aws_cloudwatch_metric_alarm" "adapter_errors"',
    );
    const throttles = extractBlock(
      alarms,
      'resource "aws_cloudwatch_metric_alarm" "adapter_throttles"',
    );
    const duration = extractBlock(
      alarms,
      'resource "aws_cloudwatch_metric_alarm" "adapter_near_timeout"',
    );

    expect(occurrences(alarms, '"adapter_errors"')).toBe(1);
    expect(occurrences(alarms, '"adapter_throttles"')).toBe(1);
    expect(occurrences(alarms, '"adapter_near_timeout"')).toBe(1);
    for (const alarm of [errors, throttles, duration]) {
      expect(alarm).toContain("for_each = local.adapter_functions");
      expect(alarm).toMatch(/period\s*=\s*300/);
      expect(alarm).toMatch(/evaluation_periods\s*=\s*1/);
      expect(alarm).toMatch(/treat_missing_data\s*=\s*"notBreaching"/);
      expect(alarm).toContain("alarm_actions");
      expect(alarm).toContain("[aws_sns_topic.alerts.arn]");
      expect(alarm).toContain("ok_actions");
    }
    expect(errors).toContain('metric_name         = "Errors"');
    expect(errors).toContain("alarm_description   = each.value.error_description");
    expect(throttles).toContain('metric_name         = "Throttles"');
    for (const alarm of [errors, throttles]) {
      expect(alarm).toContain('statistic           = "Sum"');
      expect(alarm).toContain("threshold           = 1");
      expect(alarm).toContain(
        'comparison_operator = "GreaterThanOrEqualToThreshold"',
      );
    }
    expect(duration).toMatch(/metric_name\s*=\s*"Duration"/);
    expect(duration).toMatch(/extended_statistic\s*=\s*"p95"/);
    expect(duration).toMatch(
      /threshold\s*=\s*each\.value\.timeout \* 1000 \* 0\.90/,
    );
    expect(duration).toMatch(
      /evaluate_low_sample_count_percentiles\s*=\s*"evaluate"/,
    );
  });

  it("uses exact non-monthly missing-success windows and dual-gated actions", () => {
    const alarms = readTerraform("alarms.tf");
    const locals = extractBlock(alarms, "locals");
    const cadences = extractBlock(locals, "missing_success_cadences =");
    const sources = extractBlock(locals, "non_monthly_sources =");
    const alarm = extractBlock(
      alarms,
      'resource "aws_cloudwatch_metric_alarm" "scheduled_missing_success"',
    );

    expect(locals).toContain(
      "scheduled_health_alarm_actions = var.schedules_enabled && var.scheduled_health_alerts_enabled ? [aws_sns_topic.alerts.arn] : []",
    );
    expect(cadences).not.toContain("monthly");
    for (const [cadence, values] of Object.entries(MISSING)) {
      expect(cadences).toMatch(
        new RegExp(
          `${cadence}\\s*=\\s*\\{ period = ${values.period}, evaluation_periods = ${values.evaluationPeriods}, datapoints_to_alarm = ${values.datapoints} \\}`,
        ),
      );
    }
    expect(sources).toContain('if source.cadence != "monthly"');
    expect(alarm).toContain("for_each = local.non_monthly_sources");
    expect(alarm).toContain('metric_name         = "ScheduledRunSuccess"');
    expect(alarm).toContain("dimensions          = { Component = each.key }");
    expect(alarm).toContain('statistic           = "Sum"');
    expect(alarm).toContain("period              = each.value.period");
    expect(alarm).toContain(
      "evaluation_periods  = each.value.evaluation_periods",
    );
    expect(alarm).toContain(
      "datapoints_to_alarm = each.value.datapoints_to_alarm",
    );
    expect(alarm).toContain("threshold           = 1");
    expect(alarm).toContain('comparison_operator = "LessThanThreshold"');
    expect(alarm).toContain('treat_missing_data  = "breaching"');
    expect(alarm).toContain(
      "alarm_actions       = local.scheduled_health_alarm_actions",
    );
    expect(alarm).toContain(
      "ok_actions          = local.scheduled_health_alarm_actions",
    );
  });

  it("uses two-period Minimum backlog alarms only where meaningful", () => {
    const alarms = readTerraform("alarms.tf");
    const locals = extractBlock(alarms, "locals");
    const cadences = extractBlock(
      locals,
      "persistent_unprocessed_cadences =",
    );
    const sources = extractBlock(
      locals,
      "non_monthly_unprocessed_sources =",
    );
    const alarm = extractBlock(
      alarms,
      'resource "aws_cloudwatch_metric_alarm" "scheduled_persistent_unprocessed"',
    );

    expect(cadences).not.toContain("monthly");
    for (const [cadence, values] of Object.entries(PERSISTENT)) {
      expect(cadences).toMatch(
        new RegExp(`${cadence}\\s*=\\s*\\{ period = ${values.period} \\}`),
      );
    }
    expect(sources).toContain(
      'if source.cadence != "monthly" && source.has_unprocessed_metric',
    );
    expect(alarm).toContain("for_each = local.non_monthly_unprocessed_sources");
    expect(alarm).toContain('metric_name         = "ScheduledRunUnprocessed"');
    expect(alarm).toContain("dimensions          = { Component = each.key }");
    expect(alarm).toContain('statistic           = "Minimum"');
    expect(alarm).toContain("evaluation_periods  = 2");
    expect(alarm).toContain("datapoints_to_alarm = 2");
    expect(alarm).toContain("threshold           = 0");
    expect(alarm).toContain('comparison_operator = "GreaterThanThreshold"');
    expect(alarm).toContain('treat_missing_data  = "notBreaching"');
    expect(alarm).toContain(
      "alarm_actions       = local.scheduled_health_alarm_actions",
    );
    expect(alarm).toContain(
      "ok_actions          = local.scheduled_health_alarm_actions",
    );
  });

  it("does not duplicate the suppression-sync Errors alarm", () => {
    const adapters = readTerraform("adapters.tf");
    const alarms = readTerraform("alarms.tf");
    const suppression = extractBlock(
      extractBlock(adapters, "adapter_functions ="),
      '"suppression-sync" =',
    );

    expect(alarms).not.toContain(
      'resource "aws_cloudwatch_metric_alarm" "suppression_sync_errors"',
    );
    expect(occurrences(alarms, 'metric_name         = "Errors"')).toBe(3);
    expect(suppression).toContain(
      'error_description      = "Suppression sync or replay failed; outbound enrichment must remain paused."',
    );
  });

  it("packages a Node 22 watchdog behind a disabled daily 18 UTC rule", () => {
    const watchdog = readTerraform("watchdog.tf");
    const archive = extractBlock(watchdog, 'data "archive_file" "schedule_watchdog"');
    const lambda = extractBlock(
      watchdog,
      'resource "aws_lambda_function" "schedule_watchdog"',
    );
    const rule = extractBlock(
      watchdog,
      'resource "aws_cloudwatch_event_rule" "schedule_watchdog"',
    );

    expect(archive).toContain(
      'source_dir  = "${path.module}/../lambdas/schedule-watchdog/dist"',
    );
    expect(lambda).toContain('runtime       = "nodejs22.x"');
    expect(lambda).toContain('handler       = "handler.handler"');
    expect(lambda).toContain('architectures = ["arm64"]');
    expect(lambda).toContain("memory_size   = 256");
    expect(lambda).toContain("timeout       = 60");
    expect(rule).toContain('schedule_expression = "cron(0 18 * * ? *)"');
    expect(rule).toContain(
      'state               = var.schedules_enabled ? "ENABLED" : "DISABLED"',
    );
  });

  it("gives the watchdog only own logs GetMetricData and namespace-bound PutMetricData", () => {
    const iam = readTerraform("iam.tf");
    const policy = extractBlock(
      iam,
      'data "aws_iam_policy_document" "lambda_schedule_watchdog"',
    );
    const putMetricData = extractContainingBlock(
      policy,
      'actions   = ["cloudwatch:PutMetricData"]',
    );

    expect(policy).toContain('"logs:CreateLogStream"');
    expect(policy).toContain('"logs:PutLogEvents"');
    expect(policy).toContain(
      '"arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${var.name_prefix}-schedule-watchdog*"',
    );
    expect(policy).toContain('actions   = ["cloudwatch:GetMetricData"]');
    expect(policy).toContain('actions   = ["cloudwatch:PutMetricData"]');
    expect(putMetricData).toContain('test     = "StringEquals"');
    expect(putMetricData).toContain('variable = "cloudwatch:namespace"');
    expect(putMetricData).toContain('values   = ["Callie/Sourcing"]');
    expect(policy).not.toMatch(/(?:s3|dynamodb|sns|ses|route53|tracerfy):/i);
    expect(policy).not.toMatch(/provider/i);
    expect(occurrences(policy, '"logs:')).toBe(2);
    expect(occurrences(policy, '"cloudwatch:')).toBe(3);
  });

  it("creates watchdog success and unprocessed metric filters", () => {
    const alarms = readTerraform("alarms.tf");
    const success = extractBlock(
      alarms,
      'resource "aws_cloudwatch_log_metric_filter" "schedule_watchdog_run_success"',
    );
    const unprocessed = extractBlock(
      alarms,
      'resource "aws_cloudwatch_log_metric_filter" "schedule_watchdog_run_unprocessed"',
    );

    expect(success).toContain(
      'pattern        = "{ $.eventCode = \\"SCHEDULED_RUN_COMPLETED\\" && $.status = \\"success\\" }"',
    );
    expect(success).toContain('name       = "ScheduledRunSuccess"');
    expect(success).toContain('dimensions = { Component = "$.component" }');
    expect(unprocessed).toContain(
      'pattern        = "{ $.eventCode = \\"SCHEDULED_RUN_COMPLETED\\" && $.status = \\"success\\" && $.unprocessedCount = * }"',
    );
    expect(unprocessed).toContain('name       = "ScheduledRunUnprocessed"');
    expect(unprocessed).toContain('value      = "$.unprocessedCount"');
    expect(unprocessed).toContain('dimensions = { Component = "$.component" }');
    expect(success).not.toContain("default_value");
    expect(unprocessed).not.toContain("default_value");
  });

  it("creates one watchdog Errors Throttles p95 duration and 48-hour heartbeat alarm", () => {
    const alarms = readTerraform("alarms.tf");
    const errors = extractBlock(
      alarms,
      'resource "aws_cloudwatch_metric_alarm" "schedule_watchdog_errors"',
    );
    const throttles = extractBlock(
      alarms,
      'resource "aws_cloudwatch_metric_alarm" "schedule_watchdog_throttles"',
    );
    const duration = extractBlock(
      alarms,
      'resource "aws_cloudwatch_metric_alarm" "schedule_watchdog_near_timeout"',
    );
    const heartbeat = extractBlock(
      alarms,
      'resource "aws_cloudwatch_metric_alarm" "schedule_watchdog_missing_success"',
    );

    for (const [alarm, metric] of [
      [errors, "Errors"],
      [throttles, "Throttles"],
    ] as const) {
      expect(alarm).toContain('namespace           = "AWS/Lambda"');
      expect(alarm).toContain(`metric_name         = "${metric}"`);
      expect(alarm).toContain('statistic           = "Sum"');
      expect(alarm).toContain("period              = 300");
      expect(alarm).toContain("evaluation_periods  = 1");
      expect(alarm).toContain("threshold           = 1");
      expect(alarm).toContain(
        'comparison_operator = "GreaterThanOrEqualToThreshold"',
      );
      expect(alarm).toContain('treat_missing_data  = "notBreaching"');
      expect(alarm).toContain("alarm_actions       = [aws_sns_topic.alerts.arn]");
      expect(alarm).toContain("ok_actions          = [aws_sns_topic.alerts.arn]");
    }
    expect(duration).toContain('extended_statistic                    = "p95"');
    expect(duration).toContain("threshold                             = 60 * 1000 * 0.90");
    expect(duration).toContain(
      'evaluate_low_sample_count_percentiles = "evaluate"',
    );
    expect(heartbeat).toContain(`dimensions          = { Component = "${WATCHDOG_COMPONENT}" }`);
    expect(heartbeat).toContain("period              = 3600");
    expect(heartbeat).toContain("evaluation_periods  = 48");
    expect(heartbeat).toContain("datapoints_to_alarm = 48");
    expect(heartbeat).toContain("threshold           = 1");
    expect(heartbeat).toContain('comparison_operator = "LessThanThreshold"');
    expect(heartbeat).toContain('treat_missing_data  = "breaching"');
    expect(heartbeat).toContain(
      "alarm_actions       = local.scheduled_health_alarm_actions",
    );
    expect(heartbeat).toContain(
      "ok_actions          = local.scheduled_health_alarm_actions",
    );
  });

  it("creates daily Maximum monthly health alarms for both monthly targets", () => {
    const alarms = readTerraform("alarms.tf");
    const targets = extractBlock(alarms, "monthly_health_targets =");
    const missing = extractBlock(
      alarms,
      'resource "aws_cloudwatch_metric_alarm" "monthly_missing_success"',
    );
    const unprocessed = extractBlock(
      alarms,
      'resource "aws_cloudwatch_metric_alarm" "monthly_persistent_unprocessed"',
    );

    expect(MONTHLY_COMPONENTS).toHaveLength(2);
    for (const component of MONTHLY_COMPONENTS) {
      expect(targets).toContain(`"${component}"`);
    }
    for (const [alarm, metric] of [
      [missing, "MonthlyMissingSuccess"],
      [unprocessed, "MonthlyPersistentUnprocessed"],
    ] as const) {
      expect(alarm).toContain("for_each = local.monthly_health_targets");
      expect(alarm).toContain(`metric_name         = "${metric}"`);
      expect(alarm).toContain("dimensions          = { Component = each.key }");
      expect(alarm).toContain('statistic           = "Maximum"');
      expect(alarm).toContain("period              = 86400");
      expect(alarm).toContain("evaluation_periods  = 1");
      expect(alarm).toContain("datapoints_to_alarm = 1");
      expect(alarm).toContain("threshold           = 1");
      expect(alarm).toContain(
        'comparison_operator = "GreaterThanOrEqualToThreshold"',
      );
    }
  });

  it("dual-gates every monthly health alarm action and treats missing gauges as nonbreaching", () => {
    const alarms = readTerraform("alarms.tf");
    for (const resourceName of [
      "monthly_missing_success",
      "monthly_persistent_unprocessed",
    ] as const) {
      const alarm = extractBlock(
        alarms,
        `resource "aws_cloudwatch_metric_alarm" "${resourceName}"`,
      );
      expect(alarm).toContain('treat_missing_data  = "notBreaching"');
      expect(alarm).toContain(
        "alarm_actions       = local.scheduled_health_alarm_actions",
      );
      expect(alarm).toContain(
        "ok_actions          = local.scheduled_health_alarm_actions",
      );
    }
  });

  it("adds distinct watchdog and monthly gauges to the dashboard", () => {
    const dashboard = readTerraform("dashboard.tf");
    const resource = extractBlock(
      dashboard,
      'resource "aws_cloudwatch_dashboard" "pipeline"',
    );

    for (const [title, metric] of [
      ["Invocations", "Invocations"],
      ["Errors", "Errors"],
      ["Throttles", "Throttles"],
      ["Duration p95 (ms)", "Duration"],
    ] as const) {
      const widget = extractContainingBlock(resource, `title  = "${title}"`);
      expect(widget).toContain(
        `["AWS/Lambda", "${metric}", "FunctionName", aws_lambda_function.schedule_watchdog.function_name]`,
      );
    }
    const success = extractContainingBlock(
      resource,
      'title  = "Scheduled run successes"',
    );
    expect(success).toContain(
      `["Callie/Sourcing", "ScheduledRunSuccess", "Component", "${WATCHDOG_COMPONENT}"]`,
    );
    for (const [title, metric] of [
      ["Monthly missing success", "MonthlyMissingSuccess"],
      ["Monthly persistent unprocessed", "MonthlyPersistentUnprocessed"],
    ] as const) {
      const widget = extractContainingBlock(resource, `title  = "${title}"`);
      expect(widget).toContain('stat   = "Maximum"');
      expect(widget).toContain("period = 86400");
      expect(widget).toContain(
        `metrics = [for component in local.monthly_health_targets :\n            ["Callie/Sourcing", "${metric}", "Component", component]\n          ]`,
      );
    }
  });

  it("documents watchdog build and preserves the future explicit hold point", () => {
    const readme = readFileSync(join(process.cwd(), "cloud", "README.md"), "utf8");
    const sectionStart = readme.indexOf("## Local source verification only");
    const nextSection = readme.indexOf("\n## ", sectionStart + 1);
    const section = readme.slice(sectionStart, nextSection);
    const compactSection = section.replace(/\s+/g, " ");

    expect(readme).toContain(
      "lambdas/schedule-watchdog/         # daily monthly schedule-health watchdog",
    );
    expect(section).toContain(
      'export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/schedule-watchdog && n' +
        "pm run typecheck && n" +
        "pm test && n" +
        "pm run build)",
    );
    expect(compactSection).toContain("trusted managed state");
    expect(compactSection).toContain("managed secret identifiers");
    expect(compactSection).toContain("separate founder approval");
    expect(compactSection).toContain("both gates false");
    expect(compactSection).toContain("umask 077");
    expect(compactSection).toContain("human-readable unsaved plan only");
    expect(compactSection).toContain("zero destroy");
    expect(compactSection).toContain("zero replacement");
    expect(compactSection).toContain("sanitized summary only");
    expect(compactSection).toContain("no apply");
    expect(section).not.toMatch(/\b(?:terraform|tofu) (?:init|validate|plan|show|apply)\b/);
    expect(section).not.toMatch(/\baws\s/);
    expect(section).not.toContain("TF_VAR_");
  });

  it("shows distinct seven-source invocation error throttle duration success and work series", () => {
    const dashboard = readTerraform("dashboard.tf");
    const resource = extractBlock(
      dashboard,
      'resource "aws_cloudwatch_dashboard" "pipeline"',
    );

    expect(Object.keys(SOURCES)).toHaveLength(7);
    for (const [title, metric] of [
      ["Invocations", "Invocations"],
      ["Errors", "Errors"],
      ["Throttles", "Throttles"],
      ["Duration p95 (ms)", "Duration"],
    ] as const) {
      const widget = extractContainingBlock(resource, `title  = "${title}"`);
      expect(occurrences(widget, "for k in keys(local.adapter_functions)")).toBe(1);
      expect(widget).toContain(
        `["AWS/Lambda", "${metric}", "FunctionName", aws_lambda_function.adapters[k].function_name]`,
      );
    }
    const successWidget = extractContainingBlock(
      resource,
      'title  = "Scheduled run successes"',
    );
    expect(occurrences(successWidget, "for key in keys(local.adapter_functions)")).toBe(
      1,
    );
    expect(successWidget).toContain(
      '["Callie/Sourcing", "ScheduledRunSuccess", "Component", key]',
    );
    const workWidget = extractContainingBlock(
      resource,
      'title  = "Unprocessed scheduled work"',
    );
    expect(
      occurrences(workWidget, "for key, source in local.adapter_functions"),
    ).toBe(1);
    expect(workWidget).toContain(
      '["Callie/Sourcing", "ScheduledRunUnprocessed", "Component", key]',
    );
    expect(workWidget).toContain("if source.has_unprocessed_metric");
    expect(resource).not.toContain("expression =");
  });

  it("prefixes every npm and npx command in the Task 2 files", () => {
    const exactPrefix =
      'export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; ';
    const taskFiles = [
      "cloud/terraform/variables.tf",
      "cloud/terraform/adapters.tf",
      "cloud/terraform/iam.tf",
      "cloud/terraform/alarms.tf",
      "cloud/terraform/dashboard.tf",
      "tests/infrastructure/terraformHardening.test.ts",
      "cloud/README.md",
    ] as const;
    let commandCount = 0;

    for (const relativePath of taskFiles) {
      const source = readFileSync(join(process.cwd(), relativePath), "utf8");
      for (const line of source.split("\n")) {
        const commandPattern = /\b(?:npm|npx)\s+(?:ci|install|run|test|exec|vitest)\b/g;
        for (const match of line.matchAll(commandPattern)) {
          commandCount += 1;
          expect(
            line.slice(0, match.index).endsWith(exactPrefix) ||
              line.trimStart().replace(/^['"]/, "").startsWith(exactPrefix),
          ).toBe(true);
        }
      }
    }

    expect(commandCount).toBeGreaterThan(0);
  });

  it("documents source-only verification without saved plans JSON rendering or secrets", () => {
    const variables = readTerraform("variables.tf");
    const readme = readFileSync(join(process.cwd(), "cloud", "README.md"), "utf8");
    const heading = "## Local source verification only";
    const sectionStart = readme.indexOf(heading);
    if (sectionStart < 0) throw new Error(`missing README section: ${heading}`);
    const nextSection = readme.indexOf("\n## ", sectionStart + heading.length);
    const section = readme.slice(
      sectionStart,
      nextSection < 0 ? readme.length : nextSection,
    );
    const compactSection = section.replace(/\s+/g, " ");

    expect(variables).toContain('variable "schedules_enabled"');
    expect(section).toContain(
      'export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/infrastructure/terraformHardening.test.ts',
    );
    expect(section).toContain("tofu fmt -check -recursive cloud/terraform");
    const commands = [...section.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)]
      .flatMap((match) => match[1]!.trim().split("\n"))
      .filter(Boolean);
    expect(commands).toEqual([
      'export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/schedule-watchdog && npm run typecheck && npm test && npm run build)',
      'export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/infrastructure/terraformHardening.test.ts',
      'export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run typecheck',
      "tofu fmt -check -recursive cloud/terraform",
    ]);
    expect(compactSection).toContain("trusted managed state");
    expect(compactSection).toContain("managed secret identifiers");
    expect(compactSection).toContain("separate founder approval");
    expect(compactSection).toContain("both gates false");
    expect(compactSection).toContain("human-readable unsaved plan");
    expect(compactSection).toContain("sanitized summary");
    expect(section).toContain("Saved plans");
    expect(section).toContain("JSON rendering");
    expect(section).toContain("raw Terraform secret variables");
    expect(section).toContain("backend-disabled create-only plans");
    expect(section).not.toMatch(/\b(?:terraform|tofu) (?:init|validate|plan|show|apply)\b/);
    expect(section).not.toMatch(/\baws\s/);
    expect(section).not.toContain("TF_VAR_");
  });
});
