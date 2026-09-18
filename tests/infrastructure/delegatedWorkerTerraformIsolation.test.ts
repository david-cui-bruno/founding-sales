import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Offline source checks only. No subprocesses, Terraform, providers or network.
// Deliberately not an HCL parser or proof of a safe live deployment.
const terraformDir = join(process.cwd(), "cloud/terraform");
const workerDir = join(process.cwd(), "cloud/worker-terraform");
const moduleDir = join(terraformDir, "modules/delegated-worker");
const read = (dir: string, name: string): string => readFileSync(join(dir, name), "utf8");
const tf = (dir: string): string => readdirSync(dir)
  .filter((name) => name.endsWith(".tf"))
  .sort()
  .map((name) => read(dir, name))
  .join("\n");
const compact = (source: string): string => source.replace(/^\s*#.*$/gm, "").replace(/\s+/g, " ").trim();

function block(source: string, header: string): string {
  const start = source.indexOf(header);
  if (start < 0) throw new Error(`Missing block: ${header}`);
  const open = source.indexOf("{", start + header.length);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unterminated block: ${header}`);
}

const addresses = [
  "aws_kms_key.delegated_worker",
  "aws_dynamodb_table.delegated_worker",
  "aws_cloudwatch_log_group.delegated_worker",
  "aws_cloudwatch_log_group.delegated_worker_api",
  "aws_iam_role.delegated_worker",
  "aws_iam_role_policy.delegated_worker",
  "data.archive_file.delegated_worker",
  "aws_lambda_function.delegated_worker",
  "aws_apigatewayv2_api.delegated_worker",
  "aws_apigatewayv2_integration.delegated_worker",
  "aws_apigatewayv2_route.delegated_worker",
  "aws_apigatewayv2_stage.delegated_worker",
  "aws_lambda_permission.delegated_worker_api",
  "aws_cloudwatch_event_rule.delegated_worker",
  "aws_cloudwatch_event_target.delegated_worker",
  "aws_lambda_permission.delegated_worker_schedule",
  // Operations David can see (Batch 7, D10): one alarm topic, its optional email subscription, four alarms, the held-tick metric filter and one monthly budget.
  "aws_sns_topic.delegated_worker_alarms",
  "aws_sns_topic_policy.delegated_worker_alarms",
  "aws_sns_topic_subscription.delegated_worker_alarm_email",
  "aws_cloudwatch_metric_alarm.delegated_worker_errors",
  "aws_cloudwatch_metric_alarm.delegated_worker_throttles",
  "aws_cloudwatch_metric_alarm.delegated_worker_silent_schedule",
  "aws_cloudwatch_log_metric_filter.delegated_worker_held_ticks",
  "aws_cloudwatch_metric_alarm.delegated_worker_held_ticks",
  "aws_budgets_budget.delegated_worker_monthly",
];
const defaults: Record<string, string> = {
  aws_region: '"us-east-1"',
  aws_account_id: '"326255650484"',
  name_prefix: '"callie-sourcing"',
  iam_path: '"/callie-sourcing/"',
  delegated_worker_enabled: "false",
  delegated_worker_activation_reviewed: "false",
  delegated_workspace_id: '""',
  delegated_google_client_id: '""',
  delegated_research_enabled: "false",
  delegated_research_reviewed_capability: '""',
  delegated_worker_schedule_enabled: "false",
  delegated_worker_research_once_enabled: "false",
};
// Inputs added after the legacy sourcing root was removed (17 September 2026): the module default is off and only the worker root wires them.
const workerOnlyDefaults: Record<string, string> = {
  delegated_places_enabled: "false",
  alarm_email: '""',
  monthly_budget_usd: "25",
};
const implementation = tf(moduleDir);
const worker = tf(workerDir);
const workerModule = block(worker, 'module "delegated_worker"');

describe("delegated-worker Terraform source isolation", () => {
  it("keeps cloud/terraform to the worker module only, the legacy sourcing root having been destroyed and removed", () => {
    // Ignored local artifacts (.terraform, .build, backend.hcl) are not source; only source files are inventoried.
    const rootSource = readdirSync(terraformDir).filter((name) => /\.(?:tf|example)$/.test(name));
    expect(rootSource).toEqual([]);
    expect(readdirSync(terraformDir)).toContain("modules");
    expect(readdirSync(join(terraformDir, "modules")).filter((name) => !name.startsWith("."))).toEqual(["delegated-worker"]);
    expect(readdirSync(moduleDir).filter((name) => name.endsWith(".tf")).sort()).toEqual(["main.tf", "variables.tf", "versions.tf"]);
    expect(readdirSync(workerDir).filter((name) => name.endsWith(".tf")).sort()).toEqual(["main.tf", "providers.tf", "variables.tf", "versions.tf"]);
  });

  it("has one worker implementation whose module source path exists and no transitive unrelated root dependencies", () => {
    const declared = [...implementation.matchAll(/^(resource|data) "([^"]+)" "([^"]+)"/gm)]
      .map(([, kind, type, name]) => `${kind === "data" ? "data." : ""}${type}.${name}`);
    expect(declared.sort()).toEqual([...addresses].sort());
    expect(worker).not.toMatch(/^(resource|data|moved|import|removed)\s+["{]/m);
    expect([...worker.matchAll(/^module "([^"]+)"/gm)].map((match) => match[1])).toEqual(["delegated_worker"]);
    expect(implementation).not.toMatch(/^(module|provider)\s+"/m);
    expect(implementation).not.toMatch(/\b(?:backend|provisioner)\s+"|terraform_remote_state|\bpath\.(?:root|module)\b/);
    const source = /source\s*=\s*"([^"]+)"/.exec(workerModule)?.[1];
    expect(source).toBe("../terraform/modules/delegated-worker");
    expect(resolve(workerDir, source!)).toBe(moduleDir);
    expect(existsSync(join(moduleDir, "main.tf"))).toBe(true);
    // The destroyed legacy sourcing stack (SES, S3, DNS, the schedule watchdog) never returns; the worker's own monthly budget is the one budget.
    expect(implementation + worker).not.toMatch(/(?:resource|data)\s+"(?:aws_s3_|aws_ses|aws_route53_|external|terraform_remote_state)/);
    expect(implementation + worker).not.toMatch(/resource\s+"[^"]+"\s+"[^"]*(?:watchdog|sourcing)|cloud\/terraform\.tfstate/);
    expect([...implementation.matchAll(/^resource "aws_budgets_budget" "([^"]+)"/gm)].map((match) => match[1])).toEqual(["delegated_worker_monthly"]);
  });

  it("preserves defaults, validation and all explicit caller input wiring", () => {
    for (const [name, value] of Object.entries(defaults)) {
      const original = block(read(moduleDir, "variables.tf"), `variable "${name}"`);
      for (const dir of [workerDir, moduleDir]) {
        const input = block(read(dir, "variables.tf"), `variable "${name}"`);
        expect(compact(input)).toContain(`default = ${value}`);
        // Generic descriptions may become worker-specific; types and validation may not.
        expect(compact(input.replace(/description\s*=\s*"[^"\n]*"/, "")))
          .toBe(compact(original.replace(/description\s*=\s*"[^"\n]*"/, "")));
      }
      expect(compact(workerModule)).toContain(`${name} = var.${name}`);
    }
    for (const [name, value] of Object.entries(workerOnlyDefaults)) {
      const moduleInput = block(read(moduleDir, "variables.tf"), `variable "${name}"`);
      const rootInput = block(read(workerDir, "variables.tf"), `variable "${name}"`);
      for (const input of [moduleInput, rootInput]) expect(compact(input)).toContain(`default = ${value}`);
      expect(compact(rootInput.replace(/description\s*=\s*"[^"\n]*"/, ""))).toBe(compact(moduleInput.replace(/description\s*=\s*"[^"\n]*"/, "")));
      expect(compact(block(worker, 'module "delegated_worker"'))).toContain(`${name} = var.${name}`);
    }
    const names = [...read(workerDir, "variables.tf").matchAll(/^variable "([^"]+)"/gm)].map((match) => match[1]);
    expect(names.sort()).toEqual([...Object.keys(defaults), ...Object.keys(workerOnlyDefaults)].sort());
    const moduleNames = [...read(moduleDir, "variables.tf").matchAll(/^variable "([^"]+)"/gm)].map((match) => match[1]);
    expect(moduleNames.sort()).toEqual([...Object.keys(defaults), ...Object.keys(workerOnlyDefaults), "worker_source_dir", "worker_output_path"].sort());
    const referenced = [...new Set([...implementation.matchAll(/\bvar\.([A-Za-z0-9_]+)/g)].map((match) => match[1]))];
    expect(referenced.sort()).toEqual(moduleNames.sort());
  });

  it("adds the Places credential parameter only behind its own opt-in, symmetric with the research parameter", () => {
    const source = compact(implementation);
    expect(source).toContain('delegated_places_parameter = "${local.delegated_parameter_path}/places-api-credentials"');
    expect(source).toContain('var.delegated_places_enabled ? [ "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.delegated_places_parameter}" ] : []');
    const lambda = compact(block(implementation, 'resource "aws_lambda_function" "delegated_worker"'));
    expect(lambda).toContain('DELEGATED_PLACES_CREDENTIAL_PARAMETER = var.delegated_places_enabled ? local.delegated_places_parameter : ""');
    for (const dir of [workerDir, moduleDir]) {
      const input = compact(block(read(dir, "variables.tf"), 'variable "delegated_places_enabled"'));
      expect(input).toContain("type = bool");
      expect(input).toContain("default = false");
      expect(input).toContain("places-api-credentials");
    }
    expect(compact(block(implementation, 'resource "aws_iam_role_policy" "delegated_worker"'))).not.toContain("places-api-credentials");
  });

  it("bounds optional non-secret reviewed metadata without treating it as provider or pricing proof", () => {
    for (const dir of [workerDir, moduleDir]) {
      const input = compact(block(read(dir, "variables.tf"), 'variable "delegated_research_reviewed_capability"'));
      expect(input).toContain('type = string');
      expect(input).toContain('default = ""');
      expect(input).toContain('nullable = false');
      expect(input).toContain('length(var.delegated_research_reviewed_capability) <= 3000');
      expect(input).toContain('(var.delegated_research_reviewed_capability == "" || can(jsondecode(var.delegated_research_reviewed_capability)))');
      // Matches `provenance: z.string().trim().min(1).max(500)` in researchSetupContract.ts: what Terraform carries, the worker accepts.
      expect(input).toContain('try(length(tostring(jsondecode(var.delegated_research_reviewed_capability).provenance)), 0) <= 500');
      expect(input).toContain("non-secret operator-reviewed");
      expect(input).toContain("Not readiness, provider connectivity or verified pricing proof");
      expect(input).toContain("No credentials, model defaults or default rates");
    }
    const lambda = compact(block(implementation, 'resource "aws_lambda_function" "delegated_worker"'));
    expect(lambda).toContain("DELEGATED_RESEARCH_REVIEWED_CAPABILITY = var.delegated_research_reviewed_capability");
    expect(compact(block(implementation, 'resource "aws_iam_role_policy" "delegated_worker"')))
      .not.toContain("delegated_research_reviewed_capability");
    expect(implementation).not.toContain('resource "aws_lambda_function_event_invoke_config"');
  });

  it("adds the alarms, topic and budget behind the worker opt-in, named with the worker prefix, with email only when an address is set", () => {
    const source = compact(implementation);
    for (const [address, suffix] of [
      ['resource "aws_sns_topic" "delegated_worker_alarms"', 'name = "${local.delegated_name}-alarms"'],
      ['resource "aws_cloudwatch_metric_alarm" "delegated_worker_errors"', 'alarm_name = "${local.delegated_name}-errors"'],
      ['resource "aws_cloudwatch_metric_alarm" "delegated_worker_throttles"', 'alarm_name = "${local.delegated_name}-throttles"'],
      ['resource "aws_cloudwatch_metric_alarm" "delegated_worker_silent_schedule"', 'alarm_name = "${local.delegated_name}-silent-schedule"'],
      ['resource "aws_cloudwatch_metric_alarm" "delegated_worker_held_ticks"', 'alarm_name = "${local.delegated_name}-held-ticks"'],
      ['resource "aws_cloudwatch_log_metric_filter" "delegated_worker_held_ticks"', 'name = "${local.delegated_name}-held-ticks"'],
      ['resource "aws_budgets_budget" "delegated_worker_monthly"', 'name = "${local.delegated_name}-monthly-usd"'],
    ]) expect(compact(block(implementation, address))).toContain(suffix);
    expect(source).toContain('delegated_name = "${var.name_prefix}-delegated-worker"');
    const errors = compact(block(implementation, 'resource "aws_cloudwatch_metric_alarm" "delegated_worker_errors"'));
    expect(errors).toContain('namespace = "AWS/Lambda" metric_name = "Errors"');
    expect(errors).toContain('threshold = 1 comparison_operator = "GreaterThanOrEqualToThreshold" treat_missing_data = "notBreaching"');
    expect(compact(block(implementation, 'resource "aws_cloudwatch_metric_alarm" "delegated_worker_throttles"'))).toContain('metric_name = "Throttles"');
    const silent = compact(block(implementation, 'resource "aws_cloudwatch_metric_alarm" "delegated_worker_silent_schedule"'));
    expect(silent).toContain('metric_name = "Invocations"');
    expect(silent).toContain('period = 3600 evaluation_periods = 1 threshold = 10 comparison_operator = "LessThanThreshold" treat_missing_data = "breaching"');
    const filter = compact(block(implementation, 'resource "aws_cloudwatch_log_metric_filter" "delegated_worker_held_ticks"'));
    expect(filter).toContain('log_group_name = aws_cloudwatch_log_group.delegated_worker[0].name');
    expect(filter).toContain('pattern = "{ ($.event = \\"SCHEDULED_RUN_COMPLETED\\") && (($.held > 0) || ($.places.outcome = \\"denied\\")) }"');
    expect(filter).toContain('name = "HeldTicks" namespace = "Callie/DelegatedWorker"');
    expect(compact(block(implementation, 'resource "aws_cloudwatch_metric_alarm" "delegated_worker_held_ticks"'))).toContain('namespace = "Callie/DelegatedWorker" metric_name = "HeldTicks"');
    const subscription = compact(block(implementation, 'resource "aws_sns_topic_subscription" "delegated_worker_alarm_email"'));
    expect(subscription).toContain('count = var.delegated_worker_enabled && var.alarm_email != "" ? 1 : 0');
    expect(subscription).toContain('protocol = "email" endpoint = var.alarm_email');
    const policy = compact(block(implementation, 'resource "aws_sns_topic_policy" "delegated_worker_alarms"'));
    expect(policy).toContain('Principal = { Service = ["cloudwatch.amazonaws.com", "budgets.amazonaws.com"] }');
    expect(policy).toContain('"aws:SourceAccount" = var.aws_account_id');
    const budget = compact(block(implementation, 'resource "aws_budgets_budget" "delegated_worker_monthly"'));
    expect(budget).toContain('budget_type = "COST" limit_amount = tostring(var.monthly_budget_usd) limit_unit = "USD" time_unit = "MONTHLY"');
    expect([...budget.matchAll(/threshold = (\d+) threshold_type = "PERCENTAGE" notification_type = "(ACTUAL|FORECASTED)"/g)].map((match) => `${match[1]}:${match[2]}`)).toEqual(["100:ACTUAL", "200:ACTUAL", "100:FORECASTED"]);
    expect(budget).toContain('subscriber_email_addresses = var.alarm_email != "" ? [var.alarm_email] : null');
    // Every alarm publishes to the one topic; nothing here widens the worker's IAM role or reads a parameter.
    for (const name of ["delegated_worker_errors", "delegated_worker_throttles", "delegated_worker_silent_schedule", "delegated_worker_held_ticks"]) {
      expect(compact(block(implementation, `resource "aws_cloudwatch_metric_alarm" "${name}"`))).toContain("alarm_actions = [aws_sns_topic.delegated_worker_alarms[0].arn]");
    }
    expect(compact(block(implementation, 'resource "aws_iam_role_policy" "delegated_worker"'))).not.toMatch(/sns:|budgets:|cloudwatch:/);
    for (const dir of [workerDir, moduleDir]) {
      const email = compact(block(read(dir, "variables.tf"), 'variable "alarm_email"'));
      expect(email).toContain('type = string default = "" nullable = false');
      expect(email).toContain('condition = var.alarm_email == "" || can(regex(');
      const monthly = compact(block(read(dir, "variables.tf"), 'variable "monthly_budget_usd"'));
      expect(monthly).toContain("type = number default = 25 nullable = false");
      expect(monthly).toContain("var.monthly_budget_usd >= 1 && var.monthly_budget_usd <= 1000");
    }
    expect(read(workerDir, "README.md")).toContain("A budget notifies; it never caps spend.");
  });

  it("keeps research-only invocation explicit and mutually exclusive with scheduling", () => {
    const lambda = compact(block(implementation, 'resource "aws_lambda_function" "delegated_worker"'));
    expect(lambda).toContain('DELEGATED_WORKER_RESEARCH_ONCE_ENABLED = var.delegated_worker_research_once_enabled ? "true" : "false"');
    expect(lambda).toContain('condition = !(var.delegated_worker_research_once_enabled && var.delegated_worker_schedule_enabled)');
    expect(lambda).toContain('Research-only invocation requires continuous scheduling to remain disabled.');
    expect(implementation).not.toContain('resource "aws_lambda_function_event_invoke_config"');
    expect(implementation).not.toContain('resource "aws_lambda_function_url"');
  });

  it("retains provider constraints, account allowlist and legacy tags without child provider configuration", () => {
    const requirements = compact(block(read(moduleDir, "versions.tf"), "required_providers"));
    expect(requirements).toContain('aws = { source = "hashicorp/aws" version = "~> 5.0" }');
    expect(requirements).toContain('archive = { source = "hashicorp/archive" version = "~> 2.4" }');
    for (const dir of [workerDir, moduleDir]) {
      const versions = read(dir, "versions.tf");
      expect(compact(block(versions, "required_providers"))).toBe(requirements);
      expect(versions).toContain('required_version = ">= 1.9.0"');
    }
    const providers = compact(read(workerDir, "providers.tf"));
    expect(providers).toContain('provider "aws" {');
    expect(providers).toContain("region = var.aws_region");
    expect(providers).toContain("allowed_account_ids = [var.aws_account_id]");
    expect(providers).toContain('default_tags { tags = { Project = "callie-sourcing" ManagedBy = "terraform" } }');
    expect([...worker.matchAll(/^provider "([^"]+)"/gm)].map((match) => match[1])).toEqual(["aws"]);
    expect(compact(workerModule)).toContain("providers = { aws = aws archive = archive }");
  });

  it("keeps archive evaluation disabled by default and caller paths stable", () => {
    const archive = compact(block(implementation, 'data "archive_file" "delegated_worker"'));
    expect(archive).toContain("count = var.delegated_worker_enabled ? 1 : 0");
    expect(archive).toContain("source_dir = var.worker_source_dir");
    expect(archive).toContain("output_path = var.worker_output_path");
    expect(compact(worker)).toContain('worker_source_dir = "${path.module}/../lambdas/delegated-worker/dist"');
    expect(compact(worker)).toContain('worker_output_path = "${path.module}/.build/delegated-worker.zip"');
    expect(resolve(workerDir, "../lambdas/delegated-worker/dist")).toBe(join(process.cwd(), "cloud/lambdas/delegated-worker/dist"));
    expect(existsSync(join(process.cwd(), "cloud/lambdas/delegated-worker/build.mjs"))).toBe(true);
  });

  it("preserves the endpoint output and disabled null behavior", () => {
    const output = compact(block(worker, 'output "delegated_worker_endpoint"'));
    expect(output).toContain('description = "HTTPS base only, never a bearer or unauthenticated stop URL."');
    expect(output).toContain("value = module.delegated_worker.delegated_worker_endpoint");
    expect([...worker.matchAll(/^output "([^"]+)"/gm)].map((match) => match[1])).toEqual(["delegated_worker_endpoint"]);
    expect(compact(block(implementation, 'output "delegated_worker_endpoint"')))
      .toContain("value = var.delegated_worker_enabled ? aws_apigatewayv2_api.delegated_worker[0].api_endpoint : null");
  });

  it("retains disabled gating, resource limits, routes and application-auth boundary", () => {
    const source = compact(implementation);
    for (const match of implementation.matchAll(/^(resource|data) "([^"]+)" "([^"]+)"/gm)) {
      const body = compact(block(implementation, match[0]));
      if (match[2] === "aws_apigatewayv2_route") {
        expect(body).toContain("for_each = var.delegated_worker_enabled ? local.delegated_routes : toset([])");
      } else if (match[2]?.startsWith("aws_cloudwatch_event_") || match[3] === "delegated_worker_schedule" || match[3] === "delegated_worker_silent_schedule") {
        expect(body).toContain("count = local.delegated_schedule_enabled ? 1 : 0");
      } else if (match[3] === "delegated_worker_alarm_email") {
        expect(body).toContain('count = var.delegated_worker_enabled && var.alarm_email != "" ? 1 : 0');
      } else {
        expect(body).toContain("count = var.delegated_worker_enabled ? 1 : 0");
      }
    }
    for (const invariant of [
      "delegated_schedule_enabled = var.delegated_worker_enabled && var.delegated_worker_schedule_enabled",
      'condition = var.delegated_worker_activation_reviewed && var.delegated_workspace_id != ""',
      'runtime = "nodejs22.x"', 'handler = "index.handler"', 'architectures = ["arm64"]',
      "memory_size = 256", "timeout = 60", "reserved_concurrent_executions = 5",
      "throttling_burst_limit = 5", "throttling_rate_limit = 2", "timeout_milliseconds = 30000",
      "deletion_protection_enabled = true", "point_in_time_recovery { enabled = true }",
      "enable_key_rotation = true", "deletion_window_in_days = 30",
      'schedule_expression = "rate(5 minutes)"', "maximum_event_age_in_seconds = 60", "maximum_retry_attempts = 0",
      'DELEGATED_GOOGLE_SECRET_PARAMETER = var.delegated_google_client_id == "" ? "" : local.delegated_secret_parameter',
      'DELEGATED_GOOGLE_KEY_PARAMETER = var.delegated_google_client_id == "" ? "" : local.delegated_key_parameter',
      'DELEGATED_RESEARCH_CREDENTIAL_PARAMETER = var.delegated_research_enabled ? local.delegated_research_parameter : ""',
      'DELEGATED_RESEARCH_REVIEWED_CAPABILITY = var.delegated_research_reviewed_capability',
      'DELEGATED_PLACES_CREDENTIAL_PARAMETER = var.delegated_places_enabled ? local.delegated_places_parameter : ""',
    ]) expect(source).toContain(invariant);
    expect([...implementation.matchAll(/retention_in_days\s*=\s*(\d+)/g)].map((match) => match[1])).toEqual(["7", "7"]);
    expect([...implementation.matchAll(/"((?:GET|POST) \/[^"\n]+)"/g)].map((match) => match[1])).toEqual([
      "POST /pairing/redeem", "POST /pairing/revoke", "POST /commands", "POST /commands/reconcile", "POST /emergency",
      "POST /readiness", "POST /research/configure", "POST /policies/configure", "POST /requested-followup/context", "POST /requested-followup/draft",
      "POST /research/setup/status", "POST /research/setup", "POST /accounts/preparation", "POST /reply/draft",
      "GET /events", "POST /google/begin", "GET /google/status", "GET /google/disclosure", "POST /google/revoke", "GET /oauth/callback",
    ]);
    // Authentication stays in the existing handler. Do not silently add/change API auth in an extraction.
    expect(implementation).not.toMatch(/\b(?:authorization_type|authorizer_id|api_key_required)\s*=/);
    expect(source).toContain('format = jsonencode({ requestId = "$context.requestId", status = "$context.status", responseLength = "$context.responseLength" })');
  });

  it("retains bounded IAM access and never provisions or reads secret values", () => {
    const policy = compact(block(implementation, 'resource "aws_iam_role_policy" "delegated_worker"'));
    expect(policy).toContain('Action = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:ConditionCheckItem"]');
    expect(policy).toContain('"dynamodb:LeadingKeys" = ["WORKSPACE#${var.delegated_workspace_id}"]');
    expect(policy).toContain('Action = ["ssm:GetParameter"], Resource = local.delegated_parameter_arns');
    expect(policy).toContain('"kms:ViaService" = "ssm.${var.aws_region}.amazonaws.com"');
    expect(policy).toContain('"kms:EncryptionContext:PARAMETER_ARN" = local.delegated_parameter_arns');
    expect(implementation + worker).not.toMatch(/(?:resource|data)\s+"aws_(?:ssm_parameter|secretsmanager_secret)/);
  });

  it("leaves backend configuration review-only and does not bootstrap or assume state", () => {
    expect(read(workerDir, "versions.tf")).toContain('backend "s3" {}');
    expect(readdirSync(workerDir)).not.toContain("backend.hcl");
    const example = compact(read(workerDir, "backend.hcl.example"));
    expect(example).toContain('bucket = "REVIEWED_WORKER_STATE_BUCKET"');
    expect(example).toContain('key = "cloud/delegated-worker/terraform.tfstate"');
    expect(example).not.toContain('key = "cloud/terraform.tfstate"');
    expect(example).toContain('dynamodb_table = "REVIEWED_WORKER_LOCK_TABLE"');
    expect(example).toContain("encrypt = true");
    expect(example).toContain("REVIEWED_STATE_KMS_KEY_ID");
    const review = read(workerDir, "README.md");
    expect(review).toContain("This root is the only Terraform owner of the worker");
    expect(review).toContain("This root does not create, migrate or import state.");
    expect(review).toContain("Never point this root at the legacy state key `cloud/terraform.tfstate`");
    expect(review).toContain("David destroyed the deployed legacy sourcing stack in account 326255650484 on 17 September 2026");
    expect(review).not.toMatch(/both roots|legacy root including|moved blocks in `cloud\/terraform/);
  });
});
