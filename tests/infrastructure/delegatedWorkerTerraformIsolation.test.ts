import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Offline source checks only. No subprocesses, Terraform, providers or network.
// Deliberately not an HCL parser or proof of a safe live state migration.
const legacyDir = join(process.cwd(), "cloud/terraform");
const workerDir = join(process.cwd(), "cloud/worker-terraform");
const moduleDir = join(legacyDir, "modules/delegated-worker");
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
const implementation = tf(moduleDir);
const legacy = read(legacyDir, "delegated-worker.tf");
const worker = tf(workerDir);

describe("delegated-worker Terraform source isolation", () => {
  it("has one worker implementation and no transitive unrelated root dependencies", () => {
    const declared = [...implementation.matchAll(/^(resource|data) "([^"]+)" "([^"]+)"/gm)]
      .map(([, kind, type, name]) => `${kind === "data" ? "data." : ""}${type}.${name}`);
    expect(declared.sort()).toEqual([...addresses].sort());
    expect(legacy).not.toMatch(/^(resource|data)\s+"/m);
    expect(worker).not.toMatch(/^(resource|data|moved|import|removed)\s+["{]/m);
    expect([...worker.matchAll(/^module "([^"]+)"/gm)].map((match) => match[1])).toEqual(["delegated_worker"]);
    expect(implementation).not.toMatch(/^(module|provider)\s+"/m);
    expect(implementation).not.toMatch(/\b(?:backend|provisioner)\s+"|terraform_remote_state|\bpath\.(?:root|module)\b/);
    expect(compact(block(legacy, 'module "delegated_worker"'))).toContain('source = "./modules/delegated-worker"');
    expect(compact(block(worker, 'module "delegated_worker"'))).toContain('source = "../terraform/modules/delegated-worker"');
    expect(implementation + worker).not.toMatch(/(?:resource|data)\s+"(?:aws_s3_|aws_ses|aws_route53_|aws_budgets_|external|terraform_remote_state)/);
  });

  it("moves all original count and for_each addresses only within the legacy state", () => {
    const moves = [...legacy.matchAll(/moved\s*\{\s*from\s*=\s*(\S+)\s+to\s*=\s*(\S+)\s*\}/g)];
    expect(moves.map((match) => match[1]).sort()).toEqual([...addresses].sort());
    for (const [, from, to] of moves) expect(to).toBe(`module.delegated_worker.${from}`);
    expect(block(legacy, 'module "delegated_worker"')).not.toMatch(/\b(?:count|for_each)\s*=/);
  });

  it("preserves defaults, validation and all explicit caller input wiring", () => {
    for (const [name, value] of Object.entries(defaults)) {
      const original = block(read(legacyDir, "variables.tf"), `variable "${name}"`);
      for (const dir of [legacyDir, workerDir, moduleDir]) {
        const input = block(read(dir, "variables.tf"), `variable "${name}"`);
        expect(compact(input)).toContain(`default = ${value}`);
        // Generic descriptions may become worker-specific; types and validation may not.
        expect(compact(input.replace(/description\s*=\s*"[^"\n]*"/, "")))
          .toBe(compact(original.replace(/description\s*=\s*"[^"\n]*"/, "")));
      }
      for (const caller of [legacy, worker]) {
        expect(compact(block(caller, 'module "delegated_worker"'))).toContain(`${name} = var.${name}`);
      }
    }
    const names = [...read(workerDir, "variables.tf").matchAll(/^variable "([^"]+)"/gm)].map((match) => match[1]);
    expect(names.sort()).toEqual(Object.keys(defaults).sort());
    const moduleNames = [...read(moduleDir, "variables.tf").matchAll(/^variable "([^"]+)"/gm)].map((match) => match[1]);
    expect(moduleNames.sort()).toEqual([...Object.keys(defaults), "worker_source_dir", "worker_output_path"].sort());
    const referenced = [...new Set([...implementation.matchAll(/\bvar\.([A-Za-z0-9_]+)/g)].map((match) => match[1]))];
    expect(referenced.sort()).toEqual(moduleNames.sort());
  });

  it("bounds optional non-secret reviewed metadata without treating it as provider or pricing proof", () => {
    for (const dir of [legacyDir, workerDir, moduleDir]) {
      const input = compact(block(read(dir, "variables.tf"), 'variable "delegated_research_reviewed_capability"'));
      expect(input).toContain('type = string');
      expect(input).toContain('default = ""');
      expect(input).toContain('nullable = false');
      expect(input).toContain('length(var.delegated_research_reviewed_capability) <= 3000');
      expect(input).toContain('(var.delegated_research_reviewed_capability == "" || can(jsondecode(var.delegated_research_reviewed_capability)))');
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

  it("keeps research-only invocation explicit and mutually exclusive with scheduling", () => {
    const lambda = compact(block(implementation, 'resource "aws_lambda_function" "delegated_worker"'));
    expect(lambda).toContain('DELEGATED_WORKER_RESEARCH_ONCE_ENABLED = var.delegated_worker_research_once_enabled ? "true" : "false"');
    expect(lambda).toContain('condition = !(var.delegated_worker_research_once_enabled && var.delegated_worker_schedule_enabled)');
    expect(lambda).toContain('Research-only invocation requires continuous scheduling to remain disabled.');
    expect(implementation).not.toContain('resource "aws_lambda_function_event_invoke_config"');
    expect(implementation).not.toContain('resource "aws_lambda_function_url"');
  });

  it("retains provider constraints, account allowlist and legacy tags without child provider configuration", () => {
    const requirements = compact(block(read(legacyDir, "versions.tf"), "required_providers"));
    for (const dir of [workerDir, moduleDir]) {
      const versions = read(dir, "versions.tf");
      expect(compact(block(versions, "required_providers"))).toBe(requirements);
      expect(versions).toContain('required_version = ">= 1.9.0"');
    }
    expect(compact(read(workerDir, "providers.tf"))).toBe(compact(read(legacyDir, "providers.tf")));
    for (const caller of [legacy, worker]) {
      expect(compact(block(caller, 'module "delegated_worker"'))).toContain("providers = { aws = aws archive = archive }");
    }
  });

  it("keeps archive evaluation disabled by default and caller paths stable and separate", () => {
    const archive = compact(block(implementation, 'data "archive_file" "delegated_worker"'));
    expect(archive).toContain("count = var.delegated_worker_enabled ? 1 : 0");
    expect(archive).toContain("source_dir = var.worker_source_dir");
    expect(archive).toContain("output_path = var.worker_output_path");
    for (const caller of [legacy, worker]) {
      expect(compact(caller)).toContain('worker_source_dir = "${path.module}/../lambdas/delegated-worker/dist"');
      expect(compact(caller)).toContain('worker_output_path = "${path.module}/.build/delegated-worker.zip"');
    }
    expect(resolve(legacyDir, "../lambdas/delegated-worker/dist")).toBe(resolve(workerDir, "../lambdas/delegated-worker/dist"));
    expect(resolve(legacyDir, ".build/delegated-worker.zip")).not.toBe(resolve(workerDir, ".build/delegated-worker.zip"));
  });

  it("preserves the endpoint output and disabled null behavior", () => {
    for (const caller of [legacy, worker]) {
      const output = compact(block(caller, 'output "delegated_worker_endpoint"'));
      expect(output).toContain('description = "HTTPS base only, never a bearer or unauthenticated stop URL."');
      expect(output).toContain("value = module.delegated_worker.delegated_worker_endpoint");
    }
    expect(compact(block(implementation, 'output "delegated_worker_endpoint"')))
      .toContain("value = var.delegated_worker_enabled ? aws_apigatewayv2_api.delegated_worker[0].api_endpoint : null");
    expect([...read(legacyDir, "outputs.tf").matchAll(/^output "([^"]+)"/gm)].map((match) => match[1])).toEqual([
      "raw_mail_bucket", "inbox_bucket", "ses_receipt_rule_set", "ses_inbound_domain",
      "mail_parse_lambda_name", "app_inbox_user_name", "dynamodb_table_names",
    ]);
  });

  it("retains disabled gating, resource limits, routes and application-auth boundary", () => {
    const source = compact(implementation);
    for (const match of implementation.matchAll(/^(resource|data) "([^"]+)" "([^"]+)"/gm)) {
      const body = compact(block(implementation, match[0]));
      if (match[2] === "aws_apigatewayv2_route") {
        expect(body).toContain("for_each = var.delegated_worker_enabled ? local.delegated_routes : toset([])");
      } else if (match[2]?.startsWith("aws_cloudwatch_event_") || match[3] === "delegated_worker_schedule") {
        expect(body).toContain("count = local.delegated_schedule_enabled ? 1 : 0");
      } else {
        expect(body).toContain("count = var.delegated_worker_enabled ? 1 : 0");
      }
    }
    for (const invariant of [
      "delegated_schedule_enabled = var.delegated_worker_enabled && var.delegated_worker_schedule_enabled",
      'condition = var.delegated_worker_activation_reviewed && var.delegated_workspace_id != ""',
      'runtime = "nodejs22.x"', 'handler = "index.handler"', 'architectures = ["arm64"]',
      "memory_size = 256", "timeout = 60", "reserved_concurrent_executions = 2",
      "throttling_burst_limit = 5", "throttling_rate_limit = 2", "timeout_milliseconds = 30000",
      "deletion_protection_enabled = true", "point_in_time_recovery { enabled = true }",
      "enable_key_rotation = true", "deletion_window_in_days = 30",
      'schedule_expression = "rate(5 minutes)"', "maximum_event_age_in_seconds = 60", "maximum_retry_attempts = 0",
      'DELEGATED_GOOGLE_SECRET_PARAMETER = var.delegated_google_client_id == "" ? "" : local.delegated_secret_parameter',
      'DELEGATED_GOOGLE_KEY_PARAMETER = var.delegated_google_client_id == "" ? "" : local.delegated_key_parameter',
      'DELEGATED_RESEARCH_CREDENTIAL_PARAMETER = var.delegated_research_enabled ? local.delegated_research_parameter : ""',
      'DELEGATED_RESEARCH_REVIEWED_CAPABILITY = var.delegated_research_reviewed_capability',
    ]) expect(source).toContain(invariant);
    expect([...implementation.matchAll(/retention_in_days\s*=\s*(\d+)/g)].map((match) => match[1])).toEqual(["7", "7"]);
    expect([...implementation.matchAll(/"((?:GET|POST) \/[^"\n]+)"/g)].map((match) => match[1])).toEqual([
      "POST /pairing/redeem", "POST /pairing/revoke", "POST /commands", "POST /commands/reconcile", "POST /emergency",
      "POST /readiness", "POST /research/configure", "POST /policies/configure", "POST /requested-followup/context", "POST /requested-followup/draft",
      "POST /research/setup/status", "POST /research/setup", "POST /accounts/preparation",
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
    expect(review).toContain("Never enable both roots for the same resources.");
    expect(review).toContain("Do not disable the old worker and apply as a migration");
    expect(review).toContain("No cross-state transfer is implemented or authorized by this change.");
  });
});
